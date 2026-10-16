// Reusable apply links: many people pick a bed and send a request; the owner
// approves (checks them in) or ignores each one.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import app from '../index';
import { r2Client } from '../lib/r2Client';
import { JoinRequest } from '../modules/joinRequests/joinRequest.model';
import { Owner } from '../modules/auth/owner.model';
import { Bed } from '../modules/beds/bed.model';
import { Resident } from '../modules/residents/resident.model';
import { Stay } from '../modules/stays/stay.model';

jest.setTimeout(30000);

const s3Mock = mockClient(r2Client as unknown as S3Client);
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_join_requests_test' });
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
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString();

async function setup(email: string) {
  const signup = await request(app).post('/api/auth/signup').send({ name: 'Owner', email, password: 'password123' });
  const auth = { Authorization: `Bearer ${signup.body.token}` };
  const main = await request(app).post('/api/branches').set(auth).send({ name: 'Balaji PG', address: 'A' });
  const annex = await request(app).post('/api/branches').set(auth).send({ name: 'Annex', address: 'B' });
  const room = await request(app)
    .post('/api/rooms')
    .set(auth)
    .send({ branchId: main.body.id, roomNumber: '101', floor: 1, bedCount: 2, rentPaise: 900000 });
  const annexRoom = await request(app)
    .post('/api/rooms')
    .set(auth)
    .send({ branchId: annex.body.id, roomNumber: '201', floor: 2, bedCount: 1 });
  const beds = (await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth)).body.map((b: any) => b.id);
  const annexBed = (await request(app).get(`/api/beds?roomId=${annexRoom.body.id}`).set(auth)).body[0].id;
  return { ownerId: signup.body.owner.id as string, auth, mainId: main.body.id, annexId: annex.body.id, beds: beds as string[], annexBed };
}

const tokenOf = (url: string) => url.split('/apply/')[1];

function apply(token: string, bedId: string, overrides: Record<string, string> = {}) {
  const fields = {
    name: 'Kiran Rao',
    phone: '9811111111',
    kycType: 'Aadhaar',
    kycRef: '111122223333',
    bedId,
    preferredCheckInDate: TOMORROW,
    ...overrides,
  };
  let req = request(app).post(`/api/public/join-links/${token}`);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('kycFront', JPG, 'id.jpg');
}

