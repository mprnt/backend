import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (err instanceof AppError) {
    logger.error('AppError:', {
      message: err.message,
      statusCode: err.statusCode,
      path: req.path,
      method: req.method,
    });

    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
    });
  }

  // body-parser rejects malformed or oversized bodies with a 4xx status and a
  // `type` it sets itself. Those are the client's mistake: reporting them as
  // 500s told the caller the server had failed, and made genuine server faults
  // harder to spot in the logs.
  const parserError = err as Error & { status?: number; type?: string };
  if (
    typeof parserError.status === 'number' &&
    parserError.status >= 400 &&
    parserError.status < 500 &&
    typeof parserError.type === 'string'
  ) {
    logger.warn('Rejected request body', {
      type: parserError.type,
      path: req.path,
      method: req.method,
    });
    return res.status(parserError.status).json({
      status: 'error',
      message:
        parserError.type === 'entity.too.large'
          ? 'Request body is too large'
          : 'Request body is not valid JSON',
    });
  }

  logger.error('Unexpected error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  return res.status(500).json({
    status: 'error',
    message: 'Internal server error',
  });
};

export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    status: 'error',
    message: `Route ${req.originalUrl} not found`,
  });
};
