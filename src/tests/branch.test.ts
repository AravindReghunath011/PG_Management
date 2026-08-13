import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';
import { Owner } from '../modules/auth/owner.model';
import { Branch } from '../modules/branches/branch.model';
import { Room } from '../modules/rooms/room.model';
import { Bed } from '../modules/beds/bed.model';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;
let token: string;
let ownerId: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_branch_test' });
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

  const signup = await request(app).post('/api/auth/signup').send({
    name: 'Branch Owner',
    email: 'branch-owner@example.com',
    password: 'password123',
  });
  token = signup.body.token;
  ownerId = signup.body.owner.id;
});

describe('Branch APIs', () => {
  it('creates a branch with name and address', async () => {
    const res = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: '  Sunrise PG - Koramangala  ',
        address: '  123, 4th Cross, Bangalore  ',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Sunrise PG - Koramangala',
      address: '123, 4th Cross, Bangalore',
      ownerId,
      roomCount: 0,
      totalBeds: 0,
      occupiedBeds: 0,
    });
    expect(res.body.id).toBeTruthy();
    expect(res.body._id).toBe(res.body.id);
  });

  it('rejects create without required fields', async () => {
    const res = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Only name' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('lists branches with occupancy stats for the UI', async () => {
    const create = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${token}`)
      .send({
        id: 'branch-1',
        name: 'Sunrise PG - HSR',
        address: '45, Sector 2, HSR',
      });
    expect(create.status).toBe(201);

    await Room.create({
      _id: 'room-1',
      ownerId,
      branchId: 'branch-1',
      roomNumber: '101',
      floor: 1,
    });
    await Bed.create([
      {
        _id: 'bed-1',
        ownerId,
        roomId: 'room-1',
        bedNumber: 'A',
        status: 'occupied',
      },
      {
        _id: 'bed-2',
        ownerId,
        roomId: 'room-1',
        bedNumber: 'B',
        status: 'vacant',
      },
    ]);

    const res = await request(app)
      .get('/api/branches')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: 'branch-1',
      name: 'Sunrise PG - HSR',
      address: '45, Sector 2, HSR',
      roomCount: 1,
      totalBeds: 2,
      occupiedBeds: 1,
    });
  });

  it('updates and soft-deletes a branch', async () => {
    const created = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Old Name', address: 'Old Address' });

    const id = created.body.id;

    const updated = await request(app)
      .put(`/api/branches/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name', address: 'New Address' });

    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('New Name');
    expect(updated.body.address).toBe('New Address');

    const deleted = await request(app)
      .delete(`/api/branches/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(deleted.status).toBe(200);
    expect(deleted.body.success).toBe(true);

    const list = await request(app)
      .get('/api/branches')
      .set('Authorization', `Bearer ${token}`);

    expect(list.body).toHaveLength(0);
  });
});
