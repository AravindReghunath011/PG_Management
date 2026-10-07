import { Response } from 'express';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Stay, IStay } from './stay.model';
import { Bed } from '../beds/bed.model';
import { Resident } from '../residents/resident.model';
import { Room } from '../rooms/room.model';
import { v4 as uuidv4 } from 'uuid';
import { ensureMonthlyDues, voidAutoDuesFrom } from '../payments/monthlyDues';
import { openDues, parseSettlement, settleDeposit } from './depositSettlement';

function toStayResponse(
  stay: IStay,
  extras?: { residentName?: string | null; bedLabel?: string | null }
) {
  return {
    id: stay._id,
    _id: stay._id,
    ownerId: stay.ownerId,
    residentId: stay.residentId,
    residentName: extras?.residentName ?? null,
    bedId: stay.bedId,
    bedLabel: extras?.bedLabel ?? null,
    checkInDate: stay.checkInDate,
    checkOutDate: stay.checkOutDate,
    noticeMoveOutDate: stay.noticeMoveOutDate ?? null,
    depositSettlement: stay.depositSettlement ?? null,
    monthlyRent: stay.monthlyRent,
    securityDeposit: stay.securityDeposit,
    createdAt: stay.createdAt,
    updatedAt: stay.updatedAt,
  };
}

async function enrichStays(ownerId: string | undefined, stays: IStay[]) {
  const residentIds = [...new Set(stays.map((s) => s.residentId))];
  const bedIds = [...new Set(stays.map((s) => s.bedId))];

  const [residents, beds] = await Promise.all([
    Resident.find({ ...(ownerId ? { ownerId } : {}), _id: { $in: residentIds }, deletedAt: null }),
    Bed.find({ ...(ownerId ? { ownerId } : {}), _id: { $in: bedIds }, deletedAt: null }),
  ]);

  const residentById = new Map(residents.map((r) => [r._id, r]));
  const bedById = new Map(beds.map((b) => [b._id, b]));

  const roomIds = beds.map((b) => b.roomId);
  const rooms = await Room.find({ ...(ownerId ? { ownerId } : {}), _id: { $in: roomIds }, deletedAt: null });
  const roomById = new Map(rooms.map((r) => [r._id, r]));

  return stays.map((stay) => {
    const bed = bedById.get(stay.bedId);
    const room = bed ? roomById.get(bed.roomId) : undefined;
    const bedLabel =
      room && bed ? `${room.roomNumber}-${bed.bedNumber}` : null;
    return toStayResponse(stay, {
      residentName: residentById.get(stay.residentId)?.name ?? null,
      bedLabel,
    });
  });
}

function parseAmountPaise(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
  }
  return null;
}

export const checkInResident = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { residentId, bedId, checkInDate, monthlyRent, securityDeposit, id } =
      req.body;
    const ownerId = req.ownerId!;

    const rentPaise = parseAmountPaise(monthlyRent);
    const depositPaise = parseAmountPaise(securityDeposit);

    if (
      !residentId ||
      !bedId ||
      !checkInDate ||
      rentPaise === null ||
      depositPaise === null
    ) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message:
            'residentId, bedId, checkInDate, monthlyRent, and securityDeposit are required.',
        },
      });
    }

    if (rentPaise < 0 || depositPaise < 0) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'monthlyRent and securityDeposit must be non-negative.',
        },
      });
    }

    const bed = await Bed.findOne({ _id: bedId, ownerId, deletedAt: null });
    if (!bed) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Bed not found.' },
      });
    }

    if (bed.status !== 'vacant') {
      return res.status(400).json({
        error: {
          code: 'BED_OCCUPIED',
          message: 'The selected bed is already occupied.',
        },
      });
    }

    const resident = await Resident.findOne({
      _id: residentId,
      ownerId,
      deletedAt: null,
    });
    if (!resident) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Resident not found.' },
      });
    }

    const activeStay = await Stay.findOne({
      ownerId,
      residentId,
      checkOutDate: null,
      deletedAt: null,
    });
    if (activeStay) {
      return res.status(400).json({
        error: {
          code: 'RESIDENT_ACTIVE',
          message: 'This resident already has an active stay.',
        },
      });
    }

    const stay = new Stay({
      _id: id || uuidv4(),
      ownerId,
      residentId,
      bedId,
      checkInDate: new Date(checkInDate),
      monthlyRent: rentPaise,
      securityDeposit: depositPaise,
    });

    await stay.save();

    bed.status = 'occupied';
    await bed.save();

    await ensureMonthlyDues(ownerId, new Date(), new Date());

    const [enriched] = await enrichStays(ownerId, [stay]);
    return res.status(201).json(enriched);
  } catch (error: any) {
    console.error('Check-in error:', error);
    if (error.message && error.message.includes('DOUBLE_OCCUPANCY')) {
      return res.status(400).json({
        error: {
          code: 'BED_OCCUPIED',
          message: 'This bed is already occupied by another active stay.',
        },
      });
    }
    return res.status(500).json({
      error: {
        code: 'SERVER_ERROR',
        message: 'Error during resident check-in.',
      },
    });
  }
};

