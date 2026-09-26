import { Router } from 'express';
import { queueController } from '../controllers/queueController';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  registerPrinterSchema,
  heartbeatSchema,
  pollQueueSchema,
  updateJobStatusSchema,
} from '../validators/queueValidator';

const router = Router();

/**
 * @swagger
 * /queue/printers/register:
 *   post:
 *     summary: Register a printer (Raspberry Pi)
 *     description: Register or update a Raspberry Pi printer device with the system
 *     tags: [Print Queue]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - printerId
 *               - kioskId
 *               - name
 *               - capabilities
 *             properties:
 *               printerId:
 *                 type: string
 *                 example: RPI_001
 *               kioskId:
 *                 type: string
 *                 format: uuid
 *               name:
 *                 type: string
 *                 example: Kiosk 1 - Printer A
 *               capabilities:
 *                 type: object
 *                 properties:
 *                   supportsColor:
 *                     type: boolean
 *                     default: false
 *                   supportsDoubleSided:
 *                     type: boolean
 *                     default: false
 *                   maxCopies:
 *                     type: integer
 *                     default: 100
 *                   supportedPaperSizes:
 *                     type: array
 *                     items:
 *                       type: string
 *                     default: ["a4"]
 *               ipAddress:
 *                 type: string
 *                 example: 192.168.1.100
 *     responses:
 *       201:
 *         description: Printer registered successfully
 *       400:
 *         description: Validation error
 */
router.post(
  '/printers/register',
  validate(registerPrinterSchema, 'body'),
  asyncHandler(queueController.registerPrinter.bind(queueController))
);

/**
 * @swagger
 * /queue/heartbeat:
 *   post:
 *     summary: Update printer heartbeat
 *     description: Raspberry Pi sends regular status updates
 *     tags: [Print Queue]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - printerId
 *               - status
 *             properties:
 *               printerId:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [online, offline, busy, error, maintenance]
 *               currentJobId:
 *                 type: string
 *                 format: uuid
 *               errorMessage:
 *                 type: string
 *               paperLevel:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 100
 *               inkLevel:
 *                 type: object
 *                 properties:
 *                   black:
 *                     type: integer
 *                   color:
 *                     type: integer
 *     responses:
 *       200:
 *         description: Heartbeat updated
 */
router.post(
  '/heartbeat',
  validate(heartbeatSchema, 'body'),
  asyncHandler(queueController.updateHeartbeat.bind(queueController))
);

/**
 * @swagger
 * /queue/poll:
 *   post:
 *     summary: Poll for next print job
 *     description: |
 *       Raspberry Pi polls this endpoint to get the next print job.
 *
 *       **Workflow:**
 *       1. Raspberry Pi sends its capabilities
 *       2. Backend assigns next matching job
 *       3. Returns job details with document download URL
 *       4. Raspberry Pi downloads document and prints
 *       5. Raspberry Pi updates job status via /queue/jobs/:jobId/status
 *     tags: [Print Queue]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - printerId
 *               - capabilities
 *             properties:
 *               printerId:
 *                 type: string
 *                 example: RPI_001
 *               capabilities:
 *                 type: object
 *                 required:
 *                   - supportsColor
 *                   - supportsDoubleSided
 *                   - maxCopies
 *                   - supportedPaperSizes
 *                 properties:
 *                   supportsColor:
 *                     type: boolean
 *                   supportsDoubleSided:
 *                     type: boolean
 *                   maxCopies:
 *                     type: integer
 *                   supportedPaperSizes:
 *                     type: array
 *                     items:
 *                       type: string
 *     responses:
 *       200:
 *         description: Job assigned or no jobs available
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     jobId:
 *                       type: string
 *                       format: uuid
 *                     documentUrl:
 *                       type: string
 *                       format: uri
 *                       description: Pre-signed S3 URL to download PDF
 *                     settings:
 *                       type: object
 *                     totalPages:
 *                       type: integer
 *                     assignedAt:
 *                       type: string
 *                       format: date-time
 */
router.post(
  '/poll',
  validate(pollQueueSchema, 'body'),
  asyncHandler(queueController.pollQueue.bind(queueController))
);

/**
 * @swagger
 * /queue/jobs/{jobId}:
 *   get:
 *     summary: Get job status
 *     description: Get the current status of a print job (for frontend polling)
 *     tags: [Print Queue]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Job status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     jobId:
 *                       type: string
 *                     status:
 *                       type: string
 *                       enum: [queued, assigned, printing, completed, failed, cancelled]
 *                     printedPages:
 *                       type: integer
 *                     errorMessage:
 *                       type: string
 */
router.get(
  '/jobs/:jobId',
  asyncHandler(queueController.getJobStatus.bind(queueController))
);

/**
 * @swagger
 * /queue/jobs/{jobId}/status:
 *   post:
 *     summary: Update job status
 *     description: |
 *       Raspberry Pi updates job status during printing.
 *
 *       **Status Flow:**
 *       - `printing` - Job started printing
 *       - `completed` - Job finished successfully
 *       - `failed` - Job failed (will be retried if retries available)
 *     tags: [Print Queue]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [printing, completed, failed, cancelled]
 *               errorMessage:
 *                 type: string
 *               printedPages:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Status updated successfully
 */
router.post(
  '/jobs/:jobId/status',
  validate(updateJobStatusSchema, 'body'),
  asyncHandler(queueController.updateJobStatus.bind(queueController))
);

/**
 * @swagger
 * /queue/status:
 *   get:
 *     summary: Get queue statistics
 *     description: Get current print queue statistics (last 24 hours)
 *     tags: [Print Queue]
 *     responses:
 *       200:
 *         description: Queue statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     queue:
 *                       type: object
 *                       properties:
 *                         queued:
 *                           type: integer
 *                         assigned:
 *                           type: integer
 *                         printing:
 *                           type: integer
 *                         completed:
 *                           type: integer
 *                         failed:
 *                           type: integer
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 */
router.get(
  '/status',
  asyncHandler(queueController.getQueueStatus.bind(queueController))
);

/**
 * @swagger
 * /queue/printers:
 *   get:
 *     summary: Get all registered printers
 *     description: List all Raspberry Pi printers registered in the system
 *     tags: [Print Queue]
 *     parameters:
 *       - in: query
 *         name: kioskId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by kiosk ID
 *     responses:
 *       200:
 *         description: List of printers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     count:
 *                       type: integer
 *                     printers:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           printerId:
 *                             type: string
 *                           name:
 *                             type: string
 *                           status:
 *                             type: string
 *                           kioskId:
 *                             type: string
 *                           lastHeartbeat:
 *                             type: string
 *                             format: date-time
 *                           capabilities:
 *                             type: object
 */
router.get(
  '/printers',
  asyncHandler(queueController.getPrinters.bind(queueController))
);

export default router;
