import crypto from 'crypto';
import env from '../../src/config/environment';
import { encryptAccountNumber } from '../../src/utils/payoutCrypto';

const saved = env.security as { payout_encryption_key: string | null };
const KEY = Buffer.alloc(32, 9);

/** The error code a call throws, or null if it does not throw. */
function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? null;
  }
}

/** Reads back what encryptAccountNumber wrote, the way a later decryption would. */
function decrypt(stored: string, key: Buffer): string {
  const [version, iv, tag, data] = stored.split(':');
  expect(version).toBe('v1');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8'
  );
}

describe('encryptAccountNumber', () => {
  let previous: string | null = null;
  beforeEach(() => {
    previous = saved.payout_encryption_key;
  });
  afterEach(() => {
    saved.payout_encryption_key = previous;
  });

  it('encrypts with AES-256-GCM, so the digits can be recovered only with the key', () => {
    saved.payout_encryption_key = KEY.toString('base64');
    const stored = encryptAccountNumber('123456789012');

    expect(stored).not.toContain('123456789012');
    expect(decrypt(stored, KEY)).toBe('123456789012');
  });

  it('uses a fresh IV each time, so the same number never stores the same way twice', () => {
    saved.payout_encryption_key = KEY.toString('base64');
    expect(encryptAccountNumber('123456789012')).not.toBe(encryptAccountNumber('123456789012'));
  });

  it('refuses to write without a key', () => {
    saved.payout_encryption_key = null;
    expect(codeOf(() => encryptAccountNumber('123456789012'))).toBe('PAYOUT_KEY_MISSING');
  });

  it('refuses a key that is not 32 bytes', () => {
    saved.payout_encryption_key = Buffer.alloc(16, 1).toString('base64');
    expect(codeOf(() => encryptAccountNumber('123456789012'))).toBe('PAYOUT_KEY_INVALID');
  });
});
