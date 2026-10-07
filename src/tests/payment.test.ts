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

jest.setTimeout(30000);

let mongod: MongoMemoryServer;
let token: string;
let paymentId: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_payment_test' });
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
  ]);

  const signup = await request(app).post('/api/auth/signup').send({
    name: 'Payment Owner',
    email: 'payment-owner@example.com',
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
    .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 1 });

  const beds = await request(app)
    .get(`/api/beds?roomId=${room.body.id}`)
    .set('Authorization', `Bearer ${token}`);
  const bedId = beds.body[0].id;

  const resident = await request(app)
    .post('/api/residents')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Ravi', phone: '9000000001', kycType: 'Aadhaar', kycRef: 'A1' });

  const stay = await request(app)
    .post('/api/stays')
    .set('Authorization', `Bearer ${token}`)
    .send({
      residentId: resident.body.id,
      bedId,
      checkInDate: '2026-07-01T00:00:00.000Z',
      monthlyRent: 800000,
      securityDeposit: 1600000,
    });

  const due = await request(app)
    .post('/api/payments')
    .set('Authorization', `Bearer ${token}`)
    .send({ stayId: stay.body.id, dueDate: '2026-08-01T00:00:00.000Z', rentDue: 800000 });
  paymentId = due.body.id;
});

describe('Payment transaction log', () => {
  it('records a partial collection as its own transaction, leaves the due partial', async () => {
    const res = await request(app)
      .put(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rentCollected: 300000, collectedAt: '2026-08-05T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.rentPaid).toBe(300000);
    expect(res.body.status).toBe('partial');
    expect(res.body.paidDate).toBeNull();
    expect(res.body.transaction.rentPaid).toBe(300000);

    const transactions = await PaymentTransaction.find({ paymentId });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].collectedAt.toISOString()).toBe('2026-08-05T00:00:00.000Z');
  });

  it('completes a due across two transactions on different dates', async () => {
    await request(app)
      .put(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rentCollected: 300000, collectedAt: '2026-08-05T00:00:00.000Z' });

    const second = await request(app)
      .put(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rentCollected: 500000, collectedAt: '2026-08-12T00:00:00.000Z' });

    expect(second.status).toBe(200);
    expect(second.body.rentPaid).toBe(800000);
    expect(second.body.status).toBe('paid');
    expect(second.body.paidDate).not.toBeNull();

    const transactions = await PaymentTransaction.find({ paymentId }).sort({ collectedAt: 1 });
    expect(transactions).toHaveLength(2);
    expect(transactions[0].rentPaid).toBe(300000);
    expect(transactions[1].rentPaid).toBe(500000);
  });

  it('rejects a request with no positive collected amount', async () => {
    const res = await request(app)
      .put(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rentCollected: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_AMOUNT');
  });

  it('stores the payment mode on the transaction', async () => {
    const res = await request(app)
      .put(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rentCollected: 100000, paymentMode: 'upi' });

    expect(res.status).toBe(200);
    expect(res.body.transaction.paymentMode).toBe('upi');
    const [transaction] = await PaymentTransaction.find({ paymentId });
    expect(transaction.paymentMode).toBe('upi');
  });

  it('rejects an unknown payment mode', async () => {
    const res = await request(app)
      .put(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rentCollected: 100000, paymentMode: 'crypto' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a negative collected amount', async () => {
    const res = await request(app)
      .put(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rentCollected: -100 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it("prevents owner B from recording a payment against owner A's due", async () => {
    const ownerB = await request(app).post('/api/auth/signup').send({
      name: 'Owner B',
      email: 'owner-b-payment@example.com',
      password: 'password123',
    });

    const res = await request(app)
      .put(`/api/payments/${paymentId}`)
      .set('Authorization', `Bearer ${ownerB.body.token}`)
      .send({ rentCollected: 100000 });

    expect(res.status).toBe(404);
  });
});
