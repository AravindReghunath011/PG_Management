import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../../middleware/auth';
import { PushToken } from './push.model';
import { isExpoPushToken } from './expoPush';

const badRequest = (res: Response, message: string) =>
  res.status(400).json({ error: { code: 'BAD_REQUEST', message } });

/** Registers this phone for the signed-in owner's push alerts (idempotent). */
export const registerPushToken = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token, platform } = req.body ?? {};
    if (!isExpoPushToken(token)) return badRequest(res, 'A valid Expo push token is required.');
    if (platform !== 'android' && platform !== 'ios') return badRequest(res, 'platform must be android or ios.');

    // The token moves to whoever registered it last (account switch on one phone).
    await PushToken.updateOne(
      { token },
      { $set: { ownerId: req.ownerId, platform, deletedAt: null }, $setOnInsert: { _id: uuidv4() } },
      { upsert: true }
    );
    return res.status(204).end();
  } catch (error) {
    console.error('registerPushToken error:', error);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Error registering for notifications.' } });
  }
};

/** Stops pushes to this phone (sign-out). */
export const unregisterPushToken = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token } = req.body ?? {};
    if (!isExpoPushToken(token)) return badRequest(res, 'A valid Expo push token is required.');
    await PushToken.updateOne({ token, ownerId: req.ownerId }, { $set: { deletedAt: new Date() } });
    return res.status(204).end();
  } catch (error) {
    console.error('unregisterPushToken error:', error);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Error unregistering notifications.' } });
  }
};
