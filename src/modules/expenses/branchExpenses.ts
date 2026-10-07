import { Branch } from '../branches/branch.model';

/**
 * Which expenses count for one branch's figures.
 *
 * Expenses tagged to the branch always count. Untagged ("shared") expenses
 * also count when the owner has only one branch — there is nowhere else they
 * could belong. With several branches they are left out of each branch's
 * figures (counted once, under all branches).
 */
export async function branchExpenseScope(ownerFilter: Record<string, unknown>, branchId: string) {
  const branchCount = await Branch.countDocuments({ ...ownerFilter, deletedAt: null });
  return branchCount <= 1
    ? { match: { $or: [{ branchId }, { branchId: null }] } }
    : { match: { branchId } };
}
