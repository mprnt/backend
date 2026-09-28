import { v4 as uuidv4 } from 'uuid';
import { Database, db } from '../config/database';
import { AppError } from '../utils/errors';
import {
  PrintJob,
  PrintSettings,
  CreatePrintJobParams,
  UpdatePrintJobSettingsParams,
  PricingResult,
} from '../types/printJob';
import { pricingService } from './pricingService';
import logger from '../utils/logger';

export class PrintJobService {
  constructor(private database: Database = db) {}

  /**
   * Create a new print job
   */
  async createPrintJob(params: CreatePrintJobParams): Promise<{
    job: PrintJob;
    pricing: PricingResult;
  }> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      // 1. Verify session exists and is active
      const sessionResult = await client.query(
        `SELECT id, status, expires_at FROM print_sessions WHERE id = $1`,
        [params.sessionId]
      );

      if (sessionResult.rows.length === 0) {
        throw new AppError('Session not found', 404);
      }

      const session = sessionResult.rows[0];

      if (['complete', 'error', 'expired'].includes(session.status)) {
        throw new AppError(
          `Cannot create print job for session with status: ${session.status}`,
          400
        );
      }

      if (new Date(session.expires_at) < new Date()) {
        throw new AppError('Session has expired', 400);
      }

      // 2. Verify document exists and is processed
      const documentResult = await client.query(
        `SELECT id, page_count, processed FROM documents WHERE id = $1`,
        [params.documentId]
      );

      if (documentResult.rows.length === 0) {
        throw new AppError('Document not found', 404);
      }

      const document = documentResult.rows[0];

      if (!document.processed || document.page_count === null) {
        throw new AppError(
          'Document is still processing. Please try again once processing is complete.',
          400
        );
      }

      // 3. Check if print job already exists for this session
      const existingJobResult = await client.query(
        `SELECT id FROM print_jobs WHERE session_id = $1`,
        [params.sessionId]
      );

      if (existingJobResult.rows.length > 0) {
        throw new AppError(
          'Print job already created for this session. Use update endpoint to modify settings.',
          400
        );
      }

      // 4. Calculate pricing
      const pricing = await pricingService.calculatePrice(
        params.settings,
        document.page_count,
        params.kioskId
      );

      // 5. Create print job
      const jobId = uuidv4();
      const insertResult = await client.query(
        `INSERT INTO print_jobs (
          id,
          session_id,
          document_id,
          kiosk_id,
          color_mode,
          page_range,
          custom_range,
          copies,
          orientation,
          paper_size,
          print_sides,
          base_price_per_page,
          total_pages,
          total_amount,
          status,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
        RETURNING *`,
        [
          jobId,
          params.sessionId,
          params.documentId,
          params.kioskId,
          params.settings.colorMode,
          params.settings.pageRange,
          params.settings.customRange || null,
          params.settings.copies,
          params.settings.orientation,
          params.settings.paperSize,
          params.settings.printSides,
          pricing.pricePerPage,
          pricing.totalPages,
          pricing.totalAmount,
          'pending',
        ]
      );

      await client.query('COMMIT');

      const job = this.mapRowToPrintJob(insertResult.rows[0]);

      logger.info('Print job created', {
        jobId: job.id,
        sessionId: params.sessionId,
        totalAmount: pricing.totalAmount,
      });

