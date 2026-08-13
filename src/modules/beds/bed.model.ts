import { Schema, model, Document } from 'mongoose';

export interface IBed {
  _id: string; // client UUID
  ownerId: string;
  roomId: string;
  bedNumber: string;
  status: 'vacant' | 'occupied';
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const BedSchema = new Schema<IBed>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    roomId: { type: String, required: true, index: true },
    bedNumber: { type: String, required: true },
    status: { type: String, enum: ['vacant', 'occupied'], default: 'vacant' },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

BedSchema.index({ ownerId: 1, roomId: 1, deletedAt: 1 });

export const Bed = model<IBed>('Bed', BedSchema);
