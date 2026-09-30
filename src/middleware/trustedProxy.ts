import crypto from 'crypto';
import net from 'net';
import { Request, Response, NextFunction } from 'express';
import env from '../config/environment';
import logger from '../utils/logger';

/**
 * Restores the real client IP for requests relayed by the admin dashboard.
 *
 * The dashboard keeps admin tokens out of the browser by calling the API from
 * its own server. The side effect is that every admin, in every shop, reaches
 * this API from that one server's address. Without correction:
 *
 *  - the global per-IP rate limit is shared by every admin at once;
 *  - every audit entry and failed sign-in records the dashboard's IP, which
 *    makes the security log useless for spotting an intruder.
 *
 * Trusting X-Forwarded-For is not the fix — any caller can set that header, so
 * a Pi or a stranger could claim any address. Instead the dashboard proves it
 * is the dashboard with a shared secret, and only then is its client-IP header
 * believed.
 *
 * Must run before the rate limiter, so limits key on the real client.
 */
export function trustedProxy(req: Request, _res: Response, next: NextFunction): void {
  const expected = env.admin.proxy_secret;
  if (!expected) {
    next();
    return;
  }

  const presented = req.header('X-MPrnt-Proxy-Secret');
  const clientIp = req.header('X-MPrnt-Client-IP');

  if (!presented) {
    next();
    return;
  }

  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();

  if (!crypto.timingSafeEqual(a, b)) {
    // Someone is sending the header without knowing the secret. Ignore the
    // claimed IP and carry on with the real connection address.
    logger.warn('Rejected X-MPrnt-Proxy-Secret with wrong value', { ip: req.ip });
    next();
    return;
  }

  if (clientIp && net.isIP(clientIp.trim())) {
    // req.ip is a prototype getter in Express 4; an own property shadows it,
    // so the rate limiter, audit log and everything else see the client.
    Object.defineProperty(req, 'ip', { value: clientIp.trim(), configurable: true });
  }

  next();
}
