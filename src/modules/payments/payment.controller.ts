import { Response } from 'express';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Payment, IPayment } from './payment.model';
import { PaymentTransaction } from './paymentTransaction.model';
import { Stay } from '../stays/stay.model';
import { Resident } from '../residents/resident.model';
import { Bed } from '../beds/bed.model';
import { Room } from '../rooms/room.model';
import { v4 as uuidv4 } from 'uuid';

function parseAmountPaise(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const n = Number(value.replace(/,/g, '').trim());
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
  }
  return null;
}

function toPaymentResponse(
  payment: IPayment,
  extras?: {
    residentName?: string | null;
    bedLabel?: string | null;
  }
) {
  const totalDue =
    (payment.rentDue || 0) +
    (payment.electricityDue || 0) +
    (payment.otherDue || 0);
  const totalPaid =
    (payment.rentPaid || 0) +
    (payment.electricityPaid || 0) +
    (payment.otherPaid || 0);

  return {
    id: payment._id,
    _id: payment._id,
    ownerId: payment.ownerId,
    stayId: payment.stayId,
    residentId: payment.residentId,
    residentName: extras?.residentName ?? null,
    bedLabel: extras?.bedLabel ?? null,
    dueDate: payment.dueDate,
    paidDate: payment.paidDate,
    status: payment.status,
    rentDue: payment.rentDue,
    rentPaid: payment.rentPaid,
    electricityDue: payment.electricityDue,
    electricityPaid: payment.electricityPaid,
    otherDue: payment.otherDue,
    otherPaid: payment.otherPaid,
    totalDue,
    totalPaid,
    notes: payment.notes,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

async function enrichPayments(ownerId: string | undefined, payments: IPayment[]) {
  const residentIds = [...new Set(payments.map((p) => p.residentId))];
  const stayIds = [...new Set(payments.map((p) => p.stayId))];

  const [residents, stays] = await Promise.all([
    Resident.find({ ...(ownerId ? { ownerId } : {}), _id: { $in: residentIds }, deletedAt: null }),
    Stay.find({ ...(ownerId ? { ownerId } : {}), _id: { $in: stayIds }, deletedAt: null }),
  ]);

  const residentById = new Map(residents.map((r) => [r._id, r]));
  const stayById = new Map(stays.map((s) => [s._id, s]));

  const bedIds = stays.map((s) => s.bedId);
  const beds = await Bed.find({ ...(ownerId ? { ownerId } : {}), _id: { $in: bedIds }, deletedAt: null });
  const bedById = new Map(beds.map((b) => [b._id, b]));

  const roomIds = beds.map((b) => b.roomId);
  const rooms = await Room.find({ ...(ownerId ? { ownerId } : {}), _id: { $in: roomIds }, deletedAt: null });
  const roomById = new Map(rooms.map((r) => [r._id, r]));

  return payments.map((p) => {
    const stay = stayById.get(p.stayId);
    const bed = stay ? bedById.get(stay.bedId) : undefined;
    const room = bed ? roomById.get(bed.roomId) : undefined;
    const bedLabel =
      room && bed ? `${room.roomNumber}-${bed.bedNumber}` : null;
    return toPaymentResponse(p, {
      residentName: residentById.get(p.residentId)?.name ?? null,
      bedLabel,
    });
  });
}

export const generateDue = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { stayId, dueDate, rentDue, electricityDue, otherDue, notes, id } =
      req.body;
    const ownerId = req.ownerId!;

    const rent = parseAmountPaise(rentDue);
    const electricity = parseAmountPaise(electricityDue ?? 0) ?? 0;
    const other = parseAmountPaise(otherDue ?? 0) ?? 0;

    if (!stayId || !dueDate || rent === null) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'stayId, dueDate, and rentDue are required.',
        },
      });
    }

    const stay = await Stay.findOne({ _id: stayId, ownerId, deletedAt: null });
    if (!stay) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Stay not found.' },
      });
    }

    const payment = new Payment({
      _id: id || uuidv4(),
      ownerId,
      stayId,
      residentId: stay.residentId,
      dueDate: new Date(dueDate),
      rentDue: rent,
      electricityDue: electricity,
      otherDue: other,
      notes: notes ?? null,
    });

    await payment.save();
    const [enriched] = await enrichPayments(ownerId, [payment]);
    return res.status(201).json(enriched);
  } catch (error) {
    console.error('Generate due error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error generating due.' },
    });
  }
};

