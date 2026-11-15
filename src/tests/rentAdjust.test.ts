// Closing a month for less ("no balance") and applying a rent change to this month.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';
import { Payment } from '../modules/payments/payment.model';
import { monthKeyOf } from '../modules/payments/monthlyDues';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;
const DAY = 86_400_000;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_rent_adjust_test' });
  await Payment.syncIndexes();
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

/** An owner with one tenant who checked in 3 days ago at ₹5,000, so this month's rent is raised. */
async function tenantWithThisMonthsRent(email: string) {
  const signup = await request(app).post('/api/auth/signup').send({ name: 'O', email, password: 'password123' });
  const auth = { Authorization: `Bearer ${signup.body.token}` };
  const branch = await request(app).post('/api/branches').set(auth).send({ name: 'Main', address: 'A' });
  const room = await request(app).post('/api/rooms').set(auth).send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 1 });
  const [bedId] = (await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth)).body.map((b: { id: string }) => b.id);
  const resident = await request(app).post('/api/residents').set(auth).send({ name: 'Ravi', phone: '9876500000', kycType: 'Aadhaar' });
  const stay = await request(app).post('/api/stays').set(auth).send({
    residentId: resident.body.id,
    bedId,
    checkInDate: new Date(Date.now() - 3 * DAY).toISOString(),
    monthlyRent: 500000,
    securityDeposit: 0,
  });
  // Raises the dues up to now.
  await request(app).get('/api/payments').query({ from: new Date(Date.now() - 40 * DAY).toISOString(), to: new Date().toISOString() }).set(auth);
  if (stay.status !== 201) throw new Error(`setup: resident ${resident.status} ${JSON.stringify(resident.body)} stay ${stay.status} ${JSON.stringify(stay.body)} bed ${bedId}`);
  const due = await Payment.findOne({ stayId: stay.body.id, deletedAt: null }).sort({ dueDate: -1 });
  return { auth, stayId: stay.body.id as string, due: due! };
}

describe('Close a month with no balance', () => {
  it('takes a part payment as the full rent and leaves nothing owed', async () => {
    const { auth, due } = await tenantWithThisMonthsRent('close@example.com');
    expect(due.rentDue).toBe(500000);

    const res = await request(app).put(`/api/payments/${due._id}`).set(auth).send({ rentCollected: 300000, paymentMode: 'cash', closeBalance: true });
    expect(res.status).toBe(200);
    const after = await Payment.findById(due._id);
    expect(after).toMatchObject({ rentPaid: 300000, rentDue: 300000, waivedPaise: 200000, status: 'paid' });
  });

  it('without the option, the rest stays as a balance', async () => {
    const { auth, due } = await tenantWithThisMonthsRent('noclose@example.com');
    await request(app).put(`/api/payments/${due._id}`).set(auth).send({ rentCollected: 300000, paymentMode: 'cash' });
    const after = await Payment.findById(due._id);
    expect(after).toMatchObject({ rentPaid: 300000, rentDue: 500000, status: 'partial' });
    expect(after?.waivedPaise ?? 0).toBe(0);
  });
});

describe('Rent change for this month', () => {
  it('updates this month’s rent only when asked', async () => {
    const { auth, stayId, due } = await tenantWithThisMonthsRent('apply@example.com');
    expect(due.dueMonth).toBe(monthKeyOf(new Date()));

    const no = await request(app).put(`/api/stays/${stayId}`).set(auth).send({ monthlyRent: 600000 });
    expect(no.body.currentMonthUpdated).toBe(false);
    expect((await Payment.findById(due._id))?.rentDue).toBe(500000);

    const yes = await request(app).put(`/api/stays/${stayId}`).set(auth).send({ monthlyRent: 650000, applyToCurrentMonth: true });
    expect(yes.status).toBe(200);
    expect(yes.body.currentMonthUpdated).toBe(true);
    expect((await Payment.findById(due._id))?.rentDue).toBe(650000);
  });
});
