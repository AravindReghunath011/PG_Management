import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { Owner } from './owner.model';
import { AuthenticatedRequest } from '../../middleware/auth';

const JWT_SECRET = process.env.JWT_SECRET || 'superSecretOwnerTokenKey123!';
const TOKEN_EXPIRY = '7d';

export const register = async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Name, email, and password are required.'
        }
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Password must be at least 8 characters long.'
        }
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const existingOwner = await Owner.findOne({ email: normalizedEmail });
    if (existingOwner) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'An account with this email already exists.'
        }
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const ownerId = uuidv4();

    const owner = new Owner({
      _id: ownerId,
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash,
      role: 'owner'
    });

    await owner.save();

    const token = jwt.sign(
      { id: ownerId, email: owner.email, role: owner.role },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    return res.status(201).json({
      token,
      owner: {
        id: ownerId,
        name: owner.name,
        email: owner.email,
        role: owner.role,
        mustResetPassword: owner.mustResetPassword,
        defaultDepositPaise: owner.defaultDepositPaise,
        defaultRentPaise: owner.defaultRentPaise,
        rentDueDay: owner.rentDueDay ?? null
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong during registration.'
      }
    });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Email and password are required.'
        }
      });
    }

    const owner = await Owner.findOne({ email: String(email).toLowerCase().trim() });
    if (!owner) {
      return res.status(401).json({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password.'
        }
      });
    }

    const isMatch = await bcrypt.compare(password, owner.passwordHash);
    if (!isMatch) {
      return res.status(401).json({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password.'
        }
      });
    }

    // Checked only after the password verifies, so this never reveals whether
    // an email has an account. `=== false` on purpose: owner documents created
    // before isActive existed have it undefined and must still be able to log in.
    if (owner.isActive === false) {
      return res.status(403).json({
        error: {
          code: 'ACCOUNT_DEACTIVATED',
          message: 'This account has been deactivated. Contact your administrator.'
        }
      });
    }

    const token = jwt.sign(
      { id: owner._id, email: owner.email, role: owner.role },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    return res.status(200).json({
      token,
      owner: {
        id: owner._id,
        name: owner.name,
        email: owner.email,
        role: owner.role,
        mustResetPassword: owner.mustResetPassword,
        defaultDepositPaise: owner.defaultDepositPaise,
        defaultRentPaise: owner.defaultRentPaise,
        rentDueDay: owner.rentDueDay ?? null
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong during login.'
      }
    });
  }
};

/** Current owner from JWT — used to restore session on app launch. */
export const me = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const owner = await Owner.findById(req.ownerId).select(
      '_id name email role mustResetPassword defaultDepositPaise defaultRentPaise rentDueDay'
    );
    if (!owner) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Owner not found.' },
      });
    }

    return res.status(200).json({
      owner: {
        id: owner._id,
        name: owner.name,
        email: owner.email,
        role: owner.role,
        mustResetPassword: owner.mustResetPassword,
        defaultDepositPaise: owner.defaultDepositPaise,
        defaultRentPaise: owner.defaultRentPaise,
        rentDueDay: owner.rentDueDay ?? null,
      },
    });
  } catch (error) {
    console.error('Auth me error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong loading the current owner.',
      },
    });
  }
};

/** Lets the currently-authenticated owner set a new password — used both
 * for the forced first-login reset after admin onboarding and for a
 * voluntary password change later. */
export const resetPassword = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Password must be at least 8 characters long.',
        },
      });
    }

    const owner = await Owner.findById(req.ownerId);
    if (!owner) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Owner not found.' },
      });
    }

    owner.passwordHash = await bcrypt.hash(newPassword, 10);
    owner.mustResetPassword = false;
    await owner.save();

    return res.status(200).json({
      owner: {
        id: owner._id,
        name: owner.name,
        email: owner.email,
        role: owner.role,
        mustResetPassword: owner.mustResetPassword,
        defaultDepositPaise: owner.defaultDepositPaise,
        defaultRentPaise: owner.defaultRentPaise,
        rentDueDay: owner.rentDueDay ?? null,
      },
    });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong resetting the password.',
      },
    });
  }
};

const isNonNegativeInteger = (val: unknown): val is number =>
  typeof val === 'number' && Number.isInteger(val) && val >= 0;

/** Lets the currently-authenticated owner configure account-level defaults
 * — the security deposit and monthly rent prefilled on check-in. Either
 * field may be omitted to leave it unchanged, but at least one is required. */
export const updateSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { defaultDepositPaise, defaultRentPaise, rentDueDay } = req.body;

    if (defaultDepositPaise === undefined && defaultRentPaise === undefined && rentDueDay === undefined) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'defaultDepositPaise, defaultRentPaise or rentDueDay is required.',
        },
      });
    }

    if (
      rentDueDay !== undefined &&
      rentDueDay !== null &&
      !(Number.isInteger(rentDueDay) && rentDueDay >= 1 && rentDueDay <= 28)
    ) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'rentDueDay must be a whole number from 1 to 28, or null.' },
      });
    }

    if (defaultDepositPaise !== undefined && !isNonNegativeInteger(defaultDepositPaise)) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'defaultDepositPaise must be a non-negative integer.',
        },
      });
    }

    if (defaultRentPaise !== undefined && !isNonNegativeInteger(defaultRentPaise)) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'defaultRentPaise must be a non-negative integer.',
        },
      });
    }

    const owner = await Owner.findById(req.ownerId);
    if (!owner) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Owner not found.' },
      });
    }

    if (defaultDepositPaise !== undefined) owner.defaultDepositPaise = defaultDepositPaise;
    if (defaultRentPaise !== undefined) owner.defaultRentPaise = defaultRentPaise;
    if (rentDueDay !== undefined) owner.rentDueDay = rentDueDay;
    await owner.save();

    return res.status(200).json({
      owner: {
        id: owner._id,
        name: owner.name,
        email: owner.email,
        role: owner.role,
        mustResetPassword: owner.mustResetPassword,
        defaultDepositPaise: owner.defaultDepositPaise,
        defaultRentPaise: owner.defaultRentPaise,
        rentDueDay: owner.rentDueDay ?? null,
      },
    });
  } catch (error) {
    console.error('Update settings error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong updating settings.',
      },
    });
  }
};

const MAX_OWNER_NAME_LENGTH = 60;

/** Lets the signed-in owner change their own display name. The email is the
 * login and stays as it is (an admin can change it). */
export const updateProfile = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Name cannot be empty.' },
      });
    }
    if (name.length > MAX_OWNER_NAME_LENGTH) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: `Name must be ${MAX_OWNER_NAME_LENGTH} characters or fewer.` },
      });
    }

    const owner = await Owner.findById(req.ownerId);
    if (!owner) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Owner not found.' },
      });
    }

    owner.name = name;
    await owner.save();

    return res.status(200).json({
      owner: {
        id: owner._id,
        name: owner.name,
        email: owner.email,
        role: owner.role,
        mustResetPassword: owner.mustResetPassword,
        defaultDepositPaise: owner.defaultDepositPaise,
        defaultRentPaise: owner.defaultRentPaise,
        rentDueDay: owner.rentDueDay ?? null,
      },
    });
  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong updating your profile.' },
    });
  }
};
