import { Router, Request, Response } from 'express';
import { printerService } from '../services/printerService';
import { jobAssignmentService } from '../services/jobAssignmentService';
import { queueService } from '../services/queueService';
import { websocketService } from '../services/websocketService';
import { asyncHandler } from '../utils/asyncHandler';
import logger from '../utils/logger';

const router = Router();

/**
 * @swagger
 * /printer/register:
 *   post:
 *     summary: Register a Raspberry Pi printer
 *     tags: [Printer API]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [printerId, kioskId, name, capabilities]
 *             properties:
 *               printerId:
 *                 type: string
 *               kioskId:
 *                 type: string
 *               name:
 *                 type: string
 *               ipAddress:
 *                 type: string
 *               capabilities:
 *                 type: object
 *     responses:
 *       201:
 *         description: Printer registered
 */
router.post(
  '/register',
  asyncHandler(async (req: Request, res: Response) => {
    const { printerId, kioskId, name, ipAddress, capabilities } = req.body;

    logger.info('Printer registration', { printerId, kioskId, name });

    const printer = await printerService.registerPrinter({
      printerId,
      kioskId,
      name,
      ipAddress,
      capabilities,
    });

    res.status(201).json({
      status: 'success',
      message: 'Printer registered successfully',
      data: printer,
    });
  })
);

/**
 * @swagger
 * /printer/heartbeat:
 *   post:
 *     summary: Send printer heartbeat
 *     tags: [Printer API]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [printerId]
 *             properties:
 *               printerId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Heartbeat received
 */
router.post(
  '/heartbeat',
  asyncHandler(async (req: Request, res: Response) => {
    const { printerId } = req.body;

    await printerService.updateHeartbeat(printerId);

    res.json({
      status: 'success',
      message: 'Heartbeat received',
    });
  })
);

/**
 * @swagger
 * /printer/next-job:
 *   get:
 *     summary: Get next print job for printer
 *     tags: [Printer API]
 *     parameters:
 *       - in: query
 *         name: printerId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Next job or null if none available
 */
router.get(
  '/next-job',
  asyncHandler(async (req: Request, res: Response) => {
    const { printerId } = req.query;

    if (!printerId) {
      res.status(400).json({ status: 'error', message: 'printerId required' });
      return;
    }

    logger.debug('Printer polling for next job', { printerId });

    const job = await jobAssignmentService.getNextJobForPrinter(printerId as string);

    res.json({
      status: 'success',
      data: job,
    });
  })
);

/**
 * @swagger
 * /printer/job-status:
 *   post:
 *     summary: Update job status from printer
 *     tags: [Printer API]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [jobId, status]
 *             properties:
 *               jobId:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [printing, completed, failed]
 *               printedPages:
 *                 type: integer
 *               errorMessage:
 *                 type: string
 *     responses:
 *       200:
 *         description: Status updated
 */
router.post(
  '/job-status',
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId, status, printedPages, errorMessage } = req.body;

    logger.info('Job status update from printer', { jobId, status });

    await queueService.updateJobStatus({
      jobId,
      status,
      printedPages,
      errorMessage,
    });

    // Broadcast update via WebSocket
    websocketService.broadcastJobStatus(jobId, status, {
      printedPages,
      errorMessage,
    });

    res.json({
      status: 'success',
      message: 'Job status updated',
    });
  })
);

/**
 * @swagger
 * /printer/stats:
 *   get:
 *     summary: Get printer stats
 *     tags: [Printer API]
 *     parameters:
 *       - in: query
 *         name: printerId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Printer statistics
 */
router.get(
  '/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const { printerId } = req.query;

    if (!printerId) {
      res.status(400).json({ status: 'error', message: 'printerId required' });
      return;
    }

    const pendingJobs = await jobAssignmentService.getPendingJobsCount(printerId as string);
    const printer = await printerService.getPrinter(printerId as string);

    res.json({
      status: 'success',
      data: {
        printerId: printer.printerId,
        status: printer.status,
        pendingJobs,
        capabilities: printer.capabilities,
      },
    });
  })
);

export default router;
