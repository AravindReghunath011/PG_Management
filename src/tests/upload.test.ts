// src/tests/upload.test.ts
// Real R2 credentials are never used in tests — the S3 client is mocked at
// the SDK level via aws-sdk-client-mock, so no network calls to R2 occur.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import app from '../index';
import { r2Client } from '../lib/r2Client';
import { Resident } from '../modules/residents/resident.model';
import { Branch } from '../modules/branches/branch.model';
import { Room } from '../modules/rooms/room.model';
import { Bed } from '../modules/beds/bed.model';

jest.setTimeout(20000);

let mongod: MongoMemoryServer;
const s3Mock = mockClient(r2Client as unknown as S3Client);

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

beforeEach(() => {
  s3Mock.reset();
});

describe('KYC Upload (R2)', () => {
  let token: string;
  let ownerId: string;
  let residentId: string;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const signup = await request(app)
      .post('/api/auth/signup')
      .send({ name: 'Upload Owner', email: `upload-${unique}@example.com`, password: 'password123' });
    token = signup.body.token;
    ownerId = signup.body.owner.id;

    const branch = await new Branch({ _id: `ub-${unique}`, ownerId, name: 'B1', address: 'Addy' }).save();
    const room = await new Room({ _id: `ur-${unique}`, ownerId, branchId: branch._id, roomNumber: '1', floor: 1 }).save();
    await new Bed({ _id: `ubed-${unique}`, ownerId, roomId: room._id, bedNumber: 'A', status: 'vacant' }).save();
    const resident = await new Resident({
      _id: `ures-${unique}`,
      ownerId,
      name: 'Test Resident',
      phone: '9999999999',
      kycType: 'Aadhaar',
      kycRef: '1234',
    }).save();
    residentId = resident._id;
  });

  it('uploads a KYC image to R2 and stores the public URL on the resident', async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const res = await request(app)
      .post('/api/uploads/kyc')
      .set('Authorization', `Bearer ${token}`)
      .field('residentId', residentId)
      .attach('file', Buffer.from('fake-image-bytes'), 'test.jpg');

    expect(res.status).toBe(200);
    expect(res.body.residentId).toBe(residentId);
    expect(res.body.kycImageUrl).toContain(`kyc/${residentId}.jpg`);

    const updated = await Resident.findById(residentId);
    expect(updated?.kycImageUrl).toBe(res.body.kycImageUrl);
  });

  it('returns a graceful error and leaves the resident unchanged when R2 upload fails', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('R2 down'));

    const res = await request(app)
      .post('/api/uploads/kyc')
      .set('Authorization', `Bearer ${token}`)
      .field('residentId', residentId)
      .attach('file', Buffer.from('fake-image-bytes'), 'test.jpg');

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('R2_UPLOAD_FAILED');

    const unchanged = await Resident.findById(residentId);
    expect(unchanged?.kycImageUrl).toBeNull();
  });

  it('rejects a missing residentId with 400', async () => {
    const res = await request(app)
      .post('/api/uploads/kyc')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('fake-image-bytes'), 'test.jpg');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 404 for a resident that does not belong to the authenticated owner', async () => {
    const otherSignup = await request(app)
      .post('/api/auth/signup')
      .send({ name: 'Other Owner', email: `other-${Date.now()}@example.com`, password: 'password123' });

    const res = await request(app)
      .post('/api/uploads/kyc')
      .set('Authorization', `Bearer ${otherSignup.body.token}`)
      .field('residentId', residentId)
      .attach('file', Buffer.from('fake-image-bytes'), 'test.jpg');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
