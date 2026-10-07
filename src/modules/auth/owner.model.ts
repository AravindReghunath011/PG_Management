import { Schema, model, Document } from 'mongoose';

export interface IOwner {
  _id: string; // client UUID or generated UUID
  name: string;
  email: string;
  phoneNumber?: string;
  passwordHash: string;
  role: 'owner' | 'superadmin';
  mustResetPassword: boolean;
  // Superadmin-controlled access switch. false blocks login while leaving every
  // branch/room/bed/resident/stay this owner owns intact and readable. Owners
  // are never deleted — nothing in the codebase cascades, so a delete would
  // silently orphan their whole dataset.
  isActive: boolean;
  defaultDepositPaise: number;
  defaultRentPaise: number;
  // Day of month (1–28) every resident's rent falls due; null = each stay's
  // own check-in day. The first month is always due on the check-in day.
  rentDueDay: number | null;
  // Notifications up to this instant count as read.
  notificationsSeenAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const OwnerSchema = new Schema<IOwner>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    email: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true
    },
    phoneNumber: { type: String, unique: true, sparse: true, index: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['owner', 'superadmin'], default: 'owner', required: true },
    mustResetPassword: { type: Boolean, default: false },
    // Defaults true so every pre-existing owner document stays able to log in.
    isActive: { type: Boolean, default: true },
    // In paise. Prefills the security deposit field on check-in; owner-configurable.
    defaultDepositPaise: { type: Number, default: 1700000 },
    // In paise. Prefills the monthly rent field on check-in; owner-configurable.
    defaultRentPaise: { type: Number, default: 850000 },
    rentDueDay: { type: Number, default: null, min: 1, max: 28 },
    notificationsSeenAt: { type: Date, default: null }
  },
  {
    timestamps: true,
    _id: false, // Turn off auto ObjectId generation since we provide our own uuid _id
  }
);

export const Owner = model<IOwner>('Owner', OwnerSchema);
