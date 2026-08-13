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

jest.setTimeout(30000);

let mongod: MongoMemoryServer;
let token: string;
let bedId: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_checkin_test' });
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
  ]);

  const signup = await request(app).post('/api/auth/signup').send({
    name: 'Stay Owner',
    email: 'stay-owner@example.com',
    password: 'password123',
  });
  token = signup.body.token;

  const branch = await request(app)
    .post('/api/branches')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Main', address: 'Addr' });

  const room = await request(app)
    .post('/api/rooms')
    .set('Authorization', `Bearer ${token}`)
    .send({
      branchId: branch.body.id,
      roomNumber: '101',
      floor: 1,
      bedCount: 1,
    });

  const beds = await request(app)
    .get(`/api/beds?roomId=${room.body.id}`)
    .set('Authorization', `Bearer ${token}`);
  bedId = beds.body[0].id;
});

describe('Resident + Check-in APIs', () => {
  it('creates a resident and checks them into a vacant bed', async () => {
    const resident = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Rahul Sharma',
        phone: '9876543210',
        kycType: 'Aadhaar',
        kycRef: 'XXXX-1234',
        email: 'rahul@example.com',
      });

    expect(resident.status).toBe(201);
    expect(resident.body).toMatchObject({
      name: 'Rahul Sharma',
      phone: '9876543210',
      currentStayId: null,
    });

    const checkin = await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${token}`)
      .send({
        residentId: resident.body.id,
        bedId,
        checkInDate: '2026-07-01T00:00:00.000Z',
        monthlyRent: 850000,
        securityDeposit: 1700000,
      });

    expect(checkin.status).toBe(201);
    expect(checkin.body.monthlyRent).toBe(850000);

    const list = await request(app)
      .get('/api/residents')
      .set('Authorization', `Bearer ${token}`);

    expect(list.body[0]).toMatchObject({
      id: resident.body.id,
      bedLabel: '101-A',
      currentBranchName: 'Main',
    });

    const beds = await request(app)
      .get(`/api/beds?status=vacant`)
      .set('Authorization', `Bearer ${token}`);
    expect(beds.body).toHaveLength(0);
  });

  it('blocks second active stay for the same resident', async () => {
    const resident = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Amit',
        phone: '9111111111',
        kycType: 'Passport',
        kycRef: 'P1',
      });

    await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${token}`)
      .send({
        residentId: resident.body.id,
        bedId,
        checkInDate: '2026-07-01T00:00:00.000Z',
        monthlyRent: 100000,
        securityDeposit: 100000,
      });

    const room2 = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        branchId: (
          await request(app)
            .get('/api/branches')
            .set('Authorization', `Bearer ${token}`)
        ).body[0].id,
        roomNumber: '102',
        floor: 1,
        bedCount: 1,
      });
    const bed2 = (
      await request(app)
        .get(`/api/beds?roomId=${room2.body.id}`)
        .set('Authorization', `Bearer ${token}`)
    ).body[0].id;

    const second = await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${token}`)
      .send({
        residentId: resident.body.id,
        bedId: bed2,
        checkInDate: '2026-07-02T00:00:00.000Z',
        monthlyRent: 100000,
        securityDeposit: 100000,
      });

    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('RESIDENT_ACTIVE');
  });

  it('allows updating monthlyRent on an existing stay', async () => {
    const resident = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Priya',
        phone: '9222222222',
        kycType: 'Aadhaar',
        kycRef: 'A1',
      });

    const checkin = await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${token}`)
      .send({
        residentId: resident.body.id,
        bedId,
        checkInDate: '2026-07-01T00:00:00.000Z',
        monthlyRent: 850000,
        securityDeposit: 1700000,
      });

    const update = await request(app)
      .put(`/api/stays/${checkin.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ monthlyRent: 950000 });

    expect(update.status).toBe(200);
    expect(update.body.monthlyRent).toBe(950000);
    expect(update.body.securityDeposit).toBe(1700000); // unchanged

    const fetched = await request(app)
      .get(`/api/stays/${checkin.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(fetched.body.monthlyRent).toBe(950000);
  });

  it('rejects a negative monthlyRent on update', async () => {
    const resident = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Neg Test',
        phone: '9333333333',
        kycType: 'Aadhaar',
        kycRef: 'A2',
      });

    const checkin = await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${token}`)
      .send({
        residentId: resident.body.id,
        bedId,
        checkInDate: '2026-07-01T00:00:00.000Z',
        monthlyRent: 850000,
        securityDeposit: 1700000,
      });

    const update = await request(app)
      .put(`/api/stays/${checkin.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ monthlyRent: -100 });

    expect(update.status).toBe(400);
    expect(update.body.error.code).toBe('BAD_REQUEST');
  });

  it('defaults foodPreference to with_food and allows setting without_food', async () => {
    const defaulted = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Default Food', phone: '9444444444', kycType: 'Aadhaar', kycRef: 'F1' });
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.foodPreference).toBe('with_food');

    const withoutFood = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Without Food',
        phone: '9444444445',
        kycType: 'Aadhaar',
        kycRef: 'F2',
        foodPreference: 'without_food',
      });
    expect(withoutFood.status).toBe(201);
    expect(withoutFood.body.foodPreference).toBe('without_food');

    const updated = await request(app)
      .put(`/api/residents/${defaulted.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ foodPreference: 'without_food' });
    expect(updated.status).toBe(200);
    expect(updated.body.foodPreference).toBe('without_food');
  });

  it('rejects a name over 50 characters and a phone that is not exactly 10 digits', async () => {
    const longName = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'A'.repeat(51),
        phone: '9555555555',
        kycType: 'Aadhaar',
        kycRef: 'N1',
      });
    expect(longName.status).toBe(400);

    const shortPhone = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Short Phone', phone: '12345', kycType: 'Aadhaar', kycRef: 'N2' });
    expect(shortPhone.status).toBe(400);

    const nonNumericPhone = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad Phone', phone: '95555abcde', kycType: 'Aadhaar', kycRef: 'N3' });
    expect(nonNumericPhone.status).toBe(400);
  });
});
