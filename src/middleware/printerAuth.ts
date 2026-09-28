import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import env from '../config/environment';
import { AppError } from '../utils/errors';
import { printerAuthService, AuthenticatedPrinter } from '../services/printerAuthService';
import logger from '../utils/logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      printer?: AuthenticatedPrinter;
    }
  }
}

/**
 * Constant-time string comparison that does not leak length through early exit.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Authenticates a Raspberry Pi via `X-Printer-Id` + `X-Printer-Key`.
 *
 * On success `req.printer` holds the printer's internal UUID, its external
 * printerId and its kioskId. Every handler must scope its queries by
 * `req.printer.id` rather than trusting any id in the request body.
 */
export const authenticatePrinter = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const printerId = req.header('X-Printer-Id');
    const apiKey = req.header('X-Printer-Key');

    if (!printerId || !apiKey) {
      throw new AppError('Missing X-Printer-Id or X-Printer-Key header', 401);
    }

    const printer = await printerAuthService.verifyApiKey(printerId, apiKey);

    if (!printer) {
      // Deliberately identical message for unknown printer and wrong key so the
      // response cannot be used to enumerate valid printer ids.
      logger.warn('Printer authentication failed', { printerId, ip: req.ip });
      throw new AppError('Invalid printer credentials', 401);
    }

    if (printer.revokedAt) {
      logger.warn('Revoked printer attempted access', { printerId, ip: req.ip });
      throw new AppError('Printer credentials have been revoked', 403);
    }

    req.printer = printer;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Guards the one-time enrollment endpoint with a deployment-wide shared secret.
 * This is the only printer endpoint that does not require an API key, because
 * it is how a printer obtains one.
 */
export const requireProvisioningToken = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const expected = env.printer.provisioning_token;

  if (!expected) {
    next(
      new AppError(
        'Printer enrollment is disabled: PRINTER_PROVISIONING_TOKEN is not configured',
        503
      )
    );
    return;
  }

  const provided = req.header('X-Provisioning-Token');

  if (!provided || !safeEqual(provided, expected)) {
    logger.warn('Printer enrollment rejected: bad provisioning token', { ip: req.ip });
    next(new AppError('Invalid provisioning token', 401));
    return;
  }

  next();
};
