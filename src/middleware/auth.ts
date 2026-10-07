import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Owner } from '../modules/auth/owner.model';

const JWT_SECRET = process.env.JWT_SECRET || 'superSecretOwnerTokenKey123!';

export interface AuthenticatedRequest extends Request {
  owner?: {
    id: string;
    email: string;
    role: 'owner' | 'superadmin';
  };
  ownerId?: string;
}

export const authenticateOwner = async (
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

    // Tokens live 7 days, so deactivation would otherwise not take effect until
    // the token expired. One primary-key lookup per request keeps it immediate
    // and also rejects tokens for an owner document that no longer exists.
    const owner = await Owner.findById(decoded.id).select('isActive').lean();
    if (!owner) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Access denied. Invalid or expired token.'
        }
      });
    }
    // `=== false` on purpose — owners created before isActive existed have it
    // undefined and must keep working.
    if (owner.isActive === false) {
      return res.status(403).json({
        error: {
          code: 'ACCOUNT_DEACTIVATED',
          message: 'This account has been deactivated. Contact your administrator.'
        }
      });
    }

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