      return { job, pricing };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating print job', { error, params });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get print job by ID
   */
  async getPrintJob(jobId: string): Promise<PrintJob | null> {
    const result = await this.database.query(`SELECT * FROM print_jobs WHERE id = $1`, [jobId]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToPrintJob(result.rows[0]);
  }

  /**
   * Get all print jobs for a session
   */
  async getSessionJobs(sessionId: string): Promise<PrintJob[]> {
    const result = await this.database.query(
      `SELECT pj.*
       FROM print_jobs pj
       JOIN print_sessions ps ON pj.session_id = ps.id
       WHERE ps.session_id = $1
       ORDER BY pj.created_at DESC`,
      [sessionId]
    );

    return result.rows.map((row) => this.mapRowToPrintJob(row));
  }

  /**
   * Update print job settings and recalculate pricing
   */
  async updateSettings(params: UpdatePrintJobSettingsParams): Promise<{
    job: PrintJob;
    pricing: PricingResult;
  }> {
    const client = await this.database.getClient();

    try {
      await client.query('BEGIN');

      // 1. Get existing job
      const jobResult = await client.query(
        `SELECT pj.*, d.page_count
         FROM print_jobs pj
         JOIN documents d ON pj.document_id = d.id
         WHERE pj.id = $1`,
        [params.jobId]
      );

      if (jobResult.rows.length === 0) {
        throw new AppError('Print job not found', 404);
      }

      const existingJob = jobResult.rows[0];

      // 2. Check if job can be updated (must be in pending status)
      if (existingJob.status !== 'pending') {
        throw new AppError(
          `Cannot update print job with status: ${existingJob.status}. Only pending jobs can be updated.`,
          400
        );
      }

      // 3. Merge settings
      const currentSettings: PrintSettings = {
        colorMode: existingJob.color_mode,
        copies: existingJob.copies,
        pageRange: existingJob.page_range,
        customRange: existingJob.custom_range,
        printSides: existingJob.print_sides,
        paperSize: existingJob.paper_size,
        orientation: existingJob.orientation,
      };

      const newSettings: PrintSettings = {
        ...currentSettings,
        ...params.settings,
      };

      // 4. Recalculate pricing
      const pricing = await pricingService.calculatePrice(
        newSettings,
        existingJob.page_count,
        existingJob.kiosk_id
      );

      // 5. Update job
      const updateResult = await client.query(
        `UPDATE print_jobs SET
          color_mode = $1,
          page_range = $2,
          custom_range = $3,
          copies = $4,
          orientation = $5,
          paper_size = $6,
          print_sides = $7,
          base_price_per_page = $8,
          total_pages = $9,
          total_amount = $10
         WHERE id = $11
         RETURNING *`,
        [
          newSettings.colorMode,
          newSettings.pageRange,
          newSettings.customRange || null,
          newSettings.copies,
          newSettings.orientation,
          newSettings.paperSize,
          newSettings.printSides,
          pricing.pricePerPage,
          pricing.totalPages,
          pricing.totalAmount,
          params.jobId,
        ]
      );

      await client.query('COMMIT');

      const job = this.mapRowToPrintJob(updateResult.rows[0]);

      logger.info('Print job settings updated', {
        jobId: params.jobId,
        updates: params.settings,
        newTotalAmount: pricing.totalAmount,
      });

      return { job, pricing };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating print job settings', { error, params });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update print job status
   */
  async updateStatus(jobId: string, status: string, errorMessage?: string): Promise<PrintJob> {
    const updates: string[] = ['status = $1'];
    const values: any[] = [status];
    let paramIndex = 2;

    // Add timestamp based on status
    if (status === 'queued') {
      updates.push(`queued_at = NOW()`);
    } else if (status === 'printing') {
      updates.push(`started_printing_at = NOW()`);
    } else if (status === 'completed' || status === 'failed') {
      updates.push(`completed_at = NOW()`);
    }

    // Add error message if provided
    if (errorMessage) {
      updates.push(`error_message = $${paramIndex}`);
      values.push(errorMessage);
      paramIndex++;
    }

    const query = `
      UPDATE print_jobs SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;
    values.push(jobId);

    const result = await this.database.query(query, values);

    if (result.rows.length === 0) {
      throw new AppError('Print job not found', 404);
    }

    logger.info('Print job status updated', {
      jobId,
      status,
      errorMessage,
    });

    return this.mapRowToPrintJob(result.rows[0]);
  }

  /**
   * Map database row to PrintJob object
   */
  private mapRowToPrintJob(row: any): PrintJob {
    return {
      id: row.id,
      sessionId: row.session_id,
      documentId: row.document_id,
      kioskId: row.kiosk_id,
      colorMode: row.color_mode,
      pageRange: row.page_range,
      customRange: row.custom_range,
      copies: row.copies,
      orientation: row.orientation,
      paperSize: row.paper_size,
      printSides: row.print_sides,
      basePricePerPage: parseFloat(row.base_price_per_page),
      totalPages: row.total_pages,
      totalAmount: parseFloat(row.total_amount),
      status: row.status,
      errorMessage: row.error_message,
      retryCount: row.retry_count || 0,
      createdAt: row.created_at,
      queuedAt: row.queued_at,
      startedPrintingAt: row.started_printing_at,
      completedAt: row.completed_at,
      printedPages: row.printed_pages || 0,
      printDurationSeconds: row.print_duration_seconds,
    };
  }
}