// Records one collection event (a delta added to the running total), not an
// absolute "set total paid to X" — so partial payments made on different
// days each get their own dated PaymentTransaction record.
export const recordPayment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { rentCollected, electricityCollected, otherCollected, collectedAt, notes } = req.body;
    const ownerId = req.ownerId!;

    const rentDelta = rentCollected !== undefined ? parseAmountPaise(rentCollected) : 0;
    const electricityDelta = electricityCollected !== undefined ? parseAmountPaise(electricityCollected) : 0;
    const otherDelta = otherCollected !== undefined ? parseAmountPaise(otherCollected) : 0;

    if (rentDelta === null || electricityDelta === null || otherDelta === null) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Invalid collected amount.' },
      });
    }
    if (rentDelta < 0 || electricityDelta < 0 || otherDelta < 0) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Collected amounts must be non-negative.' },
      });
    }
    if (rentDelta === 0 && electricityDelta === 0 && otherDelta === 0) {
      return res.status(400).json({
        error: { code: 'INVALID_AMOUNT', message: 'At least one collected amount must be greater than zero.' },
      });
    }

    const payment = await Payment.findOne({ _id: id, ownerId, deletedAt: null });
    if (!payment) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Payment record not found.' },
      });
    }

    const collectedDate = collectedAt ? new Date(collectedAt) : new Date();

    const transaction = new PaymentTransaction({
      _id: uuidv4(),
      ownerId,
      paymentId: payment._id,
      residentId: payment.residentId,
      stayId: payment.stayId,
      rentPaid: rentDelta,
      electricityPaid: electricityDelta,
      otherPaid: otherDelta,
      collectedAt: collectedDate,
      notes: notes ?? null,
    });
    await transaction.save();

    payment.rentPaid = (payment.rentPaid || 0) + rentDelta;
    payment.electricityPaid = (payment.electricityPaid || 0) + electricityDelta;
    payment.otherPaid = (payment.otherPaid || 0) + otherDelta;
    if (notes !== undefined) payment.notes = notes;

    await payment.save();
    const [enriched] = await enrichPayments(ownerId, [payment]);
    return res.status(200).json({
      ...enriched,
      transaction: {
        id: transaction._id,
        rentPaid: transaction.rentPaid,
        electricityPaid: transaction.electricityPaid,
        otherPaid: transaction.otherPaid,
        collectedAt: transaction.collectedAt,
      },
    });
  } catch (error) {
    console.error('Record payment error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error recording payment.' },
    });
  }
};

export const getPayments = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const { stayId, residentId, status } = req.query;
    const filter: Record<string, unknown> = { deletedAt: null };
    if (ownerId) filter.ownerId = ownerId;
    if (stayId) filter.stayId = stayId;
    if (residentId) filter.residentId = residentId;
    if (status && ['pending', 'partial', 'paid'].includes(status as string)) {
      filter.status = status;
    }

    const payments = await Payment.find(filter).sort({ dueDate: -1 });
    return res.status(200).json(await enrichPayments(ownerId, payments));
  } catch (error) {
    console.error('getPayments error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving payments.' },
    });
  }
};

export const getPaymentById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const { id } = req.params;

    const payment = await Payment.findOne({
      _id: id,
      ...(ownerId ? { ownerId } : {}),
      deletedAt: null,
    });
    if (!payment) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Payment record not found.' },
      });
    }

    const [enriched] = await enrichPayments(ownerId, [payment]);
    return res.status(200).json(enriched);
  } catch (error) {
    console.error('getPaymentById error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving payment.' },
    });
  }
};
