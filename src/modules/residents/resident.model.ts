import { Schema, model, Document } from 'mongoose';

export interface IResident {
  _id: string; // client UUID
  ownerId: string;
  name: string;
  phone: string;
  email: string | null;
  kycType: 'Aadhaar' | 'Passport' | 'DL' | 'Other';
  kycRef: string; // ID number — optional for now ('' when not given)
  kycImageUrl: string | null; // front side
  kycBackImageUrl: string | null;
  photoUrl: string | null;
  // Parent / emergency contact — all optional.
  guardianName: string | null;
  guardianPhone: string | null;
  guardianRelation: string | null;
  foodPreference: 'with_food' | 'without_food';
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
  /** True once the Owner deletes this Resident; always set together with deletedAt. */
  isDeleted: boolean;
}

const ResidentSchema = new Schema<IResident>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, default: null },
    kycType: { type: String, enum: ['Aadhaar', 'Passport', 'DL', 'Other'], required: true },
    kycRef: { type: String, default: '' },
    kycImageUrl: { type: String, default: null },
    kycBackImageUrl: { type: String, default: null },
    photoUrl: { type: String, default: null },
    guardianName: { type: String, default: null },
    guardianPhone: { type: String, default: null },
    guardianRelation: { type: String, default: null },
    foodPreference: { type: String, enum: ['with_food', 'without_food'], default: 'with_food' },
    deletedAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    _id: false,
  }
);

// Prevent duplicate phone number registration for the SAME PG owner.
ResidentSchema.index({ ownerId: 1, phone: 1, deletedAt: 1 }, { unique: true });

export const Resident = model<IResident>('Resident', ResidentSchema);

/** The soft-delete fields for a Resident. Never hard-delete: stays and payments point at it. */
export const residentDeletedFields = (when = new Date()) => ({ deletedAt: when, isDeleted: true });
export const residentRestoredFields = () => ({ deletedAt: null, isDeleted: false });

/** Marks Residents deleted before isDeleted existed, so the two fields agree. Safe to run on every boot. */
export async function backfillResidentIsDeleted() {
  const res = await Resident.updateMany(
    { deletedAt: { $ne: null }, isDeleted: { $ne: true } },
    { $set: { isDeleted: true } },
  );
  if (res.modifiedCount) console.log(`Marked ${res.modifiedCount} deleted resident(s) isDeleted: true.`);
}
