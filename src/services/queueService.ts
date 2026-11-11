import { Database, PoolClient, db } from '../config/database';
import { AppError } from '../utils/errors';
import {
  Printer,
  PrinterHeartbeat,
  JobAssignment,
  PollQueueParams,
  UpdateJobStatusParams,
  UpdateJobStatusResult,
  PrinterCapabilities,
} from '../types/queue';
import env from '../config/environment';
import logger from '../utils/logger';
import { storageService } from './storageService';
import { websocketService } from './websocketService';

/**
 * Terminal states. A job in one of these never moves again, which makes every
 * status update from a printer safely idempotent.
 */
const TERMINAL_STATUSES = ['completed', 'cancelled'];

/** A job in one of these is no longer assigned to any printer's active work. */
const FINAL_STATUSES = ['completed', 'failed', 'cancelled'];

/** Customer-facing reason when the print window closes. */
const EXPIRED_MESSAGE =
  'We could not print your job within the print window. Please show this screen to shop staff for a refund.';

/**
 * print_jobs.total_pages is the charged count, which already includes copies
 * (pricingService: physical pages x copies). The printer contract speaks in
 * pages per copy, so divide back rather than multiplying by copies again.
 */
/** The print window in whole minutes. Interpolated into SQL, so it must be an integer. */
export function printWindowMinutes(): number {
  return Math.max(1, Math.trunc(env.printer.print_window_minutes));
}

function pagesPerCopy(totalPages: number | null, copies: number | null): number {
  return Math.round((totalPages || 0) / (copies || 1));
}

interface PrinterRow {
  id: string;
  printer_id: string;
  kiosk_id: string;
  name: string;
  status: Printer['status'];
  ip_address: string | null;
  last_heartbeat: Date;
  supports_color: boolean;
  supports_double_sided: boolean;
  max_copies: number;
  supported_paper_sizes: string[] | null;
  created_at: Date;
  updated_at: Date;
  revoked_at?: Date | null;
}

interface PollPrinterRow {
  id: string;
  kiosk_id: string;
  status: Printer['status'];
  supports_color: boolean;
  supports_double_sided: boolean;
}

interface InFlightJobRow {
  job_id: string;
}

interface PollJobRow {
  job_id: string;
  priority: number;
  lease_count: number;
  color_mode: string;
  copies: number;
  page_range: string;
  custom_range: string | null;
  print_sides: string;
  paper_size: string;
  orientation: string;
  total_pages: number | null;
  print_deadline_at: Date;
  s3_key: string;
  original_filename: string;
  file_size_bytes: number | string;
  file_type: string;
}

interface CurrentQueueJobRow {
  status: string;
  lease_count: number | null;
  printer_id: string | null;
  last_printer_id: string | null;
  printed_pages: number | null;
  retry_count: number | null;
  max_retries: number;
  total_pages: number | null;
  copies: number | null;
  /** Computed by the database so the comparison uses the same clock as every other path. */
  deadline_passed: boolean;
}

interface ReclaimedJobRow {
  job_id: string;
  status: string;
}

interface JobStatusRow {
  job_id: string;
  status: string;
  printed_pages: number | null;
  error_message: string | null;
  error_code: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  total_pages: number | null;
  copies: number | null;
}

interface PrintJobStatusRow {
  id: string;
  status: string;
  printed_pages: number | null;
  total_pages: number | null;
  copies: number | null;
  error_message: string | null;
}

interface QueueCountsRow {
  queued: string;
  assigned: string;
  printing: string;
  completed: string;
  failed: string;
}

interface PendingJobsCountRow {
  count: string;
}

