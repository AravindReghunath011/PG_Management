import { v4 as uuidv4 } from 'uuid';
import { Owner } from '../auth/owner.model';
import { accessStatusOf } from '../auth/access';
import { buildNotifications, NotificationItem, routeFor } from '../notifications/notifications.service';
import { PushedAlert, PushToken } from './push.model';
import { PushMessage, sendPushMessages } from './expoPush';

/**
 * Pushes each new in-app alert to the owner's phones once. Alerts are still
 * derived on the fly (see notifications.service); `PushedAlert` only remembers
 * which alert ids have been sent.
 */

// Missing-ID reminders stay in the in-app list only.
const PUSHED_TYPES = new Set<NotificationItem['type']>([
  'rent_overdue',
  'rent_due_today',
  'rent_due_soon',
  'notice_ending',
  'move_out_today',
  'move_out_passed',
]);
// More new alerts than this in one sweep become a single summary push.
const MAX_INDIVIDUAL = 3;
// Only push between these IST hours so no one is woken up about rent.
const QUIET_UNTIL_HOUR = 8;
const QUIET_FROM_HOUR = 21;

const istHour = (d: Date) => Number(d.toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }));

export const withinPushHours = (now: Date) => {
  const hour = istHour(now);
  return hour >= QUIET_UNTIL_HOUR && hour < QUIET_FROM_HOUR;
};

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

/**
 * Phone wording: an icon to recognise the kind at a glance, "what · who" in the
 * title, and what tapping does at the end of the body.
 */
export function pushTextFor(a: NotificationItem): { title: string; body: string } {
  const who = a.residentName ?? 'A tenant';
  switch (a.type) {
    case 'rent_due_soon':
      return { title: `📅 Rent due soon · ${who}`, body: `${a.body} Tap to record it once paid.` };
    case 'rent_due_today':
      return { title: `💰 Rent due today · ${who}`, body: `${a.body} Tap to record the payment.` };
    case 'rent_overdue':
      return { title: `⚠️ Rent overdue · ${who}`, body: `${a.body} Tap to record it.` };
    case 'notice_ending':
      return { title: `🚪 ${a.title}`, body: a.body };
    case 'move_out_today':
      return { title: `🚪 ${who} moves out today`, body: `${a.body} Tap to move them out.` };
    case 'move_out_passed':
      return { title: `⏰ ${who} was due to leave`, body: `${a.body}` };
    default:
      return { title: a.title, body: a.body };
  }
}

/** One push for a busy sweep: what it adds up to, then who. */
export function summaryTextFor(alerts: NotificationItem[]): { title: string; body: string } {
  const rent = alerts.filter((a) => a.type.startsWith('rent_'));
  const moves = alerts.filter((a) => a.type === 'notice_ending' || a.type.startsWith('move_out'));
  const toCollect = rent.reduce((n, a) => n + (a.amount ?? 0), 0);
  const parts = [
    rent.length ? `${rent.length} rent${rent.length === 1 ? '' : 's'} to collect (${rupees(toCollect)})` : null,
    moves.length ? `${moves.length} move-out${moves.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const names = [...new Set(alerts.map((a) => a.residentName).filter(Boolean))] as string[];
  const people = names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and ');
  return {
    title: `🔔 ${alerts.length} things need you`,
    body: `${parts.join(' · ')}${people ? ` — ${people}` : ''}. Tap to see them.`,
  };
}

function messagesFor(alerts: NotificationItem[], tokens: string[]): PushMessage[] {
  const payloads =
    alerts.length <= MAX_INDIVIDUAL
      ? alerts.map((a) => ({ ...pushTextFor(a), data: { url: routeFor(a), alertId: a.id } }))
      : [{ ...summaryTextFor(alerts), data: { url: '/notifications' } }];
  return tokens.flatMap((to) => payloads.map((p) => ({ to, ...p })));
}

/** Sends this owner's not-yet-pushed alerts. Returns how many alerts were newly pushed. */
export async function pushNewAlerts(ownerId: string, now = new Date()): Promise<number> {
  const tokens = await PushToken.find({ ownerId, deletedAt: null }).select('token').lean();
  if (!tokens.length) return 0;

  const alerts = (await buildNotifications(ownerId, now)).filter((a) => PUSHED_TYPES.has(a.type));
  if (!alerts.length) return 0;

  const alreadyPushed = await PushedAlert.find({ ownerId, alertId: { $in: alerts.map((a) => a.id) } })
    .select('alertId')
    .lean();
  const pushedIds = new Set(alreadyPushed.map((p) => p.alertId));
  const fresh = alerts.filter((a) => !pushedIds.has(a.id));
  if (!fresh.length) return 0;

  const tokenList = tokens.map((t) => t.token);
  const messages = messagesFor(fresh, tokenList);
  // Throws when Expo is unreachable: nothing is recorded, so the next sweep retries.
  const tickets = await sendPushMessages(messages);

  // Uninstalled app / revoked permission: stop sending to that phone.
  const deadTokens = tickets
    .map((t, i) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? messages[i].to : null))
    .filter((t): t is string => t !== null);
  if (deadTokens.length) {
    await PushToken.updateMany({ ownerId, token: { $in: deadTokens } }, { $set: { deletedAt: now } });
  }

  await PushedAlert.insertMany(
    fresh.map((a) => ({ _id: uuidv4(), ownerId, alertId: a.id })),
    { ordered: false }
  ).catch((error) => {
    // A concurrent sweep already recorded some of these; the rest are inserted.
    if (error?.code !== 11000 && !error?.writeErrors) throw error;
  });

  return fresh.length;
}

/** One pass over every owner with a registered phone. */
export async function runPushSweep(now = new Date()) {
  if (!withinPushHours(now)) return;
  const ownerIds: string[] = await PushToken.distinct('ownerId', { deletedAt: null });
  const owners = await Owner.find({ _id: { $in: ownerIds }, isActive: true })
    .select('_id accessStatus')
    .lean();
  for (const owner of owners) {
    if (accessStatusOf(owner) !== 'approved') continue;
    try {
      await pushNewAlerts(String(owner._id), now);
    } catch (error) {
      console.error(`Push sweep failed for owner ${owner._id}:`, error);
    }
  }
}

/** Starts the periodic sweep (every PUSH_SWEEP_MINUTES, default 30). */
export function startPushScheduler() {
  const minutes = Number(process.env.PUSH_SWEEP_MINUTES) || 30;
  const tick = () => runPushSweep().catch((error) => console.error('Push sweep error:', error));
  setInterval(tick, minutes * 60_000).unref();
  tick();
}
