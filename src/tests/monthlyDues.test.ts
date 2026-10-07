// Automatic monthly rent dues: expected rent = Σ active tenants' rent.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';
import { Payment } from '../modules/payments/payment.model';
import { Stay } from '../modules/stays/stay.model';
import { ensureMonthlyDues, localMidnight, monthKeyOf } from '../modules/payments/monthlyDues';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_monthly_dues_test' });
  await Payment.syncIndexes();
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})),
  );
});

const DAY = 86_400_000;

async function owner(email: string, bedCount = 3) {
  const signup = await request(app).post('/api/auth/signup').send({ name: 'O', email, password: 'password123' });
  const auth = { Authorization: `Bearer ${signup.body.token}` };
  const branch = await request(app).post('/api/branches').set(auth).send({ name: 'PG', address: 'A' });
  const room = await request(app)
    .post('/api/rooms')
    .set(auth)
    .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount });
  const beds = await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth);
  return { auth, ownerId: signup.body.owner.id as string, bedIds: beds.body.map((b: any) => b.id) as string[] };
}

async function checkIn(auth: Record<string, string>, bedId: string, phone: string, rent: number, checkInDate: Date) {
  const r = await request(app)
    .post('/api/residents')
    .set(auth)
    .send({ name: `T${phone}`, phone, kycType: 'Aadhaar', kycRef: phone });
  const stay = await request(app).post('/api/stays').set(auth).send({
    residentId: r.body.id,
    bedId,
    checkInDate: checkInDate.toISOString(),
    monthlyRent: rent,
    securityDeposit: 0,
  });
  return stay.body.id as string;
}

