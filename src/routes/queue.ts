import { Router } from 'express';
import { queueController } from '../controllers/queueController';
import { validate } from '../middleware/validate';
import { authenticatePrinter, requireProvisioningToken } from '../middleware/printerAuth';
import { printerRateLimiter, printerEnrollRateLimiter } from '../middleware/rateLimiter';
import { asyncHandler } from '../utils/asyncHandler';
import {
  enrollPrinterSchema,
  registerPrinterSchema,
  heartbeatSchema,
  pollQueueSchema,
  updateJobStatusSchema,
  jobIdParamSchema,
} from '../validators/queueValidator';

const router = Router();

/**
 * Raspberry Pi API.
 *
 * Every endpoint below except /printers/enroll requires the printer's own
 * credentials:
 *   X-Printer-Id:  RPI_M001_01
 *   X-Printer-Key: mprnt_pk_...
 *
 * Enrollment instead requires the deployment-wide X-Provisioning-Token, and is
 * the only way to obtain a printer key.
 */

/**
 * @swagger
 * /queue/printers/enroll:
 *   post:
 *     summary: Enroll a Raspberry Pi and receive its API key (one time)
 *     description: |
 *       Requires the `X-Provisioning-Token` header. Returns the printer's API key
 *       in plaintext exactly once — it is stored only as a SHA-256 digest and
 *       cannot be recovered. Re-enrolling an existing printer returns 409; use
 *       the admin rotate endpoint instead.
 *     tags: [Printer API]
 *     parameters:
 *       - in: header
 *         name: X-Provisioning-Token
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [printerId, kioskId, name, capabilities]
 *             properties:
 *               printerId: { type: string, example: RPI_M001_01 }
 *               kioskId:   { type: string, format: uuid }
 *               name:      { type: string, example: "Kiosk M001 - Printer A" }
 *               ipAddress: { type: string, example: 192.168.1.50 }
 *               capabilities:
 *                 type: object
 *                 required: [supportsColor, supportsDoubleSided, maxCopies, supportedPaperSizes]
 *     responses:
 *       201: { description: Enrolled; response contains the one-time API key }
 *       409: { description: Printer already enrolled }
 */
router.post(
  '/printers/enroll',
  printerEnrollRateLimiter,
  requireProvisioningToken,
  validate(enrollPrinterSchema, 'body'),
  asyncHandler(queueController.enrollPrinter.bind(queueController))
);

/**
 * @swagger
 * /queue/printers/register:
 *   post:
 *     summary: Refresh this printer's registration on boot
 *     tags: [Printer API]
 *     responses:
 *       200: { description: Registration refreshed }
 */
router.post(
  '/printers/register',
  printerRateLimiter,
  asyncHandler(authenticatePrinter),
  validate(registerPrinterSchema, 'body'),
  asyncHandler(queueController.registerPrinter.bind(queueController))
);

/**
 * @swagger
 * /queue/heartbeat:
 *   post:
 *     summary: Report printer health
 *     description: Send every 30 seconds. Missing heartbeats for longer than
 *       PRINTER_HEARTBEAT_TIMEOUT_SECONDS marks the printer offline.
 *     tags: [Printer API]
 *     responses:
 *       200: { description: Heartbeat recorded }
 */
router.post(
  '/heartbeat',
  printerRateLimiter,
  asyncHandler(authenticatePrinter),
  validate(heartbeatSchema, 'body'),
  asyncHandler(queueController.updateHeartbeat.bind(queueController))
);

/**
 * @swagger
 * /queue/poll:
 *   post:
 *     summary: Claim the next print job
 *     description: |
 *       Returns `data: null` when there is nothing to print. A returned job is
 *       claimed exclusively by this printer under a lease; finish and report
 *       before `leaseExpiresAt` or the job is requeued for another printer.
 *
 *       If the printer already holds a job (e.g. it restarted), the same job is
 *       returned again with a fresh `documentUrl` rather than a new one.
 *     tags: [Printer API]
 *     responses:
 *       200: { description: A job assignment, or null }
 */
router.post(
  '/poll',
  printerRateLimiter,
  asyncHandler(authenticatePrinter),
  validate(pollQueueSchema, 'body'),
  asyncHandler(queueController.pollQueue.bind(queueController))
);

/**
 * @swagger
 * /queue/jobs/{jobId}/status:
 *   post:
 *     summary: Report progress or the outcome of a held job
 *     description: |
 *       Allowed values: `printing`, `completed`, `failed`, `cancelled`.
 *       `errorCode` is required when reporting `failed`.
 *
 *       The call is idempotent: repeating a terminal update returns 200 with
 *       `applied: false`, so the Pi can retry safely after a network failure.
 *     tags: [Printer API]
 *     responses:
 *       200: { description: Status recorded }
 *       403: { description: Job is not assigned to this printer }
 */
router.post(
  '/jobs/:jobId/status',
  printerRateLimiter,
  asyncHandler(authenticatePrinter),
  validate(jobIdParamSchema, 'params'),
  validate(updateJobStatusSchema, 'body'),
  asyncHandler(queueController.updateJobStatus.bind(queueController))
);

/**
 * @swagger
 * /queue/jobs/{jobId}:
 *   get:
 *     summary: Get job status (kiosk frontend polling)
 *     tags: [Print Queue]
 *     responses:
 *       200: { description: Job status }
 */
router.get(
  '/jobs/:jobId',
  validate(jobIdParamSchema, 'params'),
  asyncHandler(queueController.getJobStatus.bind(queueController))
);

// Fleet administration (queue statistics, printer listing, key rotation and
// revocation) lives under /api/v1/admin, behind admin authentication.
//
// It used to be here, guarded by the legacy `authorize('admin', 'operator')`.
// No admin token carries either role — the roles are super_admin, owner,
// manager and viewer — so those endpoints were unreachable by anyone.

export default router;
