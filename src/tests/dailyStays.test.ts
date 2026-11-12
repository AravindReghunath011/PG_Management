// Daily tenants: one person per bed, check-out frees the bed, bill = days × rate, owner scoping.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';
import { Bed } from '../modules/beds/bed.model';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;
const DAY = 86_400_000;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_daily_test' });
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

async function setup(email: string) {
  const signup = await request(app).post('/api/auth/signup').send({ name: 'Owner', email, password: 'password123' });
  const auth = { Authorization: `Bearer ${signup.body.token}` };
  const branch = await request(app).post('/api/branches').set(auth).send({ name: 'Balaji PG', address: 'A' });
  const room = await request(app)
    .post('/api/rooms')
    .set(auth)
    .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 2 });
  const beds = (await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth)).body.map((b: any) => b.id);
  return { auth, beds: beds as string[] };
}

const guest = (bedId: string, overrides: Record<string, unknown> = {}) => {
  const checkInAt = new Date(Date.now() - 2.5 * DAY);
  return {
    bedId,
    name: 'Ravi Kumar',
    phone: '9876543210',
    checkInAt: checkInAt.toISOString(),
    expectedCheckOutAt: new Date(checkInAt.getTime() + 3 * DAY).toISOString(),
    dailyRatePaise: 50000,
    amountPaidPaise: 50000,
    ...overrides,
  };
};

describe('daily tenants', () => {
  it('checks in to a free bed, bills started days, and frees the bed on check-out', async () => {
    const { auth, beds } = await setup('d1@test.com');
    const res = await request(app).post('/api/daily-stays').set(auth).send(guest(beds[0]));
    expect(res.status).toBe(201);
    const [stay] = res.body;
    // 2.5 days in → 3 started days × ₹500.
    expect(stay).toMatchObject({ days: 3, totalPaise: 150000, balancePaise: 100000, bedLabel: '101-A' });
    expect((await Bed.findById(beds[0]))!.status).toBe('occupied');

    const out = await request(app).post(`/api/daily-stays/${stay.id}/check-out`).set(auth).send({ amountPaidPaise: 150000 });
    expect(out.status).toBe(200);
    expect(out.body[0]).toMatchObject({ balancePaise: 0 });
    expect(out.body[0].checkOutAt).toBeTruthy();
    expect((await Bed.findById(beds[0]))!.status).toBe('vacant');

    const again = await request(app).post(`/api/daily-stays/${stay.id}/check-out`).set(auth).send({});
    expect(again.status).toBe(409);
  });

  it('never puts two people in one bed', async () => {
    const { auth, beds } = await setup('d2@test.com');
    expect((await request(app).post('/api/daily-stays').set(auth).send(guest(beds[0]))).status).toBe(201);
    const second = await request(app).post('/api/daily-stays').set(auth).send(guest(beds[0], { phone: '9123456789' }));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('BED_OCCUPIED');
  });

  it('rejects bad input without taking the bed', async () => {
    const { auth, beds } = await setup('d3@test.com');
    expect((await request(app).post('/api/daily-stays').set(auth).send(guest(beds[0], { phone: '12345' }))).status).toBe(400);
    expect((await request(app).post('/api/daily-stays').set(auth).send(guest(beds[0], { dailyRatePaise: 0 }))).status).toBe(400);
    expect((await Bed.findById(beds[0]))!.status).toBe('vacant');
  });

  it('deleting an open entry frees the bed', async () => {
    const { auth, beds } = await setup('d4@test.com');
    const [stay] = (await request(app).post('/api/daily-stays').set(auth).send(guest(beds[1]))).body;
    expect((await request(app).delete(`/api/daily-stays/${stay.id}`).set(auth)).status).toBe(200);
    expect((await Bed.findById(beds[1]))!.status).toBe('vacant');
    expect((await request(app).get('/api/daily-stays').set(auth)).body).toHaveLength(0);
  });

  it('keeps daily tenants owner-scoped', async () => {
    const a = await setup('d5a@test.com');
    const b = await setup('d5b@test.com');
    const [stay] = (await request(app).post('/api/daily-stays').set(a.auth).send(guest(a.beds[0]))).body;
    expect((await request(app).get('/api/daily-stays').set(b.auth)).body).toHaveLength(0);
    expect((await request(app).put(`/api/daily-stays/${stay.id}`).set(b.auth).send({ name: 'X' })).status).toBe(404);
    expect((await request(app).post(`/api/daily-stays/${stay.id}/check-out`).set(b.auth).send({})).status).toBe(404);
    // B can't take A's bed either.
    expect((await request(app).post('/api/daily-stays').set(b.auth).send(guest(a.beds[1]))).status).toBe(409);
  });
});
