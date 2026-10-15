import crypto from 'crypto';

/**
 * A readable but high-entropy temporary password, shown once to the person who
 * issues it. Avoids characters that are easily confused when read aloud or off a
 * screen, because these get handed over verbally more often than anyone admits.
 */
export function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}
