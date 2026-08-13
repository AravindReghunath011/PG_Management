import path from 'path';
import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { Resident } from '../residents/resident.model';
import { r2Client, uploadBufferToR2, buildKycObjectKey, buildPublicUrl } from '../../lib/r2Client';

export const uploadKyc = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'No file provided.' },
      });
    }

    const { residentId } = req.body;
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
    const key = buildKycObjectKey(residentId, ext);

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

    const kycImageUrl = buildPublicUrl(key);

    resident.kycImageUrl = kycImageUrl;
    await resident.save();

    return res.status(200).json({
      kycImageUrl,
      residentId: resident._id,
    });
  } catch (error) {
    console.error('KYC upload error:', error);
    return res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Error uploading KYC image.' },
    });
  }
};
