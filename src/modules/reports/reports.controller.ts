import { Response } from 'express';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Stay } from '../stays/stay.model';
import { Resident } from '../residents/resident.model';
import { Bed } from '../beds/bed.model';
import { Room } from '../rooms/room.model';
import { Branch } from '../branches/branch.model';
import { PaymentTransaction } from '../payments/paymentTransaction.model';
import { Payment } from '../payments/payment.model';
import { Expense } from '../expenses/expense.model';
import { ensureMonthlyDues, monthKeyOf, monthKeysBetween } from '../payments/monthlyDues';
import { branchExpenseScope } from '../expenses/branchExpenses';

export const getJoineesReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const ownerFilter = ownerId ? { ownerId } : {};
    const { from, to } = req.query;

    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
    twelveMonthsAgo.setDate(1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    const monthlyAgg = await Stay.aggregate([
      {
        $match: {
          ...ownerFilter,
          deletedAt: null,
          checkInDate: { $gte: twelveMonthsAgo },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$checkInDate' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const monthly = monthlyAgg.map((m) => ({ month: m._id, count: m.count }));

    let range: unknown[] | null = null;
    if (from && to) {
      const stays = await Stay.find({
        ...ownerFilter,
        deletedAt: null,
        checkInDate: { $gte: new Date(from as string), $lte: new Date(to as string) },
      }).sort({ checkInDate: 1 });

      const residentIds = [...new Set(stays.map((s) => s.residentId))];
      const bedIds = [...new Set(stays.map((s) => s.bedId))];

      const [residents, beds] = await Promise.all([
        Resident.find({ ...ownerFilter, _id: { $in: residentIds } }),
        Bed.find({ ...ownerFilter, _id: { $in: bedIds } }),
      ]);
      const residentById = new Map(residents.map((r) => [r._id, r]));
      const bedById = new Map(beds.map((b) => [b._id, b]));

      const roomIds = [...new Set(beds.map((b) => b.roomId))];
      const rooms = await Room.find({ ...ownerFilter, _id: { $in: roomIds } });
      const roomById = new Map(rooms.map((r) => [r._id, r]));

      const branchIds = [...new Set(rooms.map((r) => r.branchId))];
      const branches = await Branch.find({ ...ownerFilter, _id: { $in: branchIds } });
      const branchById = new Map(branches.map((b) => [b._id, b]));

      range = stays.map((stay) => {
        const resident = residentById.get(stay.residentId);
        const bed = bedById.get(stay.bedId);
        const room = bed ? roomById.get(bed.roomId) : undefined;
        const branch = room ? branchById.get(room.branchId) : undefined;
        return {
          residentId: stay.residentId,
          residentName: resident?.name ?? null,
          residentPhone: resident?.phone ?? null,
          stayId: stay._id,
          roomLabel: room && bed ? `${room.roomNumber}-${bed.bedNumber}` : null,
          branchName: branch?.name ?? null,
          checkInDate: stay.checkInDate,
        };
      });
    }

    return res.status(200).json({ monthly, range });
  } catch (error) {
    console.error('getJoineesReport error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error generating joinees report.' },
    });
  }
};

export const getCollectionsReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const ownerFilter = ownerId ? { ownerId } : {};
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'from and to are required.' },
      });
    }

    const transactions = await PaymentTransaction.find({
      ...ownerFilter,
      deletedAt: null,
      collectedAt: { $gte: new Date(from as string), $lte: new Date(to as string) },
    }).sort({ collectedAt: 1 });

    const residentIds = [...new Set(transactions.map((t) => t.residentId))];
    const residents = await Resident.find({ ...ownerFilter, _id: { $in: residentIds } });
    const residentById = new Map(residents.map((r) => [r._id, r]));

    let totalCollected = 0;
    const rows = transactions.map((t) => {
      const totalPaid = t.rentPaid + t.electricityPaid + t.otherPaid;
      totalCollected += totalPaid;
      return {
        id: t._id,
        residentId: t.residentId,
        residentName: residentById.get(t.residentId)?.name ?? null,
        paymentId: t.paymentId,
        rentPaid: t.rentPaid,
        electricityPaid: t.electricityPaid,
        otherPaid: t.otherPaid,
        totalPaid,
        collectedAt: t.collectedAt,
        paymentMode: t.paymentMode,
        notes: t.notes,
      };
    });

    return res.status(200).json({ transactions: rows, totalCollected });
  } catch (error) {
    console.error('getCollectionsReport error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error generating collections report.' },
    });
  }
};

