import { Schema, model } from 'mongoose';

/**
 * A one-time self check-in link. The Owner picks the bed and the terms; the
 * Resident opens `/join/<token>`, fills in their own details and is checked
 * in. Once used (usedAt set), revoked (deletedAt) or past expiresAt, the link
 * no longer works.
 */
export interface IResidentInvite {
  _id: string; // client UUID
  ownerId: string;
  /** Random URL-safe secret; the link is the only way to reach the form. */
  token: string;
  bedId: string;
  checkInDate: Date;
  monthlyRent: number; // paise
  securityDeposit: number; // paise
  expiresAt: Date;
  /** Set atomically when the Resident submits; makes the link one-time. */
  usedAt: Date | null;
  residentId: string | null;
  stayId: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const ResidentInviteSchema = new Schema<IResidentInvite>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    token: { type: String, required: true, unique: true },
    bedId: { type: String, required: true },
    checkInDate: { type: Date, required: true },
    monthlyRent: { type: Number, required: true, min: 0 },
    securityDeposit: { type: Number, required: true, min: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    residentId: { type: String, default: null },
    stayId: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false },
);

ResidentInviteSchema.index({ ownerId: 1, bedId: 1, usedAt: 1, deletedAt: 1 });

export const ResidentInvite = model<IResidentInvite>('ResidentInvite', ResidentInviteSchema);
