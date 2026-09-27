import crypto from 'crypto';
import { Database, db } from '../config/database';
import { AppError } from '../utils/errors';
import {
  PaymentOrder,
  PaymentTransaction,
  CreatePaymentOrderParams,
  VerifyPaymentParams,
  IPaymentService,
} from '../types/payment';
import logger from '../utils/logger';
import { RazorpayService } from './razorpayService';
import { websocketService } from './websocketService';

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
   * Create payment order for a print job
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
      }>(
        `SELECT id, total_amount, status, payment_status
         FROM print_jobs
         WHERE id = $1`,
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

      // 2. Check if order already exists for this job
      const existingOrderResult = await client.query<{
        order_id: string;
        status: string;
      }>(`SELECT order_id, status FROM payment_orders WHERE job_id = $1`, [params.jobId]);

      if (existingOrderResult.rows.length > 0) {
        const existingOrder = existingOrderResult.rows[0];
        if (existingOrder.status !== 'failed') {
          throw new AppError(
            `Payment order already exists for this job. Order ID: ${existingOrder.order_id}`,
            400
          );
        }
      }

      // 3. Create payment order via gateway
      const order = await this.getGateway().createOrder({
        jobId: params.jobId,
        amount: params.amount,
        currency: params.currency || 'INR',
      });

      // 4. Save order to database
      await client.query(
        `INSERT INTO payment_orders (
          id, job_id, order_id, amount, currency, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [order.id, params.jobId, order.orderId, order.amount, order.currency, order.status]
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
   * Verify payment and update job status
   */
  async verifyAndCapturePayment(params: VerifyPaymentParams): Promise<{
    success: boolean;
    transaction: PaymentTransaction;
  }> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      // 1. Get payment order
      const orderResult = await client.query<{
        id: string;
        job_id: string;
        order_id: string;
        amount: number | string;
        currency: string;
        status: string;
        created_at: Date;
      }>(
        `SELECT po.*, pj.id as job_id
         FROM payment_orders po
         JOIN print_jobs pj ON po.job_id = pj.id
         WHERE po.order_id = $1`,
        [params.orderId]
      );

      if (orderResult.rows.length === 0) {
        throw new AppError('Payment order not found', 404);
      }

      const order = orderResult.rows[0];

      // 2. Verify payment with gateway
      const isValid = await this.getGateway().verifyPayment(params);

      if (!isValid) {
        throw new AppError('Payment verification failed', 400);
      }

      // 3. Create transaction record
      const transactionId = crypto.randomUUID();
      await client.query(
        `INSERT INTO payment_transactions (
          id, order_id, payment_id, amount, currency, method, status, signature, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          transactionId,
          params.orderId,
          params.paymentId,
          order.amount,
          order.currency,
          'mock', // Will be determined by gateway in real implementation
          'captured',
          params.signature,
        ]
      );

      // 4. Update order status
      await client.query(
        `UPDATE payment_orders SET status = $1, updated_at = NOW() WHERE order_id = $2`,
        ['captured', params.orderId]
      );

      // 5. Update print job payment status and queue it
      await client.query(
        `UPDATE print_jobs
         SET payment_status = $1, paid_at = NOW(), status = $2, queued_at = NOW()
         WHERE id = $3`,
        ['paid', 'queued', order.job_id]
      );

      await client.query('COMMIT');

      const transaction: PaymentTransaction = {
        id: transactionId,
        orderId: params.orderId,
        paymentId: params.paymentId,
        amount: Number(order.amount),
        currency: order.currency,
        method: 'mock',
        status: 'captured',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      logger.info('Payment verified and captured', {
        orderId: params.orderId,
        paymentId: params.paymentId,
        jobId: order.job_id,
      });

      // Broadcast job status update via WebSocket
      websocketService.broadcastJobStatus(order.job_id, 'queued', {
        paymentVerified: true,
        paidAt: new Date().toISOString(),
      });

      return {
        success: true,
        transaction,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error verifying payment', { error, params });
      throw error;
    } finally {
      client.release();
    }
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
   * Handle payment failure
   */
  async handlePaymentFailure(
    orderId: string,
    errorCode: string,
    errorDescription: string
  ): Promise<void> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      // Update order status
      await client.query(
        `UPDATE payment_orders SET status = $1, updated_at = NOW() WHERE order_id = $2`,
        ['failed', orderId]
      );

      // Get job ID
      const orderResult = await client.query<{ job_id: string }>(
        `SELECT job_id FROM payment_orders WHERE order_id = $1`,
        [orderId]
      );

      if (orderResult.rows.length > 0) {
        const jobId = orderResult.rows[0].job_id;

        // Update job to indicate payment failure
        await client.query(
          `UPDATE print_jobs
           SET error_message = $1
           WHERE id = $2`,
          [`Payment failed: ${errorDescription}`, jobId]
        );
      }

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
