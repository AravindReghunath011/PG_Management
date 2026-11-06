import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { v4 as uuidv4 } from 'uuid';
import { Bed } from '../modules/beds/bed.model';
import { buildNotifications } from '../modules/notifications/notifications.service';
import { Payment } from '../modules/payments/payment.model';
import { Resident } from '../modules/residents/resident.model';
import { Room } from '../modules/rooms/room.model';
import { Stay } from '../modules/stays/stay.model';

jest.setTimeout(30000);

const DAY = 86_400_000;
const NOW = new Date('2026-11-15T06:00:00.000Z');

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_notification_place_test' });
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function seed(
  ownerId: string,
  place: { roomNumber: string; bedNumber: string },
  stayFields: { checkOutDate?: Date; noticeMoveOutDate?: Date } = {},
) {
  const roomId = uuidv4();
  const bedId = uuidv4();
  const residentId = uuidv4();
  const stayId = uuidv4();
  await Room.create({ _id: roomId, ownerId, branchId: uuidv4(), roomNumber: place.roomNumber, floor: 1 });
  await Bed.create({ _id: bedId, ownerId, roomId, bedNumber: place.bedNumber });
  await Resident.create({ _id: residentId, ownerId, name: 'Rahul', phone: uuidv4(), kycType: 'Aadhaar' });
  await Stay.create({
    _id: stayId,
    ownerId,
    residentId,
    bedId,
    checkInDate: new Date(NOW.getTime() - 5 * DAY),
    monthlyRent: 850000,
    securityDeposit: 0,
    ...stayFields,
  });
  return { residentId, stayId };
}

const addDue = (ownerId: string, stayId: string, residentId: string, dueDate: Date) =>
  Payment.create({ _id: uuidv4(), ownerId, stayId, residentId, dueDate, rentDue: 850000 });

describe('Alert text says where the resident stays', () => {
  it('adds the room and bed to an overdue rent alert', async () => {
    const ownerId = uuidv4();
    const { residentId, stayId } = await seed(ownerId, { roomNumber: '101', bedNumber: 'A' });
    await addDue(ownerId, stayId, residentId, new Date(NOW.getTime() - 2 * DAY));

    const alert = (await buildNotifications(ownerId, NOW)).find((a) => a.type === 'rent_overdue');
    expect(alert?.title).toBe('Rent overdue — Rahul');
    expect(alert?.body).toMatch(/^Room 101, Bed A · ₹8,500 pending since /);
  });

  it('adds it to a rent due soon alert', async () => {
    const ownerId = uuidv4();
    const { residentId, stayId } = await seed(ownerId, { roomNumber: '102', bedNumber: 'B' });
    await addDue(ownerId, stayId, residentId, new Date(NOW.getTime() + 2 * DAY));

    const alert = (await buildNotifications(ownerId, NOW)).find((a) => a.type === 'rent_due_soon');
    expect(alert?.body).toMatch(/^Room 102, Bed B · ₹8,500 due on /);
  });

  it('adds it to a move-out alert', async () => {
    const ownerId = uuidv4();
    await seed(ownerId, { roomNumber: '103', bedNumber: 'C' }, { noticeMoveOutDate: new Date(NOW.getTime() + 3 * DAY) });

    const alert = (await buildNotifications(ownerId, NOW)).find((a) => a.type === 'notice_ending');
    expect(alert?.body).toMatch(/^Room 103, Bed C · Notice period ends /);
  });

  it('keeps the place on a due left behind after check-out', async () => {
    const ownerId = uuidv4();
    const { residentId, stayId } = await seed(ownerId, { roomNumber: '104', bedNumber: 'D' }, { checkOutDate: new Date(NOW.getTime() - DAY) });
    await addDue(ownerId, stayId, residentId, new Date(NOW.getTime() - 3 * DAY));

    const alert = (await buildNotifications(ownerId, NOW)).find((a) => a.type === 'rent_overdue');
    expect(alert?.body).toMatch(/^Room 104, Bed D · /);
  });

  it('still sends the alert when the stay cannot be found', async () => {
    const ownerId = uuidv4();
    const residentId = uuidv4();
    await Resident.create({ _id: residentId, ownerId, name: 'Rahul', phone: uuidv4(), kycType: 'Aadhaar' });
    await addDue(ownerId, uuidv4(), residentId, new Date(NOW.getTime() - 2 * DAY));

    const alert = (await buildNotifications(ownerId, NOW)).find((a) => a.type === 'rent_overdue');
    expect(alert?.body).toMatch(/^₹8,500 pending since /);
  });

  it('never uses another owner’s room or bed', async () => {
    const ownerA = uuidv4();
    const ownerB = uuidv4();
    const other = await seed(ownerA, { roomNumber: '999', bedNumber: 'Z' });
    const residentId = uuidv4();
    await Resident.create({ _id: residentId, ownerId: ownerB, name: 'Priya', phone: uuidv4(), kycType: 'Aadhaar' });
    await addDue(ownerB, other.stayId, residentId, new Date(NOW.getTime() - 2 * DAY));

    const alert = (await buildNotifications(ownerB, NOW)).find((a) => a.type === 'rent_overdue');
    expect(alert?.body).not.toContain('999');
    expect(alert?.body).toMatch(/^₹8,500 pending since /);
  });
});
