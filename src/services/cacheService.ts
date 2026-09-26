import { createClient, RedisClientType } from 'redis';
import env from '../config/environment';
import logger from '../utils/logger';

/**
 * Redis Cache Service
 * Handles caching for application data
 */
class CacheService {
  private client: RedisClientType;
  private connected: boolean = false;

  constructor() {
    this.client = process.env.REDIS_URL
      ? createClient({ url: env.redis.url })
      : createClient({
          socket: {
            host: env.redis.host,
            port: env.redis.port,
          },
          password: env.redis.password || undefined,
        });

    this.client.on('error', (err) => {
      logger.error('Redis cache client error', { error: err.message });
      this.connected = false;
    });

    this.client.on('connect', () => {
      logger.info('Redis cache client connected');
      this.connected = true;
    });

    this.client.on('disconnect', () => {
      logger.warn('Redis cache client disconnected');
      this.connected = false;
    });

    // Connect to Redis
    this.connect();
  }

  private async connect() {
    try {
      await this.client.connect();
    } catch (error) {
      logger.error('Failed to connect to Redis cache', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.connected) {
      logger.warn('Cache not connected, skipping get');
      return null;
    }

    try {
      const value = await this.client.get(key);
      if (!value) return null;

      logger.debug('Cache hit', { key });
      return JSON.parse(value) as T;
    } catch (error) {
      logger.error('Cache get error', {
        key,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Set value in cache with TTL
   */
  async set(key: string, value: unknown, ttlSeconds: number = 300): Promise<void> {
    if (!this.connected) {
      logger.warn('Cache not connected, skipping set');
      return;
    }

    try {
      await this.client.setEx(key, ttlSeconds, JSON.stringify(value));
      logger.debug('Cache set', { key, ttl: ttlSeconds });
    } catch (error) {
      logger.error('Cache set error', {
        key,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Delete value from cache
   */
  async del(key: string | string[]): Promise<void> {
    if (!this.connected) {
      logger.warn('Cache not connected, skipping delete');
      return;
    }

    try {
      const keys = Array.isArray(key) ? key : [key];
      await this.client.del(keys);
      logger.debug('Cache deleted', { keys });
    } catch (error) {
      logger.error('Cache delete error', {
        key,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Check if key exists in cache
   */
  async exists(key: string): Promise<boolean> {
    if (!this.connected) {
      return false;
    }

    try {
      const exists = await this.client.exists(key);
      return exists === 1;
    } catch (error) {
      logger.error('Cache exists error', {
        key,
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  /**
   * Clear all cache (use with caution)
   */
  async flush(): Promise<void> {
    if (!this.connected) {
      logger.warn('Cache not connected, skipping flush');
      return;
    }

    try {
      await this.client.flushDb();
      logger.info('Cache flushed');
    } catch (error) {
      logger.error('Cache flush error', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    connected: boolean;
    dbSize: number;
    memory: string;
  } | null> {
    if (!this.connected) {
      return null;
    }

    try {
      const dbSize = await this.client.dbSize();
      const info = await this.client.info('memory');
      const memoryMatch = info.match(/used_memory_human:(.+)/);
      const memory = memoryMatch ? memoryMatch[1].trim() : 'unknown';

      return {
        connected: this.connected,
        dbSize,
        memory,
      };
    } catch (error) {
      logger.error('Cache stats error', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Close cache connection
   */
  async close(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
      logger.info('Redis cache client closed');
    }
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
