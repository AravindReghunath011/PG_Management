import { Schema, model } from 'mongoose';

/**
 * A reusable "apply to stay" link. Anyone with it can pick a vacant bed and
 * send their details; each submission becomes a JoinRequest the Owner approves
 * or ignores. Turning the link off (deletedAt) stops new requests.
 */
export interface IJoinLink {
  _id: string;
  ownerId: string;
  token: string;
  /** Only this Branch's beds are offered; null = all of the Owner's branches. */
  branchId: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const JoinLinkSchema = new Schema<IJoinLink>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    token: { type: String, required: true, unique: true },
    branchId: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false },
);

export const JoinLink = model<IJoinLink>('JoinLink', JoinLinkSchema);

/**
 * Details a would-be Resident sent through a JoinLink. Nothing is created in
 * the Owner's data until they approve it: approval creates the Resident (with
 * this request's id, which the uploaded files are already keyed by) and the Stay.
 */
export interface IJoinRequest {
  _id: string;
  ownerId: string;
  joinLinkId: string;
  /** The bed the applicant picked; the Owner may assign another on approval. */
  bedId: string;
  preferredCheckInDate: Date;
  name: string;
  phone: string;
  email: string | null;
  kycType: 'Aadhaar' | 'Passport' | 'DL' | 'Other';
  kycRef: string;
  kycImageUrl: string | null;
  photoUrl: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  guardianRelation: string | null;
  foodPreference: 'with_food' | 'without_food';
  status: 'pending' | 'approved' | 'rejected';
  decidedAt: Date | null;
  residentId: string | null;
  stayId: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

const JoinRequestSchema = new Schema<IJoinRequest>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    joinLinkId: { type: String, required: true },
    bedId: { type: String, required: true },
    preferredCheckInDate: { type: Date, required: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, default: null },
    kycType: { type: String, enum: ['Aadhaar', 'Passport', 'DL', 'Other'], required: true },
    kycRef: { type: String, default: '' },
    kycImageUrl: { type: String, default: null },
    photoUrl: { type: String, default: null },
    guardianName: { type: String, default: null },
    guardianPhone: { type: String, default: null },
    guardianRelation: { type: String, default: null },
    foodPreference: { type: String, enum: ['with_food', 'without_food'], default: 'with_food' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    decidedAt: { type: Date, default: null },
    residentId: { type: String, default: null },
    stayId: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false },
);

JoinRequestSchema.index({ ownerId: 1, status: 1, createdAt: -1 });

export const JoinRequest = model<IJoinRequest>('JoinRequest', JoinRequestSchema);
