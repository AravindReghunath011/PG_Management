// Raising every current tenant's rent at once.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';
import { Stay } from '../modules/stays/stay.model';
import { Payment } from '../modules/payments/payment.model';
import { revisedRent } from '../modules/stays/rentRevision';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_rent_revision_test' });
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

const DAY = 86_400_000;

async function setup(email: string) {
  const signup = await request(app).post('/api/auth/signup').send({ name: 'Owner', email, password: 'password123' });
  const auth = { Authorization: `Bearer ${signup.body.token}` };
  const main = await request(app).post('/api/branches').set(auth).send({ name: 'Main', address: 'A' });
  const annex = await request(app).post('/api/branches').set(auth).send({ name: 'Annex', address: 'B' });
  const room = await request(app).post('/api/rooms').set(auth).send({ branchId: main.body.id, roomNumber: '101', floor: 1, bedCount: 3 });
  const annexRoom = await request(app).post('/api/rooms').set(auth).send({ branchId: annex.body.id, roomNumber: '201', floor: 2, bedCount: 1 });
  const beds = (await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth)).body.map((b: any) => b.id);
  const annexBed = (await request(app).get(`/api/beds?roomId=${annexRoom.body.id}`).set(auth)).body[0].id;
  return { auth, mainId: main.body.id as string, beds: beds as string[], annexBed: annexBed as string };
}

async function checkIn(auth: Record<string, string>, bedId: string, phone: string, rent: number) {
  const r = await request(app).post('/api/residents').set(auth).send({ name: `T${phone.slice(-2)}`, phone, kycType: 'Aadhaar', kycRef: phone });
  const s = await request(app)
    .post('/api/stays')
    .set(auth)
    .send({ residentId: r.body.id, bedId, checkInDate: new Date(Date.now() - 40 * DAY).toISOString(), monthlyRent: rent, securityDeposit: 0 });
  return s.body.id as string;
}

const revise = (auth: Record<string, string>, body: Record<string, unknown>) =>
  request(app).post('/api/stays/rent-revision').set(auth).send(body);

const rentOf = async (stayId: string) => (await Stay.findById(stayId).lean())!.monthlyRent;

describe('POST /api/stays/rent-revision', () => {
  it('rounds the new rent', () => {
    expect(revisedRent(853300, 'percent', 10, 10)).toBe(939000); // ₹9,386.30 → nearest ₹10 = ₹9,390
    expect(revisedRent(853300, 'percent', 10, 1)).toBe(938600); // nearest ₹1 = ₹9,386
    expect(revisedRent(800000, 'amount', 50000, 100)).toBe(850000);
  });

  it('previews without changing anything, then raises everyone but those on notice', async () => {
    const { auth, beds, annexBed } = await setup('rr1@example.com');
    const a = await checkIn(auth, beds[0], '9000000001', 800000);
    const b = await checkIn(auth, beds[1], '9000000002', 750000);
    const c = await checkIn(auth, annexBed, '9000000003', 600000);
    await request(app).put(`/api/stays/${b}/notice`).set(auth).send({ moveOutDate: new Date(Date.now() + 20 * DAY).toISOString() });
    const duesBefore = await Payment.find({}).select('rentDue').lean();

    const preview = await revise(auth, { mode: 'percent', value: 5, preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ applied: false, changedCount: 2 });
    const rowB = preview.body.rows.find((r: any) => r.stayId === b);
    expect(rowB).toMatchObject({ skipped: 'on_notice', oldRent: 750000, newRent: 750000 });
    expect(preview.body.rows.find((r: any) => r.stayId === a)).toMatchObject({ oldRent: 800000, newRent: 840000, residentName: 'T01' });
    expect(await rentOf(a)).toBe(800000);

    const applied = await revise(auth, { mode: 'percent', value: 5 });
    expect(applied.body).toMatchObject({ applied: true, changedCount: 2, totalBefore: 2150000, totalAfter: 2220000 });
    expect(await rentOf(a)).toBe(840000);
    expect(await rentOf(b)).toBe(750000);
    expect(await rentOf(c)).toBe(630000);

    // Dues already created keep their amount.
    const duesAfter = await Payment.find({}).select('rentDue').lean();
    expect(duesAfter.map((d) => d.rentDue).sort()).toEqual(duesBefore.map((d) => d.rentDue).sort());
  });

  it('adds a flat amount to one property, leaving out chosen tenants', async () => {
    const { auth, mainId, beds, annexBed } = await setup('rr2@example.com');
    const a = await checkIn(auth, beds[0], '9000000011', 800000);
    const b = await checkIn(auth, beds[1], '9000000012', 750000);
    const c = await checkIn(auth, annexBed, '9000000013', 600000);

    const res = await revise(auth, { mode: 'amount', value: 50000, branchId: mainId, excludeStayIds: [b], roundToRupees: 1 });
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.changedCount).toBe(1);
    expect(await rentOf(a)).toBe(850000);
    expect(await rentOf(b)).toBe(750000);
    expect(await rentOf(c)).toBe(600000);
  });

  it('can include tenants on notice when asked', async () => {
    const { auth, beds } = await setup('rr3@example.com');
    const a = await checkIn(auth, beds[0], '9000000021', 800000);
    await request(app).put(`/api/stays/${a}/notice`).set(auth).send({ moveOutDate: new Date(Date.now() + 20 * DAY).toISOString() });
    await revise(auth, { mode: 'amount', value: 20000, includeOnNotice: true });
    expect(await rentOf(a)).toBe(820000);
  });

  it('rejects bad input', async () => {
    const { auth } = await setup('rr4@example.com');
    for (const body of [
      { mode: 'percent', value: 0 },
      { mode: 'percent', value: 150 },
      { mode: 'amount', value: -100 },
      { mode: 'double', value: 5 },
      { mode: 'percent', value: 5, roundToRupees: 7 },
    ]) {
      expect((await revise(auth, body)).status).toBe(400);
    }
  });

  it('never touches another owner’s tenants', async () => {
    const a = await setup('rr5a@example.com');
    const b = await setup('rr5b@example.com');
    const theirs = await checkIn(b.auth, b.beds[0], '9000000031', 700000);
    await checkIn(a.auth, a.beds[0], '9000000032', 700000);

    expect((await revise(a.auth, { mode: 'percent', value: 10, branchId: b.mainId })).status).toBe(404);
    const res = await revise(a.auth, { mode: 'percent', value: 10, excludeStayIds: [] });
    expect(res.body.rows).toHaveLength(1);
    expect(await rentOf(theirs)).toBe(700000);
  });
});
