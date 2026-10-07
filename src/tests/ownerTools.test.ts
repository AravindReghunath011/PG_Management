// Settings due day, collection board feed, profit & loss, deposit settlement,
// notifications and search escaping.
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../index';
import { Payment } from '../modules/payments/payment.model';
import { PaymentTransaction } from '../modules/payments/paymentTransaction.model';
import { Stay } from '../modules/stays/stay.model';
import { Bed } from '../modules/beds/bed.model';
import { localMidnight, monthKeyOf } from '../modules/payments/monthlyDues';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_owner_tools_test' });
  await Payment.syncIndexes();
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

const DAY = 86_400_000;

async function setup(email: string) {
  const signup = await request(app).post('/api/auth/signup').send({ name: 'O', email, password: 'password123' });
  if (signup.status !== 201) throw new Error(`setup signup: ${signup.status} ${JSON.stringify(signup.body)}`);
  const auth = { Authorization: `Bearer ${signup.body.token}` };
  const branch = await request(app).post('/api/branches').set(auth).send({ name: 'Main', address: 'A' });
  const other = await request(app).post('/api/branches').set(auth).send({ name: 'Annex', address: 'B' });
  const room = await request(app)
    .post('/api/rooms')
    .set(auth)
    .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 3 });
  const annexRoom = await request(app)
    .post('/api/rooms')
    .set(auth)
    .send({ branchId: other.body.id, roomNumber: '201', floor: 2, bedCount: 1 });
  for (const [label, r] of [['main room', room], ['annex room', annexRoom]] as const) {
    if (r.status !== 201) throw new Error(`setup ${label}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const beds = (await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth)).body.map((b: any) => b.id);
  const annexBed = (await request(app).get(`/api/beds?roomId=${annexRoom.body.id}`).set(auth)).body[0].id;
  return { auth, branchId: branch.body.id as string, otherBranchId: other.body.id as string, beds, annexBed };
}

async function checkIn(auth: Record<string, string>, bedId: string, phone: string, rent: number, daysAgo: number, deposit = 0) {
  const r = await request(app)
    .post('/api/residents')
    .set(auth)
    .send({ name: `Resident ${phone.slice(-2)}`, phone, kycType: 'Aadhaar', kycRef: phone });
  const stay = await request(app).post('/api/stays').set(auth).send({
    residentId: r.body.id,
    bedId,
    checkInDate: new Date(Date.now() - daysAgo * DAY).toISOString(),
    monthlyRent: rent,
    securityDeposit: deposit,
  });
  return { residentId: r.body.id as string, stayId: stay.body.id as string };
}

const thisMonthRange = () => {
  const [y, m] = monthKeyOf(new Date()).split('-').map(Number);
  return { from: localMidnight(y, m - 1, 1).toISOString(), to: new Date(localMidnight(y, m, 1).getTime() - 1).toISOString() };
};

describe('Settings: rent due day', () => {
  it('validates and saves rentDueDay; later months fall due on it, the first on check-in', async () => {
    const { auth, beds } = await setup('settings@example.com');
    expect((await request(app).put('/api/auth/settings').set(auth).send({ rentDueDay: 31 })).status).toBe(400);
    const saved = await request(app).put('/api/auth/settings').set(auth).send({ rentDueDay: 5 });
    expect(saved.body.owner.rentDueDay).toBe(5);
    expect((await request(app).get('/api/auth/me').set(auth)).body.owner.rentDueDay).toBe(5);

    const { stayId } = await checkIn(auth, beds[0], '9000000001', 500000, 70);
    await request(app)
      .get('/api/dashboard/overview')
      .query({ from: new Date(Date.now() - 70 * DAY).toISOString(), to: new Date().toISOString() })
      .set(auth);
    const stay = await Stay.findById(stayId);
    const dues = await Payment.find({ stayId }).sort({ dueDate: 1 });
    const checkInMonth = monthKeyOf(stay!.checkInDate);
    for (const d of dues) {
      const day = Number(d.dueDate.toLocaleDateString('en-IN', { day: 'numeric', timeZone: 'Asia/Kolkata' }));
      if (monthKeyOf(d.dueDate) === checkInMonth) {
        expect(monthKeyOf(d.dueDate)).toBe(checkInMonth);
      } else {
        expect(day).toBe(5);
      }
    }
  });
});

describe('Collection board feed', () => {
  it('filters payments to a month and includes phone, room, bed and branch', async () => {
    const { auth, beds, branchId } = await setup('board@example.com');
    await checkIn(auth, beds[0], '9000000002', 500000, 40);

    const res = await request(app).get('/api/payments').query(thisMonthRange()).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ residentPhone: '9000000002', roomNumber: '101', branchId });
    expect(res.body[0].bedNumber).toBeTruthy();

    const bad = await request(app).get('/api/payments').query({ from: 'nope' }).set(auth);
    expect(bad.status).toBe(400);
  });
});

describe('Profit & loss', () => {
  it('reports collected, expenses, net, expected and per-branch figures', async () => {
    const { auth, beds, annexBed, branchId, otherBranchId } = await setup('pl@example.com');
    await checkIn(auth, beds[0], '9000000003', 500000, 40);
    await checkIn(auth, annexBed, '9000000004', 300000, 40);
    const range = thisMonthRange();

    const dues = await request(app).get('/api/payments').query(range).set(auth);
    const mainDue = dues.body.find((d: any) => d.branchId === branchId);
    await request(app)
      .put(`/api/payments/${mainDue.id}`)
      .set(auth)
      .send({ rentCollected: 500000, paymentMode: 'upi', collectedAt: new Date().toISOString() });
    await request(app).post('/api/expenses').set(auth).send({ category: 'food', amount: 120000, date: new Date().toISOString(), branchId });
    await request(app).post('/api/expenses').set(auth).send({ category: 'rent', amount: 50000, date: new Date().toISOString(), branchId: otherBranchId });

    const all = await request(app).get('/api/reports/profit-loss').query(range).set(auth);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ totalIncome: 500000, totalExpense: 170000, net: 330000, expectedRent: 800000 });
    expect(all.body.collectionRate).toBe(62.5);
    expect(all.body.incomeByMode).toEqual([{ mode: 'upi', total: 500000 }]);
    expect(all.body.monthly).toHaveLength(1);

    const main = await request(app).get('/api/reports/profit-loss').query({ ...range, branchId }).set(auth);
    expect(main.body).toMatchObject({ totalIncome: 500000, totalExpense: 120000, expectedRent: 500000 });

    const annex = await request(app).get('/api/reports/profit-loss').query({ ...range, branchId: otherBranchId }).set(auth);
    expect(annex.body).toMatchObject({ totalIncome: 0, totalExpense: 50000, expectedRent: 300000 });
  });
});

describe('Deposit settlement on checkout', () => {
  it('applies a pending-rent deduction to dues, stores the settlement and frees the bed', async () => {
    const { auth, beds } = await setup('settle@example.com');
    const { stayId } = await checkIn(auth, beds[0], '9000000005', 500000, 40, 1500000);

    const preview = await request(app).get(`/api/stays/${stayId}/settlement-preview`).set(auth);
    expect(preview.body.securityDeposit).toBe(1500000);
    const pending = preview.body.pendingRent;
    expect(pending).toBeGreaterThan(0);

    const res = await request(app)
      .put(`/api/stays/${stayId}/checkout`)
      .set(auth)
      .send({
        checkOutDate: new Date().toISOString(),
        settlement: {
          deductions: [
            { kind: 'rent', label: 'Pending rent', amount: pending },
            { kind: 'damage', label: 'Broken chair', amount: 100000 },
          ],
          refundMode: 'upi',
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.depositSettlement).toMatchObject({
      totalDeductions: pending + 100000,
      refundAmount: 1500000 - pending - 100000,
      refundMode: 'upi',
    });
    expect((await Bed.findById(beds[0]))?.status).toBe('vacant');
    const open = await Payment.find({ stayId, deletedAt: null, status: { $ne: 'paid' } });
    expect(open).toHaveLength(0);
    const deposits = await PaymentTransaction.find({ stayId, paymentMode: 'deposit' });
    expect(deposits.reduce((n, t) => n + t.rentPaid + t.electricityPaid + t.otherPaid, 0)).toBe(pending);
  });

  it('rejects deductions above the deposit or above rent owed, without checking out', async () => {
    const { auth, beds } = await setup('settle-bad@example.com');
    const { stayId } = await checkIn(auth, beds[0], '9000000006', 500000, 40, 200000);

    const tooMuch = await request(app)
      .put(`/api/stays/${stayId}/checkout`)
      .set(auth)
      .send({ checkOutDate: new Date().toISOString(), settlement: { deductions: [{ kind: 'damage', amount: 300000 }] } });
    expect(tooMuch.status).toBe(400);

    const overRent = await request(app)
      .put(`/api/stays/${stayId}/checkout`)
      .set(auth)
      .send({ checkOutDate: new Date().toISOString(), settlement: { deductions: [{ kind: 'rent', amount: 999999999 }] } });
    expect(overRent.status).toBe(400);
    expect((await Stay.findById(stayId))?.checkOutDate).toBeNull();

    const manual = await request(app)
      .put(`/api/payments/${(await Payment.findOne({ stayId }))!._id}`)
      .set(auth)
      .send({ rentCollected: 1000, paymentMode: 'deposit' });
    expect(manual.status).toBe(400);
  });
});

describe('Notifications', () => {
  it('lists overdue rent and ending notices, and marks them read', async () => {
    const { auth, beds } = await setup('notify@example.com');
    const a = await checkIn(auth, beds[0], '9000000007', 500000, 60);
    const b = await checkIn(auth, beds[1], '9000000008', 500000, 60);
    await Payment.create({
      _id: 'overdue-1',
      ownerId: (await Stay.findById(a.stayId))!.ownerId,
      stayId: a.stayId,
      residentId: a.residentId,
      dueDate: new Date(Date.now() - 10 * DAY),
      rentDue: 500000,
    });
    await request(app)
      .put(`/api/stays/${b.stayId}/notice`)
      .set(auth)
      .send({ moveOutDate: new Date(Date.now() + 3 * DAY).toISOString() });

    const res = await request(app).get('/api/notifications').set(auth);
    expect(res.status).toBe(200);
    const types = res.body.items.map((i: any) => i.type);
    expect(types).toContain('rent_overdue');
    expect(types).toContain('notice_ending');
    expect(types).toContain('kyc_missing');
    expect(res.body.items[0].severity).toBe('high');
    expect(res.body.unreadCount).toBe(res.body.items.length);

    await request(app).put('/api/notifications/seen').set(auth);
    const after = await request(app).get('/api/notifications').set(auth);
    expect(after.body.unreadCount).toBe(0);
  });

  it('is owner-scoped', async () => {
    const a = await setup('notify-a@example.com');
    const b = await setup('notify-b@example.com');
    await checkIn(b.auth, b.beds[0], '9000000009', 500000, 60);
    const res = await request(app).get('/api/notifications').set(a.auth);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('Search', () => {
  it('treats special characters literally and matches phones typed with spaces', async () => {
    const { auth, beds } = await setup('search@example.com');
    await checkIn(auth, beds[0], '9876543210', 500000, 10);
    const weird = await request(app).get('/api/search/resident').query({ q: '(+' }).set(auth);
    expect(weird.status).toBe(200);
    const spaced = await request(app).get('/api/search/resident').query({ q: '98765 43210' }).set(auth);
    expect(spaced.body.results).toHaveLength(1);
  });
});

describe('Profile', () => {
  it('lets an owner rename themselves, and validates the name', async () => {
    const { auth } = await setup('profile@example.com');
    const res = await request(app).put('/api/auth/profile').set(auth).send({ name: '  Ravi   Kumar ' });
    expect(res.status).toBe(200);
    expect(res.body.owner.name).toBe('Ravi Kumar');
    expect(res.body.owner.email).toBe('profile@example.com');
    expect((await request(app).get('/api/auth/me').set(auth)).body.owner.name).toBe('Ravi Kumar');

    expect((await request(app).put('/api/auth/profile').set(auth).send({ name: '   ' })).status).toBe(400);
    expect((await request(app).put('/api/auth/profile').set(auth).send({ name: 'x'.repeat(61) })).status).toBe(400);
    expect((await request(app).put('/api/auth/profile').send({ name: 'No Token' })).status).toBe(401);
  });
});

describe('Room form support', () => {
  it('creates a room with per-bed prices and rejects duplicate room numbers', async () => {
    const { auth, branchId } = await setup('roomform@example.com');
    const res = await request(app).post('/api/rooms').set(auth).send({
      branchId, roomNumber: '305', floor: 3, bedCount: 3, rentPaise: 800000, amenities: ['ac'],
      bedRentPaise: [null, 900000, 750000],
    });
    expect(res.status).toBe(201);
    const beds = (await request(app).get(`/api/beds?roomId=${res.body.id}`).set(auth)).body;
    const byNumber = Object.fromEntries(beds.map((b: any) => [b.bedNumber, b]));
    expect(byNumber.A.effectiveRentPaise).toBe(800000);
    expect(byNumber.B.effectiveRentPaise).toBe(900000);
    expect(byNumber.C.effectiveRentPaise).toBe(750000);

    const dup = await request(app).post('/api/rooms').set(auth).send({ branchId, roomNumber: '305', floor: 3, bedCount: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_ROOM');

    const renameClash = await request(app).put(`/api/rooms/${res.body.id}`).set(auth).send({ roomNumber: '101' });
    expect(renameClash.status).toBe(409);
    const renameOwn = await request(app).put(`/api/rooms/${res.body.id}`).set(auth).send({ roomNumber: '305' });
    expect(renameOwn.status).toBe(200);
  });

  it('refuses to delete a room with residents, and removes its beds when empty', async () => {
    const { auth, branchId, beds } = await setup('roomdelete@example.com');
    const rooms = (await request(app).get('/api/rooms').set(auth)).body;
    const room101 = rooms.find((r: any) => r.roomNumber === '101' && r.branchId === branchId);
    await checkIn(auth, beds[0], '9000000010', 500000, 10);
    const blocked = await request(app).delete(`/api/rooms/${room101.id}`).set(auth);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('ROOM_OCCUPIED');

    const empty = await request(app).post('/api/rooms').set(auth).send({ branchId, roomNumber: '999', floor: 9, bedCount: 2 });
    expect((await request(app).delete(`/api/rooms/${empty.body.id}`).set(auth)).status).toBe(200);
    expect((await request(app).get(`/api/beds?roomId=${empty.body.id}`).set(auth)).body).toHaveLength(0);
  });
});

describe('Dashboard per property', () => {
  it('scopes every figure to the chosen branch, and rejects another owner’s branch', async () => {
    const { auth, beds, annexBed, branchId, otherBranchId } = await setup('dash-branch@example.com');
    await checkIn(auth, beds[0], '9000000020', 500000, 40);
    await checkIn(auth, annexBed, '9000000021', 300000, 40);
    await request(app).post('/api/expenses').set(auth).send({ category: 'food', amount: 70000, date: new Date().toISOString(), branchId });

    const all = await request(app).get('/api/dashboard/overview').set(auth);
    expect(all.body.branch).toBeNull();
    expect(all.body.stats).toMatchObject({ totalRooms: 2, totalBeds: 4 });
    expect(all.body.revenue.target).toBe(800000);

    const main = await request(app).get('/api/dashboard/overview').query({ branchId }).set(auth);
    expect(main.body.branch).toMatchObject({ id: branchId, name: 'Main' });
    expect(main.body.owner.displayName).toBe('Main');
    expect(main.body.stats).toMatchObject({ totalRooms: 1, totalBeds: 3, vacantBeds: 2 });
    expect(main.body.revenue).toMatchObject({ target: 500000, expenses: 70000 });
    expect(main.body.rentStatus.unpaid.map((r: any) => r.phone)).toEqual(['9000000020']);

    const annex = await request(app).get('/api/dashboard/overview').query({ branchId: otherBranchId }).set(auth);
    expect(annex.body.stats).toMatchObject({ totalRooms: 1, totalBeds: 1, vacantBeds: 0 });
    expect(annex.body.revenue).toMatchObject({ target: 300000, expenses: 0 });

    const stranger = await setup('dash-branch-other@example.com');
    const foreign = await request(app).get('/api/dashboard/overview').query({ branchId }).set(stranger.auth);
    expect(foreign.status).toBe(404);
  });
});

describe('Expenses without a property', () => {
  it('count for the only property; with several they count under all properties', async () => {
    // One property: an untagged expense belongs to it.
    const signup = await request(app).post('/api/auth/signup').send({ name: 'Solo', email: 'solo@example.com', password: 'password123' });
    const soloAuth = { Authorization: `Bearer ${signup.body.token}` };
    const only = await request(app).post('/api/branches').set(soloAuth).send({ name: 'Only PG', address: 'A' });
    await request(app).post('/api/expenses').set(soloAuth).send({ category: 'food', amount: 10000, date: new Date().toISOString() });
    const solo = await request(app).get('/api/dashboard/overview').query({ branchId: only.body.id }).set(soloAuth);
    expect(solo.body.revenue).toMatchObject({ expenses: 10000 });

    // Several properties: untagged is left out of each, but reported.
    const { auth, branchId } = await setup('shared-exp@example.com');
    await request(app).post('/api/expenses').set(auth).send({ category: 'food', amount: 10000, date: new Date().toISOString() });
    await request(app).post('/api/expenses').set(auth).send({ category: 'rent', amount: 50000, date: new Date().toISOString(), branchId });
    const main = await request(app).get('/api/dashboard/overview').query({ branchId }).set(auth);
    expect(main.body.revenue).toMatchObject({ expenses: 50000 });
    const all = await request(app).get('/api/dashboard/overview').set(auth);
    expect(all.body.revenue).toMatchObject({ expenses: 60000 });

    const now = new Date();
    const pl = await request(app)
      .get('/api/reports/profit-loss')
      .query({ from: new Date(now.getTime() - 86_400_000).toISOString(), to: new Date(now.getTime() + 86_400_000).toISOString(), branchId })
      .set(auth);
    expect(pl.body).toMatchObject({ totalExpense: 50000 });
  });

  it('rejects tagging an expense with another owner’s property', async () => {
    const a = await setup('exp-owner-a@example.com');
    const b = await setup('exp-owner-b@example.com');
    const res = await request(app)
      .post('/api/expenses')
      .set(a.auth)
      .send({ category: 'food', amount: 1000, date: new Date().toISOString(), branchId: b.branchId });
    expect(res.status).toBe(400);
  });
});
