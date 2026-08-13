import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';

/**
 * Middleware that ensures the request body's ownerId is strictly overridden
 * by the authenticated owner's ID from the JWT token.
 * This guarantees the client cannot spoof the ownerId.
 */
export const enforceOwnerBodyScope = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.ownerId) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Owner context is missing.'
      }
    });
  }

  // Force incoming request payloads to match the JWT ownerId
  if (req.body) {
    req.body.ownerId = req.ownerId;
  }
  
  next();
};
