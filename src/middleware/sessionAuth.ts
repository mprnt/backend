import { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError } from './errorHandler';
import {
  SESSION_TOKEN_HEADER,
  SessionCredential,
  sessionAccessService,
} from '../services/sessionAccessService';
import logger from '../utils/logger';

type Resolver = (req: Request) => Promise<SessionCredential | null>;

/**
 * Requires the session secret (X-Session-Token) for the session that owns the
 * resource the route acts on.
 *
 *  401 SESSION_TOKEN_REQUIRED — header missing
 *  403 SESSION_TOKEN_INVALID  — wrong token, or resource owned by another session
 *
 * When the resource does not exist the request passes through so the route
 * answers its usual 404.
 */
const requireSessionToken = (resolve: Resolver): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = req.header(SESSION_TOKEN_HEADER);
    if (!token) {
      next(new AppError('Session token required', 401, 'SESSION_TOKEN_REQUIRED'));
      return;
    }

    resolve(req)
      .then((credential) => {
        if (!credential) {
          next();
          return;
        }
        if (!sessionAccessService.verifyToken(credential, token)) {
          logger.warn('Rejected session token', { path: req.path, ip: req.ip });
          next(new AppError('Invalid session token', 403, 'SESSION_TOKEN_INVALID'));
          return;
        }
        next();
      })
      .catch(next);
  };
};

export const sessionTokenForSession = requireSessionToken((req) =>
  sessionAccessService.bySessionId(req.params.sessionId)
);

export const sessionTokenForJob = requireSessionToken((req) =>
  sessionAccessService.byJobId(req.params.jobId)
);

export const sessionTokenForDocument = requireSessionToken((req) =>
  sessionAccessService.byDocumentId(req.params.documentId)
);

/** Order id from the path (`:orderId`) or, for POST bodies, `orderId`. */
export const sessionTokenForOrder = requireSessionToken((req) => {
  const orderId = req.params.orderId ?? (req.body as { orderId?: unknown } | undefined)?.orderId;
  return typeof orderId === 'string'
    ? sessionAccessService.byOrderId(orderId)
    : Promise.resolve(null);
});
