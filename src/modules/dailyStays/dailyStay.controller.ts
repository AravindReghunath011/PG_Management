import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { AuthenticatedRequest } from '../../middleware/auth';
import { Bed } from '../beds/bed.model';
import { resolveStayPlaces } from '../stays/stayPlaces';
import { DailyStay, IDailyStay, daysCharged } from './dailyStay.model';

const DAY = 86_400_000;
const LIST_WINDOW_DAYS = 60;

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

const asDate = (v: unknown) => {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const asPaise = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const cleanPhone = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : '');
const PHONE_RE = /^[6-9]\d{9}$/;

function toResponse(s: IDailyStay, place?: { bedLabel: string | null; branchName: string | null }, now = new Date()) {
  const days = daysCharged(s.checkInAt, s.checkOutAt ?? now);
  const totalPaise = days * s.dailyRatePaise;
  return {
    id: s._id,
    bedId: s.bedId,
    bedLabel: place?.bedLabel ?? null,
    branchName: place?.branchName ?? null,
    name: s.name,
    phone: s.phone,
    checkInAt: s.checkInAt,
    expectedCheckOutAt: s.expectedCheckOutAt,
    checkOutAt: s.checkOutAt,
    dailyRatePaise: s.dailyRatePaise,
    amountPaidPaise: s.amountPaidPaise,
    note: s.note,
    days,
    totalPaise,
    balancePaise: Math.max(0, totalPaise - s.amountPaidPaise),
  };
}

async function respondWith(res: Response, ownerId: string, stays: IDailyStay[], status = 200) {
  const places = await resolveStayPlaces(ownerId, stays.map((s) => s.bedId));
  const now = new Date();
  const out = stays.map((s) => toResponse(s, places.get(s.bedId), now));
  return res.status(status).json(out);
}

/** GET /api/daily-stays — staying now, plus anyone checked out in the last 60 days. */
export const listDailyStays = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const since = new Date(Date.now() - LIST_WINDOW_DAYS * DAY);
    const stays = await DailyStay.find({
      ownerId,
      deletedAt: null,
      $or: [{ checkOutAt: null }, { checkOutAt: { $gte: since } }],
    })
      .sort({ checkOutAt: 1, checkInAt: -1 })
      .lean();
    return respondWith(res, ownerId, stays);
  } catch (error) {
    console.error('listDailyStays error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error loading daily tenants.');
  }
};

/** POST /api/daily-stays — check someone in to a free bed. */
export const checkInDailyStay = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const phone = cleanPhone(body.phone);
    const checkInAt = asDate(body.checkInAt) ?? new Date();
    const expectedCheckOutAt = asDate(body.expectedCheckOutAt);
    const rate = asPaise(body.dailyRatePaise);
    const paid = asPaise(body.amountPaidPaise ?? 0);
    if (!name || name.length > 50) return fail(res, 400, 'BAD_REQUEST', 'Enter the name (up to 50 letters).');
    if (!PHONE_RE.test(phone)) return fail(res, 400, 'BAD_REQUEST', 'Enter a 10-digit mobile number starting with 6–9.');
    if (!expectedCheckOutAt || expectedCheckOutAt <= checkInAt) {
      return fail(res, 400, 'BAD_REQUEST', 'The leaving date must be after the check-in date.');
    }
    if (!rate) return fail(res, 400, 'BAD_REQUEST', 'Enter the rent per day.');
    if (paid === null) return fail(res, 400, 'BAD_REQUEST', 'Enter the amount paid (0 if nothing yet).');

    // Claim the bed atomically: only a vacant bed can be taken.
    const bed = await Bed.findOneAndUpdate(
      { _id: body.bedId, ownerId, deletedAt: null, status: 'vacant' },
      { $set: { status: 'occupied' } },
      { new: true },
    );
    if (!bed) return fail(res, 409, 'BED_OCCUPIED', 'This bed is not free. Choose another bed.');

    try {
      const stay = await DailyStay.create({
        _id: typeof body.id === 'string' && body.id ? body.id : uuidv4(),
        ownerId,
        bedId: bed._id,
        name,
        phone,
        checkInAt,
        expectedCheckOutAt,
        dailyRatePaise: rate,
        amountPaidPaise: paid,
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : null,
      });
      return respondWith(res, ownerId, [stay.toObject()], 201).then(() => undefined);
    } catch (error) {
      await Bed.updateOne({ _id: bed._id, ownerId }, { $set: { status: 'vacant' } });
      throw error;
    }
  } catch (error) {
    console.error('checkInDailyStay error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error checking in.');
  }
};

