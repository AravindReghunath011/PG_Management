import { v4 as uuidv4 } from 'uuid';
import { Payment } from './payment.model';
import { Stay } from '../stays/stay.model';
import { Owner } from '../auth/owner.model';

/**
 * Automatic monthly rent dues.
 *
 * Every open stay owes one rent due per calendar month, falling on the owner's
 * rent due day if set (Settings), else on the stay's check-in day (clamped to
 * the month's length, so a 31st check-in falls due on the 30th). "Expected rent" for a period is then simply the
 * sum of its dues, and paid/partial/overdue all work off the same records.
 *
 * Rules for month M:
 *  - only months up to the current month (never future months);
 *  - only if M's due date is on/after the check-in day, before the checkout
 *    date, and before a notice move-out date (someone leaving before their
 *    due date doesn't owe the next cycle);
 *  - skipped when the stay already has a due dated in M — hand-made ones
 *    included, live or soft-deleted (an owner-deleted due stays deleted).
 *    An automatic due voided by checkout/notice (voidAutoDuesFrom) is
 *    restored instead, so cancelling a notice brings it back.
 *
 * Months are calendar months in the business's local time (India by default,
 * BUSINESS_UTC_OFFSET_MINUTES), and generated dues are dated at local noon.
 * Generated dues carry `dueMonth`; a unique index on {ownerId, stayId,
 * dueMonth} makes concurrent calls safe.
 */

const OFFSET_MS = Number(process.env.BUSINESS_UTC_OFFSET_MINUTES ?? 330) * 60_000;

type YM = { y: number; m: number }; // m is 0-based

