import rateLimit from 'express-rate-limit';
import env from '../config/environment';

// Global rate limiter for all requests
export const globalRateLimiter = rateLimit({
  windowMs: env.security.rate_limit_window_ms,
  max: env.security.rate_limit_max_requests,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiter for session creation (10 sessions per minute per IP)
export const sessionRateLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 10, // 10 requests per minute
  message: 'Too many session creation requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
});

/**
 * Printer endpoints are polled continuously (heartbeat every 30s, poll every 5s),
 * so they need their own budget — the global per-IP limiter would throttle a
 * kiosk whose printers share one NAT address.
 *
 * Keyed by printer identity rather than IP for exactly that reason.
 */
export const printerRateLimiter = rateLimit({
  windowMs: 60000,
  max: 120, // ~2 req/s sustained: comfortably above a 5s poll + 30s heartbeat
  message: { status: 'error', message: 'Printer is polling too fast. Back off and retry.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed by IP *and* claimed printer id. The header is unauthenticated at this
  // point, so keying on it alone would let a spoofed id burn a real printer's
  // budget; including the IP confines that to the attacker's own bucket.
  keyGenerator: (req) => `${req.ip || 'unknown'}:${req.header('X-Printer-Id') || 'anon'}`,
});

/**
 * Enrollment is a rare, privileged operation. A tight per-IP limit blunts
 * brute-forcing of the provisioning token.
 */
export const printerEnrollRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { status: 'error', message: 'Too many enrollment attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Rate limiter for specific session operations (by sessionId)
export const sessionOperationRateLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 30, // 30 requests per minute per session
  message: 'Too many requests for this session, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use sessionId from params or body, fallback to IP
    const body = req.body as { sessionId?: string } | undefined;
    return req.params.sessionId || body?.sessionId || req.ip || 'unknown';
  },
});

// Public contact form: a person sends one or two; anything more is a bot.
export const leadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { status: 'error', message: 'Too many submissions. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