/** PUT /api/daily-stays/:id — fix the name, phone, leaving date, rate or amount paid. */
export const updateDailyStay = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const stay = await DailyStay.findOne({ _id: req.params.id, ownerId, deletedAt: null });
    if (!stay) return fail(res, 404, 'NOT_FOUND', 'Daily tenant not found.');
    const body = req.body ?? {};

    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 50) return fail(res, 400, 'BAD_REQUEST', 'Enter the name (up to 50 letters).');
      stay.name = name;
    }
    if ('phone' in body) {
      const phone = cleanPhone(body.phone);
      if (!PHONE_RE.test(phone)) return fail(res, 400, 'BAD_REQUEST', 'Enter a 10-digit mobile number starting with 6–9.');
      stay.phone = phone;
    }
    if ('checkInAt' in body) {
      const d = asDate(body.checkInAt);
      if (!d) return fail(res, 400, 'BAD_REQUEST', 'Enter the check-in date.');
      stay.checkInAt = d;
    }
    if ('expectedCheckOutAt' in body) {
      const d = asDate(body.expectedCheckOutAt);
      if (!d) return fail(res, 400, 'BAD_REQUEST', 'Enter the leaving date.');
      stay.expectedCheckOutAt = d;
    }
    if (stay.expectedCheckOutAt <= stay.checkInAt) {
      return fail(res, 400, 'BAD_REQUEST', 'The leaving date must be after the check-in date.');
    }
    if ('dailyRatePaise' in body) {
      const rate = asPaise(body.dailyRatePaise);
      if (!rate) return fail(res, 400, 'BAD_REQUEST', 'Enter the rent per day.');
      stay.dailyRatePaise = rate;
    }
    if ('amountPaidPaise' in body) {
      const paid = asPaise(body.amountPaidPaise);
      if (paid === null) return fail(res, 400, 'BAD_REQUEST', 'Enter the amount paid (0 if nothing yet).');
      stay.amountPaidPaise = paid;
    }
    if ('note' in body) stay.note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : null;

    await stay.save();
    return respondWith(res, ownerId, [stay.toObject()]).then(() => undefined);
  } catch (error) {
    console.error('updateDailyStay error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error saving changes.');
  }
};

/** POST /api/daily-stays/:id/check-out — they leave; the bed is free again. */
export const checkOutDailyStay = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const stay = await DailyStay.findOne({ _id: req.params.id, ownerId, deletedAt: null });
    if (!stay) return fail(res, 404, 'NOT_FOUND', 'Daily tenant not found.');
    if (stay.checkOutAt) return fail(res, 409, 'ALREADY_CHECKED_OUT', 'Already checked out.');

    const at = asDate(req.body?.checkOutAt) ?? new Date();
    if (at < stay.checkInAt) return fail(res, 400, 'BAD_REQUEST', 'Check-out can’t be before check-in.');
    const paid = req.body?.amountPaidPaise === undefined ? stay.amountPaidPaise : asPaise(req.body.amountPaidPaise);
    if (paid === null) return fail(res, 400, 'BAD_REQUEST', 'Enter the amount paid.');

    stay.checkOutAt = at;
    stay.amountPaidPaise = paid;
    await stay.save();
    await Bed.updateOne({ _id: stay.bedId, ownerId }, { $set: { status: 'vacant' } });
    return respondWith(res, ownerId, [stay.toObject()]).then(() => undefined);
  } catch (error) {
    console.error('checkOutDailyStay error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error checking out.');
  }
};

/** DELETE /api/daily-stays/:id — remove an entry made by mistake (soft delete); frees the bed if still open. */
export const deleteDailyStay = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const stay = await DailyStay.findOne({ _id: req.params.id, ownerId, deletedAt: null });
    if (!stay) return fail(res, 404, 'NOT_FOUND', 'Daily tenant not found.');
    const wasOpen = !stay.checkOutAt;
    stay.deletedAt = new Date();
    await stay.save();
    if (wasOpen) await Bed.updateOne({ _id: stay.bedId, ownerId }, { $set: { status: 'vacant' } });
    return res.json({ id: stay._id, deleted: true });
  } catch (error) {
    console.error('deleteDailyStay error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error deleting.');
  }
};
