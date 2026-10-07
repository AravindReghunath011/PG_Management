import { Schema, model } from 'mongoose';

// How the money reached the Owner. A label for record-keeping only — no
// gateway integration (see CLAUDE.md "Do NOT").
// 'deposit' = settled from the security deposit at checkout (not a payment the
// owner records by hand, so recordPayment doesn't accept it).
export const PAYMENT_MODES = ['upi', 'cash', 'phonepe', 'bank', 'deposit'] as const;
export const RECORDABLE_PAYMENT_MODES = ['upi', 'cash', 'phonepe', 'bank'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export interface IPaymentTransaction {
  _id: string; // client/server UUID
  ownerId: string;
  paymentId: string;
  residentId: string; // denormalized from Payment at write time
  stayId: string; // denormalized from Payment at write time

  // Amount collected in THIS transaction (paise) — a delta, not cumulative
  rentPaid: number;
  electricityPaid: number;
  otherPaid: number;

  collectedAt: Date; // when the money was actually collected — back-datable
  paymentMode: PaymentMode | null;
  notes: string | null;

  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const PaymentTransactionSchema = new Schema<IPaymentTransaction>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    paymentId: { type: String, required: true, index: true },
    residentId: { type: String, required: true },
    stayId: { type: String, required: true },

    rentPaid: { type: Number, default: 0, min: 0 },
    electricityPaid: { type: Number, default: 0, min: 0 },
    otherPaid: { type: Number, default: 0, min: 0 },

    collectedAt: { type: Date, required: true },
    paymentMode: { type: String, enum: [...PAYMENT_MODES, null], default: null },
    notes: { type: String, default: null },

    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

PaymentTransactionSchema.index({ ownerId: 1, collectedAt: 1 });

export const PaymentTransaction = model<IPaymentTransaction>(
  'PaymentTransaction',
  PaymentTransactionSchema
);
