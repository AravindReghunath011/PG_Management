// src/tests/integration.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import app from '../index';
import { Owner } from '../modules/auth/owner.model';
import { Branch } from '../modules/branches/branch.model';
import { Room } from '../modules/rooms/room.model';
import { Bed } from '../modules/beds/bed.model';
import { Resident } from '../modules/residents/resident.model';
import { Stay } from '../modules/stays/stay.model';
import { Payment } from '../modules/payments/payment.model';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Increase Jest timeout for async DB operations
jest.setTimeout(30000);

let mongod: MongoMemoryServer;

describe('PG Management Platform Integration Tests', () => {
  let ownerAToken: string;
  let ownerBToken: string;
  let ownerAId: string;
  let ownerBId: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    await mongoose.connect(uri, { dbName: 'pg_management_test' });
  });

  afterAll(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await Owner.deleteMany({});
    await Branch.deleteMany({});
    await Room.deleteMany({});
    await Bed.deleteMany({});
    await Resident.deleteMany({});
    await Stay.deleteMany({});
    await Payment.deleteMany({});

    // Create two test owners
    const ownerARes = await request(app)
      .post('/api/auth/signup')
      .send({ name: 'Owner A', email: 'ownerA@example.com', password: 'password123' });
    ownerAToken = ownerARes.body.token;
    ownerAId = ownerARes.body.owner.id;

    const ownerBRes = await request(app)
      .post('/api/auth/signup')
      .send({ name: 'Owner B', email: 'ownerB@example.com', password: 'password123' });
    ownerBToken = ownerBRes.body.token;
    ownerBId = ownerBRes.body.owner.id;
  });

  // Owner isolation test
  test("Owner isolation: Owner A cannot read Owner B's data", async () => {
    const branchBId = 'branch-b-uuid';
    await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${ownerBToken}`)
      .send({ id: branchBId, name: 'Owner B Branch', address: '456 Elm St' });

    const res = await request(app)
      .get('/api/branches')
      .set('Authorization', `Bearer ${ownerAToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  // Owner spoofing test
  test("Owner isolation: Owner A cannot update or write spoofed ownerId", async () => {
    const res = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ id: 'branch-a-uuid', name: 'Downtown PG', address: '123 Main St', ownerId: ownerBId });

    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(ownerAId);
  });

  // Double occupancy test
  test('Double occupancy prevention: Cannot check in two residents to the same bed simultaneously', async () => {
    const branch = await new Branch({ _id: 'b1', ownerId: ownerAId, name: 'B1', address: 'Addy' }).save();
    const room = await new Room({ _id: 'r1', ownerId: ownerAId, branchId: branch._id, roomNumber: '101', floor: 1 }).save();
    const bed = await new Bed({ _id: 'bed1', ownerId: ownerAId, roomId: room._id, bedNumber: '101-A', status: 'vacant' }).save();

    const resident1 = await new Resident({ _id: 'res1', ownerId: ownerAId, name: 'Res One', phone: '9999999991', kycType: 'Aadhaar', kycRef: '123' }).save();
    const resident2 = await new Resident({ _id: 'res2', ownerId: ownerAId, name: 'Res Two', phone: '9999999992', kycType: 'Aadhaar', kycRef: '456' }).save();

    const checkin1 = await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({
        id: 'stay1',
        residentId: resident1._id,
        bedId: bed._id,
        checkInDate: '2026-05-01T00:00:00.000Z',
        monthlyRent: 800000,
        securityDeposit: 1500000
      });
    expect(checkin1.status).toBe(201);

    const bedUpdated = await Bed.findById(bed._id);
    expect(bedUpdated?.status).toBe('occupied');

    const checkin2 = await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({
        id: 'stay2',
        residentId: resident2._id,
        bedId: bed._id,
        checkInDate: '2026-05-02T00:00:00.000Z',
        monthlyRent: 900000,
        securityDeposit: 1500000
      });
    expect(checkin2.status).toBe(400);
    expect(checkin2.body.error.code).toBe('BED_OCCUPIED');
  });

  // Historical retrieval test
  test('Historical Retrieval: Retrieve who stayed in which bed on any past date', async () => {
    const branch = await new Branch({ _id: 'b1', ownerId: ownerAId, name: 'B1', address: 'Addy' }).save();
    const room = await new Room({ _id: 'r1', ownerId: ownerAId, branchId: branch._id, roomNumber: '101', floor: 1 }).save();
    const bed = await new Bed({ _id: 'bed1', ownerId: ownerAId, roomId: room._id, bedNumber: '101-A' }).save();

    const res1 = await new Resident({ _id: 'res1', ownerId: ownerAId, name: 'Albus Dumbledore', phone: '9999900001', kycType: 'Passport', kycRef: 'P123' }).save();
    const stay1 = await new Stay({
      _id: 'stay1',
      ownerId: ownerAId,
      residentId: res1._id,
      bedId: bed._id,
      checkInDate: new Date('2026-05-01T00:00:00.000Z'),
      checkOutDate: new Date('2026-05-10T00:00:00.000Z'),
      monthlyRent: 1000000,
      securityDeposit: 2000000
    }).save();

    const pay1 = await new Payment({
      _id: 'pay1',
      ownerId: ownerAId,
      stayId: stay1._id,
      residentId: res1._id,
      dueDate: new Date('2026-05-02T00:00:00.000Z'),
      rentDue: 1000000,
      rentPaid: 1000000
    }).save();

    const historyRes = await request(app)
      .get('/api/search/bed-history')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .query({ bedId: bed._id, date: '2026-05-05T12:00:00.000Z' });

    expect(historyRes.status).toBe(200);
    expect(historyRes.body.stay.id).toBe(stay1._id);
    expect(historyRes.body.resident.name).toBe('Albus Dumbledore');
    expect(historyRes.body.payments[0].id).toBe(pay1._id);
    expect(historyRes.body.payments[0].status).toBe('paid');

    const vacantRes = await request(app)
      .get('/api/search/bed-history')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .query({ bedId: bed._id, date: '2026-05-15T12:00:00.000Z' });

    expect(vacantRes.status).toBe(200);
    expect(vacantRes.body.stay).toBeNull();
    expect(vacantRes.body.resident).toBeNull();
  });

  // Superadmin visibility test
  test('Superadmin sees data across all owners; regular owners still only see their own', async () => {
    await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${ownerAToken}`)
      .send({ id: 'branch-a', name: 'Owner A Branch', address: '1 A St' });

    await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${ownerBToken}`)
      .send({ id: 'branch-b', name: 'Owner B Branch', address: '1 B St' });

    const passwordHash = await bcrypt.hash('superpassword123', 10);
    await new Owner({
      _id: uuidv4(),
      name: 'Super Admin',
      email: 'super@example.com',
      passwordHash,
      role: 'superadmin',
    }).save();

    const superLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'super@example.com', password: 'superpassword123' });
    expect(superLogin.status).toBe(200);
    const superToken = superLogin.body.token;

    const superRes = await request(app)
      .get('/api/branches')
      .set('Authorization', `Bearer ${superToken}`);
    expect(superRes.status).toBe(200);
    expect(superRes.body.map((b: any) => b.id).sort()).toEqual(['branch-a', 'branch-b']);

    // Owner isolation still holds for non-superadmin logins
    const ownerARes = await request(app)
      .get('/api/branches')
      .set('Authorization', `Bearer ${ownerAToken}`);
    expect(ownerARes.status).toBe(200);
    expect(ownerARes.body.map((b: any) => b.id)).toEqual(['branch-a']);
  });
});
