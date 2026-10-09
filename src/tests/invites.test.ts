// Self check-in links: one-time use, expiry, revoke, owner scoping.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import app from '../index';
import { r2Client } from '../lib/r2Client';
import { ResidentInvite } from '../modules/invites/invite.model';
import { Bed } from '../modules/beds/bed.model';
import { Resident } from '../modules/residents/resident.model';
import { Stay } from '../modules/stays/stay.model';

jest.setTimeout(30000);

const s3Mock = mockClient(r2Client as unknown as S3Client);
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_invites_test' });
  await ResidentInvite.syncIndexes();
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

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

async function createInvite(auth: Record<string, string>, bedId: string) {
  return request(app)
    .post('/api/invites')
    .set(auth)
    .send({ bedId, checkInDate: '2026-10-10T00:00:00.000Z', monthlyRent: 800000, securityDeposit: 1000000 });
}

const tokenOf = (url: string) => url.split('/join/')[1];

function submit(token: string, overrides: Record<string, string> = {}, withPhoto = true) {
  const fields = {
    name: 'Rahul Sharma',
    phone: '9876543210',
    kycType: 'Aadhaar',
    kycRef: '123412341234',
    guardianName: 'Suresh',
    guardianPhone: '9123456789',
    foodPreference: 'without_food',
    ...overrides,
  };
  let req = request(app).post(`/api/public/invites/${token}`);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  if (withPhoto) req = req.attach('photo', JPG, 'photo.jpg');
  return req.attach('kycFront', JPG, 'front.jpg');
}

describe('self check-in invites', () => {
  it('lets the resident check themselves in exactly once', async () => {
    const { auth, beds } = await setup('inv1@example.com');
    const created = await createInvite(auth, beds[0]);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'pending', roomNumber: '101', branchName: 'Balaji PG' });
    expect(created.body.url).toMatch(/\/join\/[A-Za-z0-9_-]{32}$/);
    const token = tokenOf(created.body.url);

    const details = await request(app).get(`/api/public/invites/${token}`);
    expect(details.status).toBe(200);
    expect(details.body).toMatchObject({ pgName: 'Balaji PG', roomNumber: '101', monthlyRent: 800000, bedAvailable: true });
    expect(details.body.ownerId).toBeUndefined();

    const done = await submit(token);
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ name: 'Rahul Sharma', roomNumber: '101' });

    const resident = await Resident.findOne({ phone: '9876543210' }).lean();
    expect(resident).toMatchObject({ name: 'Rahul Sharma', guardianName: 'Suresh', foodPreference: 'without_food' });
    expect(resident!.photoUrl).toContain('photos/');
    expect(resident!.kycImageUrl).toContain('kyc/');
    const stay = await Stay.findOne({ residentId: resident!._id }).lean();
    expect(stay).toMatchObject({ bedId: beds[0], monthlyRent: 800000, securityDeposit: 1000000, checkOutDate: null });
    expect((await Bed.findById(beds[0]).lean())!.status).toBe('occupied');

    // Second use and re-opening are refused.
    const again = await submit(token, { phone: '9000000000' });
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('INVITE_USED');
    expect((await request(app).get(`/api/public/invites/${token}`)).status).toBe(410);

    const list = await request(app).get('/api/invites').set(auth);
    expect(list.body[0]).toMatchObject({ status: 'used', residentName: 'Rahul Sharma' });
  });

  it('does not use up the link when the form is invalid', async () => {
    const { auth, beds } = await setup('inv2@example.com');
    const token = tokenOf((await createInvite(auth, beds[0])).body.url);

    expect((await submit(token, { phone: '123' })).status).toBe(400);
    expect((await submit(token, { kycRef: '' })).status).toBe(400);
    // The resident's photo is optional; one ID photo is enough.
    expect((await submit(token, {}, false)).status).toBe(201);
    const resident = await Resident.findOne({ phone: '9876543210' }).lean();
    expect(resident!.photoUrl).toBeNull();
    expect(resident!.kycImageUrl).toContain('kyc/');
  });

  it('accepts only one of two simultaneous submissions', async () => {
    const { auth, beds } = await setup('inv3@example.com');
    const token = tokenOf((await createInvite(auth, beds[0])).body.url);

    const results = await Promise.all([submit(token), submit(token, { phone: '9000000001' })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 410]);
    expect(await Stay.countDocuments({ bedId: beds[0] })).toBe(1);
  });

  it('refuses expired and cancelled links', async () => {
    const { auth, beds } = await setup('inv4@example.com');
    const expired = await createInvite(auth, beds[0]);
    await ResidentInvite.updateOne({ _id: expired.body.id }, { expiresAt: new Date(Date.now() - 1000) });
    const res = await request(app).get(`/api/public/invites/${tokenOf(expired.body.url)}`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('INVITE_EXPIRED');

    const cancelled = await createInvite(auth, beds[1]);
    expect((await request(app).delete(`/api/invites/${cancelled.body.id}`).set(auth)).status).toBe(200);
    expect((await submit(tokenOf(cancelled.body.url))).status).toBe(404);
    expect((await request(app).get('/api/public/invites/not-a-real-token-at-all')).status).toBe(404);
  });

  it('allows one open link per bed and none for an occupied bed', async () => {
    const { auth, beds } = await setup('inv5@example.com');
    expect((await createInvite(auth, beds[0])).status).toBe(201);
    const dup = await createInvite(auth, beds[0]);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('INVITE_EXISTS');

    await Bed.updateOne({ _id: beds[1] }, { status: 'occupied' });
    expect((await createInvite(auth, beds[1])).status).toBe(409);
  });

  it('tells the resident when the bed was taken meanwhile, and keeps the link usable', async () => {
    const { auth, beds } = await setup('inv6@example.com');
    const created = await createInvite(auth, beds[0]);
    const token = tokenOf(created.body.url);
    await Bed.updateOne({ _id: beds[0] }, { status: 'occupied' });

    const res = await submit(token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BED_TAKEN');
    expect(await Resident.countDocuments({ deletedAt: null })).toBe(0);
    expect((await ResidentInvite.findById(created.body.id).lean())!.usedAt).toBeNull();
  });

  it('keeps invites owner-scoped', async () => {
    const a = await setup('inv7a@example.com');
    const b = await setup('inv7b@example.com');
    const invite = await createInvite(a.auth, a.beds[0]);

    expect((await createInvite(b.auth, a.beds[1])).status).toBe(404);
    expect((await request(app).delete(`/api/invites/${invite.body.id}`).set(b.auth)).status).toBe(404);
    expect((await request(app).get('/api/invites').set(b.auth)).body).toEqual([]);
  });

  it('serves the join page with a locked-down CSP', async () => {
    const res = await request(app).get('/join/some-token-value-123456');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers['content-security-policy'])![1];
    expect(res.text).toContain(`<script nonce="${nonce}">`);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
