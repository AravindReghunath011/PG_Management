import { Schema, model } from 'mongoose';

/**
 * One phone that should receive an Owner's push alerts. A token belongs to
 * whichever owner registered it last, so signing into another account on the
 * same phone moves the token rather than leaking alerts to the old owner.
 */
export interface IPushToken {
  _id: string; // uuid
  ownerId: string;
  token: string; // ExponentPushToken[...]
  platform: 'android' | 'ios';
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const PushTokenSchema = new Schema<IPushToken>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ['android', 'ios'], required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

export const PushToken = model<IPushToken>('PushToken', PushTokenSchema);

/**
 * An alert (by its stable notification id, e.g. `rent_overdue:<dueId>`) that
 * has already been pushed to an owner, so each alert is pushed once.
 */
export interface IPushedAlert {
  _id: string; // uuid
  ownerId: string;
  alertId: string;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const PushedAlertSchema = new Schema<IPushedAlert>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true },
    alertId: { type: String, required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

PushedAlertSchema.index({ ownerId: 1, alertId: 1 }, { unique: true });

export const PushedAlert = model<IPushedAlert>('PushedAlert', PushedAlertSchema);
