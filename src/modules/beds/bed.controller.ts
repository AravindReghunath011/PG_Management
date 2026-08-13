import { Response } from 'express';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Bed, IBed } from './bed.model';
import { Room } from '../rooms/room.model';
import { Branch } from '../branches/branch.model';
import { Stay } from '../stays/stay.model';
import { Resident } from '../residents/resident.model';
import { v4 as uuidv4 } from 'uuid';

type BedResponse = {
  id: string;
  _id: string;
  ownerId: string;
  roomId: string;
  roomNumber: string | null;
  branchId: string | null;
  branchName: string | null;
  bedNumber: string;
  label: string;
  status: 'vacant' | 'occupied';
  residentId: string | null;
  residentName: string | null;
  residentPhone: string | null;
  monthlyRent: number | null;
  checkInDate: string | null;
  stayId: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

function toBedResponse(
  bed: IBed,
  extras?: {
    roomNumber?: string | null;
    branchId?: string | null;
    branchName?: string | null;
    residentId?: string | null;
    residentName?: string | null;
    residentPhone?: string | null;
    monthlyRent?: number | null;
    checkInDate?: string | null;
    stayId?: string | null;
  }
): BedResponse {
  const roomNumber = extras?.roomNumber ?? null;
  const label = roomNumber
    ? `Room ${roomNumber}-${bed.bedNumber}`
    : `Bed ${bed.bedNumber}`;

  return {
    id: bed._id,
    _id: bed._id,
    ownerId: bed.ownerId,
    roomId: bed.roomId,
    roomNumber,
    branchId: extras?.branchId ?? null,
    branchName: extras?.branchName ?? null,
    bedNumber: bed.bedNumber,
    label: extras?.branchName ? `${label} (${extras.branchName})` : label,
    status: bed.status,
    residentId: extras?.residentId ?? null,
    residentName: extras?.residentName ?? null,
    residentPhone: extras?.residentPhone ?? null,
    monthlyRent: extras?.monthlyRent ?? null,
    checkInDate: extras?.checkInDate ?? null,
    stayId: extras?.stayId ?? null,
    createdAt: bed.createdAt,
    updatedAt: bed.updatedAt,
  };
}

async function getOccupancyByBedIds(
  ownerId: string | undefined,
  bedIds: string[]
): Promise<
  Map<
    string,
    {
      residentId: string | null;
      residentName: string | null;
      residentPhone: string | null;
      monthlyRent: number | null;
      checkInDate: string | null;
      stayId: string | null;
    }
  >
> {
  const map = new Map<
    string,
    {
      residentId: string | null;
      residentName: string | null;
      residentPhone: string | null;
      monthlyRent: number | null;
      checkInDate: string | null;
      stayId: string | null;
    }
  >();

  if (bedIds.length === 0) return map;

  const stays = await Stay.find({
    ...(ownerId ? { ownerId } : {}),
    bedId: { $in: bedIds },
    checkOutDate: null,
    deletedAt: null,
  });

  const residentIds = [...new Set(stays.map((s) => s.residentId))];
  const residents = await Resident.find({
    ...(ownerId ? { ownerId } : {}),
    _id: { $in: residentIds },
    deletedAt: null,
  });
  const residentById = new Map(residents.map((r) => [r._id, r]));

  for (const stay of stays) {
    const resident = residentById.get(stay.residentId);
    map.set(stay.bedId, {
      residentId: stay.residentId,
      residentName: resident?.name ?? null,
      residentPhone: resident?.phone ?? null,
      monthlyRent: stay.monthlyRent,
      checkInDate: stay.checkInDate
        ? stay.checkInDate.toISOString().slice(0, 10)
        : null,
      stayId: stay._id,
    });
  }

  return map;
}

export const getBeds = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const { roomId, status } = req.query;
    const filter: Record<string, unknown> = { deletedAt: null };
    if (ownerId) filter.ownerId = ownerId;
    if (roomId) filter.roomId = roomId;
    if (status === 'vacant' || status === 'occupied') filter.status = status;

    const beds = await Bed.find(filter).sort({ bedNumber: 1 });
    const occupancy = await getOccupancyByBedIds(
      ownerId,
      beds.map((b) => b._id)
    );

    const roomIds = [...new Set(beds.map((b) => b.roomId))];
    const rooms = await Room.find({
      ...(ownerId ? { ownerId } : {}),
      _id: { $in: roomIds },
      deletedAt: null,
    });
    const roomById = new Map(rooms.map((r) => [r._id, r]));
    const branchIds = [...new Set(rooms.map((r) => r.branchId))];
    const branches = await Branch.find({
      ...(ownerId ? { ownerId } : {}),
      _id: { $in: branchIds },
      deletedAt: null,
    });
    const branchById = new Map(branches.map((b) => [b._id, b]));

    return res.status(200).json(
      beds.map((b) => {
        const room = roomById.get(b.roomId);
        const branch = room ? branchById.get(room.branchId) : undefined;
        const occ = occupancy.get(b._id);
        return toBedResponse(b, {
          roomNumber: room?.roomNumber ?? null,
          branchId: branch?._id ?? null,
          branchName: branch?.name ?? null,
          ...occ,
        });
      })
    );
  } catch (error) {
    console.error('getBeds error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving beds.' },
    });
  }
};

