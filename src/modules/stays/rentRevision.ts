import { Response } from 'express';

import { AuthenticatedRequest } from '../../middleware/auth';
import { Stay } from './stay.model';
import { Bed } from '../beds/bed.model';
import { Room } from '../rooms/room.model';
import { Branch } from '../branches/branch.model';
import { Resident } from '../residents/resident.model';

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

const ROUNDINGS = [1, 10, 50, 100]; // rupees

/** New monthly rent in paise, rounded to the nearest `roundToRupees`. */
export function revisedRent(rentPaise: number, mode: 'percent' | 'amount', value: number, roundToRupees: number) {
  const raw = mode === 'percent' ? rentPaise * (1 + value / 100) : rentPaise + value;
  const step = roundToRupees * 100;
  return Math.round(raw / step) * step;
}

/**
 * POST /api/stays/rent-revision — raise the monthly rent of every current
 * Resident at once (optionally one Branch). Body:
 *   mode: 'percent' | 'amount'   value: % (0–100) or paise to add
 *   branchId?: one property; omitted = all
 *   roundToRupees?: 1 | 10 | 50 | 100 (default 10)
 *   includeOnNotice?: also raise Residents serving notice (default false)
 *   excludeStayIds?: Residents to leave as they are
 *   preview?: true = only show what would change
 *
 * Changes Stay.monthlyRent only, exactly like editing one Resident's rent:
 * rent dues already created keep their amount; the new rent applies from the
 * next due.
 */
export const reviseRents = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const body = req.body ?? {};
    const mode = body.mode;
    const value = Number(body.value);
    const roundToRupees = body.roundToRupees === undefined ? 10 : Number(body.roundToRupees);
    const branchId = typeof body.branchId === 'string' && body.branchId ? body.branchId : null;
    const exclude = new Set<string>(Array.isArray(body.excludeStayIds) ? body.excludeStayIds.map(String) : []);
    const includeOnNotice = body.includeOnNotice === true;
    const preview = body.preview === true;

    if (mode !== 'percent' && mode !== 'amount') {
      return fail(res, 400, 'BAD_REQUEST', "mode must be 'percent' or 'amount'.");
    }
    if (!Number.isFinite(value) || value <= 0 || (mode === 'percent' && value > 100) || (mode === 'amount' && !Number.isInteger(value))) {
      return fail(res, 400, 'BAD_REQUEST', 'Enter an increase above 0 (at most 100%).');
    }
    if (!ROUNDINGS.includes(roundToRupees)) {
      return fail(res, 400, 'BAD_REQUEST', 'roundToRupees must be 1, 10, 50 or 100.');
    }

    // Current Residents of this Owner (or one Branch), with where they stay.
    let bedFilter: Record<string, unknown> = {};
    if (branchId) {
      const branch = await Branch.findOne({ _id: branchId, ownerId, deletedAt: null }).lean();
      if (!branch) return fail(res, 404, 'NOT_FOUND', 'Property not found.');
      const roomIds = (await Room.find({ ownerId, branchId, deletedAt: null }).select('_id').lean()).map((r) => r._id);
      const bedIds = (await Bed.find({ ownerId, roomId: { $in: roomIds } }).select('_id').lean()).map((b) => b._id);
      bedFilter = { bedId: { $in: bedIds } };
    }
    const stays = await Stay.find({ ownerId, checkOutDate: null, deletedAt: null, ...bedFilter }).lean();

    const [residents, beds] = await Promise.all([
      Resident.find({ ownerId, _id: { $in: stays.map((s) => s.residentId) } }).select('name').lean(),
      Bed.find({ ownerId, _id: { $in: stays.map((s) => s.bedId) } }).select('bedNumber roomId').lean(),
    ]);
    const rooms = await Room.find({ ownerId, _id: { $in: beds.map((b) => b.roomId) } }).select('roomNumber').lean();
    const nameById = new Map(residents.map((r) => [r._id, r.name]));
    const bedById = new Map(beds.map((b) => [b._id, b]));
    const roomById = new Map(rooms.map((r) => [r._id, r]));

    const rows = stays
      .map((stay) => {
        const bed = bedById.get(stay.bedId);
        const onNotice = !!stay.noticeMoveOutDate;
        const skipped = exclude.has(stay._id) ? 'excluded' : onNotice && !includeOnNotice ? 'on_notice' : null;
        const newRent = skipped ? stay.monthlyRent : revisedRent(stay.monthlyRent, mode, value, roundToRupees);
        return {
          stayId: stay._id,
          residentId: stay.residentId,
          residentName: nameById.get(stay.residentId) ?? 'Tenant',
          roomNumber: bed ? roomById.get(bed.roomId)?.roomNumber ?? null : null,
          bedNumber: bed?.bedNumber ?? null,
          onNotice,
          skipped,
          oldRent: stay.monthlyRent,
          newRent,
        };
      })
      .sort((a, b) => (a.roomNumber ?? '').localeCompare(b.roomNumber ?? '', undefined, { numeric: true }));

    const changed = rows.filter((r) => !r.skipped && r.newRent !== r.oldRent);
    if (!preview && changed.length > 0) {
      await Stay.bulkWrite(
        changed.map((r) => ({
          updateOne: {
            // checkOutDate: null again so a checkout in between is never re-priced.
            filter: { _id: r.stayId, ownerId, checkOutDate: null, deletedAt: null },
            update: { $set: { monthlyRent: r.newRent } },
          },
        })),
      );
    }

    return res.json({
      applied: !preview,
      changedCount: changed.length,
      totalBefore: rows.reduce((n, r) => n + r.oldRent, 0),
      totalAfter: rows.reduce((n, r) => n + r.newRent, 0),
      rows,
    });
  } catch (error) {
    console.error('reviseRents error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error updating rents.');
  }
};
