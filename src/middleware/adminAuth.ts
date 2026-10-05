import { Request, Response, NextFunction } from 'express';
import { adminAuthService } from '../services/adminAuthService';
import { AppError } from '../utils/errors';
import { AdminPrincipal, Permission } from '../types/admin';
import logger from '../utils/logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminPrincipal;
      /**
       * The organization this request is allowed to read and write.
       *
       * For a shop admin this is always their own organization, regardless of
       * anything in the URL or body. For a super admin it is whichever
       * organization they asked for, or null meaning "all".
       */
      tenantId?: string | null;
    }
  }
}

/**
 * Verifies the admin access token and attaches the principal.
 */
export const authenticateAdmin = (req: Request, _res: Response, next: NextFunction): void => {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError('Authentication required', 401);
    }

    req.admin = adminAuthService.verifyAccessToken(header.substring(7));
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Requires every listed permission.
 */
export const requirePermission = (...required: Permission[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const admin = req.admin;

    if (!admin) {
      next(new AppError('Authentication required', 401));
      return;
    }

    const missing = required.filter((p) => !admin.permissions.includes(p));

    if (missing.length > 0) {
      logger.warn('Permission denied', {
        adminId: admin.id,
        role: admin.role,
        required,
        missing,
        path: req.path,
      });
      next(new AppError('You do not have permission to perform this action', 403));
      return;
    }

    next();
  };
};

/** Platform-scope endpoints. */
export const requireSuperAdmin = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.admin) {
    next(new AppError('Authentication required', 401));
    return;
  }
  if (!req.admin.isSuperAdmin) {
    logger.warn('Non-super-admin attempted a platform endpoint', {
      adminId: req.admin.id,
      path: req.path,
    });
    next(new AppError('You do not have permission to perform this action', 403));
    return;
  }
  next();
};

/**
 * Blocks an admin who still has a temporary password. Mounted after the routes
 * they need to fix it (auth/me, auth/change-password; login, refresh and logout
 * are public), so everything else answers 403 PASSWORD_CHANGE_REQUIRED.
 */
export const requirePasswordChanged = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.admin?.mustChangePassword) {
    next(
      new AppError(
        'Change your temporary password before continuing',
        403,
        'PASSWORD_CHANGE_REQUIRED'
      )
    );
    return;
  }
  next();
};

/**
 * Establishes the tenant scope for the request.
 *
 * This is the control that keeps one shop out of another's data, so it derives
 * the scope from the authenticated principal and never from a client-supplied
 * value. A shop admin passing someone else's organizationId is rejected outright
 * rather than silently ignored, because the attempt is worth seeing in the logs.
 *
 * A super admin may target any organization via ?organizationId=, or omit it to
 * query across all of them.
 */
export const resolveTenant = (req: Request, _res: Response, next: NextFunction): void => {
  const admin = req.admin;

  if (!admin) {
    next(new AppError('Authentication required', 401));
    return;
  }

  const queryOrganizationId = req.query.organizationId;
  const body: unknown = req.body;
  const bodyOrganizationId =
    typeof body === 'object' &&
    body !== null &&
    'organizationId' in body &&
    typeof body.organizationId === 'string'
      ? body.organizationId
      : undefined;
  const requested =
    (typeof queryOrganizationId === 'string' ? queryOrganizationId : undefined) ||
    req.params.organizationId ||
    bodyOrganizationId;

  if (admin.isSuperAdmin) {
    req.tenantId = requested ?? null;
    next();
    return;
  }

  if (requested && requested !== admin.organizationId) {
    logger.warn('Cross-tenant access attempt', {
      adminId: admin.id,
      ownOrg: admin.organizationId,
      requestedOrg: requested,
      path: req.path,
    });
    next(new AppError('Organization not found', 404));
    return;
  }

  req.tenantId = admin.organizationId;
  next();
};

/**
 * For endpoints that cannot be answered platform-wide and need one concrete
 * organization (e.g. "my shop's printers").
 */
export const requireTenant = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.tenantId) {
    next(new AppError('An organizationId is required for this endpoint', 400));
    return;
  }
  next();
};
