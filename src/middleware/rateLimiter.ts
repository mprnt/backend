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

// Rate limiter for specific session operations (by sessionId)
export const sessionOperationRateLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 30, // 30 requests per minute per session
  message: 'Too many requests for this session, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use sessionId from params or body, fallback to IP
    return req.params.sessionId || req.body?.sessionId || req.ip || 'unknown';
  },
});
