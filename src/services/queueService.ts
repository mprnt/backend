import { Database, db } from '../config/database';
import { AppError } from '../utils/errors';
import {
  Printer,
  PrinterHeartbeat,
  // QueuedJob,
  JobAssignment,
  PollQueueParams,
  UpdateJobStatusParams,
  PrinterCapabilities,
} from '../types/queue';
import logger from '../utils/logger';
import { storageService } from './storageService';

export class QueueService {
  constructor(private database: Database = db) {}

  /**
   * Register or update a printer
   */
  async registerPrinter(params: {
    printerId: string;
    kioskId: string;
    name: string;
    capabilities: PrinterCapabilities;
    ipAddress?: string;
  }): Promise<Printer> {
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
   * Update printer heartbeat
   */
  async updateHeartbeat(heartbeat: PrinterHeartbeat): Promise<void> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      // Update printer status
      await client.query(
        `UPDATE printers SET
          status = $1,
          last_heartbeat = NOW(),
          updated_at = NOW()
         WHERE printer_id = $2`,
        [heartbeat.status, heartbeat.printerId]
      );

      // Log heartbeat
      await client.query(
        `INSERT INTO printer_heartbeats (
          printer_id, status, current_job_id, error_message,
          paper_level, ink_level_black, ink_level_color, received_at
        )
        SELECT id, $2, $3, $4, $5, $6, $7, NOW()
        FROM printers WHERE printer_id = $1`,
        [
          heartbeat.printerId,
          heartbeat.status,
          heartbeat.currentJobId,
          heartbeat.errorMessage,
          heartbeat.paperLevel,
          heartbeat.inkLevel?.black,
          heartbeat.inkLevel?.color,
        ]
      );

      await client.query('COMMIT');

      logger.debug('Printer heartbeat updated', {
        printerId: heartbeat.printerId,
        status: heartbeat.status,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating heartbeat', { error, heartbeat });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Poll for next available job
   * Raspberry Pi calls this to get work
   */
  async pollQueue(params: PollQueueParams): Promise<JobAssignment | null> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      // Get printer ID
      const printerResult = await client.query(`SELECT id FROM printers WHERE printer_id = $1`, [
        params.printerId,
      ]);

      if (printerResult.rows.length === 0) {
        throw new AppError('Printer not registered', 404);
      }

      const printerId = printerResult.rows[0].id;

      // Find next job in queue matching printer capabilities
      const jobResult = await client.query(
        `SELECT pq.*, pj.*, d.s3_key, d.file_name
         FROM print_queue pq
         JOIN print_jobs pj ON pq.job_id = pj.id
         JOIN documents d ON pj.document_id = d.id
         WHERE pq.status = 'queued'
           AND pq.retry_count < pq.max_retries
           AND (
             pj.color_mode = 'bw'
             OR (pj.color_mode = 'color' AND $2 = true)
           )
           AND (
             pj.print_sides = 'single'
             OR (pj.print_sides = 'double' AND $3 = true)
           )
         ORDER BY pq.priority DESC, pq.queued_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [printerId, params.capabilities.supportsColor, params.capabilities.supportsDoubleSided]
      );

      if (jobResult.rows.length === 0) {
        await client.query('COMMIT');
        return null; // No jobs available
      }

      const job = jobResult.rows[0];

      // Assign job to printer
      await client.query(
        `UPDATE print_queue SET
          printer_id = $1,
          status = 'assigned',
          assigned_at = NOW(),
          updated_at = NOW()
         WHERE job_id = $2`,
        [printerId, job.job_id]
      );

      // Update print job status
      await client.query(
        `UPDATE print_jobs SET
          status = 'printing',
          started_printing_at = NOW()
         WHERE id = $1`,
        [job.job_id]
      );

      await client.query('COMMIT');

      // Generate pre-signed URL for document download
      const documentUrl = await storageService.getPresignedUrl(job.s3_key, 3600);

      const assignment: JobAssignment = {
        jobId: job.job_id,
        documentUrl,
        settings: {
          colorMode: job.color_mode,
          copies: job.copies,
          pageRange: job.page_range,
          customRange: job.custom_range,
          printSides: job.print_sides,
          paperSize: job.paper_size,
          orientation: job.orientation,
        },
        totalPages: job.total_pages,
        assignedAt: new Date(),
      };

      logger.info('Job assigned to printer', {
        jobId: job.job_id,
        printerId: params.printerId,
      });

      return assignment;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error polling queue', { error, params });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update job status from Raspberry Pi
   */
  async updateJobStatus(params: UpdateJobStatusParams): Promise<void> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      const now = new Date();

      // Update queue status
      const updates: string[] = ['status = $1', 'updated_at = NOW()'];
      const values: any[] = [params.status];
      let paramIndex = 2;

      if (params.status === 'printing') {
        updates.push(`started_at = $${paramIndex}`);
        values.push(now);
        paramIndex++;
      } else if (params.status === 'completed') {
        updates.push(`completed_at = $${paramIndex}`);
        values.push(now);
        paramIndex++;
      } else if (params.status === 'failed') {
        updates.push(`failed_at = $${paramIndex}`);
        values.push(now);
        paramIndex++;
        updates.push(`retry_count = retry_count + 1`);
        if (params.errorMessage) {
          updates.push(`error_message = $${paramIndex}`);
          values.push(params.errorMessage);
          paramIndex++;
        }
      }

      values.push(params.jobId);

      await client.query(
        `UPDATE print_queue SET ${updates.join(', ')}
         WHERE job_id = $${paramIndex}`,
        values
      );

      // Update print job status
      const jobUpdates: string[] = [];
      const jobValues: any[] = [];
      let jobParamIndex = 1;

      if (params.status === 'completed') {
        jobUpdates.push(`status = 'completed'`);
        jobUpdates.push(`completed_at = $${jobParamIndex}`);
        jobValues.push(now);
        jobParamIndex++;
      } else if (params.status === 'failed') {
        jobUpdates.push(`status = 'failed'`);
        if (params.errorMessage) {
          jobUpdates.push(`error_message = $${jobParamIndex}`);
          jobValues.push(params.errorMessage);
          jobParamIndex++;
        }
      }

      if (params.printedPages !== undefined) {
        jobUpdates.push(`printed_pages = $${jobParamIndex}`);
        jobValues.push(params.printedPages);
        jobParamIndex++;
      }

      if (jobUpdates.length > 0) {
        jobValues.push(params.jobId);
        await client.query(
          `UPDATE print_jobs SET ${jobUpdates.join(', ')}
           WHERE id = $${jobParamIndex}`,
          jobValues
        );
      }

      // If failed and can retry, requeue
      if (params.status === 'failed') {
        const queueResult = await client.query(
          `SELECT retry_count, max_retries FROM print_queue WHERE job_id = $1`,
          [params.jobId]
        );

        if (queueResult.rows.length > 0) {
          const { retry_count, max_retries } = queueResult.rows[0];
          if (retry_count < max_retries) {
            await client.query(
              `UPDATE print_queue SET
                status = 'queued',
                printer_id = NULL,
                assigned_at = NULL,
                started_at = NULL,
                updated_at = NOW()
               WHERE job_id = $1`,
              [params.jobId]
            );
            logger.info('Job requeued for retry', {
              jobId: params.jobId,
              retryCount: retry_count + 1,
            });
          }
        }
      }

      await client.query('COMMIT');

      logger.info('Job status updated', {
        jobId: params.jobId,
        status: params.status,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating job status', { error, params });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get specific job status (for frontend polling)
   */
  async getJobStatus(jobId: string): Promise<{
    jobId: string;
    status: string;
    printedPages?: number;
    errorMessage?: string;
    startedAt?: Date;
    completedAt?: Date;
    failedAt?: Date;
  }> {
    try {
      const result = await this.database.query(
        `SELECT
          job_id, status, error_message,
          started_at, completed_at, failed_at
         FROM print_queue
         WHERE job_id = $1`,
        [jobId]
      );

      if (result.rows.length === 0) {
        throw new AppError('Job not found', 404);
      }

      const row = result.rows[0];
      return {
        jobId: row.job_id,
        status: row.status,
        errorMessage: row.error_message,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        failedAt: row.failed_at,
      };
    } catch (error: any) {
      // Fallback: if print_queue table doesn't exist or has missing columns, query print_jobs directly
      if (
        error.message?.includes('print_queue') ||
        error.message?.includes('does not exist') ||
        error.code === '42P01' ||
        error.code === '42703'
      ) {
        logger.warn('print_queue unavailable, using print_jobs fallback', {
          jobId,
          error: error.message,
        });

        const result = await this.database.query(
          `SELECT id, status, error_message FROM print_jobs WHERE id = $1`,
          [jobId]
        );

        if (result.rows.length === 0) {
          throw new AppError('Job not found', 404);
        }

        const row = result.rows[0];
        return {
          jobId: row.id,
          status: row.status,
          errorMessage: row.error_message,
        };
      }
      throw error;
    }
  }

  /**
   * Get queue status
   */
  async getQueueStatus(): Promise<{
    queued: number;
    assigned: number;
    printing: number;
    completed: number;
    failed: number;
  }> {
    const result = await this.database.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'queued') as queued,
        COUNT(*) FILTER (WHERE status = 'assigned') as assigned,
        COUNT(*) FILTER (WHERE status = 'printing') as printing,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed
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

  /**
   * Get all registered printers
   */
  async getPrinters(kioskId?: string): Promise<Printer[]> {
    const query = kioskId
      ? `SELECT * FROM printers WHERE kiosk_id = $1 ORDER BY name`
      : `SELECT * FROM printers ORDER BY name`;
    const params = kioskId ? [kioskId] : [];

    const result = await this.database.query(query, params);
    return result.rows.map((row) => this.mapRowToPrinter(row));
  }

  /**
   * Map database row to Printer object
   */
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
