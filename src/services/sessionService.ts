import { db } from '../config/database';
import env from '../config/environment';
import { Kiosk, PrintSession, PrintSessionInsert } from '../types/database';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { sessionAccessService } from './sessionAccessService';

interface SessionWithKioskRow extends PrintSession {
  kiosk_code: string;
  location: string;
  kiosk_status: Kiosk['status'];
  capabilities: Kiosk['capabilities'];
  printer_status: Kiosk['printer_status'];
  is_expired: boolean;
}

interface SessionKioskSummary {
  kiosk_id: string;
  location: string;
  status: Kiosk['status'];
  capabilities: Kiosk['capabilities'];
  printer_status: Kiosk['printer_status'];
}

interface SessionDocumentDetails {
  id: string;
  original_filename: string;
  file_type: string;
  page_count: number | null;
  file_size_bytes: number;
  uploaded_at: Date;
  processed: boolean;
}

interface SessionPrintJobDetails {
  id: string;
  status: string;
  color_mode: string;
  copies: number;
  page_range: string;
  custom_range: string | null;
  print_sides: string;
  paper_size: string;
  orientation: string;
  base_price_per_page: string;
  total_pages: number;
  total_amount: string;
  created_at: Date;
  queued_at: Date | null;
  completed_at: Date | null;
}

interface SessionPaymentDetails {
  transaction_id: string;
  status: string;
  amount: string;
  payment_method: string;
  completed_at: Date;
  amount_mismatch: boolean;
}

export class SessionService {
  /**
   * Generate unique session ID
   * Format: S{timestamp}{random suffix}, max 20 characters
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString();
    const randomSuffix = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, '0');

    return `S${timestamp}${randomSuffix}`;
  }

  /**
   * Session expiry: SESSION_TIMEOUT_MINUTES (default 15) from now.
   */
  private calculateExpiry(): Date {
    return new Date(Date.now() + env.security.session_timeout_minutes * 60_000);
  }

  /**
   * Get kiosk by kiosk_id (e.g., 'M001')
   */
  async getKioskByKioskId(kioskId: string): Promise<Kiosk | null> {
    const result = await db.query<Kiosk>('SELECT * FROM kiosks WHERE kiosk_id = $1', [kioskId]);
    return result.rows[0] || null;
  }

  /**
   * Get the first available active kiosk (for auto-assignment)
   */
  async getAutoAssignKiosk(): Promise<Kiosk | null> {
    const result = await db.query<Kiosk>(
      `SELECT * FROM kiosks
       WHERE status = 'active' AND printer_status = 'idle'
       ORDER BY id
       LIMIT 1`
    );
    return result.rows[0] || null;
  }

