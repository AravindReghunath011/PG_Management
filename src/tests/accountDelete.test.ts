import request from 'supertest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { v4 as uuidv4 } from 'uuid';
import app from '../index';
import { Owner } from '../modules/auth/owner.model';
import { Branch } from '../modules/branches/branch.model';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;
let tokenA: string;
let tokenB: string;
let ownerA: string;
let ownerB: string;

const PASSWORD = 'password123';
const EMAIL_A = 'delete-a@example.com';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_account_delete_test' });
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([Owner.deleteMany({}), Branch.deleteMany({})]);
  const a = await request(app).post('/api/auth/signup').send({ name: 'A', email: EMAIL_A, password: PASSWORD });
  const b = await request(app).post('/api/auth/signup').send({ name: 'B', email: 'delete-b@example.com', password: PASSWORD });
  tokenA = a.body.token;
  tokenB = b.body.token;
  ownerA = a.body.owner.id;
  ownerB = b.body.owner.id;
});

const deleteAccount = (auth: string) => request(app).delete('/api/auth/account').set('Authorization', `Bearer ${auth}`);

describe('DELETE /api/auth/account', () => {
  it('requires authentication', async () => {
    const res = await request(app).delete('/api/auth/account');
    expect(res.status).toBe(401);
  });

  it('makes the owner inactive and keeps their records', async () => {
    await Branch.create({ _id: uuidv4(), ownerId: ownerA, name: 'Main', address: 'Street 1' });

    const res = await deleteAccount(tokenA);
    expect(res.status).toBe(200);

    expect((await Owner.findById(ownerA).lean())?.isActive).toBe(false);
    expect(await Branch.countDocuments({ ownerId: ownerA, deletedAt: null })).toBe(1);
  });

  it('rejects the existing token and any new sign-in', async () => {
    await deleteAccount(tokenA);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenA}`);
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('ACCOUNT_DEACTIVATED');

    const login = await request(app).post('/api/auth/login').send({ email: EMAIL_A, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('leaves other owners untouched', async () => {
    await deleteAccount(tokenA);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenB}`);
    expect(me.status).toBe(200);
    expect(me.body.owner.id).toBe(ownerB);
  });

  it('refuses to delete a superadmin', async () => {
    const email = 'delete-admin@example.com';
    await new Owner({
      _id: uuidv4(),
      name: 'Admin',
      email,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      role: 'superadmin',
    }).save();
    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });

    const res = await deleteAccount(login.body.token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
