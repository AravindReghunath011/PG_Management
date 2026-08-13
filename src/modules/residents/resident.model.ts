import { Schema, model, Document } from 'mongoose';

export interface IResident {
  _id: string; // client UUID
  ownerId: string;
  name: string;
  phone: string;
  email: string | null;
  kycType: 'Aadhaar' | 'Passport' | 'DL' | 'Other';
  kycRef: string;
  kycImageUrl: string | null;
  foodPreference: 'with_food' | 'without_food';
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const ResidentSchema = new Schema<IResident>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, default: null },
    kycType: { type: String, enum: ['Aadhaar', 'Passport', 'DL', 'Other'], required: true },
    kycRef: { type: String, required: true },
    kycImageUrl: { type: String, default: null },
    foodPreference: { type: String, enum: ['with_food', 'without_food'], default: 'with_food' },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

// Prevent duplicate phone number registration for the SAME PG owner.
ResidentSchema.index({ ownerId: 1, phone: 1, deletedAt: 1 }, { unique: true });

export const Resident = model<IResident>('Resident', ResidentSchema);
