import { Database, PoolClient, db } from '../config/database';
import { AppError } from '../utils/errors';
import { IPaymentService } from '../types/payment';
import logger from '../utils/logger';
import { RazorpayService } from './razorpayService';

type RefundGateway = Pick<IPaymentService, 'refundPayment'>;

export interface JobRefund {
  jobId: string;
  refundId: string;
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
  status: string;
  alreadyRefunded: boolean;
  organizationId: string | null;
  createdAt: Date;
}

interface RefundRow {
  job_id: string;
  refund_id: string;
  payment_id: string;
  order_id: string;
  amount: string;
  currency: string;
  status: string;
  created_at: Date;
}

/** A job that has started or finished printing cannot be refunded here. */
const UNREFUNDABLE_JOB_STATUSES = ['printing', 'completed'];
const UNREFUNDABLE_QUEUE_STATUSES = ['assigned', 'printing', 'completed'];

/**
 * Full refunds for paid jobs that did not print (the dashboard's "refund
 * candidates"). One refund per job: a repeat call returns the stored refund
 * without calling the gateway again.
 *
 * The job row is locked for the whole operation, so concurrent requests for
 * the same job serialise and a printer cannot be handed the job mid-refund.
 */
export class RefundService {
  private gateway?: RefundGateway;

  constructor(
    private database: Database = db,
    gateway?: RefundGateway
  ) {
    this.gateway = gateway;
  }

  private getGateway(): RefundGateway {
    if (!this.gateway) {
      this.gateway = new RazorpayService();
    }
    return this.gateway;
  }

  /**
   * @param tenantId the caller's organization, or null for platform-wide
   *                 (super admin). A job of another organization is a 404.
   */
  async refundJob(params: {
    jobId: string;
    reason: string;
    tenantId: string | null;
    requestedBy: string | null;
  }): Promise<JobRefund> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      const jobResult = await client.query<{
        id: string;
        status: string;
        payment_status: string;
        organization_id: string | null;
      }>(
        `SELECT id, status, payment_status, organization_id
         FROM print_jobs WHERE id = $1 FOR UPDATE`,
        [params.jobId]
      );
      const job = jobResult.rows[0];

      if (!job || (params.tenantId && job.organization_id !== params.tenantId)) {
        throw new AppError('Print job not found', 404);
      }

      const existing = await client.query<RefundRow>(
        `SELECT job_id, refund_id, payment_id, order_id, amount, currency, status, created_at
         FROM payment_refunds WHERE job_id = $1`,
        [params.jobId]
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return this.toRefund(existing.rows[0], true, job.organization_id);
      }

      if (job.payment_status !== 'paid') {
        throw new AppError('Only paid jobs can be refunded', 409, 'NOT_REFUNDABLE');
      }

      const queue = await client.query<{ status: string }>(
        `SELECT status FROM print_queue WHERE job_id = $1 FOR UPDATE`,
        [params.jobId]
      );
      const queueStatus = queue.rows[0]?.status;
      if (
        UNREFUNDABLE_JOB_STATUSES.includes(job.status) ||
        (queueStatus && UNREFUNDABLE_QUEUE_STATUSES.includes(queueStatus))
      ) {
        throw new AppError(
          `Job is ${queueStatus ?? job.status}; it can no longer be refunded here`,
          409,
          'NOT_REFUNDABLE'
        );
      }

      const payment = await client.query<{
        payment_id: string;
        order_id: string;
        amount: string;
        currency: string;
      }>(
        `SELECT pt.payment_id, pt.order_id, pt.amount, pt.currency
         FROM payment_transactions pt
         JOIN payment_orders po ON po.order_id = pt.order_id
         WHERE po.job_id = $1 AND pt.status = 'captured'
         ORDER BY pt.created_at ASC
         LIMIT 1`,
        [params.jobId]
      );
      const captured = payment.rows[0];
      if (!captured) {
        throw new AppError('No captured payment found for this job', 409, 'NOT_REFUNDABLE');
      }

      let result;
      try {
        result = await this.getGateway().refundPayment(
          captured.payment_id,
          parseFloat(captured.amount),
          { job_id: params.jobId }
        );
      } catch (error) {
        logger.error('Gateway refund failed', {
          jobId: params.jobId,
          paymentId: captured.payment_id,
          error: error instanceof Error ? error.message : error,
        });
        throw new AppError('Payment gateway refused the refund', 502, 'REFUND_FAILED');
      }

      const row = await this.recordRefund(client, {
        jobId: params.jobId,
        orderId: captured.order_id,
        paymentId: captured.payment_id,
        refundId: result.refundId,
        amount: result.amount || parseFloat(captured.amount),
        currency: result.currency || captured.currency,
        status: result.status,
        reason: params.reason,
        requestedBy: params.requestedBy,
      });

      await client.query('COMMIT');

      logger.info('Refund issued', {
        jobId: params.jobId,
        refundId: result.refundId,
        paymentId: captured.payment_id,
      });

      return this.toRefund(row, false, job.organization_id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordRefund(
    client: PoolClient,
    r: {
      jobId: string;
      orderId: string;
      paymentId: string;
      refundId: string;
      amount: number;
      currency: string;
      status: string;
      reason: string;
      requestedBy: string | null;
    }
  ): Promise<RefundRow> {
    const inserted = await client.query<RefundRow>(
      `INSERT INTO payment_refunds
         (job_id, order_id, payment_id, refund_id, amount, currency, status, reason, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING job_id, refund_id, payment_id, order_id, amount, currency, status, created_at`,
      [
        r.jobId,
        r.orderId,
        r.paymentId,
        r.refundId,
        r.amount,
        r.currency,
        r.status,
        r.reason,
        r.requestedBy,
      ]
    );

    await client.query(
      `UPDATE print_jobs
       SET status = 'cancelled', payment_status = 'refunded', error_message = $2
       WHERE id = $1`,
      [r.jobId, `Refunded: ${r.reason}`]
    );
    await client.query(
      `UPDATE print_queue SET status = 'cancelled', updated_at = NOW()
       WHERE job_id = $1 AND status IN ('queued', 'failed')`,
      [r.jobId]
    );
    await client.query(
      `UPDATE payment_orders SET status = 'refunded', updated_at = NOW() WHERE order_id = $1`,
      [r.orderId]
    );

    return inserted.rows[0];
  }

  private toRefund(row: RefundRow, alreadyRefunded: boolean, orgId: string | null): JobRefund {
    return {
      jobId: row.job_id,
      refundId: row.refund_id,
      paymentId: row.payment_id,
      orderId: row.order_id,
      amount: parseFloat(row.amount),
      currency: row.currency,
      status: row.status,
      alreadyRefunded,
      organizationId: orgId,
      createdAt: row.created_at,
    };
  }
}

export const refundService = new RefundService();
