import crypto from 'crypto';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { AuthenticatedRequest } from '../../middleware/auth';
import { ResidentInvite, IResidentInvite } from './invite.model';
import { Bed } from '../beds/bed.model';
import { Room } from '../rooms/room.model';
import { Branch } from '../branches/branch.model';
import { Owner } from '../auth/owner.model';
import { Resident } from '../residents/resident.model';
import { parseResidentInput } from '../residents/resident.controller';
import { Stay } from '../stays/stay.model';
import { ensureMonthlyDues } from '../payments/monthlyDues';
import { isImageFile, storeResidentFile, type UploadKind } from '../uploads/upload.controller';

const DAY = 86_400_000;
export const INVITE_TTL_DAYS = 7;
/** Used invites stay in the owner's list this long, so they can see who joined. */
const LIST_WINDOW_DAYS = 30;

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

function parseAmountPaise(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

/** Where the Resident opens the link. PUBLIC_BASE_URL wins (e.g. a custom domain). */
function joinUrl(req: Request, token: string) {
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/join/${token}`;
}

type InviteStatus = 'pending' | 'used' | 'expired';
const statusOf = (invite: IResidentInvite, now = new Date()): InviteStatus =>
  invite.usedAt ? 'used' : invite.expiresAt <= now ? 'expired' : 'pending';

/** Branch / room / bed labels for a set of invites, owner-scoped. */
async function placesFor(ownerId: string, bedIds: string[]) {
  const beds = await Bed.find({ _id: { $in: bedIds }, ownerId }).lean();
  const rooms = await Room.find({ _id: { $in: beds.map((b) => b.roomId) }, ownerId }).lean();
  const branches = await Branch.find({ _id: { $in: rooms.map((r) => r.branchId) }, ownerId }).lean();
  const roomById = new Map(rooms.map((r) => [r._id, r]));
  const branchById = new Map(branches.map((b) => [b._id, b]));
  return new Map(
    beds.map((bed) => {
      const room = roomById.get(bed.roomId);
      const branch = room ? branchById.get(room.branchId) : undefined;
      return [
        bed._id,
        {
          bedNumber: bed.bedNumber,
          bedStatus: bed.status,
          roomId: room?._id ?? null,
          roomNumber: room?.roomNumber ?? null,
          floor: room?.floor ?? null,
          branchId: branch?._id ?? null,
          branchName: branch?.name ?? null,
        },
      ];
    }),
  );
}

type Place = NonNullable<ReturnType<Awaited<ReturnType<typeof placesFor>>['get']>>;

function toInviteResponse(req: Request, invite: IResidentInvite, place: Place | undefined, residentName: string | null) {
  return {
    id: invite._id,
    url: joinUrl(req, invite.token),
    status: statusOf(invite),
    bedId: invite.bedId,
    bedNumber: place?.bedNumber ?? null,
    roomId: place?.roomId ?? null,
    roomNumber: place?.roomNumber ?? null,
    branchId: place?.branchId ?? null,
    branchName: place?.branchName ?? null,
    checkInDate: invite.checkInDate,
    monthlyRent: invite.monthlyRent,
    securityDeposit: invite.securityDeposit,
    expiresAt: invite.expiresAt,
    usedAt: invite.usedAt,
    residentId: invite.residentId,
    residentName,
    createdAt: invite.createdAt,
  };
}

// ── Owner endpoints ──────────────────────────────────────────────────

/** POST /api/invites — create a one-time self check-in link for a vacant bed. */
export const createInvite = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const { bedId, checkInDate, id } = req.body ?? {};
    const rent = parseAmountPaise(req.body?.monthlyRent);
    const deposit = parseAmountPaise(req.body?.securityDeposit);
    const date = checkInDate ? new Date(checkInDate) : null;
    if (!bedId || !date || Number.isNaN(date.getTime()) || rent === null || deposit === null) {
      return fail(res, 400, 'BAD_REQUEST', 'bedId, checkInDate, monthlyRent and securityDeposit are required.');
    }
    if (rent <= 0 || deposit < 0) {
      return fail(res, 400, 'BAD_REQUEST', 'monthlyRent must be positive and securityDeposit non-negative.');
    }

    const bed = await Bed.findOne({ _id: bedId, ownerId, deletedAt: null });
    if (!bed) return fail(res, 404, 'NOT_FOUND', 'Bed not found.');
    if (bed.status !== 'vacant') return fail(res, 409, 'BED_OCCUPIED', 'This bed is already occupied.');

    const now = new Date();
    const pending = await ResidentInvite.findOne({
      ownerId,
      bedId,
      usedAt: null,
      deletedAt: null,
      expiresAt: { $gt: now },
    });
    if (pending) {
      return fail(res, 409, 'INVITE_EXISTS', 'This bed already has an unused invite link. Share or cancel that one.');
    }

    const invite = await ResidentInvite.create({
      _id: id || uuidv4(),
      ownerId,
      token: crypto.randomBytes(24).toString('base64url'),
      bedId,
      checkInDate: date,
      monthlyRent: rent,
      securityDeposit: deposit,
      expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * DAY),
    });
    const places = await placesFor(ownerId, [bedId]);
    return res.status(201).json(toInviteResponse(req, invite, places.get(bedId), null));
  } catch (error) {
    console.error('createInvite error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error creating invite link.');
  }
};

/** GET /api/invites — this owner's invites from the last 30 days, newest first. */
export const getInvites = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const since = new Date(Date.now() - LIST_WINDOW_DAYS * DAY);
    const invites = await ResidentInvite.find({ ownerId, deletedAt: null, createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .lean();
    const places = await placesFor(ownerId, invites.map((i) => i.bedId));
    const residents = await Resident.find({
      _id: { $in: invites.map((i) => i.residentId).filter(Boolean) },
      ownerId,
    }).lean();
    const nameById = new Map(residents.map((r) => [r._id, r.name]));
    return res.json(
      invites.map((i) => toInviteResponse(req, i, places.get(i.bedId), i.residentId ? nameById.get(i.residentId) ?? null : null)),
    );
  } catch (error) {
    console.error('getInvites error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error loading invite links.');
  }
};

/** DELETE /api/invites/:id — cancel an unused link (soft delete). */
export const revokeInvite = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const invite = await ResidentInvite.findOne({ _id: req.params.id, ownerId: req.ownerId!, deletedAt: null });
    if (!invite) return fail(res, 404, 'NOT_FOUND', 'Invite not found.');
    if (invite.usedAt) return fail(res, 409, 'INVITE_USED', 'This link was already used.');
    invite.deletedAt = new Date();
    await invite.save();
    return res.json({ id: invite._id, revoked: true });
  } catch (error) {
    console.error('revokeInvite error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error cancelling invite link.');
  }
};

// ── Public endpoints (the token is the only credential) ─────────────

/** Resolves a token to a usable invite, or sends the reason it can't be used. */
async function usableInvite(token: string, res: Response) {
  const invite = typeof token === 'string' && token.length >= 16
    ? await ResidentInvite.findOne({ token, deletedAt: null })
    : null;
  if (!invite) {
    fail(res, 404, 'INVITE_NOT_FOUND', 'This link is not valid. Ask your PG owner for a new one.');
    return null;
  }
  const status = statusOf(invite);
  if (status === 'used') {
    fail(res, 410, 'INVITE_USED', 'This link has already been used. Each link works only once.');
    return null;
  }
  if (status === 'expired') {
    fail(res, 410, 'INVITE_EXPIRED', 'This link has expired. Ask your PG owner for a new one.');
    return null;
  }
  return invite;
}

async function publicDetails(invite: IResidentInvite) {
  const [places, owner] = await Promise.all([
    placesFor(invite.ownerId, [invite.bedId]),
    Owner.findById(invite.ownerId).lean(),
  ]);
  const place = places.get(invite.bedId);
  return {
    pgName: place?.branchName ?? owner?.name ?? 'Your PG',
    ownerName: owner?.name ?? null,
    ownerPhone: owner?.phoneNumber ?? null,
    roomNumber: place?.roomNumber ?? null,
    floor: place?.floor ?? null,
    bedNumber: place?.bedNumber ?? null,
    bedAvailable: place?.bedStatus === 'vacant',
    checkInDate: invite.checkInDate,
    monthlyRent: invite.monthlyRent,
    securityDeposit: invite.securityDeposit,
    expiresAt: invite.expiresAt,
  };
}

/** GET /api/public/invites/:token — what the join page shows before the form. */
export const getPublicInvite = async (req: Request, res: Response) => {
  try {
    const invite = await usableInvite(req.params.token, res);
    if (!invite) return;
    return res.json(await publicDetails(invite));
  } catch (error) {
    console.error('getPublicInvite error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
};

type UploadedFiles = Partial<Record<'photo' | 'kycFront' | 'kycBack', Express.Multer.File[]>>;

/**
 * POST /api/public/invites/:token (multipart) — the Resident submits their
 * details. Claims the invite atomically first, so the link works exactly once
 * even if submitted twice at the same moment; a failure afterwards releases it.
 */
export const submitPublicInvite = async (req: Request, res: Response) => {
  const invite = await usableInvite(req.params.token, res).catch(() => null);
  if (!invite) {
    if (!res.headersSent) fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
    return;
  }
  const ownerId = invite.ownerId;

  const parsed = parseResidentInput(req.body ?? {});
  if ('error' in parsed) return fail(res, 400, 'BAD_REQUEST', parsed.error);
  const { input } = parsed;

  const files = (req.files ?? {}) as UploadedFiles;
  const photo = files.photo?.[0];
  const kycFront = files.kycFront?.[0];
  const kycBack = files.kycBack?.[0];
  if (photo && !isImageFile(photo.originalname)) return fail(res, 400, 'BAD_REQUEST', 'Your photo must be a JPG or PNG.');
  if (!kycFront) return fail(res, 400, 'BAD_REQUEST', 'Please add a photo of your ID.');

  const duplicate = await Resident.findOne({ ownerId, phone: input.phone, deletedAt: null });
  if (duplicate) {
    return fail(res, 409, 'DUPLICATE_PHONE', 'This phone number is already registered at this PG. Please contact the owner.');
  }

  const claimed = await ResidentInvite.findOneAndUpdate(
    { _id: invite._id, usedAt: null, deletedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true },
  );
  if (!claimed) return fail(res, 410, 'INVITE_USED', 'This link has already been used. Each link works only once.');

  const residentId = uuidv4();
  let residentSaved = false;
  try {
    const bed = await Bed.findOne({ _id: invite.bedId, ownerId, deletedAt: null });
    if (!bed || bed.status !== 'vacant') throw new Error('BED_TAKEN');

    const urls: Partial<Record<'photoUrl' | 'kycImageUrl' | 'kycBackImageUrl', string>> = {};
    const uploads: [UploadKind, Express.Multer.File | undefined][] = [
      ['photo', photo],
      ['kyc_front', kycFront],
      ['kyc_back', kycBack],
    ];
    for (const [kind, file] of uploads) {
      if (!file) continue;
      const { field, url } = await storeResidentFile(residentId, kind, file);
      urls[field] = url;
    }

    await Resident.create({
      _id: residentId,
      ownerId,
      name: input.name,
      phone: input.phone,
      email: input.email,
      kycType: input.kycType,
      kycRef: input.kycRef,
      foodPreference: input.foodPreference,
      ...input.guardian,
      ...urls,
    });
    residentSaved = true;

    const stay = await Stay.create({
      _id: uuidv4(),
      ownerId,
      residentId,
      bedId: bed._id,
      checkInDate: invite.checkInDate,
      monthlyRent: invite.monthlyRent,
      securityDeposit: invite.securityDeposit,
    });
    bed.status = 'occupied';
    await bed.save();

    claimed.residentId = residentId;
    claimed.stayId = stay._id;
    await claimed.save();
    await ensureMonthlyDues(ownerId, new Date(), new Date());

    const details = await publicDetails(claimed);
    return res.status(201).json({
      name: input.name,
      pgName: details.pgName,
      roomNumber: details.roomNumber,
      bedNumber: details.bedNumber,
      checkInDate: invite.checkInDate,
    });
  } catch (error) {
    // Undo: hide the half-created Resident and make the link usable again.
    if (residentSaved) {
      await Resident.updateOne({ _id: residentId, ownerId }, { $set: { deletedAt: new Date() } }).catch(() => {});
    }
    await ResidentInvite.updateOne({ _id: invite._id }, { $set: { usedAt: null } }).catch(() => {});

    const message = error instanceof Error ? error.message : '';
    if (message === 'BED_TAKEN' || message.includes('DOUBLE_OCCUPANCY')) {
      return fail(res, 409, 'BED_TAKEN', 'This bed is no longer available. Please contact the PG owner.');
    }
    console.error('submitPublicInvite error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'We couldn’t save your details. Please try again.');
  }
};
