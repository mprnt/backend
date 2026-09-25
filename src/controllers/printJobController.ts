import { Request, Response } from 'express';
import { PrintJobService } from '../services/printJobService';
import { db } from '../config/database';
import { AppError } from '../utils/errors';
import { PrintSettings } from '../types/printJob';
import logger from '../utils/logger';

class PrintJobController {
  private printJobService: PrintJobService;

  constructor() {
    this.printJobService = new PrintJobService(db);
  }

  /**
   * POST /api/v1/sessions/:sessionId/print-jobs
   * Create a new print job
   */
  async createPrintJob(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const settings: PrintSettings = req.body;

    logger.info('Creating print job', { sessionId, settings });

    // Get document and kiosk from session
    const sessionResult = await db.query(
      `SELECT ps.id AS session_id, ps.kiosk_id, d.id AS document_id
       FROM print_sessions ps
       LEFT JOIN documents d ON d.session_id = ps.id
       WHERE ps.session_id = $1
       ORDER BY d.uploaded_at DESC NULLS LAST
       LIMIT 1`,
      [sessionId]
    );

    if (sessionResult.rows.length === 0) {
      throw new AppError('Session not found', 404);
    }

    const { session_id, document_id, kiosk_id } = sessionResult.rows[0];

    if (!document_id) {
      throw new AppError('No document uploaded for this session', 400);
    }

    const { job, pricing } = await this.printJobService.createPrintJob({
      sessionId: session_id,
      documentId: document_id,
      kioskId: kiosk_id,
      settings,
    });

    res.status(201).json({
      status: 'success',
      message: 'Print job created successfully',
      data: {
        jobId: job.id,
        sessionId: job.sessionId,
        documentId: job.documentId,
        kioskId: job.kioskId,
        settings: {
          colorMode: job.colorMode,
          copies: job.copies,
          pageRange: job.pageRange,
          customRange: job.customRange,
          printSides: job.printSides,
          paperSize: job.paperSize,
          orientation: job.orientation,
        },
        pricing: {
          pricePerPage: pricing.pricePerPage,
          logicalPages: pricing.logicalPages,
          physicalPages: pricing.physicalPages,
          totalPages: pricing.totalPages,
          totalAmount: pricing.totalAmount,
          breakdown: pricing.breakdown,
        },
        status: job.status,
        createdAt: job.createdAt,
      },
    });
  }

  /**
   * GET /api/v1/print-jobs/:jobId
   * Get print job details
   */
  async getPrintJob(req: Request, res: Response): Promise<void> {
    const { jobId } = req.params;

    logger.info('Getting print job', { jobId });

    const job = await this.printJobService.getPrintJob(jobId);

    if (!job) {
      throw new AppError('Print job not found', 404);
    }

    res.json({
      status: 'success',
      data: {
        jobId: job.id,
        sessionId: job.sessionId,
        documentId: job.documentId,
        kioskId: job.kioskId,
        settings: {
          colorMode: job.colorMode,
          copies: job.copies,
          pageRange: job.pageRange,
          customRange: job.customRange,
          printSides: job.printSides,
          paperSize: job.paperSize,
          orientation: job.orientation,
        },
        pricing: {
          pricePerPage: job.basePricePerPage,
          totalPages: job.totalPages,
          totalAmount: job.totalAmount,
        },
        status: job.status,
        errorMessage: job.errorMessage,
        retryCount: job.retryCount,
        timestamps: {
          createdAt: job.createdAt,
          queuedAt: job.queuedAt,
          startedPrintingAt: job.startedPrintingAt,
          completedAt: job.completedAt,
        },
        progress: {
          printedPages: job.printedPages,
          printDurationSeconds: job.printDurationSeconds,
        },
      },
    });
  }

  /**
   * GET /api/v1/sessions/:sessionId/print-jobs
   * Get all print jobs for a session
   */
  async getSessionJobs(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;

    logger.info('Getting session print jobs', { sessionId });

    const jobs = await this.printJobService.getSessionJobs(sessionId);

    res.json({
      status: 'success',
      data: {
        sessionId,
        count: jobs.length,
        jobs: jobs.map((job) => ({
          jobId: job.id,
          settings: {
            colorMode: job.colorMode,
            copies: job.copies,
            pageRange: job.pageRange,
            customRange: job.customRange,
            printSides: job.printSides,
            paperSize: job.paperSize,
            orientation: job.orientation,
          },
          pricing: {
            pricePerPage: job.basePricePerPage,
            totalPages: job.totalPages,
            totalAmount: job.totalAmount,
          },
          status: job.status,
          createdAt: job.createdAt,
        })),
      },
    });
  }

  /**
   * PATCH /api/v1/print-jobs/:jobId/settings
   * Update print job settings
   */
  async updateSettings(req: Request, res: Response): Promise<void> {
    const { jobId } = req.params;
    const settings: Partial<PrintSettings> = req.body;

    logger.info('Updating print job settings', { jobId, settings });

    const { job, pricing } = await this.printJobService.updateSettings({
      jobId,
      settings,
    });

    res.json({
      status: 'success',
      message: 'Print job settings updated successfully',
      data: {
        jobId: job.id,
        settings: {
          colorMode: job.colorMode,
          copies: job.copies,
          pageRange: job.pageRange,
          customRange: job.customRange,
          printSides: job.printSides,
          paperSize: job.paperSize,
          orientation: job.orientation,
        },
        pricing: {
          pricePerPage: pricing.pricePerPage,
          logicalPages: pricing.logicalPages,
          physicalPages: pricing.physicalPages,
          totalPages: pricing.totalPages,
          totalAmount: pricing.totalAmount,
          breakdown: pricing.breakdown,
        },
        status: job.status,
        updatedAt: new Date().toISOString(),
      },
    });
  }
}

export const printJobController = new PrintJobController();
