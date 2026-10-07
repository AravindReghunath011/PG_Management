// Notice periods on stays, guardian details on residents, and the photo /
// ID-back upload kinds. R2 is mocked at the SDK level (see upload.test.ts).
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import app from '../index';
import { r2Client } from '../lib/r2Client';
import { Resident } from '../modules/residents/resident.model';
import { Stay } from '../modules/stays/stay.model';
import { Bed } from '../modules/beds/bed.model';

jest.setTimeout(30000);

let mongod: MongoMemoryServer;
const s3Mock = mockClient(r2Client as unknown as S3Client);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'pg_tenant_profile_test' });
});

afterAll(async () => {
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  s3Mock.reset();
  if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
});

const DAY = 86_400_000;

async function ownerWithTenant(email: string, phone = '9000000001') {
  const signup = await request(app).post('/api/auth/signup').send({ name: 'Owner', email, password: 'password123' });
  const auth = { Authorization: `Bearer ${signup.body.token}` };
  const branch = await request(app).post('/api/branches').set(auth).send({ name: 'PG', address: 'Addr' });
  const room = await request(app)
    .post('/api/rooms')
    .set(auth)
    .send({ branchId: branch.body.id, roomNumber: '101', floor: 1, bedCount: 2 });
  const beds = await request(app).get(`/api/beds?roomId=${room.body.id}`).set(auth);
  const resident = await request(app)
    .post('/api/residents')
    .set(auth)
    .send({ name: 'Rahul Sharma', phone, kycType: 'Aadhaar', kycRef: '482988129021' });
  const stay = await request(app).post('/api/stays').set(auth).send({
    residentId: resident.body.id,
    bedId: beds.body[0].id,
    checkInDate: new Date(Date.now() - 60 * DAY).toISOString(),
    monthlyRent: 850000,
    securityDeposit: 1500000,
  });
  return { auth, residentId: resident.body.id as string, stayId: stay.body.id as string, bedId: beds.body[0].id };
}

describe('Notice period', () => {
  it('records and cancels a planned move-out without freeing the bed', async () => {
    const { auth, stayId, bedId } = await ownerWithTenant('notice@example.com');
    const moveOut = new Date(Date.now() + 10 * DAY).toISOString();

    const give = await request(app).put(`/api/stays/${stayId}/notice`).set(auth).send({ moveOutDate: moveOut });
    expect(give.status).toBe(200);
    expect(new Date(give.body.noticeMoveOutDate).toISOString()).toBe(moveOut);
    expect(give.body.checkOutDate).toBeNull();
    expect((await Bed.findById(bedId))?.status).toBe('occupied');

    const listed = await request(app).get('/api/stays?active=true').set(auth);
    expect(listed.body[0].noticeMoveOutDate).toBeTruthy();

    const cancel = await request(app).delete(`/api/stays/${stayId}/notice`).set(auth);
    expect(cancel.status).toBe(200);
    expect(cancel.body.noticeMoveOutDate).toBeNull();
  });

  it('counts residents on notice in the dashboard leavingSoon stat', async () => {
    const { auth, stayId } = await ownerWithTenant('notice-dash@example.com');
    await request(app)
      .put(`/api/stays/${stayId}/notice`)
      .set(auth)
      .send({ moveOutDate: new Date(Date.now() + 5 * DAY).toISOString() });

    const res = await request(app).get('/api/dashboard/overview').set(auth);
    expect(res.body.stats.leavingSoon).toBe(1);
  });

  it('rejects notice on a checked-out stay, a bad date, and another owner’s stay', async () => {
    const a = await ownerWithTenant('notice-a@example.com');
    const b = await ownerWithTenant('notice-b@example.com', '9000000002');

    const bad = await request(app).put(`/api/stays/${a.stayId}/notice`).set(a.auth).send({ moveOutDate: 'nope' });
    expect(bad.status).toBe(400);

    const beforeCheckIn = await request(app)
      .put(`/api/stays/${a.stayId}/notice`)
      .set(a.auth)
      .send({ moveOutDate: new Date(Date.now() - 365 * DAY).toISOString() });
    expect(beforeCheckIn.body.error.code).toBe('INVALID_NOTICE_DATE');

    const foreign = await request(app)
      .put(`/api/stays/${b.stayId}/notice`)
      .set(a.auth)
      .send({ moveOutDate: new Date(Date.now() + DAY).toISOString() });
    expect(foreign.status).toBe(404);
    expect((await Stay.findById(b.stayId))?.noticeMoveOutDate).toBeNull();

    await request(app).put(`/api/stays/${a.stayId}/checkout`).set(a.auth).send({ checkOutDate: new Date().toISOString() });
    const afterCheckout = await request(app)
      .put(`/api/stays/${a.stayId}/notice`)
      .set(a.auth)
      .send({ moveOutDate: new Date(Date.now() + DAY).toISOString() });
    expect(afterCheckout.body.error.code).toBe('ALREADY_CHECKED_OUT');
  });
});

