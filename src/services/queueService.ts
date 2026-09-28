import { Database, db } from '../config/database';
import { AppError } from '../utils/errors';
import {
  Printer,
  PrinterHeartbeat,
  JobAssignment,
  PollQueueParams,
  UpdateJobStatusParams,
  PrinterCapabilities,
} from '../types/queue';
import env from '../config/environment';
import logger from '../utils/logger';
import { storageService } from './storageService';

/**
 * Terminal states. A job in one of these never moves again, which makes every
 * status update from a printer safely idempotent.
 */
const TERMINAL_STATUSES = ['completed', 'cancelled'];

export class QueueService {
  constructor(private database: Database = db) {}

  // -------------------------------------------------------------------------
  // Printer lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register or update a printer.
   *
   * Enrollment (first registration) is guarded by the provisioning token at the
   * route layer; re-registration is authenticated with the printer's own key and
   * only refreshes mutable fields. Credentials are never touched here.
   */
  async registerPrinter(params: {
    printerId: string;
    kioskId: string;
    name: string;
    capabilities: PrinterCapabilities;
    ipAddress?: string;
  }): Promise<Printer> {
    // kiosk_id is a FK to kiosks(id); fail loudly rather than with a raw PG error.
    const kiosk = await this.database.query(`SELECT id FROM kiosks WHERE id = $1`, [
      params.kioskId,
    ]);
    if (kiosk.rows.length === 0) {
      throw new AppError(`Kiosk ${params.kioskId} does not exist`, 400);
    }

    const result = await this.database.query(
      `INSERT INTO printers (
        printer_id, kiosk_id, name, ip_address,
        supports_color, supports_double_sided, max_copies, supported_paper_sizes,
        status, last_heartbeat, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'online', NOW(), NOW(), NOW())
      ON CONFLICT (printer_id) DO UPDATE SET
        name = EXCLUDED.name,
        ip_address = EXCLUDED.ip_address,
        supports_color = EXCLUDED.supports_color,
        supports_double_sided = EXCLUDED.supports_double_sided,
        max_copies = EXCLUDED.max_copies,
        supported_paper_sizes = EXCLUDED.supported_paper_sizes,
        status = 'online',
        last_heartbeat = NOW(),
        updated_at = NOW()
      RETURNING *`,
      [
        params.printerId,
        params.kioskId,
        params.name,
        params.ipAddress,
        params.capabilities.supportsColor,
        params.capabilities.supportsDoubleSided,
        params.capabilities.maxCopies,
        // supported_paper_sizes is a TEXT[]; pg maps a JS array onto it directly.
        params.capabilities.supportedPaperSizes,
      ]
    );

    logger.info('Printer registered', {
      printerId: params.printerId,
      kioskId: params.kioskId,
    });

    return this.mapRowToPrinter(result.rows[0]);
  }

  /**
   * Record a heartbeat and append to the heartbeat log.
   */
  async updateHeartbeat(heartbeat: PrinterHeartbeat): Promise<void> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      const printerResult = await client.query(
        `UPDATE printers SET
          status = $1,
          last_heartbeat = NOW(),
          updated_at = NOW()
         WHERE printer_id = $2
         RETURNING id`,
        [heartbeat.status, heartbeat.printerId]
      );

      if (printerResult.rows.length === 0) {
        throw new AppError('Printer not registered', 404);
      }

