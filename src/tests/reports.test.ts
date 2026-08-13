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
import { Payment } from '../modules/payments/payment.model';
import { PaymentTransaction } from '../modules/payments/paymentTransaction.model';
import { Expense } from '../modules/expenses/expense.model';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_reports_test' });
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
    Expense.deleteMany({}),
  ]);
});

async function setupOwnerWithBed(email: string) {
  const signup = await request(app).post('/api/auth/signup').send({
    name: 'Reports Owner',
    email,
    password: 'password123',
  });
  const token = signup.body.token;

  const branch = await request(app)
    .post('/api/branches')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Main', address: 'Addr' });

  const room = await request(app)
    .post('/api/rooms')
    .set('Authorization', `Bearer ${token}`)
    .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 3 });

  const beds = await request(app)
    .get(`/api/beds?roomId=${room.body.id}`)
    .set('Authorization', `Bearer ${token}`);

  return { token, bedIds: beds.body.map((b: any) => b.id) as string[] };
}

async function checkInResident(
  token: string,
  bedId: string,
  name: string,
  phone: string,
  checkInDate: string
) {
  const resident = await request(app)
    .post('/api/residents')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, phone, kycType: 'Aadhaar', kycRef: phone });

  const stay = await request(app)
    .post('/api/stays')
    .set('Authorization', `Bearer ${token}`)
    .send({
      residentId: resident.body.id,
      bedId,
      checkInDate,
      monthlyRent: 800000,
      securityDeposit: 1600000,
    });

  return { residentId: resident.body.id, stayId: stay.body.id };
}

