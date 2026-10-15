import multer from 'multer';
import { NextFunction, Request, Response } from 'express';
import { AppError } from './errorHandler';
import { upload } from './upload';

/**
 * Reads one document from a multipart request, and turns multer's own errors into
 * the same clear 4xx responses the rest of the API gives. Without this, an oversized
 * file would come back as a 500.
 */
export function uploadDocument(req: Request, res: Response, next: NextFunction): void {
  upload.single('document')(req, res, (err?: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return next(
        new AppError(
          tooBig ? 'A document can be at most 5 MB' : 'The upload was refused',
          tooBig ? 413 : 400,
          tooBig ? 'DOCUMENT_TOO_LARGE' : 'UPLOAD_REFUSED'
        )
      );
    }
    return next(err);
  });
}
