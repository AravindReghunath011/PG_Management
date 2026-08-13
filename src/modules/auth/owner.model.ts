import { Schema, model, Document } from 'mongoose';

export interface IOwner {
  _id: string; // client UUID or generated UUID
  name: string;
  email: string;
  phoneNumber?: string;
  passwordHash: string;
  role: 'owner' | 'superadmin';
  mustResetPassword: boolean;
  defaultDepositPaise: number;
  defaultRentPaise: number;
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
    // In paise. Prefills the security deposit field on check-in; owner-configurable.
    defaultDepositPaise: { type: Number, default: 1700000 },
    // In paise. Prefills the monthly rent field on check-in; owner-configurable.
    defaultRentPaise: { type: Number, default: 850000 }
  },
  {
    timestamps: true,
    _id: false, // Turn off auto ObjectId generation since we provide our own uuid _id
  }
);

export const Owner = model<IOwner>('Owner', OwnerSchema);
