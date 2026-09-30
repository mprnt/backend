import logger from '../utils/logger';

/**
 * In-process cache with per-entry TTL.
 *
 * Previously backed by Redis. Its only use is caching document previews for a
 * few minutes, which does not justify a separate service — especially one
 * whose quota exhaustion took the whole API down. The interface is unchanged,
 * so callers did not need to change.
 *
 * Trade-offs worth knowing:
 *  - Each instance has its own cache. With one instance (today) that is
 *    identical in behaviour. With several, a preview may be computed once per
 *    instance — harmless, as previews are derived from immutable documents.
 *  - A restart empties it. Entries are short-lived anyway.
 *  - Size is bounded: past MAX_ENTRIES the oldest entry is evicted, so memory
 *    cannot grow without limit under load.
 */

const MAX_ENTRIES = 1000;
const SWEEP_INTERVAL_MS = 60_000;

interface Entry {
  value: string;
  expiresAt: number;
}

class CacheService {
  private store = new Map<string, Entry>();
  private sweeper: NodeJS.Timeout;

  constructor() {
    // Drop expired entries periodically, so memory is reclaimed even for keys
    // that are never read again.
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  private live(key: string): Entry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.live(key);
    if (!entry) return null;

    try {
      logger.debug('Cache hit', { key });
      return JSON.parse(entry.value) as T;
    } catch {
      this.store.delete(key);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number = 300): Promise<void> {
    // Serialised on write, as Redis did, so a cached object can never be mutated
    // through a reference held by a caller.
    const serialised = JSON.stringify(value);

    // Re-inserting moves the key to the end of the Map's insertion order.
    this.store.delete(key);
    this.store.set(key, { value: serialised, expiresAt: Date.now() + ttlSeconds * 1000 });

    if (this.store.size > MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }

    logger.debug('Cache set', { key, ttl: ttlSeconds });
  }

  async del(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) this.store.delete(k);
  }

  async exists(key: string): Promise<boolean> {
    return this.live(key) !== null;
  }

  async flush(): Promise<void> {
    this.store.clear();
    logger.info('Cache flushed');
  }

  async getStats(): Promise<{ connected: boolean; dbSize: number; memory: string }> {
    this.sweep();
    return { connected: true, dbSize: this.store.size, memory: 'in-process' };
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.store.clear();
  }
}

// Export singleton instance
export const cacheService = new CacheService();

// Cache key builders
export const CacheKeys = {
  preview: (documentId: string) => `preview:${documentId}`,
  document: (documentId: string) => `document:${documentId}`,
  session: (sessionId: string) => `session:${sessionId}`,
  sessionDocument: (sessionId: string) => `session:${sessionId}:document`,
};
