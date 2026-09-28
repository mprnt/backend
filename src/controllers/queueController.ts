import { Request, Response } from 'express';
import { queueService } from '../services/queueService';
import { printerAuthService } from '../services/printerAuthService';
import { AppError } from '../utils/errors';
import { PrinterHeartbeat } from '../types/queue';
import logger from '../utils/logger';

class QueueController {
  /**
   * POST /api/v1/queue/printers/enroll
   *
   * One-time enrollment. Guarded by the provisioning token. Creates the printer
   * and returns its API key — the only time the plaintext key is ever exposed.
   */
  async enrollPrinter(req: Request, res: Response): Promise<void> {
    const { printerId, kioskId, name, capabilities, ipAddress } = req.body;

    const printer = await queueService.registerPrinter({
      printerId,
      kioskId,
      name,
      capabilities,
      ipAddress,
    });

    const issued = await printerAuthService.issueApiKeyIfAbsent(printer.id);

    if (!issued) {
      throw new AppError(
        'This printer is already enrolled. Rotate its key instead of re-enrolling.',
        409
      );
    }

    logger.info('Printer enrolled', { printerId, kioskId, ip: req.ip });

    res.status(201).json({
      status: 'success',
      message: 'Printer enrolled. Store this API key now — it will not be shown again.',
      data: {
        printerId: issued.printerId,
        apiKey: issued.apiKey,
        keyPrefix: issued.prefix,
        issuedAt: issued.issuedAt,
        kioskId: printer.kioskId,
        capabilities: printer.capabilities,
      },
    });
  }

  /**
   * POST /api/v1/queue/printers/register
   *
   * Re-registration by an already-enrolled printer: refreshes capabilities, name
   * and IP on boot. Authenticated with the printer's own key.
   */
  async registerPrinter(req: Request, res: Response): Promise<void> {
    const printer = req.printer!;
    const { name, capabilities, ipAddress } = req.body;

    const updated = await queueService.registerPrinter({
      printerId: printer.printerId,
      kioskId: printer.kioskId,
      name: name ?? printer.name,
      capabilities,
      ipAddress: ipAddress ?? req.ip,
    });

    await printerAuthService.recordSeen(printer.id, req.ip);

    res.status(200).json({
      status: 'success',
      message: 'Printer registration refreshed',
      data: {
        printerId: updated.printerId,
        name: updated.name,
        status: updated.status,
        kioskId: updated.kioskId,
        capabilities: updated.capabilities,
      },
    });
  }

  /**
   * POST /api/v1/queue/heartbeat
   */
  async updateHeartbeat(req: Request, res: Response): Promise<void> {
    const printer = req.printer!;

    // printerId comes from the credentials, never from the body, so one printer
    // cannot report health on another's behalf.
    const heartbeat: PrinterHeartbeat = {
      ...req.body,
      printerId: printer.printerId,
    };

    await queueService.updateHeartbeat(heartbeat);

    const pendingJobs = await queueService.getPendingJobsCount(printer.id);

    res.json({
      status: 'success',
      message: 'Heartbeat received',
      data: {
        serverTime: new Date().toISOString(),
        pendingJobs,
      },
    });
  }

  /**
   * POST /api/v1/queue/poll
   * Claim the next print job.
   */
  async pollQueue(req: Request, res: Response): Promise<void> {
    const printer = req.printer!;

    const assignment = await queueService.pollQueue({
      printerId: printer.printerId,
      printerUuid: printer.id,
      capabilities: req.body.capabilities,
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
   * POST /api/v1/queue/jobs/:jobId/status
   * Report progress or completion for a held job.
   */
  async updateJobStatus(req: Request, res: Response): Promise<void> {
    const printer = req.printer!;
    const { jobId } = req.params;
    const { status, errorMessage, errorCode, printedPages } = req.body;

    const result = await queueService.updateJobStatus({
      jobId,
      status,
      errorMessage,
      errorCode,
      printedPages,
      printerUuid: printer.id,
    });

    res.json({
      status: 'success',
      message: result.applied
        ? 'Job status updated'
        : 'Job already in a terminal state; update ignored',
      data: {
        jobId,
        status: result.status,
        applied: result.applied,
      },
    });
  }

  /**
   * GET /api/v1/queue/jobs/:jobId
   * Job status for the kiosk frontend to poll.
   */
  async getJobStatus(req: Request, res: Response): Promise<void> {
    const { jobId } = req.params;

    const job = await queueService.getJobStatus(jobId);

    res.json({
      status: 'success',
      data: job,
    });
  }

  /**
   * GET /api/v1/queue/status
   * Queue statistics (admin).
   */
  async getQueueStatus(_req: Request, res: Response): Promise<void> {
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
   * Registered printers (admin).
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

  /**
   * POST /api/v1/queue/printers/:printerId/rotate-key (admin)
   */
  async rotateKey(req: Request, res: Response): Promise<void> {
    const { printerId } = req.params;

    const issued = await printerAuthService.rotateApiKey(printerId);

    if (!issued) {
      throw new AppError('Printer not found', 404);
    }

    res.json({
      status: 'success',
      message: 'API key rotated. The previous key is now invalid.',
      data: {
        printerId: issued.printerId,
        apiKey: issued.apiKey,
        keyPrefix: issued.prefix,
        issuedAt: issued.issuedAt,
      },
    });
  }

  /**
   * POST /api/v1/queue/printers/:printerId/revoke (admin)
   */
  async revokeKey(req: Request, res: Response): Promise<void> {
    const { printerId } = req.params;

    const revoked = await printerAuthService.revoke(printerId);

    if (!revoked) {
      throw new AppError('Printer not found or already revoked', 404);
    }

    res.json({
      status: 'success',
      message: 'Printer credentials revoked',
      data: { printerId },
    });
  }
}

export const queueController = new QueueController();