type QueryParameter = string | number | boolean | null | Date;

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
    const kiosk = await this.database.query<{ id: string }>(`SELECT id FROM kiosks WHERE id = $1`, [
      params.kioskId,
    ]);
    if (kiosk.rows.length === 0) {
      throw new AppError(`Kiosk ${params.kioskId} does not exist`, 400);
    }

    const result = await this.database.query<PrinterRow>(
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

      const printerResult = await client.query<{ id: string }>(
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
    client?: { query: (text: string, params?: QueryParameter[]) => Promise<unknown> }
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
    // A job this printer holds past its deadline is failed now, before anything
    // else. It is never handed back, even if the sweep has not run yet.
    await this.runExpiry('pq.printer_id = $2', [params.printerUuid]);

    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      // Capabilities are read from the database, not from the request body: a
      // compromised or buggy Pi must not be able to claim a colour job by
      // claiming colour support it does not have.
      const printerResult = await client.query<PollPrinterRow>(
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
      const inFlight = await client.query<InFlightJobRow>(
        `SELECT pq.job_id
           FROM print_queue pq
          WHERE pq.printer_id = $1
            AND pq.status IN ('assigned', 'printing')
          LIMIT 1`,
        [printer.id]
      );

      const jobFilter = inFlight.rows.length > 0 ? 'pq.job_id = $4' : `pq.status = 'queued'`;

      const jobResult = await client.query<PollJobRow>(
        `SELECT pq.job_id, pq.priority, pq.lease_count,
                pj.color_mode, pj.copies, pj.page_range, pj.custom_range,
                pj.print_sides, pj.paper_size, pj.orientation, pj.total_pages,
                pj.print_deadline_at,
                d.s3_key, d.original_filename, d.file_size_bytes, d.file_type
           FROM print_queue pq
           JOIN print_jobs pj ON pq.job_id = pj.id
           JOIN documents  d  ON pj.document_id = d.id
          WHERE ${jobFilter}
            AND pj.kiosk_id = $1
            AND pj.payment_status = 'paid'
            AND pq.retry_count < pq.max_retries
            -- Never hand out a job at or past its fixed deadline. The deadline is
            -- stored on the job at payment; it does not move with leases or attempts.
            AND pj.print_deadline_at > NOW()
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

      // Attempt history: one row per claim, so a later report can be checked
      // against the printer that actually held that attempt.
      await client.query(
        `INSERT INTO print_attempts (job_id, attempt, printer_id, assigned_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (job_id, attempt) DO NOTHING`,
        [job.job_id, job.lease_count + 1, printer.id]
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
        totalPages: pagesPerCopy(job.total_pages, job.copies),
        assignedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + env.printer.job_lease_seconds * 1000).toISOString(),
        attempt: job.lease_count + 1,
        printDeadlineAt: new Date(job.print_deadline_at).toISOString(),
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
   *  - a printer may only update a job it currently holds; a former holder gets
   *    an idempotent terminal answer with `printerReleased: true`;
   *  - a job at or past its deadline is failed first, so no report can renew it;
   *  - an expiry report before the deadline is refused without changing the job;
   *  - a job already in a terminal state is left alone (idempotent retries);
   *  - `printedPages` only ever moves forward, and `null` means "unknown";
   *  - `started_at` is stamped once, not on every `printing` message.
   *
   * @param printerUuid when present, the update is scoped to that printer.
   *                    Omitted for internal/admin callers such as the reaper.
   */
  async updateJobStatus(
    params: UpdateJobStatusParams & { printerUuid?: string }
  ): Promise<UpdateJobStatusResult> {
    const result = await this.applyStatusUpdate(params);
    // Broadcast only after the transaction has committed.
    this.broadcastExpired(result.expiredJobIds ?? []);
    return result;
  }

  private async applyStatusUpdate(
    params: UpdateJobStatusParams & { printerUuid?: string }
  ): Promise<UpdateJobStatusResult> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      const current = await client.query<CurrentQueueJobRow>(
        `SELECT pq.status, pq.lease_count, pq.printer_id, pq.last_printer_id,
                pq.printed_pages, pq.retry_count, pq.max_retries,
                pj.total_pages, pj.copies,
                (pj.print_deadline_at <= NOW()) AS deadline_passed
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
      const caller = params.printerUuid;
      const isFinal = FINAL_STATUSES.includes(row.status);
      const holds = caller !== undefined && row.printer_id === caller;
      const formerHolder =
        caller !== undefined && !holds && isFinal && row.last_printer_id === caller;
      const isExpiryReport =
        params.status === 'failed' && params.errorCode === 'PRINT_WINDOW_EXPIRED';

      // Ownership. A printer that does not hold the job, and was not the last
      // holder of a finished one, is refused. An earlier attempt of its own gets
      // STALE_ATTEMPT so it knows the job moved on, not that it was never its job.
      if (caller !== undefined && !holds && !formerHolder) {
        if (params.attempt !== undefined) {
          const earlier = await client.query(
            `SELECT 1 FROM print_attempts
              WHERE job_id = $1 AND attempt = $2 AND printer_id = $3`,
            [params.jobId, params.attempt, caller]
          );
          if (earlier.rows.length > 0) {
            logger.warn('Rejected report for an earlier attempt this printer held', {
              jobId: params.jobId,
              reportedAttempt: params.attempt,
              currentAttempt: row.lease_count,
            });
            throw new AppError(
              'This report is for an earlier attempt of the job and has been rejected',
              409,
              'STALE_ATTEMPT'
            );
          }
        }
        logger.warn('Printer reported status for a job it does not hold', {
          jobId: params.jobId,
          reportedBy: caller,
        });
        throw new AppError('This job is not assigned to your printer', 403, 'JOB_NOT_ASSIGNED');
      }

      // Former holder of a finished job: the same answer every time, and the
      // printer is released. A stale attempt is still refused.
      if (formerHolder) {
        if (params.attempt !== undefined && params.attempt !== row.lease_count) {
          throw new AppError(
            'This report is for an earlier attempt of the job and has been rejected',
            409,
            'STALE_ATTEMPT'
          );
        }
        await client.query('COMMIT');
        return { applied: false, status: row.status, printerReleased: true };
      }

      // A permanently failed job is final whatever the printer reports next.
      if (row.status === 'failed') {
        await client.query('COMMIT');
        logger.debug('Ignoring report for permanently failed job', {
          jobId: params.jobId,
          reported: params.status,
        });
        return { applied: false, status: 'failed', printerReleased: true };
      }

      // A report for an earlier attempt must not change the current attempt.
      if (params.attempt !== undefined && params.attempt !== row.lease_count) {
        logger.warn('Rejected status report for a stale attempt', {
          jobId: params.jobId,
          reportedAttempt: params.attempt,
          currentAttempt: row.lease_count,
        });
        throw new AppError(
          'This report is for an earlier attempt of the job and has been rejected',
          409,
          'STALE_ATTEMPT'
        );
      }

      // Idempotency: a completed or cancelled job is final.
      if (TERMINAL_STATUSES.includes(row.status)) {
        await client.query('COMMIT');
        logger.debug('Ignoring status update for terminal job', {
          jobId: params.jobId,
          current: row.status,
          reported: params.status,
        });
        return { applied: false, status: row.status, printerReleased: true };
      }

      // The deadline is checked before anything renews the lease. At or after it,
      // the job fails now and the printer is released; the report is not applied.
      if (row.deadline_passed) {
        const expiredJobIds = await this.expireDueJobs(client, 'pq.job_id = $2', [params.jobId]);
        await client.query('COMMIT');
        logger.warn('Report arrived after the print deadline; job expired', {
          jobId: params.jobId,
          reported: params.status,
        });
        return {
          applied: isExpiryReport,
          status: 'failed',
          printerReleased: true,
          expiredJobIds,
        };
      }

      // An expiry report before the deadline is refused, and the assignment stays.
      if (isExpiryReport) {
        throw new AppError(
          'The print deadline has not passed yet; the job is still assigned to your printer',
          409,
          'DEADLINE_NOT_REACHED'
        );
      }

      // Progress only moves forward, and never past the real page count.
      // total_pages already counts every copy (it is what the customer paid for).
      // A null printedPages means unknown: keep what is recorded.
      const maxPages = row.total_pages || 0;
      const printedPages =
        params.printedPages != null
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

      // Record the last holder whenever the job reaches a final state, so a later
      // report from that printer gets the release answer.
      if (params.status === 'completed' || params.status === 'cancelled') {
        await client.query(
          `UPDATE print_queue SET last_printer_id = printer_id WHERE job_id = $1`,
          [params.jobId]
        );
      }

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
          // The printer keeps the assignment on final failure, and is recorded as the last holder.
          await client.query(
            `UPDATE print_queue SET last_printer_id = printer_id WHERE job_id = $1`,
            [params.jobId]
          );
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

      return {
        applied: true,
        status: finalStatus,
        // Released once the job is no longer active on this printer.
        printerReleased: finalStatus !== 'printing',
      };
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
   * Fail active jobs whose deadline has passed, inside the caller's transaction.
   *
   * The job keeps its row and history. The printer is released through
   * last_printer_id, and nothing can requeue the job. Only the job's own rows are
   * touched, so the caller's scope (`scopeSql`, using $2 for its first value)
   * decides which jobs are included.
   */
  private async expireDueJobs(
    client: PoolClient,
    scopeSql: string,
    scopeParams: unknown[]
  ): Promise<string[]> {
    const result = await client.query<{ job_id: string }>(
      `UPDATE print_queue pq SET
         status           = 'failed',
         last_printer_id  = COALESCE(pq.printer_id, pq.last_printer_id),
         printer_id       = NULL,
         assigned_at      = NULL,
         lease_expires_at = NULL,
         error_code       = 'PRINT_WINDOW_EXPIRED',
         error_message    = $1,
         failed_at        = NOW(),
         updated_at       = NOW()
       FROM print_jobs pj
       WHERE pj.id = pq.job_id
         AND pq.status IN ('queued', 'assigned', 'printing')
         AND pj.print_deadline_at <= NOW()
         AND ${scopeSql}
       RETURNING pq.job_id`,
      [EXPIRED_MESSAGE, ...scopeParams]
    );

    const ids = result.rows.map((r) => r.job_id);
    if (ids.length === 0) return ids;

    await client.query(
      `UPDATE print_jobs SET status = 'failed',
              error_message = 'Not printed within the print window; refund required'
        WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    logger.warn('Paid jobs failed after their print deadline', { count: ids.length, jobIds: ids });
    return ids;
  }

  /** Run an expiry in its own transaction, then tell open screens about it. */
  private async runExpiry(scopeSql: string, scopeParams: unknown[]): Promise<number> {
    const client = await this.database.getClient();
    let ids: string[] = [];
    try {
      await client.query('BEGIN');
      ids = await this.expireDueJobs(client, scopeSql, scopeParams);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    this.broadcastExpired(ids);
    return ids.length;
  }

  /** Tell any screen that is open right now. A live connection only hears pushed updates. */
  private broadcastExpired(ids: string[]): void {
    for (const id of ids) {
      websocketService.broadcastJobStatus(id, 'failed', { errorMessage: EXPIRED_MESSAGE });
    }
  }

  /**
   * Return jobs whose lease expired to the queue.
   *
   * A Pi that loses power mid-print never sends a terminal status, so without
   * this the job would sit in `printing` forever. A job past its deadline is
   * failed here rather than requeued.
   */
  async reclaimExpiredLeases(): Promise<number> {
    await this.runExpiry('TRUE', []);

    const result = await this.database.query<ReclaimedJobRow>(
      `UPDATE print_queue SET
         status = CASE WHEN retry_count + 1 < max_retries THEN 'queued' ELSE 'failed' END,
         last_printer_id = CASE WHEN retry_count + 1 < max_retries
                                THEN last_printer_id ELSE printer_id END,
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
         AND job_id IN (SELECT id FROM print_jobs WHERE print_deadline_at > NOW())
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
   * Fail every paid job still queued, assigned or printing once its fixed
   * deadline has passed. The job is never picked up again, and it stays
   * `payment_status = paid` so the attention queue flags it for a one-click
   * refund. The printer is released through last_printer_id.
   */
  async expireOutOfWindow(): Promise<number> {
    return this.runExpiry('TRUE', []);
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
    /** Pages in one copy. */
    totalPages: number;
    /** Pages this job will produce across all copies — what printedPages counts against. */
    totalSheets: number;
    copies: number;
    errorMessage?: string;
    errorCode?: string;
    startedAt?: Date;
    completedAt?: Date;
    failedAt?: Date;
  }> {
    const result = await this.database.query<JobStatusRow>(
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
        totalPages: pagesPerCopy(row.total_pages, row.copies),
        totalSheets: row.total_pages || 0,
        copies: row.copies || 1,
        errorMessage: row.error_message ?? undefined,
        errorCode: row.error_code ?? undefined,
        startedAt: row.started_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
        failedAt: row.failed_at ?? undefined,
      };
    }

    // Not queued yet (unpaid, or still being configured): report the job itself.
    const jobResult = await this.database.query<PrintJobStatusRow>(
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
      totalPages: pagesPerCopy(job.total_pages, job.copies),
      totalSheets: job.total_pages || 0,
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
    const result = await this.database.query<QueueCountsRow>(
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

    const result = await this.database.query<PrinterRow>(query, params);
    return result.rows.map((row) => this.mapRowToPrinter(row));
  }

  async getPendingJobsCount(printerUuid: string): Promise<number> {
    const result = await this.database.query<PendingJobsCountRow>(
      `SELECT COUNT(*) as count FROM print_queue
        WHERE printer_id = $1 AND status IN ('assigned', 'printing')`,
      [printerUuid]
    );
    return parseInt(result.rows[0].count) || 0;
  }

  private mapRowToPrinter(row: PrinterRow): Printer {
    return {
      id: row.id,
      printerId: row.printer_id,
      kioskId: row.kiosk_id,
      name: row.name,
      status: row.status,
      ipAddress: row.ip_address ?? undefined,
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
