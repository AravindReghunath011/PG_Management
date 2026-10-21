// The change log: every edit to a Resident or their Stay is recorded with
// before/after values, owner-scoped, and history is never rewritten.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_change_log_test' });
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
});

const DAY = 86_400_000;

async function ownerWithTenant(email: string, phone = '9000000001') {
  const signup = await request(app).post('/api/auth/signup').send({ name: 'Owner', email, password: 'password123' });
  const auth = { Authorization: `Bearer ${signup.body.token}` };
  const branch = await request(app).post('/api/branches').set(auth).send({ name: 'PG', address: 'Addr' });
  const room = await request(app)
    .post('/api/rooms')
    .set(auth)
    .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 2 });
  const beds = await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth);
  const resident = await request(app)
    .post('/api/residents')
    .set(auth)
    .send({ name: 'Rahul Sharma', phone, kycType: 'Aadhaar', kycRef: '482988129021' });
  const stay = await request(app).post('/api/stays').set(auth).send({
    residentId: resident.body.id,
    bedId: beds.body[0].id,
    checkInDate: new Date(Date.now() - 60 * DAY).toISOString(),
    monthlyRent: 850000,
    securityDeposit: 1500000,
  });
  return {
    auth,
    residentId: resident.body.id as string,
    stayId: stay.body.id as string,
    otherBedId: beds.body[1].id as string,
  };
}

const changesOf = async (auth: Record<string, string>, residentId: string) =>
  (await request(app).get(`/api/residents/${residentId}/changes`).set(auth)).body.changes as {
    action: string;
    changes: { field: string; from: unknown; to: unknown }[];
    note: string | null;
    actorRole: string;
  }[];

describe('Change log', () => {
  it('records each edited field with its old and new value', async () => {
    const { auth, residentId } = await ownerWithTenant('log@example.com');

    const res = await request(app).put(`/api/residents/${residentId}`).set(auth).send({
      name: 'Rahul K Sharma',
      phone: '9000000099',
      email: 'rahul@example.com',
      kycRef: '482988129021', // unchanged: not logged
      guardianName: 'Sunil Sharma',
      guardianPhone: '9000000077',
      guardianRelation: 'Father',
    });
    expect(res.status).toBe(200);

    const [latest] = await changesOf(auth, residentId);
    expect(latest.action).toBe('resident.updated');
    expect(latest.actorRole).toBe('owner');
    const byField = Object.fromEntries(latest.changes.map((c) => [c.field, c]));
    expect(byField.name).toEqual({ field: 'name', from: 'Rahul Sharma', to: 'Rahul K Sharma' });
    expect(byField.phone).toEqual({ field: 'phone', from: '9000000001', to: '9000000099' });
    expect(byField.email).toEqual({ field: 'email', from: null, to: 'rahul@example.com' });
    expect(byField.guardianRelation.to).toBe('Father');
    expect(byField.kycRef).toBeUndefined();
  });

  it('does not log an edit that changes nothing', async () => {
    const { auth, residentId } = await ownerWithTenant('noop@example.com');
    const before = await changesOf(auth, residentId);
    await request(app).put(`/api/residents/${residentId}`).set(auth).send({ name: 'Rahul Sharma' });
    expect(await changesOf(auth, residentId)).toHaveLength(before.length);
  });

  it('logs the whole life of a stay: check-in, rent edit, notice, move and payment', async () => {
    const { auth, residentId, stayId, otherBedId } = await ownerWithTenant('life@example.com');

    await request(app).put(`/api/stays/${stayId}`).set(auth).send({ monthlyRent: 900000 });
    await request(app)
      .put(`/api/stays/${stayId}/notice`)
      .set(auth)
      .send({ moveOutDate: new Date(Date.now() + 10 * DAY).toISOString() });
    await request(app).delete(`/api/stays/${stayId}/notice`).set(auth);
    const moved = await request(app)
      .put(`/api/stays/${stayId}/move`)
      .set(auth)
      .send({ bedId: otherBedId, moveDate: new Date().toISOString() });
    expect(moved.status).toBe(200);
    const due = (await request(app).get(`/api/payments?residentId=${residentId}`).set(auth)).body[0];
    await request(app).put(`/api/payments/${due.id}`).set(auth).send({ rentCollected: 500000, paymentMode: 'upi' });

    const log = await changesOf(auth, residentId);
    // Newest first.
    expect(log.map((l) => l.action)).toEqual([
      'payment.recorded',
      'stay.moved',
      'stay.notice_cancelled',
      'stay.notice_given',
      'stay.updated',
      'stay.checked_in',
      'resident.created',
    ]);
    expect(log[1].note).toBe('101-A → 101-B');
    expect(log[4].changes).toEqual([{ field: 'monthlyRent', from: 850000, to: 900000 }]);
    expect(log[0].changes).toEqual([{ field: 'rentPaid', from: null, to: 500000 }]);
  });

  it('keeps each owner’s log private', async () => {
    const a = await ownerWithTenant('a-log@example.com', '9000000011');
    const b = await ownerWithTenant('b-log@example.com', '9000000022');
    const res = await request(app).get(`/api/residents/${a.residentId}/changes`).set(b.auth);
    expect(res.status).toBe(404);
    expect((await changesOf(b.auth, b.residentId)).length).toBeGreaterThan(0);
  });

  it('keeps the log after the resident is deleted', async () => {
    const { auth, residentId, stayId } = await ownerWithTenant('kept@example.com');
    await request(app).put(`/api/stays/${stayId}/checkout`).set(auth).send({ checkOutDate: new Date().toISOString() });
    expect((await request(app).delete(`/api/residents/${residentId}`).set(auth)).status).toBe(200);

    const log = await changesOf(auth, residentId);
    expect(log[0].action).toBe('resident.deleted');
    expect(log.some((l) => l.action === 'stay.checked_out')).toBe(true);
  });
});
