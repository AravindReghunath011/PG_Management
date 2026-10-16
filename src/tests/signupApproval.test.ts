// Self sign-up: with approval switched on, new owners wait for a superadmin
// before they see any data. It is off by default.
import request from 'supertest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';
import { Owner } from '../modules/auth/owner.model';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_signup_approval_test' });
});

afterAll(async () => {
  process.env.OWNER_SIGNUP_REQUIRES_APPROVAL = 'false';
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  process.env.OWNER_SIGNUP_REQUIRES_APPROVAL = 'true';
  await Owner.deleteMany({});
});

async function superAdminAuth() {
  await new Owner({
    _id: uuidv4(),
    name: 'Super Admin',
    email: 'root@example.com',
    passwordHash: await bcrypt.hash('superpass123', 10),
    role: 'superadmin',
  }).save();
  const login = await request(app).post('/api/auth/login').send({ email: 'root@example.com', password: 'superpass123' });
  return { Authorization: `Bearer ${login.body.token}` };
}

const signup = (email: string) =>
  request(app).post('/api/auth/signup').send({ name: 'New PG', email, password: 'password123' });

describe('owner sign-up without approval (default)', () => {
  it('gives a new owner full access straight away', async () => {
    delete process.env.OWNER_SIGNUP_REQUIRES_APPROVAL;
    const res = await signup('instant@example.com');
    expect(res.status).toBe(201);
    expect(res.body.owner.accessStatus).toBe('approved');
    expect((await request(app).get('/api/branches').set({ Authorization: `Bearer ${res.body.token}` })).status).toBe(200);
  });

  it('lets in an owner left pending from when approval was on, but not a rejected one', async () => {
    const pending = await signup('waiting@example.com');
    const rejected = await signup('refused@example.com');
    await Owner.updateOne({ _id: rejected.body.owner.id }, { accessStatus: 'rejected' });
    process.env.OWNER_SIGNUP_REQUIRES_APPROVAL = 'false';

    const login = await request(app).post('/api/auth/login').send({ email: 'waiting@example.com', password: 'password123' });
    expect(login.body.owner.accessStatus).toBe('approved');
    expect((await request(app).get('/api/branches').set({ Authorization: `Bearer ${pending.body.token}` })).status).toBe(200);
    const blocked = await request(app).get('/api/branches').set({ Authorization: `Bearer ${rejected.body.token}` });
    expect(blocked.body.error.code).toBe('ACCOUNT_REJECTED');
  });
});

describe('owner sign-up approval (switched on)', () => {
  it('lets a new owner sign in but see nothing until approved', async () => {
    const res = await signup('new@example.com');
    expect(res.status).toBe(201);
    expect(res.body.owner.accessStatus).toBe('pending');
    const auth = { Authorization: `Bearer ${res.body.token}` };

    const me = await request(app).get('/api/auth/me').set(auth);
    expect(me.status).toBe(200);
    expect(me.body.owner.accessStatus).toBe('pending');

    for (const path of ['/api/branches', '/api/dashboard/overview', '/api/residents', '/api/invites']) {
      const blocked = await request(app).get(path).set(auth);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('ACCOUNT_PENDING');
    }
    expect((await request(app).post('/api/branches').set(auth).send({ name: 'X', address: 'Y' })).status).toBe(403);

    const login = await request(app).post('/api/auth/login').send({ email: 'new@example.com', password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.owner.accessStatus).toBe('pending');
  });

  it('gives full access once a superadmin approves', async () => {
    const admin = await superAdminAuth();
    const res = await signup('approve@example.com');
    const auth = { Authorization: `Bearer ${res.body.token}` };

    const list = await request(app).get('/api/admin/owners').set(admin);
    expect(list.body.owners.find((o: any) => o.email === 'approve@example.com').accessStatus).toBe('pending');

    const approved = await request(app)
      .put(`/api/admin/owners/${res.body.owner.id}`)
      .set(admin)
      .send({ accessStatus: 'approved' });
    expect(approved.status).toBe(200);
    expect(approved.body.owner.accessStatus).toBe('approved');

    // The same token now works — no new sign-in needed.
    expect((await request(app).get('/api/branches').set(auth)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth)).body.owner.accessStatus).toBe('approved');
  });

  it('refuses sign-in after a rejection', async () => {
    const admin = await superAdminAuth();
    const res = await signup('reject@example.com');
    await request(app).put(`/api/admin/owners/${res.body.owner.id}`).set(admin).send({ accessStatus: 'rejected' });

    const login = await request(app).post('/api/auth/login').send({ email: 'reject@example.com', password: 'password123' });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('ACCOUNT_REJECTED');
    const blocked = await request(app).get('/api/branches').set({ Authorization: `Bearer ${res.body.token}` });
    expect(blocked.body.error.code).toBe('ACCOUNT_REJECTED');
  });

  it('only lets a superadmin change access', async () => {
    const res = await signup('self@example.com');
    const other = await signup('other@example.com');
    await Owner.updateOne({ _id: other.body.owner.id }, { accessStatus: 'approved' });
    const otherAuth = { Authorization: `Bearer ${other.body.token}` };

    const attempt = await request(app)
      .put(`/api/admin/owners/${res.body.owner.id}`)
      .set(otherAuth)
      .send({ accessStatus: 'approved' });
    expect(attempt.status).toBe(403);
    expect((await Owner.findById(res.body.owner.id).lean())!.accessStatus).toBe('pending');

    const admin = await superAdminAuth();
    const bad = await request(app).put(`/api/admin/owners/${res.body.owner.id}`).set(admin).send({ accessStatus: 'yes' });
    expect(bad.status).toBe(400);
  });

  it('keeps owners created before this feature, and admin-created owners, fully working', async () => {
    // A legacy document with no accessStatus field at all.
    const legacyId = uuidv4();
    await Owner.collection.insertOne({
      _id: legacyId as any,
      name: 'Legacy',
      email: 'legacy@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
      role: 'owner',
    });
    const legacy = await request(app).post('/api/auth/login').send({ email: 'legacy@example.com', password: 'password123' });
    expect(legacy.body.owner.accessStatus).toBe('approved');
    expect((await request(app).get('/api/branches').set({ Authorization: `Bearer ${legacy.body.token}` })).status).toBe(200);

    const admin = await superAdminAuth();
    const created = await request(app).post('/api/admin/owners').set(admin).send({ name: 'Paid PG', email: 'paid@example.com' });
    expect(created.status).toBe(201);
    expect((await Owner.findOne({ email: 'paid@example.com' }).lean())!.accessStatus).toBe('approved');
  });
});
