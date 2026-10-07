import { Response } from 'express';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Branch } from '../branches/branch.model';
import { Room } from '../rooms/room.model';
import { Bed } from '../beds/bed.model';
import { Resident } from '../residents/resident.model';
import { Stay } from '../stays/stay.model';
import { Payment } from '../payments/payment.model';
import { PaymentTransaction } from '../payments/paymentTransaction.model';
import { Expense } from '../expenses/expense.model';
import { Owner } from '../auth/owner.model';
import { ensureMonthlyDues } from '../payments/monthlyDues';
import { branchExpenseScope } from '../expenses/branchExpenses';

const DAY_MS = 24 * 60 * 60 * 1000;
const LEAVING_SOON_DAYS = 30;
const DEFAULT_RENT_LIST_LIMIT = 5;
const MAX_RENT_LIST_LIMIT = 100;

export const getStats = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const ownerFilter = ownerId ? { ownerId } : {};
    if (ownerId) await ensureMonthlyDues(ownerId, new Date(), new Date());

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

/**
 * Everything the home dashboard renders, for one period, in one request.
 *
 * Query: `from`, `to` (ISO dates, default = current calendar month, UTC),
 * `limit` (rows per rent-status list, default 5) and optional `branchId` to
 * cover one branch instead of all of them. All money is in paise.
 *
 * - revenue.collected — money actually collected in the period (transactions)
 * - revenue.target    — total of every due whose dueDate falls in the period
 * - revenue.pending   — what is still owed on those dues
 * - revenue.previousCollected — collections in the equally long window just
 *   before `from`, so the client can show a period-over-period change
 * - stats.leavingSoon — open stays on notice to leave (or future checkouts)
 *   within the next 30 days
 * - rentStatus — residents with dues in the period, split into fully paid and
 *   not paid (pending/partial). Counts are totals; lists are capped at `limit`.
 */
