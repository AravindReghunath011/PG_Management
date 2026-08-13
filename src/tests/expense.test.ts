import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';
import { Owner } from '../modules/auth/owner.model';
import { Expense } from '../modules/expenses/expense.model';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;
let token: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_expense_test' });
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([Owner.deleteMany({}), Expense.deleteMany({})]);

  const signup = await request(app).post('/api/auth/signup').send({
    name: 'Expense Owner',
    email: 'expense-owner@example.com',
    password: 'password123',
  });
  token = signup.body.token;
});

describe('Expenses CRUD', () => {
  it('creates an expense with required fields', async () => {
    const res = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'electricity', amount: 500000, date: '2026-08-01T00:00:00.000Z' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      category: 'electricity',
      amount: 500000,
      branchId: null,
    });
  });

  it('rejects an invalid category', async () => {
    const res = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'rent', amount: 500000, date: '2026-08-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-positive amount', async () => {
    const res = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'cleaning', amount: 0, date: '2026-08-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
  });

  it('lists expenses filtered by date range and category', async () => {
    await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'electricity', amount: 300000, date: '2026-08-05T00:00:00.000Z' });
    await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'cleaning', amount: 100000, date: '2026-08-10T00:00:00.000Z' });
    await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'electricity', amount: 200000, date: '2026-09-01T00:00:00.000Z' });

    const augustOnly = await request(app)
      .get('/api/expenses')
      .query({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' })
      .set('Authorization', `Bearer ${token}`);
    expect(augustOnly.body).toHaveLength(2);

    const electricityOnly = await request(app)
      .get('/api/expenses')
      .query({ category: 'electricity' })
      .set('Authorization', `Bearer ${token}`);
    expect(electricityOnly.body).toHaveLength(2);
  });

  it('updates and soft-deletes an expense', async () => {
    const created = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'maintenance', amount: 150000, date: '2026-08-01T00:00:00.000Z' });

    const updated = await request(app)
      .put(`/api/expenses/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 175000, notes: 'plumber' });
    expect(updated.status).toBe(200);
    expect(updated.body.amount).toBe(175000);
    expect(updated.body.notes).toBe('plumber');

    const deleted = await request(app)
      .delete(`/api/expenses/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(deleted.status).toBe(200);

    const list = await request(app)
      .get('/api/expenses')
      .set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(0);
  });

  it("prevents owner B from seeing or modifying owner A's expenses", async () => {
    const created = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'salaries', amount: 900000, date: '2026-08-01T00:00:00.000Z' });

    const ownerB = await request(app).post('/api/auth/signup').send({
      name: 'Owner B',
      email: 'expense-owner-b@example.com',
      password: 'password123',
    });

    const list = await request(app)
      .get('/api/expenses')
      .set('Authorization', `Bearer ${ownerB.body.token}`);
    expect(list.body).toHaveLength(0);

    const update = await request(app)
      .put(`/api/expenses/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerB.body.token}`)
      .send({ amount: 1 });
    expect(update.status).toBe(404);
  });
});
