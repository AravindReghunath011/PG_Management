// The ID number (kycRef) is optional for now; the ID type is still required.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_kyc_optional_test' });
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function ownerAuth() {
  const signup = await request(app)
    .post('/api/auth/signup')
    .send({ name: 'Owner', email: 'kyc@example.com', password: 'password123' });
  return { Authorization: `Bearer ${signup.body.token}` };
}

describe('Optional ID number', () => {
  it('creates a resident without an ID number, and clears one that was given', async () => {
    const auth = await ownerAuth();

    const blank = await request(app)
      .post('/api/residents')
      .set(auth)
      .send({ name: 'No ID Yet', phone: '9100000001', kycType: 'Aadhaar' });
    expect(blank.status).toBe(201);
    expect(blank.body.kycRef).toBe('');

    const withId = await request(app)
      .post('/api/residents')
      .set(auth)
      .send({ name: 'Has ID', phone: '9100000002', kycType: 'Aadhaar', kycRef: '482988129021' });
    const cleared = await request(app).put(`/api/residents/${withId.body.id}`).set(auth).send({ kycRef: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.kycRef).toBe('');

    // The ID type is still required.
    const noType = await request(app).post('/api/residents').set(auth).send({ name: 'X', phone: '9100000003' });
    expect(noType.status).toBe(400);
  });
});
