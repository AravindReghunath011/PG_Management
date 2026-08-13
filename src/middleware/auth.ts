import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'superSecretOwnerTokenKey123!';

export interface AuthenticatedRequest extends Request {
  owner?: {
    id: string;
    email: string;
    role: 'owner' | 'superadmin';
  };
  ownerId?: string;
}

export const authenticateOwner = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Access denied. Missing or malformed authentication token.'
      }
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string; role: 'owner' | 'superadmin' };
    req.owner = decoded;
    req.ownerId = decoded.id;
    next();
  } catch (error) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Access denied. Invalid or expired token.'
      }
    });
  }
};

// Returns undefined for a superadmin (meaning "no owner filter, see all owners"),
// otherwise the authenticated owner's id. Read paths only — writes stay owner-scoped.
export const scopeOwnerId = (req: AuthenticatedRequest): string | undefined =>
  req.owner?.role === 'superadmin' ? undefined : req.ownerId;
