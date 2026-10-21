// "Move out" vs "Delete tenant": both check the Resident out; delete also
// soft-deletes them (deletedAt + isDeleted) so they leave lists and search.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';
import { Resident, backfillResidentIsDeleted } from '../modules/residents/resident.model';
import { Bed } from '../modules/beds/bed.model';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_resident_delete_test' });
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

async function ownerWithTenant(email: string) {
  const signup = await request(app).post('/api/auth/signup').send({ name: 'Owner', email, password: 'password123' });
  const auth = { Authorization: `Bearer ${signup.body.token}` };
  const branch = await request(app).post('/api/branches').set(auth).send({ name: 'PG', address: 'Addr' });
  const room = await request(app)
    .post('/api/rooms')
    .set(auth)
    .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 1 });
  const beds = await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth);
  const resident = await request(app)
    .post('/api/residents')
    .set(auth)
    .send({ name: 'Rahul Sharma', phone: '9000000001', kycType: 'Aadhaar' });
  const stay = await request(app).post('/api/stays').set(auth).send({
    residentId: resident.body.id,
    bedId: beds.body[0].id,
    checkInDate: new Date(Date.now() - 30 * DAY).toISOString(),
    monthlyRent: 850000,
    securityDeposit: 1000000,
  });
  return { auth, residentId: resident.body.id as string, stayId: stay.body.id as string, bedId: beds.body[0].id as string };
}

const checkout = (auth: Record<string, string>, stayId: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .put(`/api/stays/${stayId}/checkout`)
    .set(auth)
    .send({ checkOutDate: new Date().toISOString(), settlement: { deductions: [], refundMode: 'cash', notes: null }, ...extra });

describe('Move out vs delete tenant', () => {
  it('move out keeps the resident as a findable past tenant', async () => {
    const { auth, residentId, stayId, bedId } = await ownerWithTenant('moveout@example.com');
    expect((await checkout(auth, stayId)).status).toBe(200);

    const resident = await Resident.findById(residentId).lean();
    expect(resident!.deletedAt).toBeNull();
    expect(resident!.isDeleted).toBe(false);
    expect((await Bed.findById(bedId))!.status).toBe('vacant');
    const search = await request(app).get('/api/search/resident?q=Rahul').set(auth);
    expect(search.body.results[0].status).toBe('moved_out');
  });

  it('delete checks out, then sets deletedAt and isDeleted and hides them', async () => {
    const { auth, residentId, stayId, bedId } = await ownerWithTenant('delete@example.com');
    const res = await checkout(auth, stayId, { deleteResident: true });
    expect(res.status).toBe(200);
    expect(res.body.checkOutDate).toBeTruthy();

    const resident = await Resident.findById(residentId).lean();
    expect(resident!.deletedAt).toBeInstanceOf(Date);
    expect(resident!.isDeleted).toBe(true);
    expect((await Bed.findById(bedId))!.status).toBe('vacant');
    expect((await request(app).get('/api/search/resident?q=Rahul').set(auth)).body.results).toHaveLength(0);
    expect((await request(app).get(`/api/residents/${residentId}`).set(auth)).status).toBe(404);

    // The record and its log stay in the database.
    const log = (await request(app).get(`/api/residents/${residentId}/changes`).set(auth)).body.changes;
    expect(log.map((l: { action: string }) => l.action).slice(0, 2)).toEqual(['resident.deleted', 'stay.checked_out']);
  });

  it('DELETE /residents/:id sets both fields', async () => {
    const { auth, residentId, stayId } = await ownerWithTenant('plain-delete@example.com');
    await checkout(auth, stayId);
    expect((await request(app).delete(`/api/residents/${residentId}`).set(auth)).status).toBe(200);
    const resident = await Resident.findById(residentId).lean();
    expect(resident!.isDeleted).toBe(true);
    expect(resident!.deletedAt).toBeInstanceOf(Date);
  });

  it('backfills isDeleted for residents deleted before the field existed', async () => {
    await Resident.collection.insertOne({
      _id: 'legacy-deleted' as never,
      ownerId: 'o1',
      name: 'Old',
      phone: '9000000009',
      kycType: 'Aadhaar',
      kycRef: '',
      deletedAt: new Date(),
    });
    await backfillResidentIsDeleted();
    expect((await Resident.collection.findOne({ _id: 'legacy-deleted' as never }))!.isDeleted).toBe(true);
  });
});
