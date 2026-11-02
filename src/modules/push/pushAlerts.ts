import { v4 as uuidv4 } from 'uuid';
import { Owner } from '../auth/owner.model';
import { accessStatusOf } from '../auth/access';
import { buildNotifications, NotificationItem } from '../notifications/notifications.service';
import { PushedAlert, PushToken } from './push.model';
import { PushMessage, sendPushMessages } from './expoPush';

/**
 * Pushes each new in-app alert to the owner's phones once. Alerts are still
 * derived on the fly (see notifications.service); `PushedAlert` only remembers
 * which alert ids have been sent.
 */

// Missing-ID reminders stay in the in-app list only.
const PUSHED_TYPES = new Set<NotificationItem['type']>(['rent_overdue', 'rent_due_soon', 'notice_ending', 'move_out_passed']);
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

function messagesFor(alerts: NotificationItem[], tokens: string[]): PushMessage[] {
  const payloads =
    alerts.length <= MAX_INDIVIDUAL
      ? alerts.map((a) => ({ title: a.title, body: a.body, data: { url: '/notifications', alertId: a.id } }))
      : [
          {
            title: `${alerts.length} new alerts`,
            body: `${alerts
              .slice(0, 2)
              .map((a) => a.title)
              .join('; ')} and ${alerts.length - 2} more.`,
            data: { url: '/notifications' },
          },
        ];
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