export const getFinanceReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const ownerFilter = ownerId ? { ownerId } : {};
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'from and to are required.' },
      });
    }

    const range = { $gte: new Date(from as string), $lte: new Date(to as string) };

    const [incomeAgg, expenseAgg, expenseByCategoryAgg] = await Promise.all([
      PaymentTransaction.aggregate([
        { $match: { ...ownerFilter, deletedAt: null, collectedAt: range } },
        {
          $group: {
            _id: null,
            total: { $sum: { $add: ['$rentPaid', '$electricityPaid', '$otherPaid'] } },
          },
        },
      ]),
      Expense.aggregate([
        { $match: { ...ownerFilter, deletedAt: null, date: range } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Expense.aggregate([
        { $match: { ...ownerFilter, deletedAt: null, date: range } },
        { $group: { _id: '$category', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
      ]),
    ]);

    const totalIncome = incomeAgg[0]?.total ?? 0;
    const totalExpense = expenseAgg[0]?.total ?? 0;

    return res.status(200).json({
      totalIncome,
      totalExpense,
      net: totalIncome - totalExpense,
      expensesByCategory: expenseByCategoryAgg.map((e) => ({
        category: e._id,
        total: e.total,
      })),
    });
  } catch (error) {
    console.error('getFinanceReport error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error generating finance report.' },
    });
  }
};

export const getFoodPreferenceReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const ownerFilter = ownerId ? { ownerId } : {};

    const activeStays = await Stay.find({
      ...ownerFilter,
      deletedAt: null,
      checkOutDate: null,
    }).select('residentId');
    const residentIds = [...new Set(activeStays.map((s) => s.residentId))];

    const agg = await Resident.aggregate([
      { $match: { ...ownerFilter, deletedAt: null, _id: { $in: residentIds } } },
      { $group: { _id: '$foodPreference', count: { $sum: 1 } } },
    ]);

    const counts: Record<string, number> = {};
    for (const row of agg) counts[row._id ?? 'without_food'] = row.count;

    return res.status(200).json({
      withFood: counts['with_food'] ?? 0,
      withoutFood: counts['without_food'] ?? 0,
    });
  } catch (error) {
    console.error('getFoodPreferenceReport error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error generating food preference report.' },
    });
  }
};

/**
 * Collection summary for the dashboard's period ring.
 *
 * Answers three questions for a date range, in one request:
 *   - who owes rent and how much of it they have paid (`tenants`)
 *   - who checked out during the period (`leaving`)
 *   - what was spent (`expenses`, in paise)
 *
 * Rent only: `electricity` and `other` line items are deliberately excluded,
 * because the ring measures rent collection. Keys are snake_case to match the
 * client's CollectionSummary.fromJson.
 */
