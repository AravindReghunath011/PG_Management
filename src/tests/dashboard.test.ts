import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_dashboard_test' });
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
});

const OCT = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };

async function setupOwner(email: string, branchName: string) {
  const signup = await request(app)
    .post('/api/auth/signup')
    .send({ name: 'Dash Owner', email, password: 'password123' });
  const token = signup.body.token as string;
  const auth = { Authorization: `Bearer ${token}` };

  const branch = await request(app).post('/api/branches').set(auth).send({ name: branchName, address: 'Addr' });
  const room = await request(app)
    .post('/api/rooms')
    .set(auth)
    .send({ branchId: branch.body.id, roomNumber: '102', floor: 1, bedCount: 3 });
  const beds = await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth);

  return { token, auth, bedIds: beds.body.map((b: any) => b.id) as string[] };
}

async function checkInWithDue(
  auth: Record<string, string>,
  bedId: string,
  name: string,
  phone: string,
  rentDue: number
) {
  const resident = await request(app)
    .post('/api/residents')
    .set(auth)
    .send({ name, phone, kycType: 'Aadhaar', kycRef: phone });
  const stay = await request(app).post('/api/stays').set(auth).send({
    residentId: resident.body.id,
    bedId,
    checkInDate: '2026-09-01T00:00:00.000Z',
    monthlyRent: rentDue,
    securityDeposit: 0,
  });
  const due = await request(app)
    .post('/api/payments')
    .set(auth)
    .send({ stayId: stay.body.id, dueDate: '2026-10-05T00:00:00.000Z', rentDue });
  return { paymentId: due.body.id as string, stayId: stay.body.id as string };
}

describe('GET /api/dashboard/overview', () => {
  it('summarises revenue, beds and paid/unpaid residents for the period', async () => {
    const { auth, bedIds } = await setupOwner('dash@example.com', 'Balaji PG');

    const paid = await checkInWithDue(auth, bedIds[0], 'Paid Resident', '9000000001', 700000);
    await checkInWithDue(auth, bedIds[1], 'Rahul Kumar', '9000000002', 700000);

    await request(app)
      .put(`/api/payments/${paid.paymentId}`)
      .set(auth)
      .send({ rentCollected: 700000, collectedAt: '2026-10-06T00:00:00.000Z' });
    await request(app)
      .post('/api/expenses')
      .set(auth)
      .send({ category: 'cleaning', amount: 150000, date: '2026-10-10T00:00:00.000Z' });

    const res = await request(app).get('/api/dashboard/overview').query(OCT).set(auth);

    expect(res.status).toBe(200);
    expect(res.body.owner.displayName).toBe('Balaji PG');
    expect(res.body.revenue).toEqual({
      collected: 700000,
      target: 1400000,
      pending: 700000,
      expenses: 150000,
      previousCollected: 0,
    });
    expect(res.body.stats).toMatchObject({ totalRooms: 1, totalBeds: 3, vacantBeds: 1, unpaidCount: 1 });
    expect(res.body.rentStatus.paidCount).toBe(1);
    expect(res.body.rentStatus.unpaidCount).toBe(1);

    const unpaid = res.body.rentStatus.unpaid[0];
    expect(unpaid).toMatchObject({
      name: 'Rahul Kumar',
      phone: '9000000002',
      roomNumber: '102',
      balance: 700000,
    });
    expect(unpaid.bedNumber).toBeTruthy();
  });

  it('never returns another owner\'s data', async () => {
    const a = await setupOwner('dash-a@example.com', 'A PG');
    const b = await setupOwner('dash-b@example.com', 'B PG');
    await checkInWithDue(b.auth, b.bedIds[0], 'B Resident', '9100000001', 500000);

    const res = await request(app).get('/api/dashboard/overview').query(OCT).set(a.auth);

    expect(res.status).toBe(200);
    expect(res.body.owner.displayName).toBe('A PG');
    expect(res.body.revenue.target).toBe(0);
    expect(res.body.stats.vacantBeds).toBe(3);
    expect(res.body.rentStatus.unpaid).toHaveLength(0);
  });

  it('rejects an inverted date range', async () => {
    const { auth } = await setupOwner('dash-bad@example.com', 'X');
    const res = await request(app)
      .get('/api/dashboard/overview')
      .query({ from: OCT.to, to: OCT.from })
      .set(auth);
    expect(res.status).toBe(400);
  });
});
