import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { v4 as uuidv4 } from 'uuid';
import app from '../index';
import { Owner } from '../modules/auth/owner.model';
import { Payment } from '../modules/payments/payment.model';
import { Resident } from '../modules/residents/resident.model';
import { PushedAlert, PushToken } from '../modules/push/push.model';
import { pushNewAlerts, withinPushHours } from '../modules/push/pushAlerts';
import { buildNotifications } from '../modules/notifications/notifications.service';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;
let tokenA: string;
let tokenB: string;
let ownerA: string;

const PHONE = 'ExponentPushToken[phone-1]';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_push_test' });
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    Owner.deleteMany({}),
    PushToken.deleteMany({}),
    PushedAlert.deleteMany({}),
    Payment.deleteMany({}),
    Resident.deleteMany({}),
  ]);
  const a = await request(app).post('/api/auth/signup').send({ name: 'A', email: 'push-a@example.com', password: 'password123' });
  const b = await request(app).post('/api/auth/signup').send({ name: 'B', email: 'push-b@example.com', password: 'password123' });
  tokenA = a.body.token;
  tokenB = b.body.token;
  ownerA = a.body.owner.id;
});

const register = (auth: string, token = PHONE) =>
  request(app).post('/api/push/tokens').set('Authorization', `Bearer ${auth}`).send({ token, platform: 'android' });

async function seedOverdue(ownerId: string, residentName: string) {
  const residentId = uuidv4();
  const phone = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  await Resident.create({ _id: residentId, ownerId, name: residentName, phone, kycType: 'Aadhaar' });
  await Payment.create({
    _id: uuidv4(),
    ownerId,
    stayId: uuidv4(),
    residentId,
    dueDate: new Date(Date.now() - 5 * 86_400_000),
    rentDue: 500000,
  });
}

function mockExpo(ticket: object = { status: 'ok', id: 'ticket' }) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    const messages = JSON.parse(String((init as RequestInit).body));
    return new Response(JSON.stringify({ data: messages.map(() => ticket) }), { status: 200 });
  });
}

describe('Push token registration', () => {
  it('rejects a malformed token', async () => {
    const res = await register(tokenA, 'not-a-token');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('is idempotent for the same phone', async () => {
    expect((await register(tokenA)).status).toBe(204);
    expect((await register(tokenA)).status).toBe(204);
    expect(await PushToken.countDocuments({ token: PHONE })).toBe(1);
  });

  it('moves the phone to the owner who registered it last', async () => {
    await register(tokenA);
    await register(tokenB);
    const doc = await PushToken.findOne({ token: PHONE }).lean();
    expect(doc?.ownerId).not.toBe(ownerA);
  });

  it('only lets the owning account unregister a phone', async () => {
    await register(tokenA);
    await request(app).delete('/api/push/tokens').set('Authorization', `Bearer ${tokenB}`).send({ token: PHONE });
    expect((await PushToken.findOne({ token: PHONE }).lean())?.deletedAt).toBeNull();

    await request(app).delete('/api/push/tokens').set('Authorization', `Bearer ${tokenA}`).send({ token: PHONE });
    expect((await PushToken.findOne({ token: PHONE }).lean())?.deletedAt).not.toBeNull();
  });
});

describe('Alert steps', () => {
  it('raises rent as due soon, due today, then overdue — each a separate alert', async () => {
    const residentId = uuidv4();
    await Resident.create({ _id: residentId, ownerId: ownerA, name: 'Step', phone: '9811111111', kycType: 'Aadhaar' });
    // Due at noon IST on a fixed day; check from 2 days before, that afternoon, and the next day.
    const due = new Date('2030-03-10T06:30:00.000Z');
    await Payment.create({ _id: uuidv4(), ownerId: ownerA, stayId: uuidv4(), residentId, dueDate: due, rentDue: 500000 });
    const kinds = async (now: Date) =>
      (await buildNotifications(ownerA, now)).filter((n) => n.residentId === residentId).map((n) => n.type);
    expect(await kinds(new Date(due.getTime() - 2 * 86_400_000))).toEqual(['rent_due_soon']);
    expect(await kinds(new Date(due.getTime() + 4 * 3_600_000))).toEqual(['rent_due_today']);
    expect(await kinds(new Date(due.getTime() + 86_400_000))).toEqual(['rent_overdue']);
  });
});

describe('Pushing alerts', () => {
  it('pushes a new alert once, and only the owner’s own alerts', async () => {
    await register(tokenA);
    await seedOverdue(ownerA, 'Ravi');
    const ownerB = (await Owner.findOne({ email: 'push-b@example.com' }).lean())!._id;
    await seedOverdue(String(ownerB), 'Someone Else');
    const fetchSpy = mockExpo();

    expect(await pushNewAlerts(ownerA)).toBe(1);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(PHONE);
    // Tapping it opens Record Rent for that due.
    expect(sent[0].data.url).toMatch(/^\/record-payment\?residentId=.+&dueId=.+/);
    expect(sent[0].title).toBe('⚠️ Rent overdue · Ravi');
    expect(sent[0].body).toMatch(/₹5,000 pending since .+ Tap to record it\.$/);

    // Second sweep: nothing new, nothing sent.
    expect(await pushNewAlerts(ownerA)).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('bundles many new alerts into one summary push', async () => {
    await register(tokenA);
    for (const name of ['R1', 'R2', 'R3', 'R4', 'R5']) await seedOverdue(ownerA, name);
    const fetchSpy = mockExpo();

    expect(await pushNewAlerts(ownerA)).toBe(5);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('🔔 5 things need you');
    // Says what it adds up to (5 overdue rents of ₹5,000) and who, not just a count.
    expect(sent[0].body).toMatch(/^5 rents to collect \(₹25,000\) — .+ and 3 more\. Tap to see them\.$/);
    expect(sent[0].data.url).toBe('/notifications');
  });

  it('records nothing when Expo is unreachable, so the next sweep retries', async () => {
    await register(tokenA);
    await seedOverdue(ownerA, 'Ravi');
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    await expect(pushNewAlerts(ownerA)).rejects.toThrow('offline');
    expect(await PushedAlert.countDocuments({ ownerId: ownerA })).toBe(0);
  });

  it('stops sending to a phone that is no longer registered with Expo', async () => {
    await register(tokenA);
    await seedOverdue(ownerA, 'Ravi');
    mockExpo({ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } });

    await pushNewAlerts(ownerA);
    expect((await PushToken.findOne({ token: PHONE }).lean())?.deletedAt).not.toBeNull();
  });

  it('stays quiet at night (IST)', () => {
    expect(withinPushHours(new Date('2026-11-01T17:00:00Z'))).toBe(false); // 22:30 IST
    expect(withinPushHours(new Date('2026-11-01T05:00:00Z'))).toBe(true); // 10:30 IST
  });
});