/** Local calendar date parts of an instant. */
function localParts(date: Date) {
  const t = new Date(date.getTime() + OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

/** The instant of local midnight on y-m-d (overflowing days roll forward). */
export function localMidnight(y: number, m: number, d: number) {
  return new Date(Date.UTC(y, m, d) - OFFSET_MS);
}

export const monthKey = ({ y, m }: YM) => `${y}-${String(m + 1).padStart(2, '0')}`;

/** "YYYY-MM" of the local month an instant falls in. */
export const monthKeyOf = (date: Date) => monthKey(localParts(date));

/** "YYYY-MM" keys of every local month from `from` to `to` (inclusive). */
export function monthKeysBetween(from: Date, to: Date, max = 36): string[] {
  const a = localParts(from);
  const b = localParts(to);
  const keys: string[] = [];
  for (let y = a.y, m = a.m; (y < b.y || (y === b.y && m <= b.m)) && keys.length < max; m === 11 ? (y++, (m = 0)) : m++) {
    keys.push(monthKey({ y, m }));
  }
  return keys;
}

const daysInMonth = ({ y, m }: YM) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * The stay's due date in month `ym`, at local noon: noon is the same calendar
 * day in local time and in UTC, so readers using either (the Flutter app,
 * UTC-based reports) put the due in the same month.
 *
 * With an owner-wide due day, rent falls due on that day — except in the
 * check-in month, where the first rent is due on the check-in day itself.
 * Without one, each stay's rent falls due on its own check-in day.
 */
function dueDateIn(ym: YM, checkInDate: Date, ownerDueDay: number | null) {
  const ci = localParts(checkInDate);
  const isCheckInMonth = ci.y === ym.y && ci.m === ym.m;
  const day = ownerDueDay && !isCheckInMonth ? ownerDueDay : Math.min(ci.d, daysInMonth(ym));
  return new Date(localMidnight(ym.y, ym.m, day).getTime() + 12 * 3_600_000);
}

/**
 * Creates any missing rent dues for the owner's stays across the local months
 * that `from`–`to` touch (capped at the current month), or for one stay only
 * with `options.stayId`. Returns how many dues were created. Never throws: a failure here must not break the read that
 * triggered it, so errors are logged and 0 is returned.
 */
export async function ensureMonthlyDues(
  ownerId: string,
  from: Date,
  to: Date,
  now = new Date(),
  options: { stayId?: string } = {},
): Promise<number> {
  try {
    const start = localParts(from);
    const last = localParts(to < now ? to : now);
    const months: YM[] = [];
    for (let y = start.y, m = start.m; y < last.y || (y === last.y && m <= last.m); m === 11 ? (y++, (m = 0)) : m++) {
      months.push({ y, m });
    }
    if (months.length === 0) return 0;

    const rangeStart = localMidnight(months[0].y, months[0].m, 1);
    const tail = months[months.length - 1];
    const rangeEnd = localMidnight(tail.y, tail.m + 1, 1);

    const stays = await Stay.find({
      ownerId,
      ...(options.stayId ? { _id: options.stayId } : {}),
      deletedAt: null,
      checkInDate: { $lt: rangeEnd },
      $or: [{ checkOutDate: null }, { checkOutDate: { $gte: rangeStart } }],
    }).lean();
    if (stays.length === 0) return 0;
    const owner = await Owner.findById(ownerId).select('rentDueDay').lean();
    const ownerDueDay = owner?.rentDueDay ?? null;

    const existing = await Payment.find({
      ownerId,
      stayId: { $in: stays.map((s) => s._id) },
      dueDate: { $gte: rangeStart, $lt: rangeEnd },
    })
      .select('_id stayId dueDate dueMonth deletedAt')
      .lean();
    // Live dues, and owner-deleted hand-made ones, cover their month.
    const covered = new Set(
      existing
        .filter((p) => p.deletedAt === null || p.dueMonth === null)
        .map((p) => `${p.stayId}|${p.dueMonth ?? monthKeyOf(p.dueDate)}`),
    );
    // Voided automatic dues, restored if the month is owed again.
    const voided = new Map(
      existing.filter((p) => p.deletedAt !== null && p.dueMonth !== null).map((p) => [`${p.stayId}|${p.dueMonth}`, p._id]),
    );

    const docs = [];
    const restore: string[] = [];
    for (const stay of stays) {
      const ci = localParts(stay.checkInDate);
      const checkInDay = localMidnight(ci.y, ci.m, ci.d);
      for (const ym of months) {
        const key = monthKey(ym);
        if (covered.has(`${stay._id}|${key}`)) continue;
        const dueDate = dueDateIn(ym, stay.checkInDate, ownerDueDay);
        if (dueDate < checkInDay) continue;
        if (stay.checkOutDate && dueDate >= stay.checkOutDate) continue;
        if (stay.noticeMoveOutDate && dueDate >= stay.noticeMoveOutDate) continue;
        const voidedId = voided.get(`${stay._id}|${key}`);
        if (voidedId) {
          restore.push(voidedId);
          continue;
        }
        docs.push({
          _id: uuidv4(),
          ownerId,
          stayId: stay._id,
          residentId: stay.residentId,
          dueDate,
          dueMonth: key,
          rentDue: stay.monthlyRent,
          status: 'pending' as const,
          notes: null,
          deletedAt: null,
        });
      }
    }
    if (restore.length) {
      await Payment.updateMany({ ownerId, _id: { $in: restore } }, { $set: { deletedAt: null } });
    }
    if (docs.length === 0) return restore.length;

    try {
      const inserted = await Payment.insertMany(docs, { ordered: false });
      return inserted.length;
    } catch (error: any) {
      // A concurrent call created some of them first: the unique index
      // rejected the duplicates and the rest were inserted.
      if (error?.code === 11000 || error?.writeErrors) return error.insertedDocs?.length ?? 0;
      throw error;
    }
  } catch (error) {
    console.error('ensureMonthlyDues error:', error);
    return 0;
  }
}

/**
 * Soft-deletes the stay's automatic dues dated on/after `from` that nothing
 * has been paid against — called when a checkout or notice means the
 * resident won't be there on those due dates.
 */
export async function voidAutoDuesFrom(ownerId: string, stayId: string, from: Date) {
  await Payment.updateMany(
    {
      ownerId,
      stayId,
      dueMonth: { $type: 'string' },
      deletedAt: null,
      dueDate: { $gte: from },
      rentPaid: 0,
      electricityPaid: 0,
      otherPaid: 0,
    },
    { $set: { deletedAt: new Date() } },
  );
}