describe('Joinees report', () => {
  it('groups by checkInDate (not createdAt), including a back-dated check-in', async () => {
    const { token, bedIds } = await setupOwnerWithBed('joinees-owner@example.com');

    // Registered "today" but actually joined 3 months ago (back-dated).
    await checkInResident(token, bedIds[0], 'Old Joiner', '9000000001', '2026-05-01T00:00:00.000Z');
    await checkInResident(token, bedIds[1], 'New Joiner A', '9000000002', '2026-08-01T00:00:00.000Z');
    await checkInResident(token, bedIds[2], 'New Joiner B', '9000000003', '2026-08-15T00:00:00.000Z');

    const res = await request(app)
      .get('/api/reports/joinees')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.range).toBeNull();

    const may = res.body.monthly.find((m: any) => m.month === '2026-05');
    const aug = res.body.monthly.find((m: any) => m.month === '2026-08');
    expect(may.count).toBe(1);
    expect(aug.count).toBe(2);
  });

  it('returns a custom-range list only when from/to are both provided', async () => {
    const { token, bedIds } = await setupOwnerWithBed('joinees-range-owner@example.com');

    await checkInResident(token, bedIds[0], 'Early', '9100000001', '2026-01-01T00:00:00.000Z');
    await checkInResident(token, bedIds[1], 'InRange', '9100000002', '2026-08-05T00:00:00.000Z');

    const res = await request(app)
      .get('/api/reports/joinees')
      .query({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.range).toHaveLength(1);
    expect(res.body.range[0].residentName).toBe('InRange');
  });

  it('owner-scopes the report', async () => {
    const ownerA = await setupOwnerWithBed('joinees-a@example.com');
    const ownerB = await setupOwnerWithBed('joinees-b@example.com');

    await checkInResident(ownerA.token, ownerA.bedIds[0], 'A Resident', '9200000001', '2026-08-01T00:00:00.000Z');
    await checkInResident(ownerB.token, ownerB.bedIds[0], 'B Resident', '9200000002', '2026-08-01T00:00:00.000Z');

    const res = await request(app)
      .get('/api/reports/joinees')
      .query({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' })
      .set('Authorization', `Bearer ${ownerA.token}`);

    expect(res.body.range).toHaveLength(1);
    expect(res.body.range[0].residentName).toBe('A Resident');
  });
});

describe('Collections report', () => {
  it('sums transactions within a date range and excludes ones outside it', async () => {
    const { token, bedIds } = await setupOwnerWithBed('collections-owner@example.com');
    const { stayId } = await checkInResident(
      token,
      bedIds[0],
      'Payer',
      '9300000001',
      '2026-07-01T00:00:00.000Z'
    );

    const due = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ stayId, dueDate: '2026-08-01T00:00:00.000Z', rentDue: 800000 });

    await request(app)
      .put(`/api/payments/${due.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rentCollected: 300000, collectedAt: '2026-08-05T00:00:00.000Z' });

    await request(app)
      .put(`/api/payments/${due.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rentCollected: 500000, collectedAt: '2026-08-20T00:00:00.000Z' });

    const narrow = await request(app)
      .get('/api/reports/collections')
      .query({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-10T23:59:59.999Z' })
      .set('Authorization', `Bearer ${token}`);
    expect(narrow.body.transactions).toHaveLength(1);
    expect(narrow.body.totalCollected).toBe(300000);

    const wide = await request(app)
      .get('/api/reports/collections')
      .query({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' })
      .set('Authorization', `Bearer ${token}`);
    expect(wide.body.transactions).toHaveLength(2);
    expect(wide.body.totalCollected).toBe(800000);
  });

  it('requires both from and to', async () => {
    const { token } = await setupOwnerWithBed('collections-missing-owner@example.com');
    const res = await request(app)
      .get('/api/reports/collections')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe('Finance report', () => {
  it('computes income, expense, net, and expenses-by-category within a range', async () => {
    const { token, bedIds } = await setupOwnerWithBed('finance-owner@example.com');
    const { stayId } = await checkInResident(
      token,
      bedIds[0],
      'Finance Payer',
      '9500000001',
      '2026-07-01T00:00:00.000Z'
    );

    const due = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ stayId, dueDate: '2026-08-01T00:00:00.000Z', rentDue: 800000 });
    await request(app)
      .put(`/api/payments/${due.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rentCollected: 800000, collectedAt: '2026-08-05T00:00:00.000Z' });

    await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'electricity', amount: 200000, date: '2026-08-10T00:00:00.000Z' });
    await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'cleaning', amount: 50000, date: '2026-08-12T00:00:00.000Z' });
    // Outside the range — must not be counted.
    await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'other', amount: 999999, date: '2026-09-15T00:00:00.000Z' });

    const res = await request(app)
      .get('/api/reports/finance')
      .query({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalIncome).toBe(800000);
    expect(res.body.totalExpense).toBe(250000);
    expect(res.body.net).toBe(550000);
    expect(res.body.expensesByCategory).toEqual(
      expect.arrayContaining([
        { category: 'electricity', total: 200000 },
        { category: 'cleaning', total: 50000 },
      ])
    );
  });
});

describe('Food preference report', () => {
  it('counts only residents with an active stay', async () => {
    const { token, bedIds } = await setupOwnerWithBed('food-owner@example.com');

    const withFood = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'With Food',
        phone: '9600000001',
        kycType: 'Aadhaar',
        kycRef: 'FF1',
        foodPreference: 'with_food',
      });
    await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${token}`)
      .send({
        residentId: withFood.body.id,
        bedId: bedIds[0],
        checkInDate: '2026-08-01T00:00:00.000Z',
        monthlyRent: 800000,
        securityDeposit: 1600000,
      });

    const withoutFood = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Without Food',
        phone: '9600000002',
        kycType: 'Aadhaar',
        kycRef: 'FF2',
        foodPreference: 'without_food',
      });
    await request(app)
      .post('/api/stays')
      .set('Authorization', `Bearer ${token}`)
      .send({
        residentId: withoutFood.body.id,
        bedId: bedIds[1],
        checkInDate: '2026-08-01T00:00:00.000Z',
        monthlyRent: 800000,
        securityDeposit: 1600000,
      });

    // Registered but never checked in — must not be counted.
    await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Not Checked In',
        phone: '9600000003',
        kycType: 'Aadhaar',
        kycRef: 'FF3',
        foodPreference: 'with_food',
      });

    const res = await request(app)
      .get('/api/reports/food-preference')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ withFood: 1, withoutFood: 1 });
  });
});
