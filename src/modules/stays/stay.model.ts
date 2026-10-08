import { Schema, model } from 'mongoose';

export interface IStay {
  _id: string; // client UUID
  ownerId: string;
  residentId: string;
  bedId: string;
  checkInDate: Date;
  checkOutDate: Date | null;
  // Planned move-out while the resident still occupies the bed (notice
  // period). The bed stays occupied until checkout sets checkOutDate.
  noticeMoveOutDate: Date | null;
  // Set when a resident moves beds: the new stay continues `movedFromStayId`
  // and keeps rent falling due on the original stay's day (rentAnchorDate).
  movedFromStayId: string | null;
  rentAnchorDate: Date | null;
  // Recorded at checkout: deductions from the deposit and the refund (paise).
  depositSettlement: {
    deductions: { kind: 'rent' | 'damage' | 'cleaning' | 'other'; label: string; amount: number }[];
    totalDeductions: number;
    refundAmount: number;
    refundMode: 'upi' | 'cash' | 'phonepe' | 'bank' | null;
    notes: string | null;
    settledAt: Date;
  } | null;
  monthlyRent: number; // In paise
  securityDeposit: number; // In paise
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const StaySchema = new Schema<IStay>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    residentId: { type: String, required: true, index: true },
    bedId: { type: String, required: true, index: true },
    checkInDate: { type: Date, required: true },
    checkOutDate: { type: Date, default: null },
    noticeMoveOutDate: { type: Date, default: null },
    movedFromStayId: { type: String, default: null },
    rentAnchorDate: { type: Date, default: null },
    depositSettlement: {
      type: new Schema(
        {
          deductions: [
            new Schema(
              {
                kind: { type: String, enum: ['rent', 'damage', 'cleaning', 'other'], required: true },
                label: { type: String, required: true },
                amount: { type: Number, required: true, min: 0 },
              },
              { _id: false },
            ),
          ],
          totalDeductions: { type: Number, required: true, min: 0 },
          refundAmount: { type: Number, required: true, min: 0 },
          refundMode: { type: String, enum: ['upi', 'cash', 'phonepe', 'bank', null], default: null },
          notes: { type: String, default: null },
          settledAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    monthlyRent: { type: Number, required: true },
    securityDeposit: { type: Number, required: true },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

StaySchema.index({ ownerId: 1, bedId: 1, deletedAt: 1 });
StaySchema.index({ ownerId: 1, residentId: 1, deletedAt: 1 });

// Pre-save validation to enforce no-double-occupancy rule
StaySchema.pre('save', async function (this: any, next) {
  // If the stay is deleted or has a checkout date, no need to check for active overlaps
  if (this.deletedAt !== null || this.checkOutDate !== null) {
    return next();
  }

  try {
    const StayModel = model<IStay>('Stay');
    
    // Find any other active stay for this bed that is NOT this stay itself
    const activeStay = await StayModel.findOne({
      ownerId: this.ownerId,
      bedId: this.bedId,
      checkOutDate: null,
      deletedAt: null,
      _id: { $ne: this._id }
    });

    if (activeStay) {
      return next(new Error('DOUBLE_OCCUPANCY: Another resident is currently occupying this bed.'));
    }

    next();
  } catch (error) {
    next(error as Error);
  }
});

export const Stay = model<IStay>('Stay', StaySchema);
