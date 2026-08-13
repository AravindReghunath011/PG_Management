import { Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../../middleware/auth';
import { Owner } from '../auth/owner.model';
import { Branch } from '../branches/branch.model';
import { Room } from '../rooms/room.model';
import { Bed } from '../beds/bed.model';
import { Resident } from '../residents/resident.model';
import { PaymentTransaction } from '../payments/paymentTransaction.model';

type OwnerStats = {
  branchCount: number;
  roomCount: number;
  totalBeds: number;
  occupiedBeds: number;
  residentCount: number;
  totalCollected: number;
};

function emptyStats(): OwnerStats {
  return {
    branchCount: 0,
    roomCount: 0,
    totalBeds: 0,
    occupiedBeds: 0,
    residentCount: 0,
    totalCollected: 0,
  };
}

// Unambiguous, easy-to-read-aloud characters — avoids 0/O, 1/l/I confusion
// when this has to be relayed to the owner manually (no email sending yet).
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generateTempPassword(length = 12): string {
  const bytes = crypto.randomBytes(length);
  let password = '';
  for (let i = 0; i < length; i++) {
    password += TEMP_PASSWORD_ALPHABET[bytes[i] % TEMP_PASSWORD_ALPHABET.length];
  }
  return password;
}

function toOwnerSummary(owner: { _id: string; name: string; email: string; role: string; createdAt?: Date }, stats: OwnerStats) {
  const occupancyRate = stats.totalBeds > 0 ? Math.round((stats.occupiedBeds / stats.totalBeds) * 100) : 0;
  return {
    id: owner._id,
    name: owner.name,
    email: owner.email,
    role: owner.role,
    createdAt: owner.createdAt,
    ...stats,
    occupancyRate,
  };
}

async function getStatsByOwnerIds(ownerIds: string[]): Promise<Map<string, OwnerStats>> {
  const statsMap = new Map<string, OwnerStats>();
  for (const id of ownerIds) statsMap.set(id, emptyStats());
  if (ownerIds.length === 0) return statsMap;

  const [branchCounts, roomCounts, bedStats, residentCounts, collectedStats] = await Promise.all([
    Branch.aggregate([
      { $match: { ownerId: { $in: ownerIds }, deletedAt: null } },
      { $group: { _id: '$ownerId', count: { $sum: 1 } } },
    ]),
    Room.aggregate([
      { $match: { ownerId: { $in: ownerIds }, deletedAt: null } },
      { $group: { _id: '$ownerId', count: { $sum: 1 } } },
    ]),
    Bed.aggregate([
      { $match: { ownerId: { $in: ownerIds }, deletedAt: null } },
      {
        $group: {
          _id: '$ownerId',
          totalBeds: { $sum: 1 },
          occupiedBeds: { $sum: { $cond: [{ $eq: ['$status', 'occupied'] }, 1, 0] } },
        },
      },
    ]),
    Resident.aggregate([
      { $match: { ownerId: { $in: ownerIds }, deletedAt: null } },
      { $group: { _id: '$ownerId', count: { $sum: 1 } } },
    ]),
    PaymentTransaction.aggregate([
      { $match: { ownerId: { $in: ownerIds }, deletedAt: null } },
      {
        $group: {
          _id: '$ownerId',
          total: { $sum: { $add: ['$rentPaid', '$electricityPaid', '$otherPaid'] } },
        },
      },
    ]),
  ]);

  for (const row of branchCounts) statsMap.get(row._id)!.branchCount = row.count;
  for (const row of roomCounts) statsMap.get(row._id)!.roomCount = row.count;
  for (const row of bedStats) {
    const stats = statsMap.get(row._id)!;
    stats.totalBeds = row.totalBeds;
    stats.occupiedBeds = row.occupiedBeds;
  }
  for (const row of residentCounts) statsMap.get(row._id)!.residentCount = row.count;
  for (const row of collectedStats) statsMap.get(row._id)!.totalCollected = row.total;

  return statsMap;
}

export const getOwners = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const owners = await Owner.find({}).select('_id name email role createdAt').sort({ createdAt: -1 });
    const statsMap = await getStatsByOwnerIds(owners.map((o) => o._id));

    return res.status(200).json({
      owners: owners.map((o) => toOwnerSummary(o, statsMap.get(o._id) ?? emptyStats())),
    });
  } catch (error) {
    console.error('getOwners error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving owners.' },
    });
  }
};

// Onboards a new PG owner: superadmin supplies name + email, we generate a
// temp password (returned once, in the response — there's no email-sending
// infra yet, so the admin relays it manually) and force a reset on first login.
export const createOwner = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, email } = req.body;
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const normalizedEmail = typeof email === 'string' ? email.toLowerCase().trim() : '';

    if (!trimmedName || !normalizedEmail) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'name and email are required.' },
      });
    }

    const existing = await Owner.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'An account with this email already exists.' },
      });
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const ownerId = uuidv4();

    const owner = new Owner({
      _id: ownerId,
      name: trimmedName,
      email: normalizedEmail,
      passwordHash,
      role: 'owner',
      mustResetPassword: true,
    });
    await owner.save();

    return res.status(201).json({
      owner: {
        id: owner._id,
        name: owner.name,
        email: owner.email,
        role: owner.role,
        mustResetPassword: owner.mustResetPassword,
        createdAt: owner.createdAt,
      },
      tempPassword,
    });
  } catch (error) {
    console.error('createOwner error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error creating owner.' },
    });
  }
};

export const getOwnerById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const owner = await Owner.findById(id).select('_id name email role createdAt');
    if (!owner) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Owner not found.' },
      });
    }

    const statsMap = await getStatsByOwnerIds([owner._id]);
    return res.status(200).json({
      owner: toOwnerSummary(owner, statsMap.get(owner._id) ?? emptyStats()),
    });
  } catch (error) {
    console.error('getOwnerById error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving owner.' },
    });
  }
};
