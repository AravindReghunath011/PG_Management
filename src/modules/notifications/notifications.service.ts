import { Payment } from '../payments/payment.model';
import { Stay } from '../stays/stay.model';
import { Resident } from '../residents/resident.model';
import { Bed } from '../beds/bed.model';
import { Room } from '../rooms/room.model';
import { ensureMonthlyDues } from '../payments/monthlyDues';

/**
 * Notifications are derived from the owner's data on every read — there is no
 * notification store. Each item has a stable id (type + record id) and a date;
 * items dated after the owner's `notificationsSeenAt` count as unread.
 */

export type Severity = 'high' | 'medium' | 'low';
export type NotificationItem = {
  id: string;
  type:
    | 'rent_overdue'
    | 'rent_due_today'
    | 'rent_due_soon'
    | 'notice_ending'
    | 'move_out_today'
    | 'move_out_passed'
    | 'kyc_missing';
  severity: Severity;
  title: string;
  body: string;
  date: Date;
  residentId: string;
  /** For push wording; the in-app list shows the title. */
  residentName?: string;
  dueId?: string;
  amount?: number;
};

const DAY = 86_400_000;
const DUE_SOON_DAYS = 3;
const NOTICE_WINDOW_DAYS = 7;
const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Calendar day in India ("2026-11-12"), so "today" means the owner's today. */
const istDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** Where tapping the alert (in the app or as a push) should take the owner. */
export function routeFor(item: Pick<NotificationItem, 'type' | 'residentId' | 'dueId'>): string {
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
  if ((item.type === 'rent_overdue' || item.type === 'rent_due_today' || item.type === 'rent_due_soon') && item.dueId) {
    return `/record-payment?${q({ residentId: item.residentId, dueId: item.dueId })}`;
  }
  if (item.type === 'move_out_today' || item.type === 'move_out_passed') return `/vacate?${q({ id: item.residentId })}`;
  return `/tenants/${encodeURIComponent(item.residentId)}`;
}

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
const dayMonth = (d: Date) =>
  d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/**
 * "Room 101, Bed A" per stay. Includes checked-out stays and soft-deleted beds
 * and rooms, because a due can outlive both and still has to say where it was.
 */
async function placesByStay(ownerId: string, stayIds: string[]): Promise<Map<string, string>> {
  const stays = await Stay.find({ ownerId, _id: { $in: stayIds } }).select('_id bedId').lean();
  const beds = await Bed.find({ ownerId, _id: { $in: stays.map((s) => s.bedId) } }).select('_id roomId bedNumber').lean();
  const rooms = await Room.find({ ownerId, _id: { $in: beds.map((b) => b.roomId) } }).select('_id roomNumber').lean();
  const bedById = new Map(beds.map((b) => [b._id, b]));
  const roomById = new Map(rooms.map((r) => [r._id, r]));

  const places = new Map<string, string>();
  for (const stay of stays) {
    const bed = bedById.get(stay.bedId);
    const room = bed && roomById.get(bed.roomId);
    if (bed && room) places.set(stay._id, `Room ${room.roomNumber}, Bed ${bed.bedNumber}`);
  }
  return places;
}

