import { v4 as uuidv4 } from 'uuid';
import { Payment } from '../payments/payment.model';
import { PaymentTransaction } from '../payments/paymentTransaction.model';
import type { IStay } from './stay.model';

/**
 * Deposit settlement recorded when a resident checks out: what was deducted
 * from the security deposit and what was refunded.
 *
 * A `rent` deduction is applied to the stay's open dues (oldest first) as
 * PaymentTransactions with paymentMode 'deposit', so the dues show as paid
 * and collected totals / P&L include it. Other kinds just reduce the refund.
 */

export const DEDUCTION_KINDS = ['rent', 'damage', 'cleaning', 'other'] as const;
export type DeductionKind = (typeof DEDUCTION_KINDS)[number];
export const REFUND_MODES = ['upi', 'cash', 'phonepe', 'bank'] as const;

export type SettlementInput = {
  deductions: { kind: DeductionKind; label: string; amount: number }[];
  refundMode: (typeof REFUND_MODES)[number] | null;
  notes: string | null;
};

/** Validates the request body's `settlement`. Amounts are paise. */
export function parseSettlement(raw: unknown): { error: string } | { value: SettlementInput } {
  if (typeof raw !== 'object' || raw === null) return { error: 'settlement must be an object.' };
  const body = raw as Record<string, unknown>;
  const list = body.deductions ?? [];
  if (!Array.isArray(list) || list.length > 20) return { error: 'deductions must be a list of up to 20 items.' };

  const deductions: SettlementInput['deductions'] = [];
  for (const item of list) {
    const d = (item ?? {}) as Record<string, unknown>;
    if (!DEDUCTION_KINDS.includes(d.kind as DeductionKind)) {
      return { error: `Each deduction kind must be one of: ${DEDUCTION_KINDS.join(', ')}.` };
    }
    if (typeof d.amount !== 'number' || !Number.isInteger(d.amount) || d.amount <= 0) {
      return { error: 'Each deduction amount must be a positive whole number of paise.' };
    }
    const label = typeof d.label === 'string' && d.label.trim() ? d.label.trim().slice(0, 60) : String(d.kind);
    deductions.push({ kind: d.kind as DeductionKind, label, amount: d.amount });
  }

  const refundMode = body.refundMode ?? null;
  if (refundMode !== null && !REFUND_MODES.includes(refundMode as (typeof REFUND_MODES)[number])) {
    return { error: `refundMode must be one of: ${REFUND_MODES.join(', ')}.` };
  }
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 500) : null;
  return { value: { deductions, refundMode: refundMode as SettlementInput['refundMode'], notes } };
}

/** Open (unpaid) balance on the stay's live dues dated before `before`. */
export async function openDues(ownerId: string, stayId: string, before: Date) {
  const dues = await Payment.find({
    ownerId,
    stayId,
    deletedAt: null,
    status: { $ne: 'paid' },
    dueDate: { $lt: before },
  }).sort({ dueDate: 1 });
  const balance = dues.reduce(
    (n, p) => n + Math.max(p.rentDue + p.electricityDue + p.otherDue - (p.rentPaid + p.electricityPaid + p.otherPaid), 0),
    0,
  );
  return { dues, balance };
}

/**
 * Checks the settlement against the deposit and the open dues, applies any
 * rent deduction to those dues, and returns what to store on the stay.
 */
export async function settleDeposit(
  ownerId: string,
  stay: IStay,
  checkOut: Date,
  input: SettlementInput,
): Promise<{ error: string } | { value: NonNullable<IStay['depositSettlement']> }> {
  const total = input.deductions.reduce((n, d) => n + d.amount, 0);
  if (total > stay.securityDeposit) {
    return { error: 'Deductions can’t be more than the security deposit.' };
  }

  const rentToApply = input.deductions.filter((d) => d.kind === 'rent').reduce((n, d) => n + d.amount, 0);
  const { dues, balance } = await openDues(ownerId, stay._id, checkOut);
  if (rentToApply > balance) {
    return { error: 'The pending-rent deduction is more than the rent still owed.' };
  }

  // Pay off dues oldest-first, line by line (rent, electricity, other).
  let remaining = rentToApply;
  for (const due of dues) {
    if (remaining <= 0) break;
    const take = (owed: number, paid: number) => {
      const part = Math.min(Math.max(owed - paid, 0), remaining);
      remaining -= part;
      return part;
    };
    const rent = take(due.rentDue, due.rentPaid);
    const electricity = take(due.electricityDue, due.electricityPaid);
    const other = take(due.otherDue, due.otherPaid);
    if (rent + electricity + other === 0) continue;

    await new PaymentTransaction({
      _id: uuidv4(),
      ownerId,
      paymentId: due._id,
      residentId: due.residentId,
      stayId: due.stayId,
      rentPaid: rent,
      electricityPaid: electricity,
      otherPaid: other,
      collectedAt: checkOut,
      paymentMode: 'deposit',
      notes: 'Adjusted from security deposit at checkout',
    }).save();
    due.rentPaid += rent;
    due.electricityPaid += electricity;
    due.otherPaid += other;
    await due.save();
  }

  return {
    value: {
      deductions: input.deductions,
      totalDeductions: total,
      refundAmount: stay.securityDeposit - total,
      refundMode: input.refundMode,
      notes: input.notes,
      settledAt: checkOut,
    },
  };
}
