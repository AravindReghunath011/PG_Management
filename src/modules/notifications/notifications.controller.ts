import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { Owner } from '../auth/owner.model';
import { Payment } from '../payments/payment.model';
import { Stay } from '../stays/stay.model';
import { Resident } from '../residents/resident.model';
import { ensureMonthlyDues } from '../payments/monthlyDues';

/**
 * Notifications are derived from the owner's data on every read — there is no
 * notification store. Each item has a stable id (type + record id) and a date;
 * items dated after the owner's `notificationsSeenAt` count as unread.
 */

type Severity = 'high' | 'medium' | 'low';
type Item = {
  id: string;
  type: 'rent_overdue' | 'rent_due_soon' | 'notice_ending' | 'move_out_passed' | 'kyc_missing';
  severity: Severity;
  title: string;
  body: string;
  date: Date;
  residentId: string;
  dueId?: string;
  amount?: number;
};

const DAY = 86_400_000;
const DUE_SOON_DAYS = 3;
const NOTICE_WINDOW_DAYS = 7;
const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
const dayMonth = (d: Date) =>
  d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

async function buildNotifications(ownerId: string, now = new Date()): Promise<Item[]> {
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

  const items: Item[] = [];

  for (const due of openDues) {
    const balance = due.rentDue + due.electricityDue + due.otherDue - (due.rentPaid + due.electricityPaid + due.otherPaid);
    if (balance <= 0) continue;
    const overdue = due.dueDate < now;
    items.push({
      id: `${overdue ? 'rent_overdue' : 'rent_due_soon'}:${due._id}`,
      type: overdue ? 'rent_overdue' : 'rent_due_soon',
      severity: overdue ? 'high' : 'medium',
      title: overdue ? `Rent overdue — ${name(due.residentId)}` : `Rent due soon — ${name(due.residentId)}`,
      body: overdue
        ? `${rupees(balance)} pending since ${dayMonth(due.dueDate)}.`
        : `${rupees(balance)} due on ${dayMonth(due.dueDate)}.`,
      // "Due soon" becomes news when it enters the window, not on the due date.
      date: overdue ? due.dueDate : new Date(due.dueDate.getTime() - DUE_SOON_DAYS * DAY),
      residentId: due.residentId,
      dueId: due._id,
      amount: balance,
    });
  }

  for (const stay of openStays) {
    if (stay.noticeMoveOutDate) {
      const days = Math.ceil((stay.noticeMoveOutDate.getTime() - now.getTime()) / DAY);
      if (days < 0) {
        items.push({
          id: `move_out_passed:${stay._id}`,
          type: 'move_out_passed',
          severity: 'high',
          title: `Move-out date passed — ${name(stay.residentId)}`,
          body: `Was due to leave on ${dayMonth(stay.noticeMoveOutDate)}. Vacate & settle the deposit to free the bed.`,
          date: stay.noticeMoveOutDate,
          residentId: stay.residentId,
        });
      } else if (days <= NOTICE_WINDOW_DAYS) {
        items.push({
          id: `notice_ending:${stay._id}`,
          type: 'notice_ending',
          severity: 'medium',
          title: `${name(stay.residentId)} moves out ${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}`,
          body: `Notice period ends ${dayMonth(stay.noticeMoveOutDate)}. Plan the deposit settlement.`,
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

  // Nothing is dated in the future, so "mark as read" clears everything.
  for (const item of items) if (item.date > now) item.date = now;

  return items.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.date.getTime() - a.date.getTime(),
  );
}

export const getNotifications = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const [items, owner] = await Promise.all([
      buildNotifications(ownerId),
      Owner.findById(ownerId).select('notificationsSeenAt').lean(),
    ]);
    const seenAt = owner?.notificationsSeenAt ?? null;
    const withRead = items.map((i) => ({ ...i, unread: !seenAt || i.date > seenAt }));
    return res.status(200).json({
      items: withRead,
      unreadCount: withRead.filter((i) => i.unread).length,
      seenAt,
    });
  } catch (error) {
    console.error('getNotifications error:', error);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Error loading notifications.' } });
  }
};

/** Marks everything up to now as read. */
export const markNotificationsSeen = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const seenAt = new Date();
    await Owner.updateOne({ _id: req.ownerId }, { $set: { notificationsSeenAt: seenAt } });
    return res.status(200).json({ seenAt });
  } catch (error) {
    console.error('markNotificationsSeen error:', error);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Error updating notifications.' } });
  }
};
