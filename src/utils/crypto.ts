import crypto from 'crypto';

/**
 * Constant-time string comparison for secrets and signatures.
 * Unequal lengths return false without comparing (length is not secret here).
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
