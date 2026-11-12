import { Schema, model } from 'mongoose';

/**
 * A short stay paid by the day (a "daily tenant"): someone who takes a bed for
 * a few days, not a monthly Resident. Kept apart from Stay so monthly dues,
 * deposits and notices never apply to it.
 *
 * While open (checkOutAt null) the bed is marked occupied, so no Resident or
 * other daily tenant can take it. Check-out frees the bed.
 */
export interface IDailyStay {
  _id: string; // client UUID
  ownerId: string;
  bedId: string;
  name: string;
  phone: string;
  checkInAt: Date;
  /** The day they said they'd leave; can be changed while staying. */
  expectedCheckOutAt: Date;
  checkOutAt: Date | null;
  dailyRatePaise: number;
  /** What they have paid so far. */
  amountPaidPaise: number;
  note: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const DailyStaySchema = new Schema<IDailyStay>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    bedId: { type: String, required: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    checkInAt: { type: Date, required: true },
    expectedCheckOutAt: { type: Date, required: true },
    checkOutAt: { type: Date, default: null },
    dailyRatePaise: { type: Number, required: true, min: 0 },
    amountPaidPaise: { type: Number, default: 0, min: 0 },
    note: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false },
);

DailyStaySchema.index({ ownerId: 1, checkOutAt: 1, deletedAt: 1 });
DailyStaySchema.index({ ownerId: 1, bedId: 1, deletedAt: 1 });

export const DailyStay = model<IDailyStay>('DailyStay', DailyStaySchema);

const DAY = 86_400_000;

/** Days charged: started days between check-in and check-out (or now), at least 1. */
export function daysCharged(checkInAt: Date, until: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - checkInAt.getTime()) / DAY));
}
