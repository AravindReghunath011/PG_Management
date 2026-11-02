/**
 * Minimal client for Expo's push API. Expo forwards to FCM (Android) / APNs
 * (iOS) using the credentials uploaded to the EAS project.
 * https://docs.expo.dev/push-notifications/sending-notifications/
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_BATCH = 100;

export type PushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export type PushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

export const isExpoPushToken = (token: unknown): token is string =>
  typeof token === 'string' && /^Expo(nent)?PushToken\[.+\]$/.test(token);

/** Sends messages in batches; tickets come back in the same order. Throws if Expo is unreachable. */
export async function sendPushMessages(messages: PushMessage[]): Promise<PushTicket[]> {
  const tickets: PushTicket[] = [];
  for (let i = 0; i < messages.length; i += MAX_BATCH) {
    const batch = messages.slice(i, i + MAX_BATCH).map((m) => ({
      ...m,
      sound: 'default',
      priority: 'high',
      channelId: 'alerts', // created by the app on Android
    }));
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`Expo push failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as { data: PushTicket[] };
    tickets.push(...json.data);
  }
  return tickets;
}
