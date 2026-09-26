import { Request, Response } from 'express';
import { queueService } from '../services/queueService';
// import { AppError } from '../utils/errors';
import { /* PrinterCapabilities, */ PrinterHeartbeat } from '../types/queue';
import logger from '../utils/logger';

class QueueController {
  /**
   * POST /api/v1/queue/printers/register
   * Register a printer (Raspberry Pi)
   */
  async registerPrinter(req: Request, res: Response): Promise<void> {
    const { printerId, kioskId, name, capabilities, ipAddress } = req.body;

    logger.info('Registering printer', { printerId, kioskId });

    const printer = await queueService.registerPrinter({
      printerId,
      kioskId,
      name,
      capabilities,
      ipAddress,
    });

    res.status(201).json({
      status: 'success',
      message: 'Printer registered successfully',
      data: {
        printerId: printer.printerId,
        name: printer.name,
        status: printer.status,
        capabilities: printer.capabilities,
        registeredAt: printer.createdAt,
      },
    });
  }

  /**
   * POST /api/v1/queue/heartbeat
   * Update printer heartbeat
   */
  async updateHeartbeat(req: Request, res: Response): Promise<void> {
    const heartbeat: PrinterHeartbeat = req.body;

    await queueService.updateHeartbeat(heartbeat);

    res.json({
      status: 'success',
      message: 'Heartbeat updated',
    });
  }

  /**
   * POST /api/v1/queue/poll
   * Poll for next print job (called by Raspberry Pi)
   */
  async pollQueue(req: Request, res: Response): Promise<void> {
    const { printerId, capabilities } = req.body;

    logger.debug('Polling queue', { printerId });

    const assignment = await queueService.pollQueue({
      printerId,
      capabilities,
    });

    if (!assignment) {
      res.json({
        status: 'success',
        message: 'No jobs available',
        data: null,
      });
      return;
    }

    res.json({
      status: 'success',
      message: 'Job assigned',
      data: assignment,
    });
  }

  /**
   * GET /api/v1/queue/jobs/:jobId
   * Get specific job status (for frontend to poll)
   */
  async getJobStatus(req: Request, res: Response): Promise<void> {
    const { jobId } = req.params;

    logger.info('Getting job status', { jobId });

    const job = await queueService.getJobStatus(jobId);

    res.json({
      status: 'success',
      data: job,
    });
  }

  /**
   * POST /api/v1/queue/jobs/:jobId/status
   * Update job status from Raspberry Pi
   */
  async updateJobStatus(req: Request, res: Response): Promise<void> {
    const { jobId } = req.params;
    const { status, errorMessage, printedPages } = req.body;

    logger.info('Updating job status', { jobId, status });

    await queueService.updateJobStatus({
      jobId,
      status,
      errorMessage,
      printedPages,
    });

    res.json({
      status: 'success',
      message: 'Job status updated',
    });
  }

  /**
   * GET /api/v1/queue/status
   * Get queue statistics
   */
  async getQueueStatus(res: Response): Promise<void> {
    const stats = await queueService.getQueueStatus();

    res.json({
      status: 'success',
      data: {
        queue: stats,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * GET /api/v1/queue/printers
   * Get all registered printers
   */
  async getPrinters(req: Request, res: Response): Promise<void> {
    const { kioskId } = req.query;

    const printers = await queueService.getPrinters(kioskId as string);

    res.json({
      status: 'success',
      data: {
        count: printers.length,
        printers: printers.map((p) => ({
          printerId: p.printerId,
          name: p.name,
          status: p.status,
          kioskId: p.kioskId,
          ipAddress: p.ipAddress,
          lastHeartbeat: p.lastHeartbeat,
          capabilities: p.capabilities,
        })),
      },
    });
  }
}

export const queueController = new QueueController();