describe('Guardian details', () => {
  it('stores guardian fields on create and clears them on update', async () => {
    const signup = await request(app)
      .post('/api/auth/signup')
      .send({ name: 'O', email: 'guardian@example.com', password: 'password123' });
    const auth = { Authorization: `Bearer ${signup.body.token}` };

    const created = await request(app).post('/api/residents').set(auth).send({
      name: 'Rahul',
      phone: '9111111111',
      kycType: 'Aadhaar',
      kycRef: '482988129021',
      guardianName: ' Rajesh Sharma ',
      guardianPhone: '9443210987',
      guardianRelation: 'Father',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      guardianName: 'Rajesh Sharma',
      guardianPhone: '9443210987',
      guardianRelation: 'Father',
    });

    const cleared = await request(app)
      .put(`/api/residents/${created.body.id}`)
      .set(auth)
      .send({ guardianPhone: '' });
    expect(cleared.body.guardianPhone).toBeNull();
    expect(cleared.body.guardianName).toBe('Rajesh Sharma');
  });

  it('rejects an invalid guardian phone', async () => {
    const signup = await request(app)
      .post('/api/auth/signup')
      .send({ name: 'O', email: 'guardian-bad@example.com', password: 'password123' });
    const res = await request(app)
      .post('/api/residents')
      .set('Authorization', `Bearer ${signup.body.token}`)
      .send({ name: 'R', phone: '9111111112', kycType: 'Aadhaar', kycRef: '1', guardianPhone: '123' });
    expect(res.status).toBe(400);
  });
});

describe('Upload kinds', () => {
  it('stores the ID back side and the resident photo in their own fields', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const { auth, residentId } = await ownerWithTenant('upload-kinds@example.com');

    const back = await request(app)
      .post('/api/uploads/kyc')
      .set(auth)
      .field('residentId', residentId)
      .field('kind', 'kyc_back')
      .attach('file', Buffer.from('img'), 'back.png');
    expect(back.status).toBe(200);
    expect(back.body.url).toContain(`kyc/${residentId}-back.png`);

    const photo = await request(app)
      .post('/api/uploads/kyc')
      .set(auth)
      .field('residentId', residentId)
      .field('kind', 'photo')
      .attach('file', Buffer.from('img'), 'me.jpg');
    expect(photo.body.url).toContain(`photos/${residentId}.jpg`);

    const resident = await Resident.findById(residentId);
    expect(resident?.kycBackImageUrl).toBe(back.body.url);
    expect(resident?.photoUrl).toBe(photo.body.url);
    expect(resident?.kycImageUrl).toBeNull();
  });

  it('rejects an unknown kind and a PDF photo', async () => {
    const { auth, residentId } = await ownerWithTenant('upload-bad@example.com');
    const unknown = await request(app)
      .post('/api/uploads/kyc')
      .set(auth)
      .field('residentId', residentId)
      .field('kind', 'selfie')
      .attach('file', Buffer.from('img'), 'a.jpg');
    expect(unknown.status).toBe(400);

    const pdfPhoto = await request(app)
      .post('/api/uploads/kyc')
      .set(auth)
      .field('residentId', residentId)
      .field('kind', 'photo')
      .attach('file', Buffer.from('%PDF'), 'a.pdf');
    expect(pdfPhoto.status).toBe(400);
  });
});