describe('Automatic monthly dues', () => {
  it('creates this month’s due on check-in, and expected = Σ active rents', async () => {
    const { auth, bedIds } = await owner('dues-a@example.com');
    const fortyDaysAgo = new Date(Date.now() - 40 * DAY);
    await checkIn(auth, bedIds[0], '9000000001', 500000, fortyDaysAgo);
    await checkIn(auth, bedIds[1], '9000000002', 500000, fortyDaysAgo);

    const dues = await Payment.find({ dueMonth: monthKeyOf(new Date()) });
    expect(dues).toHaveLength(2);
    expect(dues.every((d) => d.status === 'pending' && d.rentDue === 500000)).toBe(true);

    // Dashboard for the current month (default range) expects 2 × ₹5,000.
    const res = await request(app).get('/api/dashboard/overview').set(auth);
    expect(res.body.revenue.target).toBe(1000000);
    expect(res.body.rentStatus.unpaidCount).toBe(2);
  });

  it('is idempotent across repeated and concurrent calls', async () => {
    const { auth, ownerId, bedIds } = await owner('dues-b@example.com');
    await checkIn(auth, bedIds[0], '9000000003', 500000, new Date(Date.now() - 100 * DAY));
    const from = new Date(Date.now() - 100 * DAY);
    const now = new Date();

    await Promise.all([1, 2, 3].map(() => ensureMonthlyDues(ownerId, from, now)));
    await ensureMonthlyDues(ownerId, from, now);

    const dues = await Payment.find({ ownerId });
    const months = dues.map((d) => d.dueMonth);
    expect(new Set(months).size).toBe(months.length); // one per month
    expect(dues.length).toBeGreaterThanOrEqual(3);
    expect(dues.length).toBeLessThanOrEqual(5);
  });

  it('never creates future months or dues after checkout / before check-in', async () => {
    const { auth, ownerId, bedIds } = await owner('dues-c@example.com');
    const stayId = await checkIn(auth, bedIds[0], '9000000004', 500000, new Date(Date.now() - 70 * DAY));
    await request(app)
      .put(`/api/stays/${stayId}/checkout`)
      .set(auth)
      .send({ checkOutDate: new Date(Date.now() - 20 * DAY).toISOString() });
    await Payment.deleteMany({});

    await ensureMonthlyDues(ownerId, new Date(Date.now() - 365 * DAY), new Date(Date.now() + 365 * DAY));
    const stay = await Stay.findById(stayId);
    const dues = await Payment.find({ ownerId });
    expect(dues.length).toBeGreaterThan(0);
    for (const d of dues) {
      expect(d.dueDate.getTime()).toBeLessThan(stay!.checkOutDate!.getTime());
      expect(d.dueDate.getTime()).toBeGreaterThanOrEqual(stay!.checkInDate.getTime() - DAY);
      expect(d.dueDate.getTime()).toBeLessThan(Date.now() + 31 * DAY);
    }
  });

  it('stops at a notice move-out date', async () => {
    const { auth, ownerId, bedIds } = await owner('dues-notice@example.com');
    // Due day = check-in day; notice before this month's due day → no due this month.
    const now = new Date();
    const stayId = await checkIn(auth, bedIds[0], '9000000005', 500000, new Date(now.getTime() - 60 * DAY));
    await Payment.deleteMany({});
    await Stay.updateOne({ _id: stayId }, { noticeMoveOutDate: new Date(now.getTime() - 50 * DAY) });

    await ensureMonthlyDues(ownerId, new Date(now.getTime() - 60 * DAY), now);
    const dues = await Payment.find({ ownerId });
    expect(dues.length).toBeLessThanOrEqual(1);
  });

  it('a hand-made due for the month updates the untouched automatic one', async () => {
    const { auth, bedIds } = await owner('dues-manual@example.com');
    const stayId = await checkIn(auth, bedIds[0], '9000000006', 500000, new Date(Date.now() - 40 * DAY));
    const month = monthKeyOf(new Date());
    const [y, m] = month.split('-').map(Number);

    const res = await request(app)
      .post('/api/payments')
      .set(auth)
      .send({ stayId, dueDate: localMidnight(y, m - 1, 10).toISOString(), rentDue: 520000, electricityDue: 30000 });
    expect(res.status).toBe(201);

    const dues = await Payment.find({ stayId, deletedAt: null });
    const thisMonth = dues.filter((d) => monthKeyOf(d.dueDate) === month);
    expect(thisMonth).toHaveLength(1);
    expect(thisMonth[0]).toMatchObject({ rentDue: 520000, electricityDue: 30000 });
  });

  it('keeps owners separate', async () => {
    const a = await owner('dues-iso-a@example.com');
    const b = await owner('dues-iso-b@example.com');
    await checkIn(b.auth, b.bedIds[0], '9000000007', 500000, new Date(Date.now() - 40 * DAY));

    await ensureMonthlyDues(a.ownerId, new Date(Date.now() - 100 * DAY), new Date());
    expect(await Payment.countDocuments({ ownerId: a.ownerId })).toBe(0);
    expect(await Payment.countDocuments({ ownerId: b.ownerId })).toBeGreaterThan(0);
  });
});

describe('Automatic dues follow move-out', () => {
  it('voids untouched future dues on checkout and notice, and restores them when notice is cancelled', async () => {
    const { auth, ownerId, bedIds } = await owner('dues-void@example.com');
    // Checked in "tomorrow last month", so this month's due date is still ahead.
    const checkInDate = new Date(Date.now() - 29 * DAY);
    const stayId = await checkIn(auth, bedIds[0], '9000000008', 500000, checkInDate);
    const thisMonth = monthKeyOf(new Date());
    const live = () => Payment.find({ stayId, dueMonth: thisMonth, deletedAt: null });
    const due = (await live())[0];
    expect(due).toBeTruthy();

    // Notice to leave before the due date → due voided.
    await request(app)
      .put(`/api/stays/${stayId}/notice`)
      .set(auth)
      .send({ moveOutDate: new Date(due.dueDate.getTime() - DAY).toISOString() });
    expect(await live()).toHaveLength(0);

    // Notice cancelled → the due comes back on the next read.
    await request(app).delete(`/api/stays/${stayId}/notice`).set(auth);
    await ensureMonthlyDues(ownerId, new Date(), new Date());
    expect(await live()).toHaveLength(1);

    // Vacated before the due date → voided again; paid dues are never touched.
    await request(app)
      .put(`/api/stays/${stayId}/checkout`)
      .set(auth)
      .send({ checkOutDate: new Date(due.dueDate.getTime() - DAY).toISOString() });
    expect(await live()).toHaveLength(0);
  });
});
