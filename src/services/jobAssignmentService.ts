import { Database, db } from '../config/database';
import { AppError } from '../utils/errors';
import { printerService } from './printerService';
import logger from '../utils/logger';

export interface JobAssignment {
  jobId: string;
  printerId: string;
  assignedAt: Date;
}

export interface QueuedJob {
  jobId: string;
  printerId?: string;
  status: 'queued' | 'assigned' | 'printing' | 'completed' | 'failed';
  colorMode: 'bw' | 'color';
  doubleSided: boolean;
  totalPages: number;
  kioskId: string;
  createdAt: Date;
}

export class JobAssignmentService {
  constructor(private database: Database = db) {}

  /**
   * Assign a job to the best available printer
   */
  async assignJobToPrinter(jobId: string): Promise<JobAssignment | null> {
    // Get job details
    const jobResult = await this.database.query(
      `SELECT pj.id, pj.color_mode, pj.print_sides, pj.kiosk_id, pj.total_pages
       FROM print_jobs pj
       WHERE pj.id = $1`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      throw new AppError('Job not found', 404);
    }

    const job = jobResult.rows[0];
    const colorMode = job.color_mode === 'color' ? 'color' : 'bw';
    const doubleSided = job.print_sides === 'double';

    // Find available printers matching job requirements
    const availablePrinters = await printerService.findAvailablePrinters(
      job.kiosk_id,
      colorMode,
      doubleSided
    );

    if (availablePrinters.length === 0) {
      logger.warn('No available printers for job', { jobId, colorMode, doubleSided });
      return null;
    }

    // Simple assignment: pick the printer with least recent job
    const selectedPrinter = availablePrinters[0];

    // Update job with printer assignment
    await this.database.query(
      `UPDATE print_queue
       SET printer_id = $1, status = 'assigned', assigned_at = NOW(), updated_at = NOW()
       WHERE job_id = $2`,
      [selectedPrinter.id, jobId]
    );

    logger.info('Job assigned to printer', {
      jobId,
      printerId: selectedPrinter.printerId,
      printerName: selectedPrinter.name,
    });

    return {
      jobId,
      printerId: selectedPrinter.printerId,
      assignedAt: new Date(),
    };
  }

  /**
   * Get next job for a printer to print
   */
  async getNextJobForPrinter(printerId: string): Promise<QueuedJob | null> {
    // Get printer
    const printer = await printerService.getPrinter(printerId);

    // Get first assigned job for this printer
    const result = await this.database.query(
      `SELECT pq.id, pq.printer_id, pq.status, pj.color_mode, pj.print_sides, pj.total_pages, pj.kiosk_id, pq.created_at
       FROM print_queue pq
       JOIN print_jobs pj ON pq.job_id = pj.id
       WHERE pq.printer_id = $1
       AND pq.status IN ('assigned', 'printing')
       ORDER BY pq.created_at ASC
       LIMIT 1`,
      [printer.id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      jobId: row.id,
      printerId: row.printer_id,
      status: row.status,
      colorMode: row.color_mode === 'color' ? 'color' : 'bw',
      doubleSided: row.print_sides === 'double',
      totalPages: row.total_pages,
      kioskId: row.kiosk_id,
      createdAt: new Date(row.created_at),
    };
  }

  /**
   * Get pending jobs count for a printer
   */
  async getPendingJobsCount(printerId: string): Promise<number> {
    const printer = await printerService.getPrinter(printerId);

    const result = await this.database.query(
      `SELECT COUNT(*) as count FROM print_queue
       WHERE printer_id = $1
       AND status IN ('assigned', 'printing')`,
      [printer.id]
    );

    return parseInt(result.rows[0].count) || 0;
  }

  /**
   * Get all pending jobs in queue (unassigned)
   */
  async getPendingJobs(kioskId?: string): Promise<QueuedJob[]> {
    let query = `SELECT pq.job_id, pq.printer_id, pq.status, pj.color_mode, pj.print_sides, pj.total_pages, pj.kiosk_id, pq.created_at
                 FROM print_queue pq
                 JOIN print_jobs pj ON pq.job_id = pj.id
                 WHERE pq.status = 'queued'`;
    const params: any[] = [];

    if (kioskId) {
      query += ` AND pj.kiosk_id = $1`;
      params.push(kioskId);
    }

    query += ` ORDER BY pq.created_at ASC`;

    const result = await this.database.query(query, params);

    return result.rows.map((row) => ({
      jobId: row.job_id,
      printerId: row.printer_id,
      status: row.status,
      colorMode: row.color_mode === 'color' ? 'color' : 'bw',
      doubleSided: row.print_sides === 'double',
      totalPages: row.total_pages,
      kioskId: row.kiosk_id,
      createdAt: new Date(row.created_at),
    }));
  }

  /**
   * Try to assign all pending jobs
   */
  async assignPendingJobs(): Promise<number> {
    const pendingJobs = await this.getPendingJobs();
    let assigned = 0;

    for (const job of pendingJobs) {
      try {
        const result = await this.assignJobToPrinter(job.jobId);
        if (result) {
          assigned++;
        }
      } catch (error) {
        logger.error('Failed to assign job', { jobId: job.jobId, error });
      }
    }

    if (assigned > 0) {
      logger.info('Assigned pending jobs', { count: assigned });
    }

    return assigned;
  }
}

export const jobAssignmentService = new JobAssignmentService();
