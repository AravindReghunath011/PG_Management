import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { Resident } from '../residents/resident.model';
import { Stay } from '../stays/stay.model';
import { Bed } from '../beds/bed.model';
import { Payment } from '../payments/payment.model';
import { Room } from '../rooms/room.model';
import { resolveStayPlaces, residencyStatus } from '../stays/stayPlaces';

/** Treat the search text literally ("+91", "(", "." aren't regex syntax). */
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Unified search for residents
export const searchResidents = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { q } = req.query;
    const ownerId = req.ownerId;

    if (!q || typeof q !== 'string') {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Query parameter "q" is required.'
        }
      });
    }

    // Match name or phone using regex
    const residents = await Resident.find({
      ownerId,
      deletedAt: null,
      $or: [
        { name: { $regex: escapeRegex(String(q)), $options: 'i' } },
        { phone: { $regex: escapeRegex(String(q).replace(/[\s-]/g, '')), $options: 'i' } }
      ]
    });

    // Every stay of every match, newest first — the full occupancy history,
    // not just the current stay.
    const allStays = await Stay.find({
      ownerId,
      residentId: { $in: residents.map((r) => r._id) },
      deletedAt: null
    }).sort({ checkInDate: -1 });
    const places = await resolveStayPlaces(ownerId, allStays.map((s) => s.bedId));

    const results = residents.map((resident) => {
      const stays = allStays.filter((s) => s.residentId === resident._id);
      return {
        resident: {
          id: resident._id,
          name: resident.name,
          phone: resident.phone,
          email: resident.email,
          kycType: resident.kycType,
          kycRef: resident.kycRef,
          kycImageUrl: resident.kycImageUrl
        },
        status: residencyStatus(stays),
        stays: stays.map((s) => {
          const place = places.get(s.bedId);
          return {
            id: s._id,
            bedId: s.bedId,
            bedLabel: place?.bedLabel ?? null,
            branchName: place?.branchName ?? null,
            placeRemoved: place?.placeRemoved ?? true,
            checkInDate: s.checkInDate,
            checkOutDate: s.checkOutDate,
            noticeMoveOutDate: s.noticeMoveOutDate ?? null,
            monthlyRent: s.monthlyRent,
            securityDeposit: s.securityDeposit
          };
        })
      };
    });

    // Current residents first, then past ones by most recent move-out.
    const lastSeen = (r: (typeof results)[number]) =>
      r.stays[0]?.checkOutDate ? new Date(r.stays[0].checkOutDate).getTime() : 0;
    results.sort((a, b) => {
      const aGone = a.status === 'moved_out' ? 1 : 0;
      const bGone = b.status === 'moved_out' ? 1 : 0;
      return aGone - bGone || lastSeen(b) - lastSeen(a) || a.resident.name.localeCompare(b.resident.name);
    });

    return res.status(200).json({ results });
  } catch (error) {
    console.error('Resident search error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong during resident search.'
      }
    });
  }
};

/**
 * GET /api/residents/moved-out — everyone who has stayed and has no open stay
 * now, most recent move-out first. Deleted residents are left out.
 */
export const listMovedOut = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId;
    const stays = await Stay.find({ ownerId, deletedAt: null }).sort({ checkInDate: -1 }).lean();
    const byResident = new Map<string, typeof stays>();
    for (const s of stays) {
      const list = byResident.get(s.residentId) ?? [];
      list.push(s);
      byResident.set(s.residentId, list);
    }
    const gone = [...byResident.entries()].filter(([, list]) => list.every((s) => s.checkOutDate));
    const residents = await Resident.find({ ownerId, deletedAt: null, _id: { $in: gone.map(([id]) => id) } }).lean();
    const lastStays = residents.map((r) => byResident.get(r._id)![0]);
    const places = await resolveStayPlaces(ownerId, lastStays.map((s) => s.bedId));

    const results = residents
      .map((r) => {
        const last = byResident.get(r._id)!.reduce((a, b) => (b.checkOutDate! > a.checkOutDate! ? b : a));
        const place = places.get(last.bedId);
        return {
          id: r._id,
          name: r.name,
          phone: r.phone,
          photoUrl: r.photoUrl ?? null,
          bedLabel: place?.bedLabel ?? null,
          branchName: place?.branchName ?? null,
          checkInDate: last.checkInDate,
          checkOutDate: last.checkOutDate,
        };
      })
      .sort((a, b) => new Date(b.checkOutDate!).getTime() - new Date(a.checkOutDate!).getTime());

    return res.status(200).json({ results });
  } catch (error) {
    console.error('listMovedOut error:', error);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Error loading past tenants.' } });
  }
};

// Retrieve historical occupancy and payments of a bed on any date
export const queryBedHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { bedId, date } = req.query;
    const ownerId = req.ownerId;

    if (!bedId || !date) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Parameters "bedId" and "date" are required.'
        }
      });
    }

    const queryDate = new Date(date as string);
    if (isNaN(queryDate.getTime())) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid date parameter. Use ISO-8601 string.'
        }
      });
    }

    // Find the Bed first to make sure it exists
    const bed = await Bed.findOne({ _id: bedId as string, ownerId, deletedAt: null });
    if (!bed) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Bed not found.'
        }
      });
    }

    const room = await Room.findOne({ _id: bed.roomId, ownerId, deletedAt: null });

    // Find Stay active on the queryDate for this bed
    const stay = await Stay.findOne({
      ownerId,
      bedId: bedId as string,
      deletedAt: null,
      checkInDate: { $lte: queryDate },
      $or: [
        { checkOutDate: null },
        { checkOutDate: { $gte: queryDate } }
      ]
    });

    if (!stay) {
      return res.status(200).json({
        bed: {
          id: bed._id,
          bedNumber: bed.bedNumber,
          roomNumber: room?.roomNumber || 'Unknown'
        },
        stay: null,
        resident: null,
        payments: []
      });
    }

    // Resolve Resident
    const resident = await Resident.findOne({
      _id: stay.residentId,
      ownerId,
      deletedAt: null
    });

    // Resolve Payments generated for this stay
    const payments = await Payment.find({
      ownerId,
      stayId: stay._id,
      deletedAt: null
    }).sort({ dueDate: 1 });

    return res.status(200).json({
      bed: {
        id: bed._id,
        bedNumber: bed.bedNumber,
        roomNumber: room?.roomNumber || 'Unknown'
      },
      stay: {
        id: stay._id,
        checkInDate: stay.checkInDate,
        checkOutDate: stay.checkOutDate,
        monthlyRent: stay.monthlyRent,
        securityDeposit: stay.securityDeposit
      },
      resident: resident ? {
        id: resident._id,
        name: resident.name,
        phone: resident.phone,
        email: resident.email,
        kycType: resident.kycType,
        kycRef: resident.kycRef,
        kycImageUrl: resident.kycImageUrl
      } : null,
      payments: payments.map(p => ({
        id: p._id,
        dueDate: p.dueDate,
        paidDate: p.paidDate,
        status: p.status,
        rentDue: p.rentDue,
        rentPaid: p.rentPaid,
        electricityDue: p.electricityDue,
        electricityPaid: p.electricityPaid,
        otherDue: p.otherDue,
        otherPaid: p.otherPaid,
        notes: p.notes
      }))
    });
  } catch (error) {
    console.error('Bed history query error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong during bed history query.'
      }
    });
  }
};
