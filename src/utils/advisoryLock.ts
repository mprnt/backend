import { db } from '../config/database';
import logger from './logger';

/**
 * Well-known advisory lock keys. Arbitrary but fixed integers; each background
 * sweep owns one.
 */
export const LOCKS = {
  SESSION_EXPIRY: 7001,
  DOCUMENT_SWEEP: 7002,
} as const;

/**
 * Run `fn` only if no other process currently holds `key`.
 *
 * Replaces what a Bull repeatable job gave us — "exactly one runner at a time"
 * — using Postgres, which we already depend on. If a second instance is ever
 * added, or a slow run overlaps the next tick, the loser simply skips rather
 * than doing the work twice.
 *
 * Uses a session-level lock on a dedicated client, and always unlocks and
 * releases that client, so a thrown error can never leave the lock held.
 *
 * @returns the result of `fn`, or null when the lock was not acquired.
 */
export async function withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T | null> {
  const client = await db.getClient();

  try {
    const acquired = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key]
    );

    if (!acquired.rows[0]?.locked) {
      logger.debug('Advisory lock busy; skipping this run', { key });
      return null;
    }

    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch((error) => {
        logger.error('Failed to release advisory lock', { key, error });
      });
    }
  } finally {
    client.release();
  }
}