      await client.query(
        `INSERT INTO printer_heartbeats (
          printer_id, status, current_job_id, error_message,
          paper_level, ink_level_black, ink_level_color, received_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          printerResult.rows[0].id,
          heartbeat.status,
          heartbeat.currentJobId ?? null,
          heartbeat.errorMessage ?? null,
          heartbeat.paperLevel ?? null,
          heartbeat.inkLevel?.black ?? null,
          heartbeat.inkLevel?.color ?? null,
        ]
      );

      await client.query('COMMIT');

      logger.debug('Printer heartbeat updated', {
        printerId: heartbeat.printerId,
        status: heartbeat.status,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating heartbeat', { error, printerId: heartbeat.printerId });
      throw error;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Queue entry
  // -------------------------------------------------------------------------

  /**
   * Put a paid job into the print queue.
   *
   * Called inside the payment transaction so a job becomes payable and printable
   * atomically — there is no window where money is captured but no queue row exists.
   * `ON CONFLICT DO NOTHING` makes a replayed payment webhook harmless.
   */
  async enqueueJob(
    jobId: string,
    priority = 0,
    client?: { query: (text: string, params?: any[]) => Promise<unknown> }
  ): Promise<void> {
    const exec = client ?? this.database;

    await exec.query(
      `INSERT INTO print_queue (job_id, status, priority, queued_at, created_at, updated_at)
       VALUES ($1, 'queued', $2, NOW(), NOW(), NOW())
       ON CONFLICT (job_id) DO NOTHING`,
      [jobId, priority]
    );

    logger.info('Job enqueued for printing', { jobId, priority });
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  /**
   * Claim the next job for a printer.
   *
   * Pull model: the printer asks for work and atomically claims one row via
   * `FOR UPDATE SKIP LOCKED`, so two printers polling concurrently can never be
   * handed the same job. The claim carries a lease; if the Pi dies mid-print the
   * reaper returns the job to the queue.
   *
   * @param printerUuid internal printers.id, taken from the authenticated
   *                    credentials — never from the request body.
   */
  async pollQueue(
    params: PollQueueParams & { printerUuid: string }
  ): Promise<JobAssignment | null> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      // Capabilities are read from the database, not from the request body: a
      // compromised or buggy Pi must not be able to claim a colour job by
      // claiming colour support it does not have.
      const printerResult = await client.query(
        `SELECT id, kiosk_id, status, supports_color, supports_double_sided, max_copies
           FROM printers
          WHERE id = $1 AND revoked_at IS NULL`,
        [params.printerUuid]
      );

      if (printerResult.rows.length === 0) {
        throw new AppError('Printer not registered', 404);
      }

      const printer = printerResult.rows[0];

      if (printer.status === 'maintenance') {
        await client.query('COMMIT');
        return null;
      }

      // A printer may hold only one job at a time. If it already has one
      // (e.g. it restarted mid-print), hand the same job back rather than a new one.
      const inFlight = await client.query(
        `SELECT pq.job_id
           FROM print_queue pq
          WHERE pq.printer_id = $1
            AND pq.status IN ('assigned', 'printing')
          LIMIT 1`,
        [printer.id]
      );

      const jobFilter = inFlight.rows.length > 0 ? 'pq.job_id = $4' : `pq.status = 'queued'`;

      const jobResult = await client.query(
        `SELECT pq.job_id, pq.priority, pq.lease_count,
                pj.color_mode, pj.copies, pj.page_range, pj.custom_range,
                pj.print_sides, pj.paper_size, pj.orientation, pj.total_pages,
                d.s3_key, d.original_filename, d.file_size_bytes, d.file_type
           FROM print_queue pq
           JOIN print_jobs pj ON pq.job_id = pj.id
           JOIN documents  d  ON pj.document_id = d.id
          WHERE ${jobFilter}
            AND pj.kiosk_id = $1
            AND pj.payment_status = 'paid'
            AND pq.retry_count < pq.max_retries
            AND (pj.color_mode <> 'color'  OR $2 = true)
            AND (pj.print_sides <> 'double' OR $3 = true)
          ORDER BY pq.priority DESC, pq.queued_at ASC
          LIMIT 1
          FOR UPDATE OF pq SKIP LOCKED`,
        inFlight.rows.length > 0
          ? [
              printer.kiosk_id,
              printer.supports_color,
              printer.supports_double_sided,
              inFlight.rows[0].job_id,
            ]
          : [printer.kiosk_id, printer.supports_color, printer.supports_double_sided]
      );

      if (jobResult.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      const job = jobResult.rows[0];

      // Claim it: assign, stamp a lease, and count the lease for retry accounting.
      await client.query(
        `UPDATE print_queue SET
          printer_id = $1,
          -- A resumed job stays 'printing'; only a fresh claim becomes 'assigned'.
          status = CASE WHEN status = 'printing' THEN 'printing' ELSE 'assigned' END,
          assigned_at = COALESCE(assigned_at, NOW()),
          lease_expires_at = NOW() + ($2 || ' seconds')::interval,
          lease_count = lease_count + 1,
          updated_at = NOW()
         WHERE job_id = $3`,
        [printer.id, String(env.printer.job_lease_seconds), job.job_id]
      );

      await client.query(
        `UPDATE print_jobs SET
          status = 'printing',
          started_printing_at = COALESCE(started_printing_at, NOW())
         WHERE id = $1`,
        [job.job_id]
      );

      await client.query('COMMIT');

      // Pre-signed URL is generated after commit: it is not transactional state,
      // and a rollback must not leave a live download link behind.
      const documentUrl = await storageService.getPresignedUrl(
        job.s3_key,
        env.printer.document_url_ttl_seconds
      );

      const assignment: JobAssignment = {
        jobId: job.job_id,
        documentUrl,
        documentUrlExpiresAt: new Date(
          Date.now() + env.printer.document_url_ttl_seconds * 1000
        ).toISOString(),
        fileName: job.original_filename,
        fileSizeBytes: Number(job.file_size_bytes),
        mimeType: job.file_type,
        settings: {
          colorMode: job.color_mode,
          copies: job.copies,
          pageRange: job.page_range,
          customRange: job.custom_range ?? undefined,
          printSides: job.print_sides,
          paperSize: job.paper_size,
          orientation: job.orientation,
        },
        totalPages: job.total_pages,
        assignedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + env.printer.job_lease_seconds * 1000).toISOString(),
        attempt: job.lease_count + 1,
      };

      logger.info('Job claimed by printer', {
        jobId: job.job_id,
        printerId: params.printerId,
        attempt: assignment.attempt,
      });

      return assignment;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error polling queue', { error, printerId: params.printerId });
      throw error;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Status reporting
  // -------------------------------------------------------------------------

  /**
   * Apply a status update reported by a printer.
   *
   * Guarantees:
   *  - a printer may only update a job it currently holds (ownership check);
   *  - a job already in a terminal state is left alone (idempotent retries);
   *  - `printedPages` only ever moves forward, so out-of-order arrivals from a
   *    retrying Pi cannot walk the progress bar backwards;
   *  - `started_at` is stamped once, not on every `printing` message.
   *
   * @param printerUuid when present, the update is scoped to that printer.
   *                    Omitted for internal/admin callers such as the reaper.
   */
  async updateJobStatus(
    params: UpdateJobStatusParams & { printerUuid?: string }
  ): Promise<{ applied: boolean; status: string }> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      const current = await client.query(
        `SELECT pq.status, pq.printer_id, pq.printed_pages, pq.retry_count, pq.max_retries,
                pj.total_pages, pj.copies
           FROM print_queue pq
           JOIN print_jobs pj ON pq.job_id = pj.id
          WHERE pq.job_id = $1
          FOR UPDATE OF pq`,
        [params.jobId]
      );

      if (current.rows.length === 0) {
        throw new AppError('Job not found in print queue', 404);
      }

      const row = current.rows[0];

      // Ownership: reject a report about a job this printer does not hold.
      if (params.printerUuid && row.printer_id !== params.printerUuid) {
        await client.query('ROLLBACK');
        logger.warn('Printer reported status for a job it does not hold', {
          jobId: params.jobId,
          reportedBy: params.printerUuid,
          heldBy: row.printer_id,
        });
        throw new AppError('This job is not assigned to your printer', 403);
      }

      // Idempotency: a completed or cancelled job is final.
      if (TERMINAL_STATUSES.includes(row.status)) {
        await client.query('COMMIT');
        logger.debug('Ignoring status update for terminal job', {
          jobId: params.jobId,
          current: row.status,
          reported: params.status,
        });
        return { applied: false, status: row.status };
      }

      // Progress only moves forward, and never past the real page count.
      const maxPages = (row.total_pages || 0) * (row.copies || 1);
      const printedPages =
        params.printedPages !== undefined
          ? Math.min(Math.max(params.printedPages, row.printed_pages || 0), maxPages)
          : row.printed_pages;

      await client.query(
        // $1 is cast explicitly everywhere: assigning it to a varchar column while
        // also comparing it against text literals otherwise leaves Postgres unable
        // to settle on one type for the parameter (SQLSTATE 42P08).
        `UPDATE print_queue SET
           status           = $1::varchar,
           printed_pages    = $2,
           error_message    = $3,
           error_code       = $4,
           last_reported_at = NOW(),
           started_at       = CASE WHEN $1::text = 'printing' THEN COALESCE(started_at, NOW())
                                   ELSE started_at END,
           completed_at     = CASE WHEN $1::text = 'completed' THEN NOW() ELSE completed_at END,
           failed_at        = CASE WHEN $1::text = 'failed'    THEN NOW() ELSE failed_at END,
           retry_count      = CASE WHEN $1::text = 'failed' THEN retry_count + 1
                                   ELSE retry_count END,
           lease_expires_at = CASE WHEN $1::text IN ('completed', 'failed', 'cancelled') THEN NULL
                                   ELSE NOW() + ($5 || ' seconds')::interval END,
           updated_at       = NOW()
         WHERE job_id = $6`,
        [
          params.status,
          printedPages,
          params.errorMessage ?? null,
          params.errorCode ?? null,
          String(env.printer.job_lease_seconds),
          params.jobId,
        ]
      );

      // Mirror onto print_jobs, which is what the customer-facing API reads.
      await client.query(
        `UPDATE print_jobs SET
           printed_pages = $1,
           status = CASE
                      WHEN $2::text = 'completed' THEN 'completed'
                      WHEN $2::text = 'cancelled' THEN 'cancelled'
                      WHEN $2::text = 'printing'  THEN 'printing'
                      ELSE status
                    END,
           completed_at  = CASE WHEN $2::text = 'completed' THEN NOW() ELSE completed_at END,
           error_message = COALESCE($3, error_message),
           print_duration_seconds = CASE
                      WHEN $2::text = 'completed' AND started_printing_at IS NOT NULL
                      THEN EXTRACT(EPOCH FROM (NOW() - started_printing_at))::int
                      ELSE print_duration_seconds
                    END
         WHERE id = $4`,
        [printedPages, params.status, params.errorMessage ?? null, params.jobId]
      );

      let finalStatus: string = params.status;

      // Failure handling: requeue while retries remain, otherwise fail for good.
      if (params.status === 'failed') {
        const retriesUsed = (row.retry_count || 0) + 1;

        if (retriesUsed < row.max_retries) {
          await client.query(
            `UPDATE print_queue SET
               status = 'queued',
               printer_id = NULL,
               assigned_at = NULL,
               started_at = NULL,
               lease_expires_at = NULL,
               updated_at = NOW()
             WHERE job_id = $1`,
            [params.jobId]
          );
          await client.query(
            `UPDATE print_jobs SET status = 'queued', retry_count = $1 WHERE id = $2`,
            [retriesUsed, params.jobId]
          );
          finalStatus = 'queued';
          logger.info('Job requeued after failure', {
            jobId: params.jobId,
            attempt: retriesUsed,
            maxRetries: row.max_retries,
          });
        } else {
          await client.query(`UPDATE print_jobs SET status = 'failed' WHERE id = $1`, [
            params.jobId,
          ]);
          logger.error('Job failed permanently — eligible for refund', {
            jobId: params.jobId,
            attempts: retriesUsed,
            errorCode: params.errorCode,
            errorMessage: params.errorMessage,
          });
        }
      }

      await client.query('COMMIT');

      logger.info('Job status updated', {
        jobId: params.jobId,
        status: finalStatus,
        printedPages,
      });

      return { applied: true, status: finalStatus };
    } catch (error) {
      await client.query('ROLLBACK');
      if (!(error instanceof AppError)) {
        logger.error('Error updating job status', { error, jobId: params.jobId });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Return jobs whose lease expired to the queue.
   *
   * A Pi that loses power mid-print never sends a terminal status, so without
   * this the job would sit in `printing` forever and the customer would never
   * be refunded or reprinted.
   */
  async reclaimExpiredLeases(): Promise<number> {
    const result = await this.database.query(
      `UPDATE print_queue SET
         status = CASE WHEN retry_count + 1 < max_retries THEN 'queued' ELSE 'failed' END,
         printer_id = NULL,
         assigned_at = NULL,
         started_at = NULL,
         lease_expires_at = NULL,
         retry_count = retry_count + 1,
         error_code = 'LEASE_EXPIRED',
         error_message = 'Printer stopped reporting before the job finished',
         failed_at = CASE WHEN retry_count + 1 >= max_retries THEN NOW() ELSE failed_at END,
         updated_at = NOW()
       WHERE status IN ('assigned', 'printing')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < NOW()
       RETURNING job_id, status`
    );

    if (result.rowCount) {
      logger.warn('Reclaimed jobs with expired leases', {
        count: result.rowCount,
        jobIds: result.rows.map((r) => r.job_id),
      });

      // Keep print_jobs in step with the queue.
      await this.database.query(
        `UPDATE print_jobs pj SET status = pq.status
           FROM print_queue pq
          WHERE pq.job_id = pj.id AND pj.id = ANY($1::uuid[])`,
        [result.rows.map((r) => r.job_id)]
      );
    }

    return result.rowCount || 0;
  }

  /**
   * Mark printers that have stopped heartbeating as offline so they stop being
   * considered for new work.
   */
  async markStaleAsOffline(): Promise<number> {
    const result = await this.database.query(
      `UPDATE printers SET status = 'offline', updated_at = NOW()
        WHERE status IN ('online', 'busy')
          AND last_heartbeat < NOW() - ($1 || ' seconds')::interval`,
      [String(env.printer.heartbeat_timeout_seconds)]
    );

    if (result.rowCount) {
      logger.warn('Marked stale printers offline', { count: result.rowCount });
    }

    return result.rowCount || 0;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getJobStatus(jobId: string): Promise<{
    jobId: string;
    status: string;
    printedPages: number;
    /** Pages in the document. */
    totalPages: number;
    /** Sheets this job will produce (totalPages x copies) — what printedPages counts against. */
    totalSheets: number;
    copies: number;
    errorMessage?: string;
    errorCode?: string;
    startedAt?: Date;
    completedAt?: Date;
    failedAt?: Date;
  }> {
    const result = await this.database.query(
      `SELECT pq.job_id, pq.status, pq.printed_pages, pq.error_message, pq.error_code,
              pq.started_at, pq.completed_at, pq.failed_at, pj.total_pages, pj.copies
         FROM print_queue pq
         JOIN print_jobs pj ON pq.job_id = pj.id
        WHERE pq.job_id = $1`,
      [jobId]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        jobId: row.job_id,
        status: row.status,
        printedPages: row.printed_pages || 0,
        totalPages: row.total_pages || 0,
        totalSheets: (row.total_pages || 0) * (row.copies || 1),
        copies: row.copies || 1,
        errorMessage: row.error_message ?? undefined,
        errorCode: row.error_code ?? undefined,
        startedAt: row.started_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
        failedAt: row.failed_at ?? undefined,
      };
    }

    // Not queued yet (unpaid, or still being configured): report the job itself.
    const jobResult = await this.database.query(
      `SELECT id, status, printed_pages, total_pages, copies, error_message
         FROM print_jobs WHERE id = $1`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      throw new AppError('Job not found', 404);
    }

    const job = jobResult.rows[0];
    return {
      jobId: job.id,
      status: job.status,
      printedPages: job.printed_pages || 0,
      totalPages: job.total_pages || 0,
      totalSheets: (job.total_pages || 0) * (job.copies || 1),
      copies: job.copies || 1,
      errorMessage: job.error_message ?? undefined,
    };
  }

  async getQueueStatus(): Promise<{
    queued: number;
    assigned: number;
    printing: number;
    completed: number;
    failed: number;
  }> {
    const result = await this.database.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'queued')    as queued,
        COUNT(*) FILTER (WHERE status = 'assigned')  as assigned,
        COUNT(*) FILTER (WHERE status = 'printing')  as printing,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed')    as failed
       FROM print_queue
       WHERE created_at > NOW() - INTERVAL '24 hours'`
    );

