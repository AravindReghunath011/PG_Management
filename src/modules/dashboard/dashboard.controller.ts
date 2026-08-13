import { Response } from 'express';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Branch } from '../branches/branch.model';
import { Room } from '../rooms/room.model';
import { Bed } from '../beds/bed.model';
import { Resident } from '../residents/resident.model';
import { Stay } from '../stays/stay.model';
import { Payment } from '../payments/payment.model';

export const getStats = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const ownerFilter = ownerId ? { ownerId } : {};

    const [
      totalBranches,
      totalRooms,
      totalBeds,
      occupiedBeds,
      totalResidents,
      pendingPayments,
      recentStays,
      recentPayments,
    ] = await Promise.all([
      Branch.countDocuments({ ...ownerFilter, deletedAt: null }),
      Room.countDocuments({ ...ownerFilter, deletedAt: null }),
      Bed.countDocuments({ ...ownerFilter, deletedAt: null }),
      Bed.countDocuments({ ...ownerFilter, status: 'occupied', deletedAt: null }),
      Resident.countDocuments({ ...ownerFilter, deletedAt: null }),

      // Sum all pending/partial payment dues
      Payment.aggregate([
        {
          $match: {
            ...ownerFilter,
            deletedAt: null,
            status: { $in: ['pending', 'partial'] },
          },
        },
        {
          $group: {
            _id: null,
            totalDue: {
              $sum: {
                $subtract: [
                  { $add: ['$rentDue', '$electricityDue', '$otherDue'] },
                  { $add: ['$rentPaid', '$electricityPaid', '$otherPaid'] },
                ],
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),

      // Last 5 check-ins for recent activity
      Stay.find({ ...ownerFilter, deletedAt: null })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('_id residentId bedId checkInDate checkOutDate createdAt'),

      // Last 5 payments
      Payment.find({ ...ownerFilter, deletedAt: null, status: 'paid' })
        .sort({ updatedAt: -1 })
        .limit(5)
        .select('_id residentId stayId rentPaid electricityPaid otherPaid updatedAt'),
    ]);

    const vacantBeds = totalBeds - occupiedBeds;
    const occupancyRate = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;
    const pendingDuesTotal = pendingPayments[0]?.totalDue ?? 0;
    const pendingDuesCount = pendingPayments[0]?.count ?? 0;

    // Resolve resident names for activity feed
    const stayResidentIds = recentStays.map((s: any) => s.residentId);
    const paymentResidentIds = recentPayments.map((p: any) => p.residentId);
    const allIds = [...new Set([...stayResidentIds, ...paymentResidentIds])];

    const residents = await Resident.find({
      _id: { $in: allIds },
      ...ownerFilter,
    }).select('_id name');

    const residentMap: Record<string, string> = {};
    for (const r of residents as any[]) {
      residentMap[r._id] = r.name;
    }

    // Resolve bed → room number for display
    const bedIds = recentStays.map((s: any) => s.bedId);
    const beds = await Bed.find({ _id: { $in: bedIds }, ...ownerFilter }).select('_id bedNumber roomId');
    const bedMap: Record<string, any> = {};
    for (const b of beds as any[]) bedMap[b._id] = b;

    const roomIds = Object.values(bedMap).map((b: any) => b.roomId);
    const rooms = await Room.find({ _id: { $in: roomIds }, ...ownerFilter }).select('_id roomNumber branchId');
    const roomMap: Record<string, any> = {};
    for (const r of rooms as any[]) roomMap[r._id] = r;

    const recentActivity = [
      ...recentStays.map((s: any) => ({
        type: s.checkOutDate ? 'checkout' : 'checkin',
        residentName: residentMap[s.residentId] ?? 'Unknown',
        bedNumber: bedMap[s.bedId]?.bedNumber ?? '',
        roomNumber: roomMap[bedMap[s.bedId]?.roomId]?.roomNumber ?? '',
        timestamp: s.createdAt,
      })),
      ...recentPayments.map((p: any) => ({
        type: 'payment',
        residentName: residentMap[p.residentId] ?? 'Unknown',
        amountPaid: p.rentPaid + p.electricityPaid + p.otherPaid,
        timestamp: p.updatedAt,
      })),
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 10);

    return res.status(200).json({
      stats: {
        totalBranches,
        totalRooms,
        totalBeds,
        occupiedBeds,
        vacantBeds,
        occupancyRate,
        totalResidents,
        pendingDuesTotal,
        pendingDuesCount,
      },
      recentActivity,
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error fetching dashboard stats.' },
    });
  }
};
