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

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_search_test' });
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
});

describe('Resident search — full stay history', () => {
  it('returns every past and current stay with bed/branch labels, newest first', async () => {
    const signup = await request(app).post('/api/auth/signup').send({
      name: 'Search Owner',
      email: 'search-owner@example.com',
      password: 'password123',
    });
    const token = signup.body.token;

    const branch = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main', address: 'Addr' });

    const roomA = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 1 });
    const roomB = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: branch.body.id, roomNumber: '102', floor: 1, bedCount: 1 });

    const bedA = (
      await request(app)
        .get(`/api/beds?roomId=${roomA.body.id}`)
        .set('Authorization', `Bearer ${token}`)
    ).body[0].id;
    const bedB = (
      await request(app)
        .get(`/api/beds?roomId=${roomB.body.id}`)
        .set('Authorization', `Bearer ${token}`)
    ).body[0].id;

    const resident = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'History Resident', phone: '9700000001', kycType: 'Aadhaar', kycRef: 'H1' });

    // First stay: room A, later checked out.
    const stay1 = await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${token}`)
      .send({
        residentId: resident.body.id,
        bedId: bedA,
        checkInDate: '2026-01-01T00:00:00.000Z',
        monthlyRent: 800000,
        securityDeposit: 1600000,
      });
    await request(app)
      .put(`/api/stays/${stay1.body.id}/checkout`)
      .set('Authorization', `Bearer ${token}`)
      .send({ checkOutDate: '2026-03-01T00:00:00.000Z' });

    // Second, current stay: room B.
    await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${token}`)
      .send({
        residentId: resident.body.id,
        bedId: bedB,
        checkInDate: '2026-04-01T00:00:00.000Z',
        monthlyRent: 900000,
        securityDeposit: 1800000,
      });

    const res = await request(app)
      .get('/api/search/resident')
      .query({ q: 'History' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const stays = res.body.results[0].stays;
    expect(stays).toHaveLength(2);

    // Newest first.
    expect(stays[0].bedLabel).toBe('102-A');
    expect(stays[0].branchName).toBe('Main');
    expect(stays[0].checkOutDate).toBeNull();

    expect(stays[1].bedLabel).toBe('101-A');
    expect(stays[1].checkInDate).toBe('2026-01-01T00:00:00.000Z');
    expect(stays[1].checkOutDate).toBe('2026-03-01T00:00:00.000Z');
  });
});