export async function buildNotifications(ownerId: string, now = new Date()): Promise<NotificationItem[]> {
  await ensureMonthlyDues(ownerId, now, now);

  const [openDues, openStays] = await Promise.all([
    Payment.find({
      ownerId,
      deletedAt: null,
      status: { $ne: 'paid' },
      dueDate: { $lte: new Date(now.getTime() + DUE_SOON_DAYS * DAY) },
    }).lean(),
    Stay.find({ ownerId, deletedAt: null, checkOutDate: null }).lean(),
  ]);

  const residentIds = [...new Set([...openDues.map((d) => d.residentId), ...openStays.map((s) => s.residentId)])];
  const residents = await Resident.find({ ownerId, _id: { $in: residentIds } })
    .select('_id name kycImageUrl kycBackImageUrl')
    .lean();
  const residentById = new Map(residents.map((r) => [r._id, r]));
  const name = (id: string) => residentById.get(id)?.name ?? 'A resident';

  const places = await placesByStay(ownerId, [...new Set([...openDues.map((d) => d.stayId), ...openStays.map((s) => s._id)])]);
  const at = (stayId: string) => {
    const place = places.get(stayId);
    return place ? `${place} · ` : '';
  };

  const items: NotificationItem[] = [];

  for (const due of openDues) {
    const balance = due.rentDue + due.electricityDue + due.otherDue - (due.rentPaid + due.electricityPaid + due.otherPaid);
    if (balance <= 0) continue;
    // Three steps, each its own alert (and push): 3 days before, on the day, after.
    const today = istDay(due.dueDate) === istDay(now);
    const overdue = !today && due.dueDate < now;
    const type = today ? 'rent_due_today' : overdue ? 'rent_overdue' : 'rent_due_soon';
    items.push({
      id: `${type}:${due._id}`,
      type,
      severity: overdue ? 'high' : 'medium',
      title: today
        ? `Rent due today — ${name(due.residentId)}`
        : overdue
          ? `Rent overdue — ${name(due.residentId)}`
          : `Rent due soon — ${name(due.residentId)}`,
      body: today
        ? `${at(due.stayId)}${rupees(balance)} to collect today.`
        : overdue
          ? `${at(due.stayId)}${rupees(balance)} pending since ${dayMonth(due.dueDate)}.`
          : `${at(due.stayId)}${rupees(balance)} due on ${dayMonth(due.dueDate)}.`,
      // "Due soon" becomes news when it enters the window, "today" on the day.
      date: overdue ? due.dueDate : today ? now : new Date(due.dueDate.getTime() - DUE_SOON_DAYS * DAY),
      residentId: due.residentId,
      dueId: due._id,
      amount: balance,
    });
  }

  for (const stay of openStays) {
    if (stay.noticeMoveOutDate) {
      // Two steps, each its own alert: 7 days before, and on the day (then "passed").
      const days = Math.ceil((stay.noticeMoveOutDate.getTime() - now.getTime()) / DAY);
      if (istDay(stay.noticeMoveOutDate) === istDay(now)) {
        items.push({
          id: `move_out_today:${stay._id}`,
          type: 'move_out_today',
          severity: 'high',
          title: `${name(stay.residentId)} moves out today`,
          body: `${at(stay._id)}Settle the deposit and free the bed.`,
          date: now,
          residentId: stay.residentId,
        });
      } else if (days < 0) {
        items.push({
          id: `move_out_passed:${stay._id}`,
          type: 'move_out_passed',
          severity: 'high',
          title: `Move-out date passed — ${name(stay.residentId)}`,
          body: `${at(stay._id)}Was due to leave on ${dayMonth(stay.noticeMoveOutDate)}. Vacate & settle the deposit to free the bed.`,
          date: stay.noticeMoveOutDate,
          residentId: stay.residentId,
        });
      } else if (days <= NOTICE_WINDOW_DAYS) {
        items.push({
          id: `notice_ending:${stay._id}`,
          type: 'notice_ending',
          severity: 'medium',
          title: `${name(stay.residentId)} moves out in ${days} day${days === 1 ? '' : 's'}`,
          body: `${at(stay._id)}Notice period ends ${dayMonth(stay.noticeMoveOutDate)}. Plan the deposit settlement.`,
          // Dated when it enters the window, so it shows as new then.
          date: new Date(stay.noticeMoveOutDate.getTime() - NOTICE_WINDOW_DAYS * DAY),
          residentId: stay.residentId,
        });
      }
    }
    const resident = residentById.get(stay.residentId);
    if (resident && !resident.kycImageUrl && !resident.kycBackImageUrl) {
      items.push({
        id: `kyc_missing:${stay.residentId}`,
        type: 'kyc_missing',
        severity: 'low',
        title: `ID document missing — ${resident.name}`,
        body: 'No ID proof uploaded for this resident.',
        date: stay.checkInDate,
        residentId: stay.residentId,
      });
    }
  }

  for (const item of items) item.residentName = name(item.residentId);

  // Nothing is dated in the future, so "mark as read" clears everything.
  for (const item of items) if (item.date > now) item.date = now;

  return items.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.date.getTime() - a.date.getTime(),
  );
}
