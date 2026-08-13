// src/tests/auth.test.ts
import request from 'supertest';
import app from '../index';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Increase Jest timeout for async DB operations
jest.setTimeout(20000);

let mongod: MongoMemoryServer;

// Use a separate test DB
const TEST_DB_URI = process.env.MONGODB_URI?.replace('pg_management', 'pg_management_test') || 'mongodb://localhost:27017/pg_management_test';

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

describe('Auth Routes', () => {
  const testUser = { name: 'Test User', email: 'test@example.com', password: 'Password123' };

  it('should register a new user', async () => {
    const res = await request(app).post('/api/auth/signup').send(testUser);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('token');
    expect(res.body.owner).toMatchObject({
      email: testUser.email,
      name: testUser.name,
      role: 'owner'
    });
  });

  it('should login an existing user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testUser.email, password: testUser.password });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.owner.email).toBe(testUser.email);
    expect(res.body.owner.role).toBe('owner');
  });

  it('should reject invalid credentials with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testUser.email, password: 'WrongPassword1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('self-registered users are not forced to reset their password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testUser.email, password: testUser.password });
    expect(res.body.owner.mustResetPassword).toBe(false);
  });
});

describe('Password reset', () => {
  it('lets an authenticated owner set a new password and clears the flag', async () => {
    const signup = await request(app).post('/api/auth/signup').send({
      name: 'Reset User',
      email: 'reset-user@example.com',
      password: 'OldPassword123',
    });
    const token = signup.body.token;

    const reset = await request(app)
      .put('/api/auth/reset-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword: 'NewPassword456' });

    expect(reset.status).toBe(200);
    expect(reset.body.owner.mustResetPassword).toBe(false);

    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'reset-user@example.com', password: 'OldPassword123' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'reset-user@example.com', password: 'NewPassword456' });
    expect(newLogin.status).toBe(200);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const signup = await request(app).post('/api/auth/signup').send({
      name: 'Short Pass User',
      email: 'short-pass@example.com',
      password: 'OldPassword123',
    });

    const res = await request(app)
      .put('/api/auth/reset-password')
      .set('Authorization', `Bearer ${signup.body.token}`)
      .send({ newPassword: 'short' });

    expect(res.status).toBe(400);
  });
});

describe('Account settings', () => {
  it('defaults defaultDepositPaise for a new owner', async () => {
    const signup = await request(app).post('/api/auth/signup').send({
      name: 'Settings User',
      email: 'settings-user@example.com',
      password: 'Password123',
    });
    expect(signup.body.owner.defaultDepositPaise).toBe(1700000);
  });

  it('lets an owner update their default deposit, reflected in /auth/me', async () => {
    const signup = await request(app).post('/api/auth/signup').send({
      name: 'Deposit User',
      email: 'deposit-user@example.com',
      password: 'Password123',
    });
    const token = signup.body.token;

    const update = await request(app)
      .put('/api/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ defaultDepositPaise: 2500000 });
    expect(update.status).toBe(200);
    expect(update.body.owner.defaultDepositPaise).toBe(2500000);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(me.body.owner.defaultDepositPaise).toBe(2500000);
  });

  it('rejects a negative or non-integer defaultDepositPaise', async () => {
    const signup = await request(app).post('/api/auth/signup').send({
      name: 'Bad Deposit User',
      email: 'bad-deposit-user@example.com',
      password: 'Password123',
    });
    const token = signup.body.token;

    const negative = await request(app)
      .put('/api/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ defaultDepositPaise: -100 });
    expect(negative.status).toBe(400);

    const nonInteger = await request(app)
      .put('/api/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ defaultDepositPaise: 100.5 });
    expect(nonInteger.status).toBe(400);
  });

  it('defaults defaultRentPaise for a new owner and lets it be updated independently', async () => {
    const signup = await request(app).post('/api/auth/signup').send({
      name: 'Rent User',
      email: 'rent-user@example.com',
      password: 'Password123',
    });
    expect(signup.body.owner.defaultRentPaise).toBe(850000);
    const token = signup.body.token;

    const update = await request(app)
      .put('/api/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ defaultRentPaise: 950000 });
    expect(update.status).toBe(200);
    expect(update.body.owner.defaultRentPaise).toBe(950000);
    expect(update.body.owner.defaultDepositPaise).toBe(1700000);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(me.body.owner.defaultRentPaise).toBe(950000);
  });

  it('rejects a negative or non-integer defaultRentPaise, and an empty body', async () => {
    const signup = await request(app).post('/api/auth/signup').send({
      name: 'Bad Rent User',
      email: 'bad-rent-user@example.com',
      password: 'Password123',
    });
    const token = signup.body.token;

    const negative = await request(app)
      .put('/api/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ defaultRentPaise: -100 });
    expect(negative.status).toBe(400);

    const empty = await request(app)
      .put('/api/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(empty.status).toBe(400);
  });
});
