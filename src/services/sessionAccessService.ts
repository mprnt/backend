import crypto from 'crypto';
import { Database, db } from '../config/database';
import { safeEqual, sha256Hex } from '../utils/crypto';

/** The header a customer client sends on every session-scoped route. */
export const SESSION_TOKEN_HEADER = 'X-Session-Token';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionCredential {
  /** Internal print_sessions.id */
  id: string;
  /** Public session_id (e.g. S1727…) */
  sessionId: string;
  accessTokenHash: string | null;
}

/**
 * Resolves which session owns a session, job, document or payment order, so a
 * single check can guard every customer route. Each lookup returns null when
 * the resource does not exist; the route then answers its own 404.
 */
export class SessionAccessService {
  constructor(private database: Database = db) {}

  /** A fresh secret and the hash stored for it. Only the hash is persisted. */
  generateToken(): { token: string; hash: string } {
    const token = crypto.randomBytes(32).toString('hex');
    return { token, hash: sha256Hex(token) };
  }

  verifyToken(credential: SessionCredential, token: string): boolean {
    if (!credential.accessTokenHash) {
      return false;
    }
    return safeEqual(credential.accessTokenHash, sha256Hex(token));
  }

  bySessionId(sessionId: string): Promise<SessionCredential | null> {
    return this.lookup(`WHERE ps.session_id = $1`, '', sessionId);
  }

  byJobId(jobId: string): Promise<SessionCredential | null> {
    // A malformed id cannot match; skip the query (Postgres would reject the cast).
    if (!UUID_RE.test(jobId)) return Promise.resolve(null);
    return this.lookup(`WHERE pj.id = $1`, 'JOIN print_jobs pj ON pj.session_id = ps.id', jobId);
  }

  byDocumentId(documentId: string): Promise<SessionCredential | null> {
    if (!UUID_RE.test(documentId)) return Promise.resolve(null);
    return this.lookup(`WHERE d.id = $1`, 'JOIN documents d ON d.session_id = ps.id', documentId);
  }

  byOrderId(orderId: string): Promise<SessionCredential | null> {
    return this.lookup(
      `WHERE po.order_id = $1`,
      `JOIN print_jobs pj ON pj.session_id = ps.id
       JOIN payment_orders po ON po.job_id = pj.id`,
      orderId
    );
  }

  private async lookup(
    where: string,
    joins: string,
    value: string
  ): Promise<SessionCredential | null> {
    const result = await this.database.query<{
      id: string;
      session_id: string;
      access_token_hash: string | null;
    }>(
      `SELECT ps.id, ps.session_id, ps.access_token_hash
       FROM print_sessions ps
       ${joins}
       ${where}
       LIMIT 1`,
      [value]
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, sessionId: row.session_id, accessTokenHash: row.access_token_hash }
      : null;
  }
}

export const sessionAccessService = new SessionAccessService();
