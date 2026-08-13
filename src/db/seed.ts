import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { connectDB, disconnectDB } from './connection';
import { Owner } from '../modules/auth/owner.model';

dotenv.config();

const MASTER_ADMIN_EMAIL = (process.env.MASTER_ADMIN_EMAIL || 'admin@pgmanagement.local')
  .toLowerCase()
  .trim();
const MASTER_ADMIN_PASSWORD = process.env.MASTER_ADMIN_PASSWORD || 'Admin@12345';
const MASTER_ADMIN_NAME = process.env.MASTER_ADMIN_NAME || 'Master Admin';

async function seedMasterAdmin(): Promise<void> {
  await connectDB();

  const existing = await Owner.findOne({ email: MASTER_ADMIN_EMAIL });

  if (existing) {
    if (existing.role !== 'superadmin') {
      existing.role = 'superadmin';
      existing.name = MASTER_ADMIN_NAME;
      existing.passwordHash = await bcrypt.hash(MASTER_ADMIN_PASSWORD, 10);
      await existing.save();
      console.log(`Updated existing account to master admin: ${MASTER_ADMIN_EMAIL}`);
    } else {
      // Keep credentials in sync with env on re-seed
      existing.name = MASTER_ADMIN_NAME;
      existing.passwordHash = await bcrypt.hash(MASTER_ADMIN_PASSWORD, 10);
      await existing.save();
      console.log(`Master admin already exists — credentials refreshed: ${MASTER_ADMIN_EMAIL}`);
    }
  } else {
    const passwordHash = await bcrypt.hash(MASTER_ADMIN_PASSWORD, 10);
    await Owner.create({
      _id: uuidv4(),
      name: MASTER_ADMIN_NAME,
      email: MASTER_ADMIN_EMAIL,
      passwordHash,
      role: 'superadmin'
    });
    console.log(`Master admin created: ${MASTER_ADMIN_EMAIL}`);
  }

  console.log('Seed complete.');
  console.log(`  email:    ${MASTER_ADMIN_EMAIL}`);
  console.log(`  password: ${MASTER_ADMIN_PASSWORD}`);
  console.log(`  role:     superadmin`);
}

seedMasterAdmin()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDB();
  });
