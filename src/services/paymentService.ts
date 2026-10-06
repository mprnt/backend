import crypto from 'crypto';
import { Database, PoolClient, db } from '../config/database';
import env from '../config/environment';
import { AppError } from '../utils/errors';
import { hmacSha256Hex, safeEqual } from '../utils/crypto';
import {
  PaymentOrder,
  PaymentMethod,
  PaymentTransaction,
  CreatePaymentOrderParams,
  VerifyPaymentParams,
  IPaymentService,
} from '../types/payment';
import logger from '../utils/logger';
import { RazorpayService } from './razorpayService';
import { websocketService } from './websocketService';
import { queueService } from './queueService';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Raw JSON body, kept only for /payment/webhook (see app.ts). */
      rawBody?: Buffer;
    }
  }
}

/** Order statuses a client-reported failure may move to `failed`. */
const FAILABLE_ORDER_STATUSES = ['created', 'attempted', 'pending'] as const;

const toPaise = (amount: string | number): number => Math.round(Number(amount) * 100);

interface CaptureArgs {
  orderId: string;
  paymentId: string;
  /** null when the capture comes from the webhook (no client signature). */
  signature: string | null;
  method: string;
  /** Amount Razorpay reports as paid, in paise (webhook only). */
  paidAmountPaise?: number;
}

interface CaptureOutcome {
  jobId: string;
  alreadyCaptured: boolean;
  queued: boolean;
  amountMismatch: boolean;
  /** The job was refunded before this payment arrived; recorded, not queued. */
  jobRefunded: boolean;
  /** The upload was deleted (session expired) before the money arrived; recorded, not queued. */
  documentMissing: boolean;
  transaction: PaymentTransaction;
}

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        status?: string;
        method?: string;
      };
    };
  };
}

/**
 * Payment Service
 * Handles payment order creation, verification, and tracking
 * Delegates actual payment processing to RazorpayService.
 *
 * Test mode: Set RAZORPAY_KEY_ID=rzp_test_* to use Razorpay's test environment.
 * Live mode: Set RAZORPAY_KEY_ID=rzp_live_* to use real payments.
 * The same service handles both — no separate mock needed.
 */
export class PaymentService {
  private paymentGateway: IPaymentService | null = null;
  private injectedGateway?: IPaymentService;

  constructor(
    private database: Database = db,
    gateway?: IPaymentService
  ) {
    this.injectedGateway = gateway;
  }

  private getGateway(): IPaymentService {
    if (!this.paymentGateway) {
      this.paymentGateway = this.injectedGateway || new RazorpayService();
    }
    return this.paymentGateway;
  }

  /**
   * Create payment order for a print job.
   *
   * The amount is always the job's total_amount, read under a row lock inside
   * this transaction. updateSettings takes the same lock and refuses to run
   * once an order exists, so the amount fixed at Razorpay always matches the
   * settings that will be printed.
   *
   * The session must still be live and its upload still present: the expiry
   * sweep deletes the file, and a job paid without one can never print. Once
   * the order exists the session is extended by the payment grace period, so a
   * customer who opens checkout in the last minute does not lose their upload
   * while a UPI payment settles.
   */
  async createPaymentOrder(params: CreatePaymentOrderParams): Promise<{
    order: PaymentOrder;
    jobId: string;
  }> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      // 1. Verify print job exists and is in pending status
      const jobResult = await client.query<{
        id: string;
        total_amount: string;
        status: string;
        payment_status: string;
        document_id: string | null;
        session_uuid: string;
        session_status: string;
        session_expires_at: Date;
      }>(
        `SELECT pj.id, pj.total_amount, pj.status, pj.payment_status, pj.document_id,
                ps.id AS session_uuid, ps.status AS session_status,
                ps.expires_at AS session_expires_at
         FROM print_jobs pj
         JOIN print_sessions ps ON ps.id = pj.session_id
         WHERE pj.id = $1
         FOR UPDATE OF pj`,
        [params.jobId]
      );

      if (jobResult.rows.length === 0) {
        throw new AppError('Print job not found', 404);
      }

      const job = jobResult.rows[0];

      if (job.status !== 'pending') {
        throw new AppError(`Cannot create payment for job with status: ${job.status}`, 400);
      }

      if (job.payment_status === 'paid') {
        throw new AppError('Payment already completed for this job', 400);
      }

      if (
        ['expired', 'complete', 'error'].includes(job.session_status) ||
        new Date(job.session_expires_at) < new Date()
      ) {
        throw new AppError(
          'This session has expired. Scan the kiosk QR code to start again.',
          410,
          'SESSION_EXPIRED'
        );
      }

