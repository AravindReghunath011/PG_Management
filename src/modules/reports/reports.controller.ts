import { Response } from 'express';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Stay } from '../stays/stay.model';
import { Resident } from '../residents/resident.model';
import { Bed } from '../beds/bed.model';
import { Room } from '../rooms/room.model';
import { Branch } from '../branches/branch.model';
import { PaymentTransaction } from '../payments/paymentTransaction.model';
import { Expense } from '../expenses/expense.model';

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