export const getOverview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const ownerFilter = ownerId ? { ownerId } : {};

    const now = new Date();
    const fromDate = req.query.from
      ? new Date(req.query.from as string)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const toDate = req.query.to
      ? new Date(req.query.to as string)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1);

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'from and to must be valid dates.' },
      });
    }
    if (fromDate > toDate) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'from must not be after to.' },
      });
    }

    const rawLimit = Number(req.query.limit ?? DEFAULT_RENT_LIST_LIMIT);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.floor(rawLimit), 0), MAX_RENT_LIST_LIMIT)
      : DEFAULT_RENT_LIST_LIMIT;

    // Expected rent = this period's dues, so make sure they exist first.
    if (ownerId) await ensureMonthlyDues(ownerId, fromDate, toDate);

    // Optional: one branch only. Money follows stays on that branch's beds;
    // expenses are the ones recorded against the branch.
    const branchId = typeof req.query.branchId === 'string' && req.query.branchId ? req.query.branchId : null;
    let scopedBranch: { _id: string; name: string } | null = null;
    let roomScope: Record<string, unknown> = {};
    let bedScope: Record<string, unknown> = {};
    let stayScope: Record<string, unknown> = {};
    let moneyScope: Record<string, unknown> = {};
    let expenseScope: Record<string, unknown> = {};
    if (branchId) {
      scopedBranch = await Branch.findOne({ ...ownerFilter, _id: branchId, deletedAt: null }).select('_id name').lean();
      if (!scopedBranch) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Branch not found.' } });
      }
      const roomIds = (await Room.find({ ...ownerFilter, branchId, deletedAt: null }).select('_id').lean()).map((r) => r._id);
      const bedIds = (await Bed.find({ ...ownerFilter, roomId: { $in: roomIds } }).select('_id').lean()).map((b) => b._id);
      const stayIds = (await Stay.find({ ...ownerFilter, bedId: { $in: bedIds } }).select('_id').lean()).map((x) => x._id);
      roomScope = { branchId };
      bedScope = { roomId: { $in: roomIds } };
      stayScope = { bedId: { $in: bedIds } };
      moneyScope = { stayId: { $in: stayIds } };
      const scope = await branchExpenseScope(ownerFilter, branchId);
      expenseScope = scope.match;
    }

    const range = { $gte: fromDate, $lte: toDate };
    const periodMs = toDate.getTime() - fromDate.getTime();
    const prevRange = {
      $gte: new Date(fromDate.getTime() - periodMs - 1),
      $lt: fromDate,
    };
    const leavingUntil = new Date(now.getTime() + LEAVING_SOON_DAYS * DAY_MS);
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const sumCollected = (match: object) =>
      PaymentTransaction.aggregate([
        { $match: { ...ownerFilter, ...moneyScope, deletedAt: null, ...match } },
        {
          $group: {
            _id: null,
            total: { $sum: { $add: ['$rentPaid', '$electricityPaid', '$otherPaid'] } },
          },
        },
      ]);

    const [
      owner,
      firstBranch,
      totalRooms,
      totalBeds,
      vacantBeds,
      leavingSoon,
      collectedAgg,
      prevCollectedAgg,
      expenseAgg,
      payments,
    ] = await Promise.all([
      Owner.findById(req.ownerId).select('name isActive').lean(),
      Branch.findOne({ ...ownerFilter, deletedAt: null }).sort({ createdAt: 1 }).select('name').lean(),
      Room.countDocuments({ ...ownerFilter, ...roomScope, deletedAt: null }),
      Bed.countDocuments({ ...ownerFilter, ...bedScope, deletedAt: null }),
      Bed.countDocuments({ ...ownerFilter, ...bedScope, deletedAt: null, status: 'vacant' }),
      // On notice to move out within the window, or checked out with a future date.
      Stay.countDocuments({
        ...ownerFilter,
        ...stayScope,
        deletedAt: null,
        $or: [
          { checkOutDate: null, noticeMoveOutDate: { $gte: startOfToday, $lte: leavingUntil } },
          { checkOutDate: { $gte: now, $lte: leavingUntil } },
        ],
      }),
      sumCollected({ collectedAt: range }),
      sumCollected({ collectedAt: prevRange }),
      Expense.aggregate([
        { $match: { ...ownerFilter, ...expenseScope, deletedAt: null, date: range } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Payment.find({ ...ownerFilter, ...moneyScope, deletedAt: null, dueDate: range }).sort({ dueDate: 1 }).lean(),
    ]);

    // One row per resident: a resident can hold several dues in a period.
    type RentRow = {
      residentId: string;
      stayId: string;
      due: number;
      paid: number;
      oldestUnpaidDueDate: Date | null;
    };
    const byResident = new Map<string, RentRow>();
    let target = 0;
    let pending = 0;
    for (const p of payments) {
      const due = p.rentDue + p.electricityDue + p.otherDue;
      const paid = p.rentPaid + p.electricityPaid + p.otherPaid;
      target += due;
      pending += Math.max(due - paid, 0);

      const row =
        byResident.get(p.residentId) ??
        { residentId: p.residentId, stayId: p.stayId, due: 0, paid: 0, oldestUnpaidDueDate: null };
      row.due += due;
      row.paid += paid;
      if (p.status !== 'paid' && !row.oldestUnpaidDueDate) row.oldestUnpaidDueDate = p.dueDate;
      byResident.set(p.residentId, row);
    }

    const rows = [...byResident.values()];
    const unpaidRows = rows
      .filter((r) => r.paid < r.due)
      .sort((a, b) => (a.oldestUnpaidDueDate?.getTime() ?? 0) - (b.oldestUnpaidDueDate?.getTime() ?? 0));
    const paidRows = rows.filter((r) => r.paid >= r.due);

    // Resolve names and bed/room labels only for the rows we return.
    const shown = [...unpaidRows.slice(0, limit), ...paidRows.slice(0, limit)];
    const stays = await Stay.find({ ...ownerFilter, _id: { $in: shown.map((r) => r.stayId) } })
      .select('_id bedId')
      .lean();
    const stayById = new Map(stays.map((s) => [s._id, s]));
    const [residents, beds] = await Promise.all([
      Resident.find({ ...ownerFilter, _id: { $in: shown.map((r) => r.residentId) } })
        .select('_id name phone')
        .lean(),
      Bed.find({ ...ownerFilter, _id: { $in: stays.map((s) => s.bedId) } })
        .select('_id bedNumber roomId')
        .lean(),
    ]);
    const residentById = new Map(residents.map((r) => [r._id, r]));
    const bedById = new Map(beds.map((b) => [b._id, b]));
    const rooms = await Room.find({ ...ownerFilter, _id: { $in: beds.map((b) => b.roomId) } })
      .select('_id roomNumber')
      .lean();
    const roomById = new Map(rooms.map((r) => [r._id, r]));

    const toItem = (r: RentRow) => {
      const resident = residentById.get(r.residentId);
      const bed = bedById.get(stayById.get(r.stayId)?.bedId ?? '');
      const room = bed ? roomById.get(bed.roomId) : undefined;
      const overdueMs = r.oldestUnpaidDueDate ? now.getTime() - r.oldestUnpaidDueDate.getTime() : 0;
      return {
        residentId: r.residentId,
        stayId: r.stayId,
        name: resident?.name ?? 'Unknown',
        phone: resident?.phone ?? null,
        roomNumber: room?.roomNumber ?? null,
        bedNumber: bed?.bedNumber ?? null,
        totalDue: r.due,
        totalPaid: Math.min(r.paid, r.due),
        balance: Math.max(r.due - r.paid, 0),
        dueDate: r.oldestUnpaidDueDate,
        // Negative means "due in N days"; only meaningful for unpaid rows.
        daysOverdue: r.oldestUnpaidDueDate ? Math.floor(overdueMs / DAY_MS) : 0,
      };
    };

    return res.status(200).json({
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      branch: scopedBranch ? { id: scopedBranch._id, name: scopedBranch.name } : null,
      owner: {
        name: owner?.name ?? null,
        displayName: scopedBranch?.name ?? firstBranch?.name ?? owner?.name ?? null,
        isActive: owner?.isActive !== false,
      },
      revenue: {
        collected: collectedAgg[0]?.total ?? 0,
        target,
        pending,
        expenses: expenseAgg[0]?.total ?? 0,
        previousCollected: prevCollectedAgg[0]?.total ?? 0,
      },
      stats: {
        totalRooms,
        totalBeds,
        vacantBeds,
        unpaidCount: unpaidRows.length,
        leavingSoon,
      },
      rentStatus: {
        paidCount: paidRows.length,
        unpaidCount: unpaidRows.length,
        paid: paidRows.slice(0, limit).map(toItem),
        unpaid: unpaidRows.slice(0, limit).map(toItem),
      },
      generatedAt: now.toISOString(),
    });
  } catch (error) {
    console.error('Dashboard overview error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error fetching dashboard overview.' },
    });
  }
};
