import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';
import env from '../config/environment';
import logger from '../utils/logger';

/**
 * Parse `timestamp without time zone` (OID 1114) as UTC.
 *
 * Every timestamp column in this schema holds UTC, but node-postgres by default
 * parses these as the *host's* local time. On a UTC host (production) that is
 * coincidentally right; on any other host every timestamp shifts by the local
 * offset — 5h30m on an IST laptop. That mismatch caused a bypassable account
 * lockout, a refresh-token failure and a "today" report that queried yesterday.
 *
 * With this in place the result is identical in production and correct
 * everywhere else.
 */
types.setTypeParser(1114, (value: string) => new Date(value.replace(' ', 'T') + 'Z'));

export class Database {
  private pool: Pool;
  private static instance: Database;

  private constructor() {
    this.pool = new Pool({
      connectionString: env.database.url,
      host: env.database.host,
      port: env.database.port,
      database: env.database.name,
      user: env.database.user,
      password: env.database.password,
      min: env.database.pool_min,
      max: env.database.pool_max,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: env.node_env === 'production' ? { rejectUnauthorized: false } : undefined,
    });

    // Handle pool errors
    this.pool.on('error', (err: Error) => {
      logger.error('Unexpected error on idle client', err);
    });

    // Log pool connections in development
    if (env.node_env === 'development') {
      this.pool.on('connect', () => {
        logger.debug('New client connected to database');
      });
    }

    logger.info('Database connection pool initialized');
  }

  public static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  /**
   * Execute a query with parameters
   */
  public async query<T extends QueryResultRow = any>(
    text: string,
    params?: any[]
  ): Promise<QueryResult<T>> {
    const start = Date.now();
    try {
      const result = await this.pool.query<T>(text, params);
      const duration = Date.now() - start;

      if (env.node_env === 'development') {
        logger.debug('Executed query', {
          text,
          duration,
          rows: result.rowCount,
        });
      }

      return result;
    } catch (error) {
      logger.error('Database query error', {
        text,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get a client from the pool for transactions
   */
  public async getClient(): Promise<PoolClient> {
    return await this.pool.connect();
  }

  /**
   * Execute a transaction
   */
  public async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Transaction rolled back', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Test database connection
   */
  public async testConnection(): Promise<boolean> {
    try {
      const result = await this.query('SELECT NOW() as current_time');
      logger.info('Database connection test successful', {
        time: result.rows[0].current_time,
      });
      return true;
    } catch (error) {
      logger.error('Database connection test failed', {
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  /**
   * Get pool statistics
   */
  public getPoolStats() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  /**
   * Close all connections in the pool
   */
  public async close(): Promise<void> {
    await this.pool.end();
    logger.info('Database connection pool closed');
  }
}

// Export singleton instance
export const db = Database.getInstance();

// Export types for convenience
export type { PoolClient, QueryResult, QueryResultRow };
