import { Bed } from '../beds/bed.model';
import { Room } from '../rooms/room.model';
import { Branch } from '../branches/branch.model';

/** Where a stay happened, for display in history. */
export type StayPlace = {
  bedLabel: string | null; // "101-A"
  roomNumber: string | null;
  bedNumber: string | null;
  branchId: string | null;
  branchName: string | null;
  /** The bed, its room or its property has since been (soft-)deleted. */
  placeRemoved: boolean;
};

/**
 * Resolves bed → room → branch labels for stay history, keyed by bedId.
 *
 * Deliberately includes soft-deleted beds, rooms and branches: history is
 * permanent, so a stay in a property that was later removed must still say
 * where it was. Always owner-scoped.
 */
export async function resolveStayPlaces(
  ownerId: string | undefined,
  bedIds: string[]
): Promise<Map<string, StayPlace>> {
  const scope = ownerId ? { ownerId } : {};
  const places = new Map<string, StayPlace>();
  const uniqueBedIds = [...new Set(bedIds)];
  if (uniqueBedIds.length === 0) return places;

  const beds = await Bed.find({ ...scope, _id: { $in: uniqueBedIds } });
  const rooms = await Room.find({ ...scope, _id: { $in: [...new Set(beds.map((b) => b.roomId))] } });
  const roomById = new Map(rooms.map((r) => [r._id, r]));
  const branches = await Branch.find({ ...scope, _id: { $in: [...new Set(rooms.map((r) => r.branchId))] } });
  const branchById = new Map(branches.map((b) => [b._id, b]));

  for (const bed of beds) {
    const room = roomById.get(bed.roomId);
    const branch = room ? branchById.get(room.branchId) : undefined;
    places.set(bed._id, {
      bedLabel: room ? `${room.roomNumber}-${bed.bedNumber}` : null,
      roomNumber: room?.roomNumber ?? null,
      bedNumber: bed.bedNumber,
      branchId: branch?._id ?? null,
      branchName: branch?.name ?? null,
      placeRemoved: !!(bed.deletedAt || room?.deletedAt || branch?.deletedAt),
    });
  }
  return places;
}

/** "staying" while a stay is open, "notice" if that stay has a move-out date, else "moved_out". */
export function residencyStatus(
  stays: { checkOutDate: Date | null; noticeMoveOutDate?: Date | null }[]
): 'staying' | 'notice' | 'moved_out' {
  const open = stays.find((s) => !s.checkOutDate);
  if (!open) return 'moved_out';
  return open.noticeMoveOutDate ? 'notice' : 'staying';
}
