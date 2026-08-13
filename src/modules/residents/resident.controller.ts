import { Response } from 'express';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Resident, IResident } from './resident.model';
import { Stay } from '../stays/stay.model';
import { Bed } from '../beds/bed.model';
import { Room } from '../rooms/room.model';
import { Branch } from '../branches/branch.model';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_KYC = new Set(['Aadhaar', 'Passport', 'DL', 'Other']);

function normalizeKycType(raw: unknown): 'Aadhaar' | 'Passport' | 'DL' | 'Other' | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (ALLOWED_KYC.has(value)) {
    return value as 'Aadhaar' | 'Passport' | 'DL' | 'Other';
  }
  const lower = value.toLowerCase();
  if (lower.includes('aadhaar') || lower.includes('aadhar')) return 'Aadhaar';
  if (lower.includes('passport')) return 'Passport';
  if (lower.includes('driving') || lower === 'dl') return 'DL';
  if (value.length > 0) return 'Other';
  return null;
}

function normalizeFoodPreference(raw: unknown): 'with_food' | 'without_food' {
  return raw === 'without_food' ? 'without_food' : 'with_food';
}

const PHONE_REGEX = /^[0-9]{10}$/;
const MAX_NAME_LENGTH = 50;

type ResidentResponse = {
  id: string;
  _id: string;
  ownerId: string;
  name: string;
  phone: string;
  email: string | null;
  kycType: string;
  kycRef: string;
  kycImageUrl: string | null;
  foodPreference: string;
  currentStayId: string | null;
  currentBedId: string | null;
  currentBedNumber: string | null;
  currentRoomId: string | null;
  currentRoomNumber: string | null;
  currentBranchId: string | null;
  currentBranchName: string | null;
  bedLabel: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

function toResidentResponse(
  resident: IResident,
  occupancy?: {
    stayId: string | null;
    bedId: string | null;
    bedNumber: string | null;
    roomId: string | null;
    roomNumber: string | null;
    branchId: string | null;
    branchName: string | null;
  }
): ResidentResponse {
  const bedLabel =
    occupancy?.roomNumber && occupancy?.bedNumber
      ? `${occupancy.roomNumber}-${occupancy.bedNumber}`
      : null;

  return {
    id: resident._id,
    _id: resident._id,
    ownerId: resident.ownerId,
    name: resident.name,
    phone: resident.phone,
    email: resident.email ?? null,
    kycType: resident.kycType,
    kycRef: resident.kycRef,
    kycImageUrl: resident.kycImageUrl ?? null,
    foodPreference: resident.foodPreference ?? 'with_food',
    currentStayId: occupancy?.stayId ?? null,
    currentBedId: occupancy?.bedId ?? null,
    currentBedNumber: occupancy?.bedNumber ?? null,
    currentRoomId: occupancy?.roomId ?? null,
    currentRoomNumber: occupancy?.roomNumber ?? null,
    currentBranchId: occupancy?.branchId ?? null,
    currentBranchName: occupancy?.branchName ?? null,
    bedLabel,
    createdAt: resident.createdAt,
    updatedAt: resident.updatedAt,
  };
}

async function getOccupancyByResidentIds(
  ownerId: string | undefined,
  residentIds: string[]
): Promise<
  Map<
    string,
    {
      stayId: string | null;
      bedId: string | null;
      bedNumber: string | null;
      roomId: string | null;
      roomNumber: string | null;
      branchId: string | null;
      branchName: string | null;
    }
  >
> {
  const map = new Map<
    string,
    {
      stayId: string | null;
      bedId: string | null;
      bedNumber: string | null;
      roomId: string | null;
      roomNumber: string | null;
      branchId: string | null;
      branchName: string | null;
    }
  >();
  if (residentIds.length === 0) return map;

  const stays = await Stay.find({
    ...(ownerId ? { ownerId } : {}),
    residentId: { $in: residentIds },
    checkOutDate: null,
    deletedAt: null,
  });

  const bedIds = stays.map((s) => s.bedId);
  const beds = await Bed.find({
    ...(ownerId ? { ownerId } : {}),
    _id: { $in: bedIds },
    deletedAt: null,
  });
  const bedById = new Map(beds.map((b) => [b._id, b]));

  const roomIds = beds.map((b) => b.roomId);
  const rooms = await Room.find({
    ...(ownerId ? { ownerId } : {}),
    _id: { $in: roomIds },
    deletedAt: null,
  });
  const roomById = new Map(rooms.map((r) => [r._id, r]));

  const branchIds = rooms.map((r) => r.branchId);
  const branches = await Branch.find({
    ...(ownerId ? { ownerId } : {}),
    _id: { $in: branchIds },
    deletedAt: null,
  });
  const branchById = new Map(branches.map((b) => [b._id, b]));

  for (const stay of stays) {
    const bed = bedById.get(stay.bedId);
    const room = bed ? roomById.get(bed.roomId) : undefined;
    const branch = room ? branchById.get(room.branchId) : undefined;
    map.set(stay.residentId, {
      stayId: stay._id,
      bedId: bed?._id ?? stay.bedId,
      bedNumber: bed?.bedNumber ?? null,
      roomId: room?._id ?? null,
      roomNumber: room?.roomNumber ?? null,
      branchId: branch?._id ?? null,
      branchName: branch?.name ?? null,
    });
  }

  return map;
}

export const getResidents = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const residents = await Resident.find({
      ...(ownerId ? { ownerId } : {}),
      deletedAt: null,
    }).sort({ name: 1 });
    const occupancy = await getOccupancyByResidentIds(
      ownerId,
      residents.map((r) => r._id)
    );
    return res.status(200).json(
      residents.map((r) => toResidentResponse(r, occupancy.get(r._id)))
    );
  } catch (error) {
    console.error('getResidents error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving residents.' },
    });
  }
};

