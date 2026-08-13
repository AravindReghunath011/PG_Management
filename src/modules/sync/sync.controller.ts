import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { Branch } from '../branches/branch.model';
import { Room } from '../rooms/room.model';
import { Bed } from '../beds/bed.model';
import { Resident } from '../residents/resident.model';
import { Stay } from '../stays/stay.model';
import { Payment } from '../payments/payment.model';

const MODEL_MAP: { [key: string]: any } = {
  branch: Branch,
  room: Room,
  bed: Bed,
  resident: Resident,
  stay: Stay,
  payment: Payment
};

export const pullChanges = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { lastPulledAt } = req.body;
    const ownerId = req.ownerId;

    const pullDate = lastPulledAt ? new Date(lastPulledAt) : new Date(0);
    const now = new Date();

    const fetchChanges = async (model: any) => {
      // Find all records updated since lastPulledAt
      const records = await model.find({
        ownerId,
        updatedAt: { $gt: pullDate }
      });

      const created = [];
      const updated = [];
      const deleted = [];

      for (const rec of records) {
        const json = rec.toJSON();
        // Standardize _id to id for client convenience
        json.id = json._id;
        delete json._id;
        delete json.__v;

        if (json.deletedAt !== null) {
          deleted.push(json);
        } else if (rec.createdAt.getTime() === rec.updatedAt.getTime()) {
          created.push(json);
        } else {
          updated.push(json);
        }
      }

      return { created, updated, deleted };
    };

    const changes = {
      branches: await fetchChanges(Branch),
      rooms: await fetchChanges(Room),
      beds: await fetchChanges(Bed),
      residents: await fetchChanges(Resident),
      stays: await fetchChanges(Stay),
      payments: await fetchChanges(Payment)
    };

    return res.status(200).json({
      changes,
      pulledAt: now.toISOString()
    });
  } catch (error) {
    console.error('Pull changes error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Error pulling data changes.'
      }
    });
  }
};

export const pushChanges = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { actions } = req.body;
    const ownerId = req.ownerId;

    if (!Array.isArray(actions)) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Actions array is required.'
        }
      });
    }

    const appliedActionIds: number[] = [];

    for (const actionItem of actions) {
      const { id, action, entityType, entityId, payload } = actionItem;
      const Model = MODEL_MAP[entityType];

      if (!Model) {
        console.warn(`Unknown entity type ignored: ${entityType}`);
        continue;
      }

      try {
        // Enforce owner scope on incoming payloads
        payload._id = entityId;
        payload.ownerId = ownerId;

        // Fetch existing record
        const existingRecord = await Model.findOne({ _id: entityId, ownerId });

        if (existingRecord) {
          const payloadUpdatedDate = new Date(payload.updatedAt);
          const dbUpdatedDate = new Date(existingRecord.updatedAt);

          // Apply LWW: Only overwrite if payload has a newer updatedAt timestamp
          if (payloadUpdatedDate > dbUpdatedDate) {
            if (action === 'delete') {
              existingRecord.deletedAt = payload.deletedAt || new Date();
            } else {
              // Copy all fields except immutable ones
              Object.assign(existingRecord, payload);
            }
            await existingRecord.save();
          }
        } else {
          // If deleted action but record doesn't exist, ignore or create as soft-deleted
          if (action === 'delete') {
            payload.deletedAt = payload.deletedAt || new Date();
          }
          const newRecord = new Model(payload);
          await newRecord.save();
        }

        appliedActionIds.push(id);
      } catch (err: any) {
        console.error(`Error processing sync action ${id}:`, err.message);
        // Do not fail the whole batch, let client keep failing actions in its queue
      }
    }

    return res.status(200).json({
      success: true,
      appliedActionIds
    });
  } catch (error) {
    console.error('Push changes error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Error pushing data changes.'
      }
    });
  }
};
