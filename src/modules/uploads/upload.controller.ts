import path from 'path';
import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { Resident } from '../residents/resident.model';
import { r2Client, uploadBufferToR2, buildKycObjectKey, buildPublicUrl } from '../../lib/r2Client';

/**
 * What the file is. `kyc_front` is the default so existing clients that send
 * only `file` + `residentId` keep writing kycImageUrl as before.
 */
const UPLOAD_KINDS = {
  kyc_front: { field: 'kycImageUrl', key: (id: string, ext: string) => buildKycObjectKey(id, ext) },
  kyc_back: { field: 'kycBackImageUrl', key: (id: string, ext: string) => buildKycObjectKey(`${id}-back`, ext) },
  photo: { field: 'photoUrl', key: (id: string, ext: string) => `photos/${id}${ext}` },
} as const;
type UploadKind = keyof typeof UPLOAD_KINDS;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);

export const uploadKyc = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'No file provided.' },
      });
    }

    const { residentId } = req.body;
    const kind = (req.body.kind ?? 'kyc_front') as UploadKind;
    if (!(kind in UPLOAD_KINDS)) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'kind must be kyc_front, kyc_back, or photo.' },
      });
    }
    if (!residentId) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'residentId is required.' },
      });
    }

    const ownerId = req.ownerId!;
    const resident = await Resident.findOne({
      _id: residentId,
      ownerId,
      deletedAt: null,
    });

    if (!resident) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Resident not found.' },
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (kind === 'photo' && !IMAGE_EXTS.has(ext)) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Resident photo must be a JPG or PNG.' },
      });
    }
    const { field, key: keyFor } = UPLOAD_KINDS[kind];
    const key = keyFor(residentId, ext);

    try {
      await uploadBufferToR2(r2Client, {
        bucket: process.env.R2_BUCKET_NAME!,
        key,
        body: req.file.buffer,
        contentType: req.file.mimetype,
      });
    } catch (uploadError) {
      console.error('R2 upload error:', uploadError);
      return res.status(502).json({
        error: { code: 'R2_UPLOAD_FAILED', message: 'Error uploading KYC image to storage.' },
      });
    }

    const url = buildPublicUrl(key);

    resident[field] = url;
    await resident.save();

    return res.status(200).json({
      kind,
      url,
      // Kept for existing clients, which read kycImageUrl after a front upload.
      kycImageUrl: resident.kycImageUrl,
      residentId: resident._id,
    });
  } catch (error) {
    console.error('KYC upload error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error uploading KYC image.' },
    });
  }
};
