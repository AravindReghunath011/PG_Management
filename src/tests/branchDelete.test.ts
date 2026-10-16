import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';
import { Owner } from '../modules/auth/owner.model';
import { Branch } from '../modules/branches/branch.model';
import { Room } from '../modules/rooms/room.model';
import { Bed } from '../modules/beds/bed.model';
import { Resident } from '../modules/residents/resident.model';
import { Stay } from '../modules/stays/stay.model';
import { Payment } from '../modules/payments/payment.model';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_branch_delete_test' });
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    Owner.deleteMany({}),
    Branch.deleteMany({}),
    Room.deleteMany({}),
    Bed.deleteMany({}),
    Resident.deleteMany({}),
    Stay.deleteMany({}),
    Payment.deleteMany({}),
  ]);
});

async function signup(email: string) {
  const res = await request(app).post('/api/auth/signup').send({ name: 'Owner', email, password: 'password123' });
  return { Authorization: `Bearer ${res.body.token}` };
}

/** One branch, one room "101" with one bed, one resident checked in. */
async function setup(auth: Record<string, string>, phone = '9700000001') {
  const branch = await request(app).post('/api/branches').set(auth).send({ name: 'Old PG', address: 'Addr' });
  const room = await request(app)
    .post('/api/rooms')
    .set(auth)
    .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 1 });
  const bedId = (await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth)).body[0].id;
  const resident = await request(app)
    .post('/api/residents')
    .set(auth)
    .send({ name: 'Past Resident', phone, kycType: 'Aadhaar', kycRef: 'P1' });
  const stay = await request(app).post('/api/stays').set(auth).send({
    residentId: resident.body.id,
    bedId,
    checkInDate: '2026-01-01T00:00:00.000Z',
    monthlyRent: 800000,
    securityDeposit: 1600000,
  });
  return { branchId: branch.body.id as string, roomId: room.body.id as string, bedId, residentId: resident.body.id as string, stayId: stay.body.id as string };
}

describe('Property (Branch) soft delete', () => {
  it('refuses to delete a property while a resident is staying', async () => {
    const auth = await signup('occupied@example.com');
    const { branchId } = await setup(auth);

    const res = await request(app).delete(`/api/branches/${branchId}`).set(auth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BRANCH_OCCUPIED');
    expect((await Branch.findById(branchId))!.deletedAt).toBeNull();
  });

  it('soft-deletes the property with its rooms and beds, keeping stay history', async () => {
    const auth = await signup('cascade@example.com');
    const { branchId, roomId, bedId, residentId, stayId } = await setup(auth);
    await request(app).put(`/api/stays/${stayId}/checkout`).set(auth).send({ checkOutDate: '2026-03-01T00:00:00.000Z' });

    const res = await request(app).delete(`/api/branches/${branchId}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ removedRooms: 1, removedBeds: 1 });

    // Soft, not hard: the records still exist with deletedAt set.
    const [branch, room, bed, stay] = await Promise.all([
      Branch.findById(branchId),
      Room.findById(roomId),
      Bed.findById(bedId),
      Stay.findById(stayId),
    ]);
    expect(branch!.deletedAt).not.toBeNull();
    expect(room!.deletedAt).toEqual(branch!.deletedAt);
    expect(bed!.deletedAt).toEqual(branch!.deletedAt);
    expect(stay!.deletedAt).toBeNull();
    expect(stay!.checkOutDate).not.toBeNull();

    // Gone from live lists.
    expect((await request(app).get('/api/branches').set(auth)).body).toHaveLength(0);
    expect((await request(app).get('/api/rooms').set(auth)).body).toHaveLength(0);

    // Still findable in search, still labelled.
    const search = await request(app).get('/api/search/resident').query({ q: 'Past' }).set(auth);
    const hit = search.body.results[0];
    expect(hit.status).toBe('moved_out');
    expect(hit.stays[0]).toMatchObject({ bedLabel: '101-A', branchName: 'Old PG', placeRemoved: true });

    // And the full history page still works.
    const history = await request(app).get(`/api/residents/${residentId}/history`).set(auth);
    expect(history.status).toBe(200);
    expect(history.body.status).toBe('moved_out');
    expect(history.body.stays[0]).toMatchObject({ roomNumber: '101', bedNumber: 'A', branchName: 'Old PG', placeRemoved: true });
  });

  it('does not let another owner delete the property', async () => {
    const ownerA = await signup('a@example.com');
    const ownerB = await signup('b@example.com');
    const { branchId, stayId } = await setup(ownerA);
    await request(app).put(`/api/stays/${stayId}/checkout`).set(ownerA).send({ checkOutDate: '2026-03-01T00:00:00.000Z' });

    const res = await request(app).delete(`/api/branches/${branchId}`).set(ownerB);
    expect(res.status).toBe(404);
    expect((await Branch.findById(branchId))!.deletedAt).toBeNull();
  });
});

describe('Resident history', () => {
  it('returns a moved-out resident with stays and dues', async () => {
    const auth = await signup('history@example.com');
    const { residentId, stayId } = await setup(auth);
    await request(app).put(`/api/stays/${stayId}/checkout`).set(auth).send({ checkOutDate: '2026-03-01T00:00:00.000Z' });

    const res = await request(app).get(`/api/residents/${residentId}/history`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.resident).toMatchObject({ id: residentId, name: 'Past Resident', currentStayId: null });
    expect(res.body.status).toBe('moved_out');
    expect(res.body.stays).toHaveLength(1);
    expect(res.body.stays[0]).toMatchObject({ id: stayId, bedLabel: '101-A', placeRemoved: false });
    for (const p of res.body.payments) expect(p.stayId).toBe(stayId);
  });

  it('is owner-scoped', async () => {
    const ownerA = await signup('ha@example.com');
    const ownerB = await signup('hb@example.com');
    const { residentId } = await setup(ownerA);

    const res = await request(app).get(`/api/residents/${residentId}/history`).set(ownerB);
    expect(res.status).toBe(404);
  });
});

describe('Resident search status', () => {
  it('labels staying vs moved-out and lists current residents first', async () => {
    const auth = await signup('status@example.com');
    const past = await setup(auth, '9700000001');
    await request(app).put(`/api/stays/${past.stayId}/checkout`).set(auth).send({ checkOutDate: '2026-03-01T00:00:00.000Z' });

    // A second resident ("Past Resident" too, so both match) currently staying.
    const room = await request(app)
      .post('/api/rooms')
      .set(auth)
      .send({ branchId: past.branchId, roomNumber: '102', floor: 1, bedCount: 1 });
    const bedId = (await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth)).body[0].id;
    const current = await request(app)
      .post('/api/residents')
      .set(auth)
      .send({ name: 'Past Resident Two', phone: '9700000002', kycType: 'Aadhaar', kycRef: 'P2' });
    await request(app).post('/api/stays').set(auth).send({
      residentId: current.body.id,
      bedId,
      checkInDate: '2026-04-01T00:00:00.000Z',
      monthlyRent: 800000,
      securityDeposit: 0,
    });

    const res = await request(app).get('/api/search/resident').query({ q: 'Past' }).set(auth);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['staying', 'moved_out']);
    expect(res.body.results[0].resident.id).toBe(current.body.id);
  });
});
