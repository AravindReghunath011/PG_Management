import { Schema, model, Document } from 'mongoose';

export interface IBranch {
  _id: string; // client UUID
  ownerId: string;
  name: string;
  address: string;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const BranchSchema = new Schema<IBranch>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

// High-speed indices for owner isolation
BranchSchema.index({ ownerId: 1, deletedAt: 1 });

export const Branch = model<IBranch>('Branch', BranchSchema);
