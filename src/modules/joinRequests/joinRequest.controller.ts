import crypto from 'crypto';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { AuthenticatedRequest } from '../../middleware/auth';
import { JoinLink, JoinRequest, IJoinRequest } from './joinRequest.model';
import { Bed } from '../beds/bed.model';
import { Room } from '../rooms/room.model';
import { Branch } from '../branches/branch.model';
import { Owner } from '../auth/owner.model';
import { ownerAcceptsPublicLinks } from '../auth/access';
import { Resident, residentDeletedFields, residentRestoredFields } from '../residents/resident.model';
import { parseResidentInput } from '../residents/resident.controller';
import { Stay } from '../stays/stay.model';
import { ensureMonthlyDues } from '../payments/monthlyDues';
import { logChange } from '../changeLog/changeLog';
import { isImageFile, storeResidentFile } from '../uploads/upload.controller';

const DAY = 86_400_000;

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

function applyUrl(req: Request, token: string) {
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/apply/${token}`;
}

/**
 * Every bed of the Owner (optionally one Branch) with its room, branch and
 * effective rent (bed → room → owner default), keyed by bed id.
 */
async function bedCatalog(ownerId: string, branchId: string | null) {
  const owner = await Owner.findById(ownerId).select('name defaultRentPaise defaultDepositPaise').lean();
  const branches = await Branch.find({ ownerId, deletedAt: null, ...(branchId ? { _id: branchId } : {}) }).lean();
  const rooms = await Room.find({ ownerId, deletedAt: null, branchId: { $in: branches.map((b) => b._id) } }).lean();
  const beds = await Bed.find({ ownerId, deletedAt: null, roomId: { $in: rooms.map((r) => r._id) } }).lean();
  const roomById = new Map(rooms.map((r) => [r._id, r]));
  const branchById = new Map(branches.map((b) => [b._id, b]));
  const entries = beds.map((bed) => {
    const room = roomById.get(bed.roomId)!;
    const branch = branchById.get(room.branchId)!;
    return [
      bed._id,
      {
        bed,
        room,
        branch,
        rentPaise: bed.rentPaise ?? room.rentPaise ?? owner?.defaultRentPaise ?? 0,
      },
    ] as const;
  });
  return { owner, branches, rooms, beds: new Map(entries) };
}

const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// ── Public (the link token is the only credential) ─────────────────

async function usableLink(token: string, res: Response) {
  const link =
    typeof token === 'string' && token.length >= 16 ? await JoinLink.findOne({ token, deletedAt: null }) : null;
  if (!link || !(await ownerAcceptsPublicLinks(link.ownerId))) {
    fail(res, 404, 'LINK_NOT_FOUND', 'This link is not active. Ask the PG for a new one.');
    return null;
  }
  return link;
}

/** GET /api/public/join-links/:token — the PG and its vacant beds to choose from. */
export const getPublicJoinLink = async (req: Request, res: Response) => {
  try {
    const link = await usableLink(req.params.token, res);
    if (!link) return;
    const { owner, branches, rooms, beds } = await bedCatalog(link.ownerId, link.branchId);

    const vacant = [...beds.values()].filter((b) => b.bed.status === 'vacant');
    const payload = branches
      .map((branch) => ({
        id: branch._id,
        name: branch.name,
        rooms: rooms
          .filter((r) => r.branchId === branch._id)
          .map((room) => ({
            id: room._id,
            roomNumber: room.roomNumber,
            floor: room.floor,
            isAc: (room.amenities ?? []).includes('ac'),
            beds: vacant
              .filter((v) => v.room._id === room._id)
              .map((v) => ({ id: v.bed._id, bedNumber: v.bed.bedNumber, rentPaise: v.rentPaise }))
              .sort((a, b) => byNumber(a.bedNumber, b.bedNumber)),
          }))
          .filter((room) => room.beds.length > 0)
          .sort((a, b) => byNumber(a.roomNumber, b.roomNumber)),
      }))
      .filter((branch) => branch.rooms.length > 0);

    return res.json({
      // The properties the visitor can pick from; the owner's own name only as a last resort.
      pgName:
        payload.length > 0 && payload.length <= 3
          ? payload.map((b) => b.name).join(' · ')
          : branches.length === 1
            ? branches[0].name
            : owner?.name ?? 'Our PG',
      depositPaise: owner?.defaultDepositPaise ?? null,
      branches: payload,
    });
  } catch (error) {
    console.error('getPublicJoinLink error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
};

type UploadedFiles = Partial<Record<'photo' | 'kycFront' | 'kycBack', Express.Multer.File[]>>;

/** POST /api/public/join-links/:token (multipart) — send a request to stay. */
export const submitJoinRequest = async (req: Request, res: Response) => {
  try {
    const link = await usableLink(req.params.token, res);
    if (!link) return;
    const ownerId = link.ownerId;

    const parsed = parseResidentInput(req.body ?? {});
    if ('error' in parsed) return fail(res, 400, 'BAD_REQUEST', parsed.error);
    const { input } = parsed;

    const date = req.body?.preferredCheckInDate ? new Date(req.body.preferredCheckInDate) : null;
    const now = Date.now();
    if (!date || Number.isNaN(date.getTime()) || date.getTime() < now - 3 * 365 * DAY || date.getTime() > now + 365 * DAY) {
      // Past dates are allowed: people already staying use the link too.
      return fail(res, 400, 'BAD_REQUEST', 'Choose a move-in date from the last 3 years or the next year.');
    }

    const files = (req.files ?? {}) as UploadedFiles;
    const photo = files.photo?.[0];
    // ID photos are optional: none, the front, or front and back.
    const kycFront = files.kycFront?.[0];
    const kycBack = files.kycBack?.[0];
    if (photo && !isImageFile(photo.originalname)) return fail(res, 400, 'BAD_REQUEST', 'Your photo must be a JPG or PNG.');

    const { beds } = await bedCatalog(ownerId, link.branchId);
    const chosen = typeof req.body?.bedId === 'string' ? beds.get(req.body.bedId) : undefined;
    if (!chosen) return fail(res, 400, 'BAD_REQUEST', 'Choose a room and bed.');
    if (chosen.bed.status !== 'vacant') {
      return fail(res, 409, 'BED_TAKEN', 'That bed was just taken. Please choose another one.');
    }

    if (await Resident.exists({ ownerId, phone: input.phone, deletedAt: null })) {
      return fail(res, 409, 'DUPLICATE_PHONE', 'This phone number is already registered at this PG. Please contact the owner.');
    }
    if (await JoinRequest.exists({ ownerId, phone: input.phone, status: 'pending', deletedAt: null })) {
      return fail(res, 409, 'ALREADY_APPLIED', 'You have already sent a request. The owner will contact you.');
    }

    // Files are stored under the request id, which becomes the Resident id on approval.
    const requestId = uuidv4();
    const urls: Partial<Record<'photoUrl' | 'kycImageUrl' | 'kycBackImageUrl', string>> = {};
    try {
      if (photo) urls.photoUrl = (await storeResidentFile(requestId, 'photo', photo)).url;
      if (kycFront) urls.kycImageUrl = (await storeResidentFile(requestId, 'kyc_front', kycFront)).url;
      if (kycBack) urls.kycBackImageUrl = (await storeResidentFile(requestId, 'kyc_back', kycBack)).url;
    } catch (uploadError) {
      console.error('join request upload error:', uploadError);
      return fail(res, 502, 'UPLOAD_FAILED', 'We couldn’t upload your photos. Please try again.');
    }

    await JoinRequest.create({
      _id: requestId,
      ownerId,
      joinLinkId: link._id,
      bedId: chosen.bed._id,
      preferredCheckInDate: date,
      name: input.name,
      phone: input.phone,
      email: input.email,
      kycType: input.kycType,
      kycRef: input.kycRef,
      foodPreference: input.foodPreference,
      ...input.guardian,
      ...urls,
    });

    return res.status(201).json({
      name: input.name,
      pgName: chosen.branch.name,
      roomNumber: chosen.room.roomNumber,
      bedNumber: chosen.bed.bedNumber,
    });
  } catch (error) {
    console.error('submitJoinRequest error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'We couldn’t send your request. Please try again.');
  }
};

// ── Owner: links ───────────────────────────────────────────────────

/** GET /api/join-links — the Owner's active apply links. */
export const getJoinLinks = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const links = await JoinLink.find({ ownerId, deletedAt: null }).sort({ createdAt: -1 }).lean();
    const branches = await Branch.find({ ownerId, _id: { $in: links.map((l) => l.branchId).filter(Boolean) } }).lean();
    const nameById = new Map(branches.map((b) => [b._id, b.name]));
    return res.json(
      links.map((l) => ({
        id: l._id,
        url: applyUrl(req, l.token),
        branchId: l.branchId,
        branchName: l.branchId ? nameById.get(l.branchId) ?? null : null,
        createdAt: l.createdAt,
      })),
    );
  } catch (error) {
    console.error('getJoinLinks error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error loading links.');
  }
};

/** POST /api/join-links — get (or create) the apply link for a Branch, or all branches. */
export const createJoinLink = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const branchId = typeof req.body?.branchId === 'string' && req.body.branchId ? req.body.branchId : null;
    let branchName: string | null = null;
    if (branchId) {
      const branch = await Branch.findOne({ _id: branchId, ownerId, deletedAt: null }).lean();
      if (!branch) return fail(res, 404, 'NOT_FOUND', 'Property not found.');
      branchName = branch.name;
    }
    const existing = await JoinLink.findOne({ ownerId, branchId, deletedAt: null });
    const link =
      existing ??
      (await JoinLink.create({
        _id: typeof req.body?.id === 'string' && req.body.id ? req.body.id : uuidv4(),
        ownerId,
        branchId,
        token: crypto.randomBytes(24).toString('base64url'),
      }));
    return res.status(existing ? 200 : 201).json({
      id: link._id,
      url: applyUrl(req, link.token),
      branchId,
      branchName,
      createdAt: link.createdAt,
    });
  } catch (error) {
    console.error('createJoinLink error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error creating link.');
  }
};

/** DELETE /api/join-links/:id — turn a link off (soft delete). Existing requests stay. */
export const disableJoinLink = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const link = await JoinLink.findOne({ _id: req.params.id, ownerId: req.ownerId!, deletedAt: null });
    if (!link) return fail(res, 404, 'NOT_FOUND', 'Link not found.');
    link.deletedAt = new Date();
    await link.save();
    return res.json({ id: link._id, disabled: true });
  } catch (error) {
    console.error('disableJoinLink error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error turning the link off.');
  }
};

// ── Owner: requests ────────────────────────────────────────────────

async function toRequestResponses(ownerId: string, requests: IJoinRequest[]) {
  const { owner, beds } = await bedCatalog(ownerId, null);
  return requests.map((r) => {
    const place = beds.get(r.bedId);
    return {
      id: r._id,
      status: r.status,
      name: r.name,
      phone: r.phone,
      email: r.email,
      kycType: r.kycType,
      kycRef: r.kycRef,
      kycImageUrl: r.kycImageUrl,
      kycBackImageUrl: r.kycBackImageUrl ?? null,
      photoUrl: r.photoUrl,
      guardianName: r.guardianName,
      guardianPhone: r.guardianPhone,
      guardianRelation: r.guardianRelation,
      foodPreference: r.foodPreference,
      preferredCheckInDate: r.preferredCheckInDate,
      bedId: r.bedId,
      bedNumber: place?.bed.bedNumber ?? null,
      roomId: place?.room._id ?? null,
      roomNumber: place?.room.roomNumber ?? null,
      branchId: place?.branch._id ?? null,
      branchName: place?.branch.name ?? null,
      bedAvailable: place?.bed.status === 'vacant',
      bedRentPaise: place?.rentPaise ?? null,
      defaultDepositPaise: owner?.defaultDepositPaise ?? null,
      residentId: r.residentId,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    };
  });
}

/** GET /api/join-requests?status=pending|approved|rejected|all (default pending). */
export const getJoinRequests = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ownerId = req.ownerId!;
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    if (!['pending', 'approved', 'rejected', 'all'].includes(status)) {
      return fail(res, 400, 'BAD_REQUEST', 'status must be pending, approved, rejected or all.');
    }
    const requests = await JoinRequest.find({
      ownerId,
      deletedAt: null,
      ...(status === 'all' ? {} : { status }),
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    return res.json(await toRequestResponses(ownerId, requests));
  } catch (error) {
    console.error('getJoinRequests error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error loading requests.');
  }
};

/** POST /api/join-requests/:id/reject — ignore a request. Nothing else changes. */
export const rejectJoinRequest = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const updated = await JoinRequest.findOneAndUpdate(
      { _id: req.params.id, ownerId: req.ownerId!, status: 'pending', deletedAt: null },
      { $set: { status: 'rejected', decidedAt: new Date() } },
      { new: true },
    ).lean();
    if (!updated) return fail(res, 404, 'NOT_FOUND', 'No pending request with that id.');
    const [response] = await toRequestResponses(req.ownerId!, [updated]);
    return res.json(response);
  } catch (error) {
    console.error('rejectJoinRequest error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error ignoring the request.');
  }
};

/**
 * POST /api/join-requests/:id/approve — check the applicant in. Body (all
 * optional): bedId (defaults to the bed they picked), checkInDate (their
 * preferred date), monthlyRent / securityDeposit in paise (bed rent / owner
 * default). Claims the request first so it can't be approved twice.
 */
export const approveJoinRequest = async (req: AuthenticatedRequest, res: Response) => {
  const ownerId = req.ownerId!;
  const request = await JoinRequest.findOne({ _id: req.params.id, ownerId, status: 'pending', deletedAt: null })
    .lean()
    .catch(() => null);
  if (!request) return fail(res, 404, 'NOT_FOUND', 'No pending request with that id.');

  const { owner, beds } = await bedCatalog(ownerId, null);
  const bedId = typeof req.body?.bedId === 'string' && req.body.bedId ? req.body.bedId : request.bedId;
  const place = beds.get(bedId);
  if (!place) return fail(res, 404, 'NOT_FOUND', 'Bed not found.');
  if (place.bed.status !== 'vacant') {
    return fail(res, 409, 'BED_OCCUPIED', 'That bed is occupied now. Choose another bed for this person.');
  }

  const rent = req.body?.monthlyRent !== undefined ? parseAmountPaise(req.body.monthlyRent) : place.rentPaise;
  const deposit =
    req.body?.securityDeposit !== undefined ? parseAmountPaise(req.body.securityDeposit) : owner?.defaultDepositPaise ?? 0;
  const checkInDate = req.body?.checkInDate ? new Date(req.body.checkInDate) : new Date(request.preferredCheckInDate);
  if (rent === null || rent <= 0 || deposit === null || deposit < 0 || Number.isNaN(checkInDate.getTime())) {
    return fail(res, 400, 'BAD_REQUEST', 'Check the rent, deposit and move-in date.');
  }
  if (await Resident.exists({ ownerId, phone: request.phone, deletedAt: null })) {
    return fail(res, 409, 'DUPLICATE_PHONE', 'A tenant with this phone number already exists.');
  }

  const claimed = await JoinRequest.findOneAndUpdate(
    { _id: request._id, ownerId, status: 'pending' },
    { $set: { status: 'approved', decidedAt: new Date() } },
    { new: true },
  );
  if (!claimed) return fail(res, 409, 'ALREADY_DECIDED', 'This request was already handled.');

  try {
    // Upsert: a failed earlier attempt may have left this (soft-deleted) Resident.
    await Resident.findOneAndUpdate(
      { _id: request._id, ownerId },
      {
        $set: {
          name: request.name,
          phone: request.phone,
          email: request.email,
          kycType: request.kycType,
          kycRef: request.kycRef,
          kycImageUrl: request.kycImageUrl,
          kycBackImageUrl: request.kycBackImageUrl ?? null,
          photoUrl: request.photoUrl,
          guardianName: request.guardianName,
          guardianPhone: request.guardianPhone,
          guardianRelation: request.guardianRelation,
          foodPreference: request.foodPreference,
          ...residentRestoredFields(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    let stay;
    try {
      stay = await Stay.create({
        _id: uuidv4(),
        ownerId,
        residentId: request._id,
        bedId,
        checkInDate,
        monthlyRent: rent,
        securityDeposit: deposit,
      });
    } catch (error) {
      await Resident.updateOne({ _id: request._id, ownerId }, { $set: residentDeletedFields() });
      throw error;
    }
    await Bed.updateOne({ _id: bedId, ownerId }, { $set: { status: 'occupied' } });

    claimed.residentId = request._id;
    claimed.stayId = stay._id;
    claimed.bedId = bedId;
    await claimed.save();
    await logChange(req, { ownerId, residentId: request._id, action: 'resident.created', note: 'Approved from an apply-link request' });
    await logChange(req, {
      ownerId,
      residentId: request._id,
      stayId: stay._id,
      action: 'stay.checked_in',
      note: `${place.room.roomNumber}-${place.bed.bedNumber}`,
      changes: [
        { field: 'checkInDate', from: null, to: checkInDate.toISOString() },
        { field: 'monthlyRent', from: null, to: rent },
        { field: 'securityDeposit', from: null, to: deposit },
      ],
    });
    await ensureMonthlyDues(ownerId, new Date(), new Date());

    const [response] = await toRequestResponses(ownerId, [claimed.toObject()]);
    return res.json({ ...response, stayId: stay._id });
  } catch (error) {
    await JoinRequest.updateOne({ _id: request._id }, { $set: { status: 'pending', decidedAt: null } }).catch(() => {});
    const message = error instanceof Error ? error.message : '';
    if (message.includes('DOUBLE_OCCUPANCY')) {
      return fail(res, 409, 'BED_OCCUPIED', 'That bed is occupied now. Choose another bed for this person.');
    }
    console.error('approveJoinRequest error:', error);
    return fail(res, 500, 'SERVER_ERROR', 'Error approving the request.');
  }
};
