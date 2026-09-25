import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { AppError } from './errorHandler';

/**
 * Validation middleware for document-related requests
 */

// UUID v4 format validation
const uuidSchema = Joi.string()
  .uuid({ version: 'uuidv4' })
  .required()
  .messages({
    'string.guid': 'Invalid document ID format. Must be a valid UUID.',
    'any.required': 'Document ID is required',
  });

// Session ID format validation (S{timestamp})
const sessionIdSchema = Joi.string()
  .pattern(/^S\d{13}$/)
  .required()
  .messages({
    'string.pattern.base': 'Invalid session ID format. Must be S followed by timestamp.',
    'any.required': 'Session ID is required',
  });

/**
 * Validate document ID parameter
 */
export const validateDocumentId = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const { documentId } = req.params;

  const { error } = uuidSchema.validate(documentId);

  if (error) {
    throw new AppError(error.details[0].message, 400);
  }

  next();
};

/**
 * Validate session ID parameter
 */
export const validateSessionId = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const { sessionId } = req.params;

  const { error } = sessionIdSchema.validate(sessionId);

  if (error) {
    throw new AppError(error.details[0].message, 400);
  }

  next();
};

/**
 * Validate file upload
 */
export const validateFileUpload = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  if (!req.file) {
    throw new AppError('No file uploaded', 400);
  }

  const file = req.file;

  // Validate file size (already handled by multer, but double-check)
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (file.size > maxSize) {
    throw new AppError(`File size exceeds maximum limit of ${maxSize / 1024 / 1024}MB`, 413);
  }

  // Validate file type
  const allowedMimeTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];
  if (!allowedMimeTypes.includes(file.mimetype)) {
    throw new AppError(
      `Invalid file type: ${file.mimetype}. Allowed types: PDF, PNG, JPEG`,
      400
    );
  }

  next();
};

/**
 * Validate query parameters for document listing
 */
export const validateDocumentQuery = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const schema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    processed: Joi.boolean(),
    fileType: Joi.string().valid('application/pdf', 'image/png', 'image/jpeg'),
  });

  const { error, value } = schema.validate(req.query, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const messages = error.details.map((detail) => detail.message).join(', ');
    throw new AppError(`Validation error: ${messages}`, 400);
  }

  // Replace query with validated values
  req.query = value;
  next();
};

/**
 * General request validation middleware factory
 */
export const validate = (schema: Joi.ObjectSchema, source: 'body' | 'params' | 'query' = 'body') => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const dataToValidate = req[source];

    const { error, value } = schema.validate(dataToValidate, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const messages = error.details.map((detail) => detail.message).join(', ');
      throw new AppError(`Validation error: ${messages}`, 400);
    }

    // Replace with validated values
    req[source] = value;
    next();
  };
};
