import { Response } from 'express';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Room, IRoom } from './room.model';
import { Bed } from '../beds/bed.model';
import { Branch } from '../branches/branch.model';
import { parseRentPaise } from '../../utils/rent';
import { v4 as uuidv4 } from 'uuid';

type RoomStats = { totalBeds: number; occupiedBeds: number };

type RoomResponse = {
  id: string;
  _id: string;
  ownerId: string;
  branchId: string;
  roomNumber: string;
  floor: number;
  type: string;
  amenities: string[];
  rentPaise: number | null;
  totalBeds: number;
  occupiedBeds: number;
  createdAt?: Date;
  updatedAt?: Date;
};

function roomTypeFromBedCount(totalBeds: number): string {
  switch (totalBeds) {
    case 0:
      return 'No beds';
    case 1:
      return 'Single';
    case 2:
      return 'Double Sharing';
    case 3:
      return 'Triple Sharing';
    case 4:
      return 'Quad Sharing';
    default:
      return `${totalBeds}-Sharing`;
  }
}

function toRoomResponse(room: IRoom, stats: RoomStats = { totalBeds: 0, occupiedBeds: 0 }): RoomResponse {
  return {
    id: room._id,
    _id: room._id,
    ownerId: room.ownerId,
    branchId: room.branchId,
    roomNumber: room.roomNumber,
    floor: room.floor,
    type: roomTypeFromBedCount(stats.totalBeds),
    amenities: room.amenities ?? [],
    rentPaise: room.rentPaise ?? null,
    totalBeds: stats.totalBeds,
    occupiedBeds: stats.occupiedBeds,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

async function getStatsByRoomIds(
  ownerId: string | undefined,
  roomIds: string[]
): Promise<Map<string, RoomStats>> {
  const statsMap = new Map<string, RoomStats>();
  for (const id of roomIds) {
    statsMap.set(id, { totalBeds: 0, occupiedBeds: 0 });
  }
  if (roomIds.length === 0) return statsMap;

  const beds = await Bed.find({
    ...(ownerId ? { ownerId } : {}),
    roomId: { $in: roomIds },
    deletedAt: null,
  }).select('roomId status');

  for (const bed of beds) {
    const stats = statsMap.get(bed.roomId);
    if (!stats) continue;
    stats.totalBeds += 1;
    if (bed.status === 'occupied') stats.occupiedBeds += 1;
  }

  return statsMap;
}

const BED_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const getRooms = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const { branchId, floor } = req.query;
    const filter: Record<string, unknown> = { deletedAt: null };
    if (ownerId) filter.ownerId = ownerId;
    if (branchId) filter.branchId = branchId;
    if (floor !== undefined && floor !== '') {
      const floorNum = Number(floor);
      if (!Number.isNaN(floorNum)) filter.floor = floorNum;
    }

    const rooms = await Room.find(filter).sort({ floor: 1, roomNumber: 1 });
    const statsMap = await getStatsByRoomIds(
      ownerId,
      rooms.map((r) => r._id)
    );

    return res.status(200).json(
      rooms.map((r) => toRoomResponse(r, statsMap.get(r._id)))
    );
  } catch (error) {
    console.error('getRooms error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving rooms.' },
    });
  }
};

export const getRoomById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const { id } = req.params;
    const room = await Room.findOne({
      _id: id,
      ...(ownerId ? { ownerId } : {}),
      deletedAt: null,
    });
    if (!room) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Room not found.' },
      });
    }

    const statsMap = await getStatsByRoomIds(ownerId, [room._id]);
    return res.status(200).json(toRoomResponse(room, statsMap.get(room._id)));
  } catch (error) {
    console.error('getRoomById error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving room.' },
    });
  }
};