export const getCollectionSummaryReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const ownerFilter = ownerId ? { ownerId } : {};
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'from and to are required.' },
      });
    }

    const fromDate = new Date(from as string);
    const toDate = new Date(to as string);
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

    if (ownerId) await ensureMonthlyDues(ownerId, fromDate, toDate);
    const range = { $gte: fromDate, $lte: toDate };

    const [payments, leavingStays, expenseAgg] = await Promise.all([
      // Dues falling in the period, whatever their payment status.
      Payment.find({ ...ownerFilter, deletedAt: null, dueDate: range }),
      Stay.find({ ...ownerFilter, deletedAt: null, checkOutDate: range }).sort({
        checkOutDate: 1,
      }),
      Expense.aggregate([
        { $match: { ...ownerFilter, deletedAt: null, date: range } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    // One row per resident: a resident can hold several dues in a period.
    const byResident = new Map<
      string,
      { residentId: string; stayId: string; dueAmount: number; paidAmount: number }
    >();
    for (const p of payments) {
      const row = byResident.get(p.residentId);
      if (row) {
        row.dueAmount += p.rentDue;
        row.paidAmount += p.rentPaid;
      } else {
        byResident.set(p.residentId, {
          residentId: p.residentId,
          stayId: p.stayId,
          dueAmount: p.rentDue,
          paidAmount: p.rentPaid,
        });
      }
    }

    // Resolve bed → room → branch labels for both tenants and leavers.
    const stayIds = [
      ...new Set([
        ...[...byResident.values()].map((r) => r.stayId),
        ...leavingStays.map((s) => s._id),
      ]),
    ];
    const stays = await Stay.find({ ...ownerFilter, _id: { $in: stayIds } });
    const stayById = new Map(stays.map((s) => [s._id, s]));

    const residentIds = [
      ...new Set([
        ...byResident.keys(),
        ...leavingStays.map((s) => s.residentId),
      ]),
    ];
    const bedIds = [...new Set(stays.map((s) => s.bedId))];

    const [residents, beds] = await Promise.all([
      Resident.find({ ...ownerFilter, _id: { $in: residentIds } }),
      Bed.find({ ...ownerFilter, _id: { $in: bedIds } }),
    ]);
    const residentById = new Map(residents.map((r) => [r._id, r]));
    const bedById = new Map(beds.map((b) => [b._id, b]));

    const roomIds = [...new Set(beds.map((b) => b.roomId))];
    const rooms = await Room.find({ ...ownerFilter, _id: { $in: roomIds } });
    const roomById = new Map(rooms.map((r) => [r._id, r]));

    const branchIds = [...new Set(rooms.map((r) => r.branchId))];
    const branches = await Branch.find({ ...ownerFilter, _id: { $in: branchIds } });
    const branchById = new Map(branches.map((b) => [b._id, b]));

    const placeOf = (stayId: string | undefined) => {
      const stay = stayId ? stayById.get(stayId) : undefined;
      const bed = stay ? bedById.get(stay.bedId) : undefined;
      const room = bed ? roomById.get(bed.roomId) : undefined;
      const branch = room ? branchById.get(room.branchId) : undefined;
      return {
        room_number: room?.roomNumber ?? null,
        bed_number: bed?.bedNumber ?? null,
        branch_name: branch?.name ?? null,
      };
    };

    const tenants = [...byResident.values()]
      .map((row) => {
        const resident = residentById.get(row.residentId);
        return {
          resident_id: row.residentId,
          name: resident?.name ?? 'Unknown',
          phone: resident?.phone ?? null,
          ...placeOf(row.stayId),
          due_amount: row.dueAmount,
          // Never report more paid than was due — the ring treats due as 100%.
          paid_amount: Math.min(row.paidAmount, row.dueAmount),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const leaving = leavingStays.map((s) => ({
      name: residentById.get(s.residentId)?.name ?? 'Unknown',
      leaving_on: (s.checkOutDate as Date).toISOString(),
      ...placeOf(s._id),
    }));

    return res.status(200).json({
      tenants,
      leaving,
      expenses: expenseAgg[0]?.total ?? 0,
    });
  } catch (error) {
    console.error('getCollectionSummaryReport error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error generating collection summary.' },
    });
  }
};

/**
 * Profit & loss for a period, optionally for one branch.
 *
 * - income: money actually collected (PaymentTransaction.collectedAt in range)
 * - expectedRent: dues falling in the range (automatic monthly dues included)
 * - expenses: Expense.date in range; for one branch, only that branch's
 *   expenses (owner-wide expenses with no branch are left out)
 * - monthly: the same three per local month, oldest first, for trend charts
 * All money in paise.
 */
export const getProfitLossReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const ownerFilter = ownerId ? { ownerId } : {};
    const { from, to, branchId } = req.query;

    const fromDate = new Date(from as string);
    const toDate = new Date(to as string);
    if (!from || !to || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'from and to must be valid dates.' },
      });
    }
    if (fromDate > toDate) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'from must not be after to.' },
      });
    }

    if (ownerId) await ensureMonthlyDues(ownerId, fromDate, toDate);
    const range = { $gte: fromDate, $lte: toDate };

    // One branch: restrict money to stays on that branch's beds.
    let stayFilter: Record<string, unknown> = {};
    let expenseBranchFilter: Record<string, unknown> = {};
    if (branchId) {
      const rooms = await Room.find({ ...ownerFilter, branchId: branchId as string }).select('_id').lean();
      const beds = await Bed.find({ ...ownerFilter, roomId: { $in: rooms.map((r) => r._id) } }).select('_id').lean();
      const stays = await Stay.find({ ...ownerFilter, bedId: { $in: beds.map((b) => b._id) } }).select('_id').lean();
      stayFilter = { stayId: { $in: stays.map((s) => s._id) } };
      const scope = await branchExpenseScope(ownerFilter, branchId as string);
      expenseBranchFilter = scope.match;
    }

    const [transactions, dues, expenses] = await Promise.all([
      PaymentTransaction.find({ ...ownerFilter, ...stayFilter, deletedAt: null, collectedAt: range })
        .select('collectedAt rentPaid electricityPaid otherPaid paymentMode')
        .lean(),
      Payment.find({ ...ownerFilter, ...stayFilter, deletedAt: null, dueDate: range })
        .select('dueDate rentDue electricityDue otherDue')
        .lean(),
      Expense.find({ ...ownerFilter, ...expenseBranchFilter, deletedAt: null, date: range })
        .select('date amount category')
        .lean(),
    ]);

    const months = new Map(
      monthKeysBetween(fromDate, toDate).map((m) => [m, { month: m, income: 0, expense: 0, expected: 0 }]),
    );
    const bucket = (d: Date) => months.get(monthKeyOf(d));

    let totalIncome = 0;
    const byMode = new Map<string, number>();
    for (const t of transactions) {
      const amount = t.rentPaid + t.electricityPaid + t.otherPaid;
      totalIncome += amount;
      const mode = t.paymentMode ?? 'unspecified';
      byMode.set(mode, (byMode.get(mode) ?? 0) + amount);
      const b = bucket(t.collectedAt);
      if (b) b.income += amount;
    }

    let expectedRent = 0;
    for (const d of dues) {
      const amount = d.rentDue + d.electricityDue + d.otherDue;
      expectedRent += amount;
      const b = bucket(d.dueDate);
      if (b) b.expected += amount;
    }

    let totalExpense = 0;
    const byCategory = new Map<string, number>();
    for (const e of expenses) {
      totalExpense += e.amount;
      byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount);
      const b = bucket(e.date);
      if (b) b.expense += e.amount;
    }

    const sortDesc = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);

    return res.status(200).json({
      totalIncome,
      totalExpense,
      net: totalIncome - totalExpense,
      expectedRent,
      collectionRate: expectedRent > 0 ? Math.round((totalIncome / expectedRent) * 1000) / 10 : null,
      expensesByCategory: sortDesc(byCategory).map(([category, total]) => ({ category, total })),
      incomeByMode: sortDesc(byMode).map(([mode, total]) => ({ mode, total })),
      monthly: [...months.values()],
    });
  } catch (error) {
    console.error('getProfitLossReport error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error generating profit & loss report.' },
    });
  }
};