export const checkOutResident = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { checkOutDate, settlement } = req.body;
    const ownerId = req.ownerId!;

    const parsedSettlement = settlement !== undefined && settlement !== null ? parseSettlement(settlement) : null;
    if (parsedSettlement && 'error' in parsedSettlement) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsedSettlement.error } });
    }

    if (!checkOutDate) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'checkOutDate is required.',
        },
      });
    }

    const stay = await Stay.findOne({ _id: id, ownerId, deletedAt: null });
    if (!stay) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Stay not found.' },
      });
    }

    if (stay.checkOutDate !== null) {
      return res.status(400).json({
        error: {
          code: 'ALREADY_CHECKED_OUT',
          message: 'This stay is already checked out.',
        },
      });
    }

    const checkoutTime = new Date(checkOutDate);
    if (checkoutTime < stay.checkInDate) {
      return res.status(400).json({
        error: {
          code: 'INVALID_CHECKOUT_DATE',
          message: 'Checkout date cannot be prior to check-in date.',
        },
      });
    }

    // Every month of the stay up to move-out is owed; later dues aren't.
    await ensureMonthlyDues(ownerId, stay.checkInDate, checkoutTime, new Date(), { stayId: stay._id });
    await voidAutoDuesFrom(ownerId, stay._id, checkoutTime);
    if (parsedSettlement) {
      const settled = await settleDeposit(ownerId, stay, checkoutTime, parsedSettlement.value);
      if ('error' in settled) {
        return res.status(400).json({ error: { code: 'INVALID_SETTLEMENT', message: settled.error } });
      }
      stay.depositSettlement = settled.value;
    }

    stay.checkOutDate = checkoutTime;
    await stay.save();

    const bed = await Bed.findOne({ _id: stay.bedId, ownerId });
    if (bed) {
      bed.status = 'vacant';
      await bed.save();
    }

    const [enriched] = await enrichStays(ownerId, [stay]);
    return res.status(200).json(enriched);
  } catch (error) {
    console.error('Checkout error:', error);
    return res.status(500).json({
      error: {
        code: 'SERVER_ERROR',
        message: 'Error during resident check-out.',
      },
    });
  }
};

export const updateStay = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { id } = req.params;
    const { monthlyRent, securityDeposit, checkInDate } = req.body;

    const stay = await Stay.findOne({ _id: id, ownerId, deletedAt: null });
    if (!stay) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Stay not found.' },
      });
    }

    if (checkInDate !== undefined) {
      // Correcting a data-entry mistake on the still-open stay only — never
      // touch bedId here (that would silently rewrite occupancy history,
      // which CLAUDE.md's non-negotiable rules forbid). A checked-out stay's
      // dates are permanent history and stay untouched.
      if (stay.checkOutDate) {
        return res.status(400).json({
          error: {
            code: 'BAD_REQUEST',
            message: 'Cannot change the check-in date of a closed stay.',
          },
        });
      }
      const parsedDate = new Date(checkInDate);
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'checkInDate must be a valid date.' },
        });
      }
      if (parsedDate > new Date()) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'checkInDate cannot be in the future.' },
        });
      }
      stay.checkInDate = parsedDate;
    }

    if (monthlyRent !== undefined) {
      const rentPaise = parseAmountPaise(monthlyRent);
      if (rentPaise === null || rentPaise < 0) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'monthlyRent must be a non-negative amount.' },
        });
      }
      stay.monthlyRent = rentPaise;
    }

    if (securityDeposit !== undefined) {
      const depositPaise = parseAmountPaise(securityDeposit);
      if (depositPaise === null || depositPaise < 0) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'securityDeposit must be a non-negative amount.' },
        });
      }
      stay.securityDeposit = depositPaise;
    }

    await stay.save();
    const [enriched] = await enrichStays(ownerId, [stay]);
    return res.status(200).json(enriched);
  } catch (error) {
    console.error('updateStay error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error updating stay.' },
    });
  }
};