/** A live room with the same number in the branch (case-insensitive), if any. */
async function findDuplicateRoom(ownerId: string, branchId: string, roomNumber: string, exceptId?: string) {
  const escaped = roomNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Room.findOne({
    ownerId,
    branchId,
    deletedAt: null,
    roomNumber: { $regex: `^${escaped}$`, $options: 'i' },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
}

export const createRoom = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { branchId, roomNumber, floor, id, bedCount, amenities, rentPaise, bedRentPaise } =
      req.body;

    const rent = parseRentPaise(rentPaise);
    if (rent.kind === 'invalid') {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: rent.message },
      });
    }

    const trimmedNumber =
      typeof roomNumber === 'string' ? roomNumber.trim() : '';
    const floorNum = typeof floor === 'number' ? floor : Number(floor);
    const bedsToCreate =
      bedCount === undefined || bedCount === null || bedCount === ''
        ? 0
        : Number(bedCount);

    if (!branchId || !trimmedNumber || Number.isNaN(floorNum)) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'branchId, roomNumber, and floor are required.',
        },
      });
    }

    if (bedsToCreate < 0 || bedsToCreate > 26 || !Number.isInteger(bedsToCreate)) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'bedCount must be an integer between 0 and 26.',
        },
      });
    }

    // Optional per-bed prices, one per bed in order (null = use room rent).
    const bedRents: (number | null)[] = [];
    if (bedRentPaise !== undefined && bedRentPaise !== null) {
      if (!Array.isArray(bedRentPaise) || bedRentPaise.length > bedsToCreate) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'bedRentPaise must be a list with at most one price per bed.' },
        });
      }
      for (const value of bedRentPaise) {
        const parsed = parseRentPaise(value);
        if (parsed.kind === 'invalid') {
          return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.message } });
        }
        bedRents.push(parsed.kind === 'ok' ? parsed.value : null);
      }
    }

    const branch = await Branch.findOne({
      _id: branchId,
      ownerId,
      deletedAt: null,
    });
    if (!branch) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Branch not found.' },
      });
    }

    if (await findDuplicateRoom(ownerId, branchId, trimmedNumber)) {
      return res.status(409).json({
        error: { code: 'DUPLICATE_ROOM', message: `Room ${trimmedNumber} already exists in ${branch.name}.` },
      });
    }

    const roomId = id || uuidv4();
    const room = new Room({
      _id: roomId,
      ownerId,
      branchId,
      roomNumber: trimmedNumber,
      floor: floorNum,
      amenities: Array.isArray(amenities) ? amenities : [],
      rentPaise: rent.kind === 'ok' ? rent.value : null,
    });
    await room.save();

    if (bedsToCreate > 0) {
      const beds = Array.from({ length: bedsToCreate }, (_, i) => ({
        _id: uuidv4(),
        ownerId,
        roomId,
        bedNumber: BED_LETTERS[i],
        status: 'vacant' as const,
        rentPaise: bedRents[i] ?? null,
      }));
      await Bed.insertMany(beds);
    }

    const statsMap = await getStatsByRoomIds(ownerId, [roomId]);
    return res.status(201).json(toRoomResponse(room, statsMap.get(roomId)));
  } catch (error) {
    console.error('createRoom error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error creating room.' },
    });
  }
};

export const updateRoom = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { id } = req.params;
    const { roomNumber, floor, amenities, rentPaise } = req.body;

    const rent = parseRentPaise(rentPaise);
    if (rent.kind === 'invalid') {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: rent.message },
      });
    }

    const room = await Room.findOne({ _id: id, ownerId, deletedAt: null });
    if (!room) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Room not found.' },
      });
    }

    if (typeof roomNumber === 'string' && roomNumber.trim()) {
      if (await findDuplicateRoom(room.ownerId, room.branchId, roomNumber.trim(), room._id)) {
        return res.status(409).json({
          error: { code: 'DUPLICATE_ROOM', message: `Room ${roomNumber.trim()} already exists in this property.` },
        });
      }
      room.roomNumber = roomNumber.trim();
    }
    if (floor !== undefined && floor !== null && floor !== '') {
      const floorNum = typeof floor === 'number' ? floor : Number(floor);
      if (Number.isNaN(floorNum)) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'floor must be a number.' },
        });
      }
      room.floor = floorNum;
    }
    if (Array.isArray(amenities)) {
      room.amenities = amenities;
    }
    // 'absent' leaves the stored override untouched; an explicit null clears it.
    if (rent.kind === 'ok') {
      room.rentPaise = rent.value;
    }

    await room.save();
    const statsMap = await getStatsByRoomIds(ownerId, [room._id]);
    return res.status(200).json(toRoomResponse(room, statsMap.get(room._id)));
  } catch (error) {
    console.error('updateRoom error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error updating room.' },
    });
  }
};

export const deleteRoom = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const room = await Room.findOne({
      _id: id,
      ownerId: req.ownerId,
      deletedAt: null,
    });
    if (!room) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Room not found.' },
      });
    }

    const occupied = await Bed.countDocuments({ ownerId: req.ownerId, roomId: room._id, deletedAt: null, status: 'occupied' });
    if (occupied > 0) {
      return res.status(400).json({
        error: {
          code: 'ROOM_OCCUPIED',
          message: `Room ${room.roomNumber} has ${occupied} occupied bed${occupied === 1 ? '' : 's'}. Vacate the residents first.`,
        },
      });
    }

    const now = new Date();
    room.deletedAt = now;
    await room.save();
    // Its (vacant) beds go with it; stay history keeps pointing at them.
    await Bed.updateMany({ ownerId: req.ownerId, roomId: room._id, deletedAt: null }, { $set: { deletedAt: now } });
    return res.status(200).json({
      success: true,
      message: 'Room soft-deleted successfully.',
    });
  } catch (error) {
    console.error('deleteRoom error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error deleting room.' },
    });
  }
};