      if (!job.document_id) {
        throw new AppError(
          'The uploaded document is no longer available. Upload it again in a new session.',
          409,
          'DOCUMENT_MISSING'
        );
      }

      // 2. Check if order already exists for this job
      const existingOrderResult = await client.query<{
        order_id: string;
        status: string;
      }>(`SELECT order_id, status FROM payment_orders WHERE job_id = $1`, [params.jobId]);

      const openOrder = existingOrderResult.rows.find((o) => o.status !== 'failed');
      if (openOrder) {
        // The client resumes this order (GET /print-jobs/:jobId/payment)
        // rather than opening a second one for the same job.
        throw new AppError(
          `Payment order already exists for this job. Order ID: ${openOrder.order_id}`,
          400,
          'PAYMENT_ORDER_EXISTS'
        );
      }

      // 3. Create payment order via gateway, priced from the locked row
      const order = await this.getGateway().createOrder({
        jobId: params.jobId,
        amount: parseFloat(job.total_amount),
        currency: params.currency || 'INR',
      });

      // 4. Save order to database
      await client.query(
        `INSERT INTO payment_orders (
          id, job_id, order_id, amount, currency, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [order.id, params.jobId, order.orderId, order.amount, order.currency, order.status]
      );

      await client.query(
        `UPDATE print_sessions SET expires_at = GREATEST(expires_at, $2) WHERE id = $1`,
        [
          job.session_uuid,
          new Date(Date.now() + env.security.session_payment_grace_minutes * 60_000),
        ]
      );

      await client.query('COMMIT');

      logger.info('Payment order created', {
        orderId: order.orderId,
        jobId: params.jobId,
        amount: order.amount,
      });

      return {
        order,
        jobId: params.jobId,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating payment order', { error, params });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Verify payment (client callback) and capture it.
   *
   * Idempotent: verifying an order that is already captured returns the
   * stored transaction. Throws 409 AMOUNT_MISMATCH, after recording the money,
   * when the order amount differs from the job total; the job is not queued.
   */
  async verifyAndCapturePayment(params: VerifyPaymentParams): Promise<{
    success: boolean;
    transaction: PaymentTransaction;
  }> {
    // Signature (and, for live keys, the gateway's captured status) first.
    const isValid = await this.getGateway().verifyPayment(params);

    if (!isValid) {
      throw new AppError('Payment verification failed', 400);
    }

    const outcome = await this.captureInTransaction({
      orderId: params.orderId,
      paymentId: params.paymentId,
      signature: params.signature,
      method: 'mock', // Will be determined by gateway in real implementation
    });

    if (outcome.amountMismatch) {
      throw new AppError(
        'Paid amount does not match the print job total. The job was not queued; it will be refunded.',
        409,
        'AMOUNT_MISMATCH'
      );
    }

    if (outcome.jobRefunded) {
      throw new AppError(
        'This print job was already refunded, so it was not queued. The payment was recorded.',
        409,
        'PAYMENT_REFUNDED'
      );
    }

    if (outcome.documentMissing) {
      throw new AppError(
        'Payment received, but the session had expired and the document was deleted, so ' +
          'nothing will print. The payment will be refunded.',
        409,
        'DOCUMENT_MISSING'
      );
    }

    return { success: true, transaction: outcome.transaction };
  }

  /**
   * Razorpay webhook. Verifies X-Razorpay-Signature (HMAC-SHA256 of the raw
   * body with RAZORPAY_WEBHOOK_SECRET) and, for payment.captured / order.paid,
   * runs the same capture path as /payment/verify. Safe to receive twice.
   */
  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined
  ): Promise<{ handled: boolean; event: string; reason?: string }> {
    const secret = env.payment.razorpay_webhook_secret;
    if (!secret) {
      throw new AppError('Webhook not configured', 503, 'WEBHOOK_NOT_CONFIGURED');
    }
    if (!rawBody || !signature || !safeEqual(hmacSha256Hex(secret, rawBody), signature)) {
      throw new AppError('Invalid webhook signature', 400, 'INVALID_SIGNATURE');
    }

    let payload: RazorpayWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhookPayload;
    } catch {
      throw new AppError('Invalid webhook body', 400);
    }

    const event = payload.event ?? 'unknown';
    if (event !== 'payment.captured' && event !== 'order.paid') {
      return { handled: false, event, reason: 'ignored_event' };
    }

    const payment = payload.payload?.payment?.entity;
    if (!payment?.id || !payment.order_id || payment.status !== 'captured') {
      return { handled: false, event, reason: 'no_captured_payment' };
    }

    try {
      const outcome = await this.captureInTransaction({
        orderId: payment.order_id,
        paymentId: payment.id,
        signature: null,
        method: payment.method ?? 'unknown',
        paidAmountPaise: payment.amount,
      });
      if (outcome.amountMismatch) {
        return { handled: true, event, reason: 'amount_mismatch' };
      }
      if (outcome.jobRefunded) {
        return { handled: true, event, reason: 'job_refunded' };
      }
      if (outcome.documentMissing) {
        return { handled: true, event, reason: 'document_missing' };
      }
      return {
        handled: true,
        event,
        reason: outcome.alreadyCaptured ? 'already_captured' : undefined,
      };
    } catch (error) {
      // An order we never created (another integration on the same account).
      // Acknowledge so Razorpay stops retrying.
      if (error instanceof AppError && error.statusCode === 404) {
        logger.warn('Webhook for unknown order', { orderId: payment.order_id, event });
        return { handled: false, event, reason: 'unknown_order' };
      }
      // A late or retried event for an order we already refunded.
      if (error instanceof AppError && error.code === 'PAYMENT_REFUNDED') {
        return { handled: false, event, reason: 'refunded' };
      }
      throw error;
    }
  }

  /** Runs captureOrder in its own transaction and broadcasts when queued. */
  private async captureInTransaction(args: CaptureArgs): Promise<CaptureOutcome> {
    const client = await this.database.getClient();
    let outcome: CaptureOutcome;

    try {
      await client.query('BEGIN');
      outcome = await this.captureOrder(client, args);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error capturing payment', { error, orderId: args.orderId });
      throw error;
    } finally {
      client.release();
    }

    if (outcome.queued) {
      websocketService.broadcastJobStatus(outcome.jobId, 'queued', {
        paymentVerified: true,
        paidAt: new Date().toISOString(),
      });
    }

    return outcome;
  }

  /**
   * The one place a payment becomes "paid". Used by /payment/verify and the
   * webhook. Locks the order and job rows, so concurrent callers serialise and
   * the second sees the order already captured.
   */
  private async captureOrder(client: PoolClient, args: CaptureArgs): Promise<CaptureOutcome> {
    const orderResult = await client.query<{
      job_id: string;
      amount: string;
      currency: string;
      status: string;
      total_amount: string;
      payment_status: string;
      document_id: string | null;
      job_status: string;
    }>(
      `SELECT po.job_id, po.amount, po.currency, po.status,
              pj.total_amount, pj.payment_status, pj.document_id, pj.status AS job_status
       FROM payment_orders po
       JOIN print_jobs pj ON po.job_id = pj.id
       WHERE po.order_id = $1
       FOR UPDATE`,
      [args.orderId]
    );

    if (orderResult.rows.length === 0) {
      throw new AppError('Payment order not found', 404);
    }

    const order = orderResult.rows[0];
    const orderPaise = toPaise(order.amount);
    const jobPaise = toPaise(order.total_amount);

    // Refunded: the money went back. A webhook retry or late delivery must not
    // flip the order back to captured or queue the job for a free print.
    if (order.status === 'refunded') {
      throw new AppError('This payment has been refunded', 409, 'PAYMENT_REFUNDED');
    }

    // Already captured: return what was stored (idempotent).
    if (order.status === 'captured') {
      const existing = await client.query<{
        id: string;
        payment_id: string;
        amount: string;
        currency: string;
        method: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, payment_id, amount, currency, method, created_at, updated_at
         FROM payment_transactions
         WHERE order_id = $1 AND status = 'captured'
         ORDER BY created_at ASC
         LIMIT 1`,
        [args.orderId]
      );
      const row = existing.rows[0];
      return {
        jobId: order.job_id,
        alreadyCaptured: true,
        queued: false,
        jobRefunded: order.payment_status === 'refunded',
        // A repeat verify must not report success for a job that never queued.
        amountMismatch: orderPaise !== jobPaise,
        // Only a job that never queued; a printed job's file is deleted on expiry too.
        documentMissing: order.document_id === null && order.job_status === 'pending',
        transaction: {
          id: row?.id ?? '',
          orderId: args.orderId,
          paymentId: row?.payment_id ?? args.paymentId,
          amount: Number(row?.amount ?? order.amount),
          currency: row?.currency ?? order.currency,
          method: (row?.method ?? args.method) as PaymentMethod,
          status: 'captured',
          createdAt: row?.created_at ?? new Date(),
          updatedAt: row?.updated_at ?? new Date(),
        },
      };
    }

    const gatewayMismatch =
      args.paidAmountPaise !== undefined && args.paidAmountPaise !== orderPaise;
    const amountMismatch = gatewayMismatch || orderPaise !== jobPaise;

    // Record the money first: it was taken whatever happens next.
    const transactionId = crypto.randomUUID();
    await client.query(
      `INSERT INTO payment_transactions (
        id, order_id, payment_id, amount, currency, method, status, signature, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (payment_id) DO NOTHING`,
      [
        transactionId,
        args.orderId,
        args.paymentId,
        args.paidAmountPaise !== undefined ? args.paidAmountPaise / 100 : order.amount,
        order.currency,
        args.method,
        'captured',
        args.signature,
      ]
    );

    await client.query(
      `UPDATE payment_orders SET status = $1, updated_at = NOW() WHERE order_id = $2`,
      ['captured', args.orderId]
    );

    let queued = false;
    const jobRefunded = order.payment_status === 'refunded';
    // document_id is SET NULL when the expiry sweep deletes the upload.
    const documentMissing = order.document_id === null;

    if (jobRefunded) {
      // The job was refunded (and cancelled) before this payment landed, e.g.
      // an older order paid late. Keep the record for a refund; never queue.
      logger.error('Payment for an already refunded job', {
        orderId: args.orderId,
        paymentId: args.paymentId,
        jobId: order.job_id,
      });
    } else if (order.payment_status === 'paid') {
      // A second order for the same job was paid too. Keep the record for a
      // refund; never queue the job twice.
      logger.error('Duplicate payment for an already paid job', {
        orderId: args.orderId,
        paymentId: args.paymentId,
        jobId: order.job_id,
      });
    } else if (amountMismatch) {
      // Paid, but not the price of what would print. Do not queue; leave it
      // paid-but-unprinted so it surfaces as a refund candidate.
      await client.query(
        `UPDATE print_jobs
         SET payment_status = 'paid', paid_at = NOW(), error_message = $1
         WHERE id = $2`,
        [
          `Amount mismatch: paid ${(args.paidAmountPaise ?? orderPaise) / 100}, job total ${jobPaise / 100}`,
          order.job_id,
        ]
      );
      logger.error('Payment amount does not match job total; job not queued', {
        orderId: args.orderId,
        jobId: order.job_id,
        orderPaise,
        jobPaise,
        paidAmountPaise: args.paidAmountPaise,
      });
    } else if (documentMissing) {
      // Paid after the session expired and its upload was deleted. The Pi
      // could never fetch the file, so queueing would strand the job; leave it
      // paid-but-unprinted so it surfaces as a refund candidate.
      await client.query(
        `UPDATE print_jobs
         SET payment_status = 'paid', paid_at = NOW(), error_message = $1
         WHERE id = $2`,
        ['Paid after the document was deleted (session expired); refund required', order.job_id]
      );
      logger.error('Payment for a job whose document was deleted; job not queued', {
        orderId: args.orderId,
        jobId: order.job_id,
      });
    } else {
      await client.query(
        `UPDATE print_jobs
         SET payment_status = $1, paid_at = NOW(), status = $2, queued_at = NOW()
         WHERE id = $3`,
        ['paid', 'queued', order.job_id]
      );

      // Put the job into the print queue inside the same transaction.
      // Without this row no printer can ever see the job, so payment and
      // queue entry must succeed or fail together.
      await queueService.enqueueJob(order.job_id, 0, client);
      queued = true;
    }

    logger.info('Payment captured', {
      orderId: args.orderId,
      paymentId: args.paymentId,
      jobId: order.job_id,
      queued,
      via: args.signature === null ? 'webhook' : 'verify',
    });

    return {
      jobId: order.job_id,
      alreadyCaptured: false,
      queued,
      amountMismatch: amountMismatch && order.payment_status !== 'paid' && !jobRefunded,
      jobRefunded,
      documentMissing:
        documentMissing && !amountMismatch && order.payment_status !== 'paid' && !jobRefunded,
      transaction: {
        id: transactionId,
        orderId: args.orderId,
        paymentId: args.paymentId,
        amount: Number(order.amount),
        currency: order.currency,
        method: args.method as PaymentMethod,
        status: 'captured',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
  }

  /**
   * Get payment order details
   */
  async getPaymentOrder(orderId: string): Promise<PaymentOrder | null> {
    const result = await this.database.query<{
      id: string;
      order_id: string;
      amount: string;
      currency: string;
      status: string;
      created_at: Date;
    }>(`SELECT * FROM payment_orders WHERE order_id = $1`, [orderId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      orderId: row.order_id,
      amount: parseFloat(row.amount),
      currency: row.currency,
      status: row.status as PaymentOrder['status'],
      createdAt: row.created_at,
    };
  }

  /**
   * Order status for polling. amountMismatch is true when the order was
   * captured but its amount differs from the job total, i.e. the money was
   * taken and the job was deliberately not queued (see captureOrder).
   */
  async getPaymentOrderStatus(orderId: string): Promise<{
    order: PaymentOrder;
    amountMismatch: boolean;
    jobRefunded: boolean;
    documentMissing: boolean;
  } | null> {
    const result = await this.database.query<{
      id: string;
      order_id: string;
      amount: string;
      currency: string;
      status: string;
      created_at: Date;
      total_amount: string;
      payment_status: string;
      document_missing: boolean;
    }>(
      `SELECT po.id, po.order_id, po.amount, po.currency, po.status, po.created_at,
              pj.total_amount, pj.payment_status,
              (pj.document_id IS NULL AND pj.status = 'pending') AS document_missing
         FROM payment_orders po
         JOIN print_jobs pj ON pj.id = po.job_id
        WHERE po.order_id = $1`,
      [orderId]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      order: {
        id: row.id,
        orderId: row.order_id,
        amount: parseFloat(row.amount),
        currency: row.currency,
        status: row.status as PaymentOrder['status'],
        createdAt: row.created_at,
      },
      amountMismatch:
        row.status === 'captured' && toPaise(row.amount) !== toPaise(row.total_amount),
      jobRefunded: row.payment_status === 'refunded',
      documentMissing: row.status === 'captured' && row.document_missing === true,
    };
  }

  /**
   * Get payment order for a job
   */
  async getJobPaymentOrder(jobId: string): Promise<PaymentOrder | null> {
    const result = await this.database.query<{
      id: string;
      order_id: string;
      amount: string;
      currency: string;
      status: string;
      created_at: Date;
    }>(`SELECT * FROM payment_orders WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`, [jobId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      orderId: row.order_id,
      amount: parseFloat(row.amount),
      currency: row.currency,
      status: row.status as PaymentOrder['status'],
      createdAt: row.created_at,
    };
  }

  /**
   * Record a payment failure reported by the client.
   *
   * Only an order still open (created / attempted) can move to failed. A
   * captured or refunded order is never touched: this route is public, and
   * flipping a paid order to failed corrupted revenue and allowed a new,
   * differently priced order for an already paid job.
   */
  async handlePaymentFailure(
    orderId: string,
    errorCode: string,
    errorDescription: string
  ): Promise<void> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      const updated = await client.query<{ job_id: string }>(
        `UPDATE payment_orders SET status = 'failed', updated_at = NOW()
         WHERE order_id = $1 AND status IN (${FAILABLE_ORDER_STATUSES.map((st) => `'${st}'`).join(', ')})
         RETURNING job_id`,
        [orderId]
      );

      if (updated.rows.length === 0) {
        const current = await client.query<{ status: string }>(
          `SELECT status FROM payment_orders WHERE order_id = $1`,
          [orderId]
        );
        if (current.rows.length === 0) {
          throw new AppError('Payment order not found', 404);
        }
        throw new AppError(
          `Cannot mark a ${current.rows[0].status} order as failed`,
          409,
          'ORDER_NOT_FAILABLE'
        );
      }

      // Note the failure on the job, unless it has been paid meanwhile.
      await client.query(
        `UPDATE print_jobs
         SET error_message = $1
         WHERE id = $2 AND payment_status <> 'paid'`,
        [`Payment failed: ${errorDescription}`, updated.rows[0].job_id]
      );

      await client.query('COMMIT');

      logger.warn('Payment failure recorded', {
        orderId,
        errorCode,
        errorDescription,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error handling payment failure', { error, orderId });
      throw error;
    } finally {
      client.release();
    }
  }
}

let instance: PaymentService | null = null;

export const getPaymentService = (): PaymentService => {
  if (!instance) {
    instance = new PaymentService();
  }
  return instance;
};

export const paymentService = new Proxy({} as PaymentService, {
  get: (_target, prop) => {
    const service = getPaymentService();
    const value = Reflect.get(service, prop, service) as unknown;

    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(service);
    }

    return value;
  },
});
