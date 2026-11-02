import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { Owner } from '../auth/owner.model';
import { buildNotifications } from './notifications.service';

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
