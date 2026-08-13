import { Schema, model, Document } from 'mongoose';

export interface IRoom {
  _id: string; // client UUID
  ownerId: string;
  branchId: string;
  roomNumber: string;
  floor: number;
  amenities: string[]; // e.g. ['ac'] — fixed list, extend in code as needed
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const RoomSchema = new Schema<IRoom>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    branchId: { type: String, required: true, index: true },
    roomNumber: { type: String, required: true },
    floor: { type: Number, required: true },
    amenities: { type: [String], default: [] },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

RoomSchema.index({ ownerId: 1, branchId: 1, deletedAt: 1 });

export const Room = model<IRoom>('Room', RoomSchema);
