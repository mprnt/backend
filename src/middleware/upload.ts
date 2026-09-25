import multer from 'multer';
import { Request } from 'express';
import { AppError } from './errorHandler';

/**
 * Multer configuration for file uploads
 */

// File filter - only allow PDF, PNG, JPEG
const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimeTypes = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        `Invalid file type. Only PDF, PNG, and JPEG files are allowed. Received: ${file.mimetype}`,
        400
      )
    );
  }
};

// Storage configuration - use memory storage (we'll upload to S3/MinIO)
const storage = multer.memoryStorage();

// Multer upload middleware
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
    files: 1, // Only 1 file per request
  },
});

// Single file upload middleware
export const uploadSingle = upload.single('document');
