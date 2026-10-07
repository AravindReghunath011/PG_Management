import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { Resident } from '../residents/resident.model';
import { Stay } from '../stays/stay.model';
import { Bed } from '../beds/bed.model';
import { Payment } from '../payments/payment.model';
import { Room } from '../rooms/room.model';

/** Treat the search text literally ("+91", "(", "." aren't regex syntax). */
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
import { Branch } from '../branches/branch.model';

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

    const results = [];
    for (const resident of residents) {
      // Find active or past stays, newest first — this is the resident's
      // full occupancy history, not just their current stay.
      const stays = await Stay.find({
        ownerId,
        residentId: resident._id,
        deletedAt: null
      }).sort({ checkInDate: -1 });

      const bedIds = [...new Set(stays.map((s) => s.bedId))];
      const beds = await Bed.find({ ownerId, _id: { $in: bedIds }, deletedAt: null });
      const bedById = new Map(beds.map((b) => [b._id, b]));

      const roomIds = [...new Set(beds.map((b) => b.roomId))];
      const rooms = await Room.find({ ownerId, _id: { $in: roomIds }, deletedAt: null });
      const roomById = new Map(rooms.map((r) => [r._id, r]));

      const branchIds = [...new Set(rooms.map((r) => r.branchId))];
      const branches = await Branch.find({ ownerId, _id: { $in: branchIds }, deletedAt: null });
      const branchById = new Map(branches.map((b) => [b._id, b]));

      results.push({
        resident: {
          id: resident._id,
          name: resident.name,
          phone: resident.phone,
          email: resident.email,
          kycType: resident.kycType,
          kycRef: resident.kycRef,
          kycImageUrl: resident.kycImageUrl
        },
        stays: stays.map(s => {
          const bed = bedById.get(s.bedId);
          const room = bed ? roomById.get(bed.roomId) : undefined;
          const branch = room ? branchById.get(room.branchId) : undefined;
          return {
            id: s._id,
            bedId: s.bedId,
            bedLabel: room && bed ? `${room.roomNumber}-${bed.bedNumber}` : null,
            branchName: branch?.name ?? null,
            checkInDate: s.checkInDate,
            checkOutDate: s.checkOutDate,
            monthlyRent: s.monthlyRent,
            securityDeposit: s.securityDeposit
          };
        })
      });
    }

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
