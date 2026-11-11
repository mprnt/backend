import { Request, Response } from 'express';
import { ParamsDictionary } from 'express-serve-static-core';
import { queueService } from '../services/queueService';
import { printerAuthService } from '../services/printerAuthService';
import { fleetService } from '../services/fleetService';
import { physicalOutcomeService } from '../services/physicalOutcomeService';
import { AppError } from '../utils/errors';
import { auditService } from '../services/auditService';
import { PrinterCapabilities, PrinterHeartbeat, UpdateJobStatusParams } from '../types/queue';
import logger from '../utils/logger';

type RequestWithBody<Body> = Request<ParamsDictionary, unknown, Body>;

interface EnrollPrinterBody {
  printerId: string;
  kioskId: string;
  name: string;
  capabilities: PrinterCapabilities;
  ipAddress?: string;
}

interface RegisterPrinterBody {
  name?: string;
  capabilities: PrinterCapabilities;
  ipAddress?: string;
}

type HeartbeatBody = Omit<PrinterHeartbeat, 'printerId'>;

interface PollQueueBody {
  capabilities?: PrinterCapabilities;
}

type UpdateJobStatusBody = Pick<
  UpdateJobStatusParams,
  'status' | 'errorMessage' | 'errorCode' | 'printedPages' | 'attempt'
>;

interface JobEvidenceBody {
  attempt: number;
  outcome?: string;
  evidence: { cupsJobId: string; cupsState: string };
}

class QueueController {
  /**
   * POST /api/v1/queue/printers/enroll
   *
   * One-time enrollment. Guarded by the provisioning token. Creates the printer
   * and returns its API key — the only time the plaintext key is ever exposed.
   */
  async enrollPrinter(req: RequestWithBody<EnrollPrinterBody>, res: Response): Promise<void> {
    const { printerId, kioskId, name, capabilities, ipAddress } = req.body;

    // Shared with dashboard enrollment. Checks for an existing printer id before
    // writing anything, so a rejected re-enrollment no longer mutates the
    // printer it was rejected for.
    const issued = await fleetService.enrollPrinter({
      printerId,
      kioskUuid: kioskId,
      name,
      capabilities,
      ipAddress,
      enrolledByDevice: true,
    });

    await auditService.record({
      actorId: null,
      actorScope: 'platform',
      organizationId: issued.organizationId,
      action: 'printer.enrolled',
      resourceType: 'printer',
      details: { printerId, via: 'provisioning_token' },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    logger.info('Printer enrolled', { printerId, kioskId, ip: req.ip });

    res.status(201).json({
      status: 'success',
      message: 'Printer enrolled. Store this API key now — it will not be shown again.',
      data: {
        printerId: issued.printerId,
        apiKey: issued.apiKey,
        keyPrefix: issued.prefix,
        issuedAt: issued.issuedAt,
        kioskId,
        capabilities,
      },
    });
  }

  /**
   * POST /api/v1/queue/printers/register
   *
   * Re-registration by an already-enrolled printer: refreshes capabilities, name
   * and IP on boot. Authenticated with the printer's own key.
   */
  async registerPrinter(req: RequestWithBody<RegisterPrinterBody>, res: Response): Promise<void> {
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
  async updateHeartbeat(req: RequestWithBody<HeartbeatBody>, res: Response): Promise<void> {
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
  async pollQueue(req: RequestWithBody<PollQueueBody>, res: Response): Promise<void> {
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
  async updateJobStatus(req: RequestWithBody<UpdateJobStatusBody>, res: Response): Promise<void> {
    const printer = req.printer!;
    const { jobId } = req.params;
    const { status, errorMessage, errorCode, printedPages, attempt } = req.body;

    const result = await queueService.updateJobStatus({
      jobId,
      status,
      errorMessage,
      errorCode,
      printedPages,
      attempt,
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
        // True once this printer no longer holds the job: the Pi may then resume
        // unrelated work, after its own local physical-safety check.
        printerReleased: result.printerReleased,
      },
    });
  }

  /**
   * POST /api/v1/queue/jobs/:jobId/evidence
   * What CUPS reported for an attempt this printer held. Evidence only: it never
   * changes the physical outcome, and it never changes assignment release.
   */
  async recordEvidence(req: RequestWithBody<JobEvidenceBody>, res: Response): Promise<void> {
    const printer = req.printer!;
    const { jobId } = req.params;
    const { attempt, outcome, evidence } = req.body;

    if (outcome !== undefined && outcome !== 'unknown') {
      throw new AppError(
        'A printer cannot record the physical outcome. Send evidence only; an operator records the outcome.',
        400,
        'PHYSICAL_OUTCOME_NOT_PRINTER_SETTABLE'
      );
    }

    const result = await physicalOutcomeService.recordEvidence({
      jobId,
      printerUuid: printer.id,
      attempt,
      cupsJobId: evidence.cupsJobId,
      cupsState: evidence.cupsState,
    });

    res.json({
      status: 'success',
      message: result.applied ? 'Evidence recorded' : 'Evidence already recorded',
      data: {
        jobId,
        attempt,
        applied: result.applied,
        physicalOutcome: result.physicalOutcome,
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
}

export const queueController = new QueueController();