    return {
      queued: parseInt(result.rows[0].queued) || 0,
      assigned: parseInt(result.rows[0].assigned) || 0,
      printing: parseInt(result.rows[0].printing) || 0,
      completed: parseInt(result.rows[0].completed) || 0,
      failed: parseInt(result.rows[0].failed) || 0,
    };
  }

  async getPrinters(kioskId?: string): Promise<Printer[]> {
    const query = kioskId
      ? `SELECT * FROM printers WHERE kiosk_id = $1 ORDER BY name`
      : `SELECT * FROM printers ORDER BY name`;
    const params = kioskId ? [kioskId] : [];

    const result = await this.database.query(query, params);
    return result.rows.map((row) => this.mapRowToPrinter(row));
  }

  async getPendingJobsCount(printerUuid: string): Promise<number> {
    const result = await this.database.query(
      `SELECT COUNT(*) as count FROM print_queue
        WHERE printer_id = $1 AND status IN ('assigned', 'printing')`,
      [printerUuid]
    );
    return parseInt(result.rows[0].count) || 0;
  }

  private mapRowToPrinter(row: any): Printer {
    return {
      id: row.id,
      printerId: row.printer_id,
      kioskId: row.kiosk_id,
      name: row.name,
      status: row.status,
      ipAddress: row.ip_address,
      lastHeartbeat: row.last_heartbeat,
      capabilities: {
        supportsColor: row.supports_color,
        supportsDoubleSided: row.supports_double_sided,
        maxCopies: row.max_copies,
        supportedPaperSizes: row.supported_paper_sizes || ['a4'],
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const queueService = new QueueService();