export const getResidentById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const { id } = req.params;
    const resident = await Resident.findOne({
      _id: id,
      ...(ownerId ? { ownerId } : {}),
      deletedAt: null,
    });
    if (!resident) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Resident not found.' },
      });
    }
    const occupancy = await getOccupancyByResidentIds(ownerId, [resident._id]);
    return res
      .status(200)
      .json(toResidentResponse(resident, occupancy.get(resident._id)));
  } catch (error) {
    console.error('getResidentById error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving resident.' },
    });
  }
};

export const createResident = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, phone, email, kycType, kycRef, kycImageUrl, foodPreference, id } = req.body;
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const trimmedPhone = typeof phone === 'string' ? phone.trim() : '';
    const trimmedKycRef = typeof kycRef === 'string' ? kycRef.trim() : '';
    const normalizedKyc = normalizeKycType(kycType);

    if (!trimmedName || !trimmedPhone || !normalizedKyc || !trimmedKycRef) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'name, phone, kycType, and kycRef are required.',
        },
      });
    }

    if (trimmedName.length > MAX_NAME_LENGTH) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: `name must be ${MAX_NAME_LENGTH} characters or fewer.`,
        },
      });
    }

    if (!PHONE_REGEX.test(trimmedPhone)) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'phone must be exactly 10 digits.',
        },
      });
    }

    const existing = await Resident.findOne({
      ownerId: req.ownerId,
      phone: trimmedPhone,
      deletedAt: null,
    });
    if (existing) {
      return res.status(400).json({
        error: {
          code: 'DUPLICATE_PHONE',
          message: 'A resident with this phone number already exists.',
        },
      });
    }

    const resident = new Resident({
      _id: id || uuidv4(),
      ownerId: req.ownerId,
      name: trimmedName,
      phone: trimmedPhone,
      email:
        typeof email === 'string' && email.trim() ? email.trim() : null,
      kycType: normalizedKyc,
      kycRef: trimmedKycRef,
      kycImageUrl: kycImageUrl ?? null,
      foodPreference: normalizeFoodPreference(foodPreference),
    });

    await resident.save();
    return res.status(201).json(toResidentResponse(resident));
  } catch (error) {
    console.error('createResident error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error creating resident.' },
    });
  }
};

export const updateResident = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { id } = req.params;
    const { name, phone, email, kycType, kycRef, kycImageUrl, foodPreference } = req.body;

    const resident = await Resident.findOne({ _id: id, ownerId, deletedAt: null });
    if (!resident) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Resident not found.' },
      });
    }

    if (typeof phone === 'string' && phone.trim() && phone.trim() !== resident.phone) {
      const trimmedPhone = phone.trim();
      if (!PHONE_REGEX.test(trimmedPhone)) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'phone must be exactly 10 digits.' },
        });
      }
      const existing = await Resident.findOne({
        ownerId,
        phone: trimmedPhone,
        deletedAt: null,
      });
      if (existing) {
        return res.status(400).json({
          error: {
            code: 'DUPLICATE_PHONE',
            message: 'A resident with this phone number already exists.',
          },
        });
      }
      resident.phone = trimmedPhone;
    }

    if (typeof name === 'string' && name.trim()) {
      const trimmedName = name.trim();
      if (trimmedName.length > MAX_NAME_LENGTH) {
        return res.status(400).json({
          error: {
            code: 'BAD_REQUEST',
            message: `name must be ${MAX_NAME_LENGTH} characters or fewer.`,
          },
        });
      }
      resident.name = trimmedName;
    }
    if (email !== undefined) {
      resident.email =
        typeof email === 'string' && email.trim() ? email.trim() : null;
    }
    const normalizedKyc = normalizeKycType(kycType);
    if (normalizedKyc) resident.kycType = normalizedKyc;
    if (typeof kycRef === 'string' && kycRef.trim()) resident.kycRef = kycRef.trim();
    if (kycImageUrl !== undefined) resident.kycImageUrl = kycImageUrl;
    if (foodPreference !== undefined) {
      resident.foodPreference = normalizeFoodPreference(foodPreference);
    }

    await resident.save();
    const occupancy = await getOccupancyByResidentIds(ownerId, [resident._id]);
    return res
      .status(200)
      .json(toResidentResponse(resident, occupancy.get(resident._id)));
  } catch (error) {
    console.error('updateResident error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error updating resident.' },
    });
  }
};

export const deleteResident = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { id } = req.params;
    const resident = await Resident.findOne({ _id: id, ownerId, deletedAt: null });
    if (!resident) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Resident not found.' },
      });
    }

    const activeStay = await Stay.findOne({
      ownerId,
      residentId: id,
      checkOutDate: null,
      deletedAt: null,
    });
    if (activeStay) {
      return res.status(400).json({
        error: {
          code: 'RESIDENT_ACTIVE',
          message: 'Cannot delete a resident with an active stay. Check out first.',
        },
      });
    }

    resident.deletedAt = new Date();
    await resident.save();
    return res.status(200).json({
      success: true,
      message: 'Resident soft-deleted successfully.',
    });
  } catch (error) {
    console.error('deleteResident error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error deleting resident.' },
    });
  }
};
