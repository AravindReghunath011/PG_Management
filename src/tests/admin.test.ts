import request from 'supertest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';
import { Owner } from '../modules/auth/owner.model';
import { Branch } from '../modules/branches/branch.model';
import { Room } from '../modules/rooms/room.model';
import { Bed } from '../modules/beds/bed.model';
import { Resident } from '../modules/residents/resident.model';
import { Stay } from '../modules/stays/stay.model';
import { Payment } from '../modules/payments/payment.model';
import { PaymentTransaction } from '../modules/payments/paymentTransaction.model';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_admin_test' });
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
    PaymentTransaction.deleteMany({}),
  ]);
});

async function createSuperAdmin(): Promise<string> {
  const passwordHash = await bcrypt.hash('superpass123', 10);
  await new Owner({
    _id: uuidv4(),
    name: 'Super Admin',
    email: 'super-admin-test@example.com',
    passwordHash,
    role: 'superadmin',
  }).save();

  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'super-admin-test@example.com', password: 'superpass123' });
  return login.body.token;
}

describe('Admin owners endpoints', () => {
  it('rejects a regular owner (403)', async () => {
    const signup = await request(app).post('/api/auth/signup').send({
      name: 'Regular Owner',
      email: 'regular-owner@example.com',
      password: 'password123',
    });

    const res = await request(app)
      .get('/api/admin/owners')
      .set('Authorization', `Bearer ${signup.body.token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lists all owners with business-snapshot stats', async () => {
    const superToken = await createSuperAdmin();

    const ownerA = await request(app).post('/api/auth/signup').send({
      name: 'Owner A',
      email: 'owner-a-admin@example.com',
      password: 'password123',
    });
    const tokenA = ownerA.body.token;
    const ownerAId = ownerA.body.owner.id;

    const branch = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Main', address: 'Addr' });
    const room = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 2 });
    const beds = await request(app)
      .get(`/api/beds?roomId=${room.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    await Bed.updateOne({ _id: beds.body[0].id }, { status: 'occupied' });
    await Resident.create({
      _id: 'res-admin-1',
      ownerId: ownerAId,
      name: 'Res One',
      phone: '9111111111',
      kycType: 'Aadhaar',
      kycRef: '1',
    });

    const res = await request(app)
      .get('/api/admin/owners')
      .set('Authorization', `Bearer ${superToken}`);

    expect(res.status).toBe(200);
    const found = res.body.owners.find((o: any) => o.id === ownerAId);
    expect(found).toMatchObject({
      branchCount: 1,
      roomCount: 1,
      totalBeds: 2,
      occupiedBeds: 1,
      residentCount: 1,
      occupancyRate: 50,
    });
  });

  it('returns a single owner detail by id', async () => {
    const superToken = await createSuperAdmin();
    const ownerB = await request(app).post('/api/auth/signup').send({
      name: 'Owner B',
      email: 'owner-b-admin@example.com',
      password: 'password123',
    });

    const res = await request(app)
      .get(`/api/admin/owners/${ownerB.body.owner.id}`)
      .set('Authorization', `Bearer ${superToken}`);

    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({
      id: ownerB.body.owner.id,
      name: 'Owner B',
      email: 'owner-b-admin@example.com',
      branchCount: 0,
      residentCount: 0,
    });
  });

  it('returns 404 for a non-existent owner id', async () => {
    const superToken = await createSuperAdmin();
    const res = await request(app)
      .get('/api/admin/owners/does-not-exist')
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(404);
  });

  it('includes totalCollected (earnings) in owner stats', async () => {
    const superToken = await createSuperAdmin();

    const ownerC = await request(app).post('/api/auth/signup').send({
      name: 'Owner C',
      email: 'owner-c-admin@example.com',
      password: 'password123',
    });
    const tokenC = ownerC.body.token;
    const ownerCId = ownerC.body.owner.id;

    const branch = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${tokenC}`)
      .send({ name: 'Main', address: 'Addr' });
    const room = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${tokenC}`)
      .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 1 });
    const beds = await request(app)
      .get(`/api/beds?roomId=${room.body.id}`)
      .set('Authorization', `Bearer ${tokenC}`);
    const resident = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${tokenC}`)
      .send({ name: 'Earner Res', phone: '9222222222', kycType: 'Aadhaar', kycRef: 'E1' });
    const stay = await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${tokenC}`)
      .send({
        residentId: resident.body.id,
        bedId: beds.body[0].id,
        checkInDate: '2026-07-01T00:00:00.000Z',
        monthlyRent: 800000,
        securityDeposit: 1600000,
      });
    const due = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${tokenC}`)
      .send({ stayId: stay.body.id, dueDate: '2026-08-01T00:00:00.000Z', rentDue: 800000 });
    await request(app)
      .put(`/api/payments/${due.body.id}`)
      .set('Authorization', `Bearer ${tokenC}`)
      .send({ rentCollected: 800000, collectedAt: '2026-08-05T00:00:00.000Z' });

    const res = await request(app)
      .get(`/api/admin/owners/${ownerCId}`)
      .set('Authorization', `Bearer ${superToken}`);

    expect(res.status).toBe(200);
    expect(res.body.owner.totalCollected).toBe(800000);
  });
});

describe('Admin owner onboarding', () => {
  it('creates an owner with a generated temp password and forces a reset', async () => {
    const superToken = await createSuperAdmin();

    const res = await request(app)
      .post('/api/admin/owners')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ name: 'New Owner', email: 'new-owner@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.owner).toMatchObject({
      name: 'New Owner',
      email: 'new-owner@example.com',
      role: 'owner',
      mustResetPassword: true,
    });
    expect(typeof res.body.tempPassword).toBe('string');
    expect(res.body.tempPassword.length).toBeGreaterThanOrEqual(8);

    // The temp password actually works to log in, and the login response
    // flags that a reset is required.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'new-owner@example.com', password: res.body.tempPassword });
    expect(login.status).toBe(200);
    expect(login.body.owner.mustResetPassword).toBe(true);
  });

  it('rejects onboarding from a non-superadmin', async () => {
    const signup = await request(app).post('/api/auth/signup').send({
      name: 'Regular Owner 2',
      email: 'regular-owner-2@example.com',
      password: 'password123',
    });

    const res = await request(app)
      .post('/api/admin/owners')
      .set('Authorization', `Bearer ${signup.body.token}`)
      .send({ name: 'New Owner', email: 'blocked-owner@example.com' });

    expect(res.status).toBe(403);
  });

  it('rejects a duplicate email', async () => {
    const superToken = await createSuperAdmin();
    await request(app)
      .post('/api/admin/owners')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ name: 'First', email: 'dup-owner@example.com' });

    const res = await request(app)
      .post('/api/admin/owners')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ name: 'Second', email: 'dup-owner@example.com' });

    expect(res.status).toBe(400);
  });
});
