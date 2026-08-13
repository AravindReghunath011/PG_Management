import { Response } from 'express';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Branch, IBranch } from './branch.model';
import { Room } from '../rooms/room.model';
import { Bed } from '../beds/bed.model';
import { v4 as uuidv4 } from 'uuid';

type BranchStats = {
  roomCount: number;
  totalBeds: number;
  occupiedBeds: number;
};

type BranchResponse = {
  id: string;
  _id: string;
  ownerId: string;
  name: string;
  address: string;
  roomCount: number;
  totalBeds: number;
  occupiedBeds: number;
  createdAt?: Date;
  updatedAt?: Date;
};

function toBranchResponse(
  branch: IBranch,
  stats: BranchStats = { roomCount: 0, totalBeds: 0, occupiedBeds: 0 }
): BranchResponse {
  return {
    id: branch._id,
    _id: branch._id,
    ownerId: branch.ownerId,
    name: branch.name,
    address: branch.address,
    roomCount: stats.roomCount,
    totalBeds: stats.totalBeds,
    occupiedBeds: stats.occupiedBeds,
    createdAt: branch.createdAt,
    updatedAt: branch.updatedAt,
  };
}

async function getStatsByBranchIds(
  ownerId: string | undefined,
  branchIds: string[]
): Promise<Map<string, BranchStats>> {
  const statsMap = new Map<string, BranchStats>();
  for (const id of branchIds) {
    statsMap.set(id, { roomCount: 0, totalBeds: 0, occupiedBeds: 0 });
  }
  if (branchIds.length === 0) return statsMap;

  const rooms = await Room.find({
    ...(ownerId ? { ownerId } : {}),
    branchId: { $in: branchIds },
    deletedAt: null,
  }).select('_id branchId');

  for (const room of rooms) {
    const stats = statsMap.get(room.branchId);
    if (stats) stats.roomCount += 1;
  }

  const allRoomIds = rooms.map((r) => r._id);
  if (allRoomIds.length === 0) return statsMap;

  const beds = await Bed.find({
    ...(ownerId ? { ownerId } : {}),
    roomId: { $in: allRoomIds },
    deletedAt: null,
  }).select('roomId status');

  const roomToBranch = new Map<string, string>();
  for (const room of rooms) {
    roomToBranch.set(room._id, room.branchId);
  }

  for (const bed of beds) {
    const branchId = roomToBranch.get(bed.roomId);
    if (!branchId) continue;
    const stats = statsMap.get(branchId);
    if (!stats) continue;
    stats.totalBeds += 1;
    if (bed.status === 'occupied') stats.occupiedBeds += 1;
  }

  return statsMap;
}

export const getBranches = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const branches = await Branch.find({
      ...(ownerId ? { ownerId } : {}),
      deletedAt: null,
    }).sort({ createdAt: -1 });

    const statsMap = await getStatsByBranchIds(
      ownerId,
      branches.map((b) => b._id)
    );

    return res.status(200).json(
      branches.map((b) =>
        toBranchResponse(b, statsMap.get(b._id) ?? undefined)
      )
    );
  } catch (error) {
    console.error('getBranches error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving branches.' },
    });
  }
};

export const getBranchById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const { id } = req.params;
    const branch = await Branch.findOne({
      _id: id,
      ...(ownerId ? { ownerId } : {}),
      deletedAt: null,
    });
    if (!branch) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Branch not found.' },
      });
    }

    const statsMap = await getStatsByBranchIds(ownerId, [branch._id]);
    return res
      .status(200)
      .json(toBranchResponse(branch, statsMap.get(branch._id)));
  } catch (error) {
    console.error('getBranchById error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving branch.' },
    });
  }
};

export const createBranch = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, address, id } = req.body;
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const trimmedAddress = typeof address === 'string' ? address.trim() : '';

    if (!trimmedName || !trimmedAddress) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Name and address are required.',
        },
      });
    }

    const branch = new Branch({
      _id: id || uuidv4(),
      ownerId: req.ownerId,
      name: trimmedName,
      address: trimmedAddress,
    });

    await branch.save();
    return res.status(201).json(toBranchResponse(branch));
  } catch (error) {
    console.error('createBranch error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error creating branch.' },
    });
  }
};

export const updateBranch = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { id } = req.params;
    const { name, address } = req.body;

    const branch = await Branch.findOne({ _id: id, ownerId, deletedAt: null });
    if (!branch) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Branch not found.' },
      });
    }

    if (typeof name === 'string' && name.trim()) {
      branch.name = name.trim();
    }
    if (typeof address === 'string' && address.trim()) {
      branch.address = address.trim();
    }

    await branch.save();

    const statsMap = await getStatsByBranchIds(ownerId, [branch._id]);
    return res
      .status(200)
      .json(toBranchResponse(branch, statsMap.get(branch._id)));
  } catch (error) {
    console.error('updateBranch error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error updating branch.' },
    });
  }
};

export const deleteBranch = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const branch = await Branch.findOne({
      _id: id,
      ownerId: req.ownerId,
      deletedAt: null,
    });
    if (!branch) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Branch not found.' },
      });
    }

    branch.deletedAt = new Date();
    await branch.save();
    return res.status(200).json({
      success: true,
      message: 'Branch soft-deleted successfully.',
    });
  } catch (error) {
    console.error('deleteBranch error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error deleting branch.' },
    });
  }
};
