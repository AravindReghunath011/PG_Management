import { Schema, model } from 'mongoose';

export interface IPayment {
  _id: string; // client UUID
  ownerId: string;
  stayId: string;
  residentId: string;
  dueDate: Date;
  // "YYYY-MM" on rent dues created automatically each month (see
  // monthlyDues.ts); null on dues created by hand.
  dueMonth: string | null;
  paidDate: Date | null;
  status: 'pending' | 'partial' | 'paid';
  
  // Dues (in paise minor units)
  rentDue: number;
  rentPaid: number;
  
  electricityDue: number;
  electricityPaid: number;
  
  otherDue: number;
  otherPaid: number;
  
  notes: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const PaymentSchema = new Schema<IPayment>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    stayId: { type: String, required: true, index: true },
    residentId: { type: String, required: true, index: true },
    dueDate: { type: Date, required: true },
    dueMonth: { type: String, default: null },
    paidDate: { type: Date, default: null },
    status: { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending' },
    
    // Line-items stored as integers (minor units - paise)
    rentDue: { type: Number, required: true, min: 0 },
    rentPaid: { type: Number, default: 0, min: 0 },
    
    electricityDue: { type: Number, default: 0, min: 0 },
    electricityPaid: { type: Number, default: 0, min: 0 },
    
    otherDue: { type: Number, default: 0, min: 0 },
    otherPaid: { type: Number, default: 0, min: 0 },
    
    notes: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

PaymentSchema.index({ ownerId: 1, stayId: 1, deletedAt: 1 });
PaymentSchema.index({ ownerId: 1, residentId: 1, deletedAt: 1 });
// At most one automatic rent due per stay per month (hand-made dues have no
// dueMonth and aren't constrained).
PaymentSchema.index(
  { ownerId: 1, stayId: 1, dueMonth: 1 },
  { unique: true, partialFilterExpression: { dueMonth: { $type: 'string' } } },
);

// Ensure status matches due balances on update/save
PaymentSchema.pre('save', function (this: any, next) {
  const totalDue = this.rentDue + this.electricityDue + this.otherDue;
  const totalPaid = this.rentPaid + this.electricityPaid + this.otherPaid;

  if (totalPaid >= totalDue && totalDue > 0) {
    this.status = 'paid';
    if (!this.paidDate) this.paidDate = new Date();
  } else if (totalPaid > 0) {
    this.status = 'partial';
    this.paidDate = null;
  } else {
    this.status = 'pending';
    this.paidDate = null;
  }
  next();
});

export const Payment = model<IPayment>('Payment', PaymentSchema);
