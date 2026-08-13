import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';

export const authenticateSuperAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.owner || req.owner.role !== 'superadmin') {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'Access denied. Super Admin privileges required.'
      }
    });
  }
  next();
};
