import { Schema, model } from 'mongoose';

export type ExpenseCategory =
  | 'electricity'
  | 'cleaning'
  | 'maintenance'
  | 'salaries'
  | 'other';

export interface IExpense {
  _id: string; // client UUID
  ownerId: string;
  branchId: string | null;
  category: ExpenseCategory;
  amount: number; // paise
  date: Date; // when it was paid — back-datable
  notes: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const ExpenseSchema = new Schema<IExpense>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    branchId: { type: String, default: null },
    category: {
      type: String,
      enum: ['electricity', 'cleaning', 'maintenance', 'salaries', 'other'],
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true },
    notes: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

ExpenseSchema.index({ ownerId: 1, date: 1 });

export const Expense = model<IExpense>('Expense', ExpenseSchema);
