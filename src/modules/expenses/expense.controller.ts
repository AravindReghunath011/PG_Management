import { Response } from 'express';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Expense, IExpense, ExpenseCategory } from './expense.model';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_CATEGORIES = new Set<ExpenseCategory>([
  'electricity',
  'cleaning',
  'maintenance',
  'salaries',
  'other',
]);

function parseAmountPaise(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const n = Number(value.replace(/,/g, '').trim());
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
  }
  return null;
}

function toExpenseResponse(expense: IExpense) {
  return {
    id: expense._id,
    _id: expense._id,
    ownerId: expense.ownerId,
    branchId: expense.branchId,
    category: expense.category,
    amount: expense.amount,
    date: expense.date,
    notes: expense.notes,
    createdAt: expense.createdAt,
    updatedAt: expense.updatedAt,
  };
}

export const createExpense = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { branchId, category, amount, date, notes, id } = req.body;

    const amountPaise = parseAmountPaise(amount);
    const expenseDate = date ? new Date(date) : null;

    if (
      !ALLOWED_CATEGORIES.has(category) ||
      amountPaise === null ||
      amountPaise <= 0 ||
      !expenseDate ||
      isNaN(expenseDate.getTime())
    ) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'category, a positive amount, and date are required.',
        },
      });
    }

    const expense = new Expense({
      _id: id || uuidv4(),
      ownerId,
      branchId: branchId ?? null,
      category,
      amount: amountPaise,
      date: expenseDate,
      notes: notes ?? null,
    });

    await expense.save();
    return res.status(201).json(toExpenseResponse(expense));
  } catch (error) {
    console.error('createExpense error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error creating expense.' },
    });
  }
};

export const getExpenses = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const { from, to, branchId, category } = req.query;
    const filter: Record<string, unknown> = { deletedAt: null };
    if (ownerId) filter.ownerId = ownerId;
    if (branchId) filter.branchId = branchId;
    if (category && ALLOWED_CATEGORIES.has(category as ExpenseCategory)) {
      filter.category = category;
    }
    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.$gte = new Date(from as string);
      if (to) range.$lte = new Date(to as string);
      filter.date = range;
    }

    const expenses = await Expense.find(filter).sort({ date: -1 });
    return res.status(200).json(expenses.map(toExpenseResponse));
  } catch (error) {
    console.error('getExpenses error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error retrieving expenses.' },
    });
  }
};

export const updateExpense = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { id } = req.params;
    const { branchId, category, amount, date, notes } = req.body;

    const expense = await Expense.findOne({ _id: id, ownerId, deletedAt: null });
    if (!expense) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Expense not found.' },
      });
    }

    if (category !== undefined) {
      if (!ALLOWED_CATEGORIES.has(category)) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'Invalid category.' },
        });
      }
      expense.category = category;
    }
    if (amount !== undefined) {
      const amountPaise = parseAmountPaise(amount);
      if (amountPaise === null || amountPaise <= 0) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'Invalid amount.' },
        });
      }
      expense.amount = amountPaise;
    }
    if (date !== undefined) {
      const expenseDate = new Date(date);
      if (isNaN(expenseDate.getTime())) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'Invalid date.' },
        });
      }
      expense.date = expenseDate;
    }
    if (branchId !== undefined) expense.branchId = branchId;
    if (notes !== undefined) expense.notes = notes;

    await expense.save();
    return res.status(200).json(toExpenseResponse(expense));
  } catch (error) {
    console.error('updateExpense error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error updating expense.' },
    });
  }
};

export const deleteExpense = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { id } = req.params;
    const expense = await Expense.findOne({ _id: id, ownerId, deletedAt: null });
    if (!expense) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Expense not found.' },
      });
    }

    expense.deletedAt = new Date();
    await expense.save();
    return res.status(200).json({
      success: true,
      message: 'Expense soft-deleted successfully.',
    });
  } catch (error) {
    console.error('deleteExpense error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error deleting expense.' },
    });
  }
};