describe('apply links', () => {
  it('collects requests from many people without touching the owner’s data', async () => {
    const { auth, beds } = await setup('jr1@example.com');
    const link = await request(app).post('/api/join-links').set(auth).send({});
    expect(link.status).toBe(201);
    expect(link.body.url).toMatch(/\/apply\/[A-Za-z0-9_-]{32}$/);
    // Asking again returns the same link.
    const again = await request(app).post('/api/join-links').set(auth).send({});
    expect(again.status).toBe(200);
    expect(tokenOf(again.body.url)).toBe(tokenOf(link.body.url));
    const token = tokenOf(link.body.url);

    const page = await request(app).get(`/api/public/join-links/${token}`);
    expect(page.status).toBe(200);
    const main = page.body.branches.find((b: any) => b.name === 'Balaji PG');
    expect(main.rooms[0]).toMatchObject({ roomNumber: '101', isAc: false });
    expect(main.rooms[0].beds.map((b: any) => b.rentPaise)).toEqual([900000, 900000]);
    expect(page.body.ownerId).toBeUndefined();

    expect((await apply(token, beds[0])).status).toBe(201);
    expect((await apply(token, beds[0], { phone: '9822222222', name: 'Second' })).status).toBe(201);
    const dup = await apply(token, beds[1]);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_APPLIED');

    expect(await Resident.countDocuments({})).toBe(0);
    expect(await Stay.countDocuments({})).toBe(0);
    expect((await Bed.findById(beds[0]).lean())!.status).toBe('vacant');

    const pending = await request(app).get('/api/join-requests').set(auth);
    expect(pending.body).toHaveLength(2);
    expect(pending.body[0]).toMatchObject({ status: 'pending', roomNumber: '101', bedAvailable: true, bedRentPaise: 900000 });
  });

  it('checks a request in on approval, with the owner’s changes', async () => {
    const { auth, beds } = await setup('jr2@example.com');
    const token = tokenOf((await request(app).post('/api/join-links').set(auth).send({})).body.url);
    await apply(token, beds[0]);
    await apply(token, beds[0], { phone: '9822222222', name: 'Second' });
    const [second, first] = (await request(app).get('/api/join-requests').set(auth)).body;

    const ok = await request(app)
      .post(`/api/join-requests/${first.id}/approve`)
      .set(auth)
      .send({ monthlyRent: 850000, securityDeposit: 500000 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', residentId: first.id });

    const resident = await Resident.findById(first.id).lean();
    expect(resident).toMatchObject({ name: 'Kiran Rao', phone: '9811111111', deletedAt: null });
    expect(resident!.kycImageUrl).toContain(`kyc/${first.id}`);
    const stay = await Stay.findOne({ residentId: first.id }).lean();
    expect(stay).toMatchObject({ bedId: beds[0], monthlyRent: 850000, securityDeposit: 500000 });
    expect((await Bed.findById(beds[0]).lean())!.status).toBe('occupied');
    expect((await request(app).post(`/api/join-requests/${first.id}/approve`).set(auth).send({})).status).toBe(404);

    // The other person wanted the same bed: it's taken, so the owner picks another.
    const clash = await request(app).post(`/api/join-requests/${second.id}/approve`).set(auth).send({});
    expect(clash.status).toBe(409);
    expect((await JoinRequest.findById(second.id).lean())!.status).toBe('pending');
    const moved = await request(app).post(`/api/join-requests/${second.id}/approve`).set(auth).send({ bedId: beds[1] });
    expect(moved.status).toBe(200);
    expect((await Stay.findOne({ residentId: second.id }).lean())!.monthlyRent).toBe(900000); // bed rent by default

    // The tenants list shows both.
    const tenants = await request(app).get('/api/residents').set(auth);
    expect(tenants.body.map((r: any) => r.name).sort()).toEqual(['Kiran Rao', 'Second']);
  });

  it('ignores a request without creating anything', async () => {
    const { auth, beds } = await setup('jr3@example.com');
    const token = tokenOf((await request(app).post('/api/join-links').set(auth).send({})).body.url);
    await apply(token, beds[0]);
    const [req] = (await request(app).get('/api/join-requests').set(auth)).body;

    const res = await request(app).post(`/api/join-requests/${req.id}/reject`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(await Resident.countDocuments({})).toBe(0);
    expect((await request(app).get('/api/join-requests').set(auth)).body).toHaveLength(0);
    expect((await request(app).get('/api/join-requests?status=rejected').set(auth)).body).toHaveLength(1);
    expect((await request(app).post(`/api/join-requests/${req.id}/approve`).set(auth).send({})).status).toBe(404);
  });

  it('limits a property link to that property and stops working when turned off', async () => {
    const { auth, mainId, beds, annexBed } = await setup('jr4@example.com');
    const link = await request(app).post('/api/join-links').set(auth).send({ branchId: mainId });
    const token = tokenOf(link.body.url);

    const page = await request(app).get(`/api/public/join-links/${token}`);
    expect(page.body.branches.map((b: any) => b.name)).toEqual(['Balaji PG']);
    expect((await apply(token, annexBed)).status).toBe(400);

    await Bed.updateOne({ _id: beds[1] }, { status: 'occupied' });
    const taken = await apply(token, beds[1]);
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('BED_TAKEN');

    expect((await request(app).delete(`/api/join-links/${link.body.id}`).set(auth)).status).toBe(200);
    expect((await request(app).get(`/api/public/join-links/${token}`)).status).toBe(404);
    expect((await apply(token, beds[0])).status).toBe(404);
  });

  it('keeps links and requests owner-scoped, and off for unapproved owners', async () => {
    const a = await setup('jr5a@example.com');
    const b = await setup('jr5b@example.com');
    const token = tokenOf((await request(app).post('/api/join-links').set(a.auth).send({})).body.url);
    await apply(token, a.beds[0]);
    const [req] = (await request(app).get('/api/join-requests').set(a.auth)).body;

    expect((await request(app).get('/api/join-requests').set(b.auth)).body).toEqual([]);
    expect((await request(app).post(`/api/join-requests/${req.id}/approve`).set(b.auth).send({})).status).toBe(404);
    expect((await request(app).post(`/api/join-requests/${req.id}/reject`).set(b.auth)).status).toBe(404);
    expect((await request(app).post('/api/join-links').set(b.auth).send({ branchId: a.mainId })).status).toBe(404);
    // Owner B can't use A's link to book one of B's own beds.
    expect((await apply(token, b.beds[0], { phone: '9833333333' })).status).toBe(400);

    // A pending owner only counts as unapproved while approval is switched on.
    await Owner.updateOne({ _id: a.ownerId }, { accessStatus: 'pending' });
    expect((await request(app).get(`/api/public/join-links/${token}`)).status).toBe(200);
    process.env.OWNER_SIGNUP_REQUIRES_APPROVAL = 'true';
    try {
      expect((await request(app).get(`/api/public/join-links/${token}`)).status).toBe(404);
    } finally {
      process.env.OWNER_SIGNUP_REQUIRES_APPROVAL = 'false';
    }
    await Owner.updateOne({ _id: a.ownerId }, { accessStatus: 'rejected' });
    expect((await request(app).get(`/api/public/join-links/${token}`)).status).toBe(404);
  });

  it('serves the apply page with a locked-down CSP', async () => {
    const res = await request(app).get('/apply/some-token-value-123456');
    expect(res.status).toBe(200);
    const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers['content-security-policy'])![1];
    expect(res.text).toContain(`<script nonce="${nonce}">`);
    expect(res.text).not.toContain('__CSS__');
  });
});
