import crypto from 'crypto';
import env from '../config/environment';
import { AppError } from './errors';

/**
 * Encrypts a shop's bank account number before it is stored (AES-256-GCM, a fresh
 * 12-byte IV per value). The key comes from PAYOUT_ENCRYPTION_KEY. Without it nothing
 * is written: refusing is better than storing an account number in plain text.
 *
 * The number is never read back in full. Screens show the last four digits, which are
 * stored in their own column, so this module only encrypts.
 */
export function encryptAccountNumber(plain: string): string {
  const key = keyBytes();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    ':'
  );
}

function keyBytes(): Buffer {
  const raw = env.security.payout_encryption_key;
  if (!raw) {
    throw new AppError(
      'Bank details cannot be saved until PAYOUT_ENCRYPTION_KEY is set on the server',
      503,
      'PAYOUT_KEY_MISSING'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new AppError(
      'PAYOUT_ENCRYPTION_KEY must be 32 random bytes, base64 encoded',
      500,
      'PAYOUT_KEY_INVALID'
    );
  }
  return key;
}