export const getBedById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const { id } = req.params;

    const bed = await Bed.findOne({
      _id: id,
      ...(ownerId ? { ownerId } : {}),
      deletedAt: null,
    });
    if (!bed) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Bed not found.' },
      });
    }

    const room = await Room.findOne({
      _id: bed.roomId,
      ...(ownerId ? { ownerId } : {}),
      deletedAt: null,
    });
    const branch = room
      ? await Branch.findOne({
          _id: room.branchId,
          ...(ownerId ? { ownerId } : {}),
          deletedAt: null,
        })
      : null;
    const occupancy = await getOccupancyByBedIds(ownerId, [bed._id]);

    return res.status(200).json(
      toBedResponse(bed, {
        roomNumber: room?.roomNumber ?? null,
        branchId: branch?._id ?? null,
        branchName: branch?.name ?? null,
        ...occupancy.get(bed._id),
      })
    );
  } catch (error) {
    console.error('getBedById error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving bed.' },
    });
  }
};

export const createBed = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { roomId, bedNumber, id } = req.body;
    const trimmed =
      typeof bedNumber === 'string' ? bedNumber.trim().toUpperCase() : '';

    if (!roomId || !trimmed) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'roomId and bedNumber are required.',
        },
      });
    }

    const room = await Room.findOne({ _id: roomId, ownerId, deletedAt: null });
    if (!room) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Room not found.' },
      });
    }

    const existing = await Bed.findOne({
      ownerId,
      roomId,
      bedNumber: trimmed,
      deletedAt: null,
    });
    if (existing) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: `Bed ${trimmed} already exists in this room.`,
        },
      });
    }

    const bed = new Bed({
      _id: id || uuidv4(),
      ownerId,
      roomId,
      bedNumber: trimmed,
      status: 'vacant',
    });
    await bed.save();
    return res.status(201).json(
      toBedResponse(bed, {
        roomNumber: room.roomNumber,
        branchId: room.branchId,
      })
    );
  } catch (error) {
    console.error('createBed error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error creating bed.' },
    });
  }
};

export const updateBed = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { id } = req.params;
    const { bedNumber, status } = req.body;

    const bed = await Bed.findOne({ _id: id, ownerId, deletedAt: null });
    if (!bed) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Bed not found.' },
      });
    }

    if (typeof bedNumber === 'string' && bedNumber.trim()) {
      bed.bedNumber = bedNumber.trim().toUpperCase();
    }
    if (status === 'vacant' || status === 'occupied') {
      bed.status = status;
    }

    await bed.save();
    const occupancy = await getOccupancyByBedIds(ownerId, [bed._id]);
    return res.status(200).json(toBedResponse(bed, occupancy.get(bed._id)));
  } catch (error) {
    console.error('updateBed error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error updating bed.' },
    });
  }
};

export const deleteBed = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const bed = await Bed.findOne({
      _id: id,
      ownerId: req.ownerId,
      deletedAt: null,
    });
    if (!bed) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Bed not found.' },
      });
    }

    if (bed.status === 'occupied') {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Cannot delete an occupied bed. Check out the resident first.',
        },
      });
    }

    bed.deletedAt = new Date();
    await bed.save();
    return res.status(200).json({
      success: true,
      message: 'Bed soft-deleted successfully.',
    });
  } catch (error) {
    console.error('deleteBed error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error deleting bed.' },
    });
  }
};
