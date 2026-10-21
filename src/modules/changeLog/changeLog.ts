import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest, scopeOwnerId } from '../../middleware/auth';
import { Resident } from '../residents/resident.model';
import { ChangeLog, type ChangeAction, type FieldChange, type IChangeLog } from './changeLog.model';

type Entry = {
  ownerId: string;
  residentId: string | null;
  stayId?: string | null;
  action: ChangeAction;
  changes?: FieldChange[];
  note?: string | null;
};

/** Plain values for the log: dates as ISO strings, undefined as null. */
const plain = (value: unknown) => (value instanceof Date ? value.toISOString() : value ?? null);

/**
 * The fields whose value differs between `before` and `after`. Pass `before`
 * as a copy taken before the change was applied.
 */
export function diffFields<T extends object>(before: T, after: T, fields: (keyof T & string)[]): FieldChange[] {
  return fields
    .map((field) => ({ field, from: plain(before[field]), to: plain(after[field]) }))
    .filter((c) => JSON.stringify(c.from) !== JSON.stringify(c.to));
}

/** Who made a change: the signed-in Owner, or a Resident on a public link. */
export const actorOf = (req: AuthenticatedRequest | null) =>
  req?.owner
    ? { actorId: req.owner.id, actorRole: req.owner.role === 'superadmin' ? ('superadmin' as const) : ('owner' as const) }
    : { actorId: null, actorRole: 'resident' as const };

/**
 * Appends one entry to the change log. The change itself is already saved, so
 * a logging failure is reported but never undoes or fails the request.
 * An update that changed nothing is not logged.
 */
export async function logChange(req: AuthenticatedRequest | null, entry: Entry): Promise<void> {
  if (entry.action.endsWith('.updated') && !(entry.changes?.length)) return;
  try {
    await ChangeLog.create({
      _id: uuidv4(),
      ownerId: entry.ownerId,
      residentId: entry.residentId,
      stayId: entry.stayId ?? null,
      action: entry.action,
      changes: entry.changes ?? [],
      note: entry.note ?? null,
      ...actorOf(req),
    });
  } catch (error) {
    console.error('Change log write failed:', entry.action, error);
  }
}

const toLogResponse = (log: IChangeLog) => ({
  id: log._id,
  residentId: log.residentId,
  stayId: log.stayId,
  action: log.action,
  changes: log.changes,
  note: log.note,
  actorRole: log.actorRole,
  createdAt: log.createdAt,
});

/** GET /api/residents/:id/changes — every change to one Resident, newest first. */
export const getResidentChanges = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = scopeOwnerId(req);
    const scope = ownerId ? { ownerId } : {};
    // Deleted Residents keep their log, so no deletedAt filter here.
    const resident = await Resident.findOne({ _id: req.params.id, ...scope }).select('_id').lean();
    if (!resident) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resident not found.' } });
    }
    const logs = await ChangeLog.find({ ...scope, residentId: resident._id, deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    return res.status(200).json({ changes: logs.map(toLogResponse) });
  } catch (error) {
    console.error('getResidentChanges error:', error);
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Error retrieving changes.' } });
  }
};
