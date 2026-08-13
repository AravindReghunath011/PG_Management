import { Schema, model } from 'mongoose';

export interface IStay {
  _id: string; // client UUID
  ownerId: string;
  residentId: string;
  bedId: string;
  checkInDate: Date;
  checkOutDate: Date | null;
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
