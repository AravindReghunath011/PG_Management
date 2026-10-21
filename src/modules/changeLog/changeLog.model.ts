import { Schema, model } from 'mongoose';

/**
 * What happened. Resident and Stay changes, files and payments — everything
 * an Owner (or a Resident via a public link) changes about a Resident.
 */
export type ChangeAction =
  | 'resident.created'
  | 'resident.updated'
  | 'resident.deleted'
  | 'resident.file'
  | 'stay.checked_in'
  | 'stay.updated'
  | 'stay.checked_out'
  | 'stay.moved'
  | 'stay.notice_given'
  | 'stay.notice_cancelled'
  | 'stay.rent_revised'
  | 'payment.recorded';

/** One field's before and after. Dates are ISO strings, money is paise. */
export type FieldChange = { field: string; from: unknown; to: unknown };

/**
 * An append-only record of one change. Never edited or deleted: it is the
 * history of who changed what, and when.
 */
export interface IChangeLog {
  _id: string;
  ownerId: string;
  residentId: string | null;
  stayId: string | null;
  action: ChangeAction;
  changes: FieldChange[];
  /** A readable line for things that aren't single fields, e.g. a move "101-A → 102-B". */
  note: string | null;
  /** Who made it: the Owner's id, or null for a Resident using a public link. */
  actorId: string | null;
  actorRole: 'owner' | 'superadmin' | 'resident';
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const ChangeLogSchema = new Schema<IChangeLog>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true },
    residentId: { type: String, default: null },
    stayId: { type: String, default: null },
    action: { type: String, required: true },
    changes: {
      type: [{ _id: false, field: String, from: Schema.Types.Mixed, to: Schema.Types.Mixed }],
      default: [],
    },
    note: { type: String, default: null },
    actorId: { type: String, default: null },
    actorRole: { type: String, enum: ['owner', 'superadmin', 'resident'], required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

ChangeLogSchema.index({ ownerId: 1, residentId: 1, createdAt: -1 });

export const ChangeLog = model<IChangeLog>('ChangeLog', ChangeLogSchema);
