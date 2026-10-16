import { Owner, type IOwner } from './owner.model';

export type AccessStatus = IOwner['accessStatus'];

/**
 * Whether new sign-ups must wait for a superadmin. Off unless the env turns it
 * on: for now every sign-up gets access straight away.
 */
export const signupRequiresApproval = () => process.env.OWNER_SIGNUP_REQUIRES_APPROVAL === 'true';

/**
 * Owner documents created before accessStatus existed have it undefined:
 * approved. While approval is switched off, a 'pending' owner (signed up when
 * it was on) is approved too; a rejected owner stays rejected.
 */
export const accessStatusOf = (owner: { accessStatus?: AccessStatus | null }): AccessStatus => {
  const status = owner.accessStatus ?? 'approved';
  return status === 'pending' && !signupRequiresApproval() ? 'approved' : status;
};

/**
 * Whether an Owner's public links (invite / apply) may take submissions: the
 * account must exist, be active and be approved.
 */
export async function ownerAcceptsPublicLinks(ownerId: string): Promise<boolean> {
  const owner = await Owner.findById(ownerId).select('isActive accessStatus').lean();
  return !!owner && owner.isActive !== false && accessStatusOf(owner) === 'approved';
}
