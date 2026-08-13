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
let ownerId: string;
let branchId: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_rooms_test' });
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

  const signup = await request(app).post('/api/auth/signup').send({
    name: 'Room Owner',
    email: 'room-owner@example.com',
    password: 'password123',
  });
  token = signup.body.token;
  ownerId = signup.body.owner.id;

  const branch = await request(app)
    .post('/api/branches')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Test Branch', address: '123 Test St' });
  branchId = branch.body.id;
});

describe('Room & Bed APIs', () => {
  it('creates a room with initial beds and returns UI stats', async () => {
    const res = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        branchId,
        roomNumber: ' 101 ',
        floor: 1,
        bedCount: 3,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      branchId,
      roomNumber: '101',
      floor: 1,
      type: 'Triple Sharing',
      totalBeds: 3,
      occupiedBeds: 0,
    });
    expect(res.body.id).toBeTruthy();

    const beds = await request(app)
      .get(`/api/beds?roomId=${res.body.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(beds.status).toBe(200);
    expect(beds.body).toHaveLength(3);
    expect(beds.body.map((b: { bedNumber: string }) => b.bedNumber)).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('lists rooms filtered by branch with occupancy', async () => {
    const room = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId, roomNumber: '201', floor: 2, bedCount: 2 });

    await Bed.updateOne(
      { roomId: room.body.id, bedNumber: 'A' },
      { status: 'occupied' }
    );

    const res = await request(app)
      .get(`/api/rooms?branchId=${branchId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      roomNumber: '201',
      floor: 2,
      totalBeds: 2,
      occupiedBeds: 1,
      type: 'Double Sharing',
    });
  });

  it('lists beds with resident occupancy details', async () => {
    const room = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId, roomNumber: '301', floor: 3, bedCount: 1 });

    const bedId = (
      await Bed.findOne({ roomId: room.body.id, bedNumber: 'A' })
    )?._id as string;

    await Resident.create({
      _id: 'res-1',
      ownerId,
      name: 'Rahul Sharma',
      phone: '9876543210',
      kycType: 'Aadhaar',
      kycRef: 'XXXX',
    });

    await Stay.create({
      _id: 'stay-1',
      ownerId,
      residentId: 'res-1',
      bedId,
      checkInDate: new Date('2025-03-15'),
      checkOutDate: null,
      monthlyRent: 850000,
      securityDeposit: 1000000,
    });

    await Bed.updateOne({ _id: bedId }, { status: 'occupied' });

    const res = await request(app)
      .get(`/api/beds?roomId=${room.body.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      bedNumber: 'A',
      status: 'occupied',
      residentName: 'Rahul Sharma',
      residentPhone: '9876543210',
      monthlyRent: 850000,
      checkInDate: '2025-03-15',
    });
  });

  it('creates a room with amenities and defaults to an empty list', async () => {
    const withAC = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId, roomNumber: '401', floor: 4, bedCount: 1, amenities: ['ac'] });
    expect(withAC.status).toBe(201);
    expect(withAC.body.amenities).toEqual(['ac']);

    const withoutAmenities = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId, roomNumber: '402', floor: 4, bedCount: 1 });
    expect(withoutAmenities.status).toBe(201);
    expect(withoutAmenities.body.amenities).toEqual([]);
  });

  it('updates room amenities', async () => {
    const room = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId, roomNumber: '403', floor: 4, bedCount: 1 });

    const updated = await request(app)
      .put(`/api/rooms/${room.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amenities: ['ac'] });

    expect(updated.status).toBe(200);
    expect(updated.body.amenities).toEqual(['ac']);
  });
});
