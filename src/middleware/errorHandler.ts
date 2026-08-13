import { Request, Response, NextFunction } from 'express';

export const globalErrorHandler = (
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  console.error('Unhandled error:', err);

  // Multer file-size / type errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: { code: 'FILE_TOO_LARGE', message: 'File exceeds 5 MB limit.' },
    });
  }

  if (err.message && err.message.includes('Only jpg')) {
    return res.status(400).json({
      error: { code: 'INVALID_FILE_TYPE', message: err.message },
    });
  }

  const status = err.status || 500;
  return res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred.',
    },
  });
};