  /**
   * Create a new print session
   */
  async createSession(
    kioskId?: string,
    clientIp?: string,
    userAgent?: string
  ): Promise<{ session: PrintSession; kiosk: Kiosk; sessionToken: string }> {
    let kiosk: Kiosk | null;

    if (kioskId) {
      // Validate kiosk exists and is active
      kiosk = await this.getKioskByKioskId(kioskId);

      if (!kiosk) {
        logger.warn('Kiosk not found', { kioskId });
        throw new AppError('Kiosk not found', 404);
      }

      if (kiosk.status !== 'active') {
        logger.warn('Kiosk is not active', { kioskId, status: kiosk.status });
        throw new AppError(`Kiosk is currently ${kiosk.status}. Please try another kiosk.`, 400);
      }
    } else {
      // Auto-assign the first available active kiosk
      kiosk = await this.getAutoAssignKiosk();

      if (!kiosk) {
        logger.warn('No available kiosks for auto-assignment');
        throw new AppError('No active kiosks available. Please specify a kiosk ID.', 400);
      }

      logger.info('Auto-assigned kiosk', { kioskId: kiosk.kiosk_id });
    }

    // Generate session ID and expiry
    const sessionId = this.generateSessionId();
    const expiresAt = this.calculateExpiry();
    // The secret is returned to the client once; only its hash is stored.
    const { token: sessionToken, hash: accessTokenHash } = sessionAccessService.generateToken();

    logger.info('Creating new session', {
      sessionId,
      kioskId: kiosk.kiosk_id,
      expiresAt,
    });

    // Insert session into database
    const sessionData: Partial<PrintSessionInsert> = {
      session_id: sessionId,
      kiosk_id: kiosk.id,
      status: 'draft',
      expires_at: expiresAt,
      client_ip: clientIp,
      user_agent: userAgent,
    };

    const result = await db.query<PrintSession>(
      `INSERT INTO print_sessions
       (session_id, kiosk_id, status, expires_at, client_ip, user_agent, access_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        sessionData.session_id,
        sessionData.kiosk_id,
        sessionData.status,
        sessionData.expires_at,
        sessionData.client_ip,
        sessionData.user_agent,
        accessTokenHash,
      ]
    );

    const session = result.rows[0];

    logger.info('Session created successfully', {
      sessionId: session.session_id,
      id: session.id,
    });

    return { session, kiosk, sessionToken };
  }

  /**
   * Get session by session_id
   */
  async getSession(sessionId: string): Promise<PrintSession | null> {
    const result = await db.query<PrintSession>(
      'SELECT * FROM print_sessions WHERE session_id = $1',
      [sessionId]
    );
    return result.rows[0] || null;
  }

  /**
   * Check if session is expired
   */
  isSessionExpired(session: PrintSession): boolean {
    return new Date() > new Date(session.expires_at);
  }

  /**
   * Get complete session details with associated data
   */
  async getSessionDetails(sessionId: string): Promise<{
    session: PrintSession;
    kiosk: Kiosk;
    document: SessionDocumentDetails | null;
    printJob: SessionPrintJobDetails | null;
    payment: SessionPaymentDetails | null;
  }> {
    const session = await this.getSession(sessionId);

    if (!session) {
      throw new AppError('Session not found', 404);
    }

    // An expired session stays readable when the customer has paid: they come
    // back (reload, rescan) to watch the print or see the refund, and their
    // job usually finishes after the 15-minute window. Everything else is gone.
    if (this.isSessionExpired(session) && session.status !== 'complete') {
      const paid = await db.query(
        `SELECT 1 FROM print_jobs
          WHERE session_id = $1 AND payment_status IN ('paid', 'refunded')
          LIMIT 1`,
        [session.id]
      );
      if (paid.rows.length === 0) {
        throw new AppError('Session has expired', 410);
      }
    }

    // Get kiosk details
    const kioskResult = await db.query<Kiosk>('SELECT * FROM kiosks WHERE id = $1', [
      session.kiosk_id,
    ]);
    const kiosk = kioskResult.rows[0];

    // Get associated document (if any)
    const documentResult = await db.query<SessionDocumentDetails>(
      'SELECT * FROM documents WHERE session_id = $1',
      [session.id]
    );
    const document = documentResult.rows[0] || null;

    // Get print job (if any)
    const printJobResult = await db.query<SessionPrintJobDetails>(
      'SELECT * FROM print_jobs WHERE session_id = $1',
      [session.id]
    );
    const printJob = printJobResult.rows[0] || null;

    // Get the captured payment (if any). Payments live in payment_orders /
    // payment_transactions; the legacy `payments` table is never written.
    // amount_mismatch marks a payment that was taken but not queued (the order
    // amount differs from the job total, see PaymentService.captureOrder).
    const paymentResult = await db.query<SessionPaymentDetails>(
      `SELECT pt.payment_id AS transaction_id,
              CASE WHEN po.status = 'refunded' OR pj.payment_status = 'refunded' THEN 'refunded'
                   ELSE pt.status END AS status,
              pt.amount, pt.method AS payment_method, pt.created_at AS completed_at,
              (ROUND(po.amount * 100) <> ROUND(pj.total_amount * 100)) AS amount_mismatch
         FROM payment_transactions pt
         JOIN payment_orders po ON po.order_id = pt.order_id
         JOIN print_jobs pj ON pj.id = po.job_id
        WHERE po.job_id = $1 AND pt.status = 'captured'
        ORDER BY pt.created_at ASC
        LIMIT 1`,
      [printJob?.id ?? null]
    );
    const payment = paymentResult.rows[0] || null;

    logger.info('Retrieved session details', {
      sessionId,
      hasDocument: !!document,
      hasPrintJob: !!printJob,
      hasPayment: !!payment,
    });

    return {
      session,
      kiosk,
      document,
      printJob,
      payment,
    };
  }

  /**
   * List sessions with filtering and pagination
   */
  async listSessions(filters?: {
    status?: string;
    kioskId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    sessions: Array<PrintSession & { kiosk: SessionKioskSummary; is_expired: boolean }>;
    total: number;
    active: number;
    expired: number;
  }> {
    const limit = filters?.limit || 20;
    const offset = filters?.offset || 0;

    // Build WHERE clause
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters?.status) {
      conditions.push(`ps.status = $${paramIndex}`);
      params.push(filters.status);
      paramIndex++;
    }

    if (filters?.kioskId) {
      conditions.push(`k.kiosk_id = $${paramIndex}`);
      params.push(filters.kioskId);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get sessions with kiosk info
    const sessionsQuery = `
      SELECT
        ps.*,
        k.kiosk_id AS kiosk_code,
        k.location,
        k.status as kiosk_status,
        k.capabilities,
        k.printer_status,
        CASE
          WHEN ps.expires_at < CURRENT_TIMESTAMP AND ps.status != 'complete' THEN true
          ELSE false
        END as is_expired
      FROM print_sessions ps
      JOIN kiosks k ON ps.kiosk_id = k.id
      ${whereClause}
      ORDER BY ps.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(limit, offset);

    const sessionsResult = await db.query<SessionWithKioskRow>(sessionsQuery, params);

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM print_sessions ps
      JOIN kiosks k ON ps.kiosk_id = k.id
      ${whereClause}
    `;

    const countResult = await db.query<{ total: string }>(countQuery, params.slice(0, -2)); // Remove limit/offset
    const total = parseInt(countResult.rows[0].total, 10);

    // Get stats
    const statsQuery = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'draft' AND expires_at > CURRENT_TIMESTAMP) as active,
        COUNT(*) FILTER (WHERE expires_at < CURRENT_TIMESTAMP AND status != 'complete') as expired
      FROM print_sessions
    `;

    const statsResult = await db.query<{ active: string; expired: string }>(statsQuery);
    const active = parseInt(statsResult.rows[0].active, 10);
    const expired = parseInt(statsResult.rows[0].expired, 10);

    // Map results
    const sessions = sessionsResult.rows.map((row) => {
      const {
        kiosk_code,
        location,
        kiosk_status,
        capabilities,
        printer_status,
        is_expired,
        ...session
      } = row;
      return {
        ...session,
        kiosk: {
          kiosk_id: kiosk_code,
          location,
          status: kiosk_status,
          capabilities,
          printer_status,
        },
        is_expired,
      };
    });

    logger.info('Sessions listed', {
      total,
      active,
      expired,
      returned: sessions.length,
      filters,
    });

    return {
      sessions,
      total,
      active,
      expired,
    };
  }

  /**
   * Cancel/expire a session
   */
  async cancelSession(sessionId: string): Promise<PrintSession> {
    const session = await this.getSession(sessionId);

    if (!session) {
      throw new AppError('Session not found', 404);
    }

    if (session.status === 'complete') {
      throw new AppError('Cannot cancel a completed session', 400);
    }

    // A paid job prints whatever the session says, so cancelling would only
    // hide it from the customer while it still prints.
    const paidJob = await db.query(
      `SELECT 1 FROM print_jobs
        WHERE session_id = $1 AND payment_status = 'paid'
          AND status NOT IN ('completed', 'cancelled', 'failed')
        LIMIT 1`,
      [session.id]
    );
    if (paidJob.rows.length > 0) {
      throw new AppError(
        'This session has a paid print job in progress and cannot be cancelled',
        409,
        'SESSION_PAID'
      );
    }

    const result = await db.query<PrintSession>(
      `UPDATE print_sessions
       SET status = $1, completed_at = CURRENT_TIMESTAMP
       WHERE session_id = $2
       RETURNING *`,
      ['expired', sessionId]
    );

    logger.info('Session cancelled', { sessionId });

    return result.rows[0];
  }
}

// Export singleton instance
export const sessionService = new SessionService();