export const getStays = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const { residentId, bedId, active } = req.query;
    const filter: Record<string, unknown> = { deletedAt: null };
    if (ownerId) filter.ownerId = ownerId;
    if (residentId) filter.residentId = residentId;
    if (bedId) filter.bedId = bedId;
    if (active === 'true') filter.checkOutDate = null;

    const stays = await Stay.find(filter).sort({ checkInDate: -1 });
    return res.status(200).json(await enrichStays(ownerId, stays));
  } catch (error) {
    console.error('getStays error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving stays.' },
    });
  }
};

export const getStayById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const { id } = req.params;

    const stay = await Stay.findOne({
      _id: id,
      ...(ownerId ? { ownerId } : {}),
      deletedAt: null,
    });
    if (!stay) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Stay not found.' },
      });
    }

    const [enriched] = await enrichStays(ownerId, [stay]);
    return res.status(200).json(enriched);
  } catch (error) {
    console.error('getStayById error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving stay.' },
    });
  }
};

/**
 * Records a notice period: the resident plans to move out on `moveOutDate`
 * but keeps the bed until checkout. Replaces any earlier notice.
 */
export const giveNotice = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { id } = req.params;
    const moveOut = new Date(req.body?.moveOutDate);

    if (!req.body?.moveOutDate || Number.isNaN(moveOut.getTime())) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'moveOutDate must be a valid date.' },
      });
    }

    const stay = await Stay.findOne({ _id: id, ownerId, deletedAt: null });
    if (!stay) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Stay not found.' } });
    }
    if (stay.checkOutDate !== null) {
      return res.status(400).json({
        error: { code: 'ALREADY_CHECKED_OUT', message: 'This stay is already checked out.' },
      });
    }
    if (moveOut < stay.checkInDate) {
      return res.status(400).json({
        error: { code: 'INVALID_NOTICE_DATE', message: 'Move-out date cannot be before check-in.' },
      });
    }

    stay.noticeMoveOutDate = moveOut;
    await stay.save();
    await voidAutoDuesFrom(ownerId, stay._id, moveOut);
    const [enriched] = await enrichStays(ownerId, [stay]);
    return res.status(200).json(enriched);
  } catch (error) {
    console.error('Give notice error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error recording notice.' },
    });
  }
};

/** Withdraws a notice period; the resident stays on. */
export const cancelNotice = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const stay = await Stay.findOne({ _id: req.params.id, ownerId, deletedAt: null });
    if (!stay) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Stay not found.' } });
    }
    if (stay.checkOutDate !== null) {
      return res.status(400).json({
        error: { code: 'ALREADY_CHECKED_OUT', message: 'This stay is already checked out.' },
      });
    }

    stay.noticeMoveOutDate = null;
    await stay.save();
    const [enriched] = await enrichStays(ownerId, [stay]);
    return res.status(200).json(enriched);
  } catch (error) {
    console.error('Cancel notice error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error cancelling notice.' },
    });
  }
};

/**
 * What a checkout on `date` would settle: deposit held and rent still owed
 * on dues before that date — used to prefill the vacate & settle screen.
 */
export const getSettlementPreview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const stay = await Stay.findOne({ _id: req.params.id, ownerId, deletedAt: null });
    if (!stay) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Stay not found.' } });
    }
    const date = req.query.date ? new Date(req.query.date as string) : new Date();
    if (Number.isNaN(date.getTime())) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'date must be a valid date.' } });
    }
    // The whole stay, so earlier unpaid months count too (this stay only).
    await ensureMonthlyDues(ownerId, stay.checkInDate, date, new Date(), { stayId: stay._id });
    const { dues, balance } = await openDues(ownerId, stay._id, date);
    return res.status(200).json({
      securityDeposit: stay.securityDeposit,
      pendingRent: balance,
      openDues: dues.map((d) => ({
        id: d._id,
        dueDate: d.dueDate,
        balance: Math.max(d.rentDue + d.electricityDue + d.otherDue - (d.rentPaid + d.electricityPaid + d.otherPaid), 0),
      })),
    });
  } catch (error) {
    console.error('Settlement preview error:', error);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Error preparing settlement.' } });
  }
};
