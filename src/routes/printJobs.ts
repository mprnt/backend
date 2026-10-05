import { Router } from 'express';
import { printJobController } from '../controllers/printJobController';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { sessionTokenForJob, sessionTokenForSession } from '../middleware/sessionAuth';
import {
  createPrintJobSchema,
  updatePrintJobSettingsSchema,
  validateJobIdParam,
} from '../validators/printJobValidator';

/**
 * Two routers so each set of paths is mounted exactly once:
 *  - sessionPrintJobRoutes under /sessions  -> /sessions/:sessionId/print-jobs
 *  - router (default) under the API root   -> /print-jobs/:jobId[...]
 * Mounting one router at both prefixes used to create shadow paths such as
 * /sessions/print-jobs/:jobId and /:sessionId/print-jobs.
 */
export const sessionPrintJobRoutes = Router();
const router = Router();

/**
 * @swagger
 * /sessions/{sessionId}/print-jobs:
 *   post:
 *     summary: Create a print job
 *     description: Create a new print job with pricing calculation. Job status will be 'pending' until payment is completed.
 *     tags: [Print Jobs]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Session ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PrintSettings'
 *           examples:
 *             bw-single:
 *               summary: Black & White, Single-sided
 *               value:
 *                 colorMode: bw
 *                 copies: 1
 *                 pageRange: all
 *                 printSides: single
 *                 paperSize: a4
 *                 orientation: portrait
 *             color-double:
 *               summary: Color, Double-sided
 *               value:
 *                 colorMode: color
 *                 copies: 2
 *                 pageRange: all
 *                 printSides: double
 *                 paperSize: a4
 *                 orientation: portrait
 *             custom-range:
 *               summary: Custom Page Range
 *               value:
 *                 colorMode: bw
 *                 copies: 1
 *                 pageRange: custom
 *                 customRange: "1-5,8,10-12"
 *                 printSides: single
 *                 paperSize: a4
 *                 orientation: portrait
 *     responses:
 *       201:
 *         description: Print job created successfully with pricing
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Print job created successfully
 *                 data:
 *                   $ref: '#/components/schemas/PrintJob'
 *       400:
 *         description: Validation error or duplicate job
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               duplicate:
 *                 summary: Duplicate Job
 *                 value:
 *                   status: error
 *                   message: Print job already created for this session
 *               invalid-range:
 *                 summary: Invalid Page Range
 *                 value:
 *                   status: error
 *                   message: Page 15 exceeds document page count (10)
 *       404:
 *         description: Session or document not found
 */
sessionPrintJobRoutes.post(
  '/:sessionId/print-jobs',
  sessionTokenForSession,
  validate(createPrintJobSchema, 'body'),
  asyncHandler(printJobController.createPrintJob.bind(printJobController))
);

/**
 * @swagger
 * /sessions/{sessionId}/print-jobs:
 *   get:
 *     summary: List session print jobs
 *     description: Get all print jobs for a specific session
 *     tags: [Print Jobs]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Session ID
 *     responses:
 *       200:
 *         description: List of print jobs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     sessionId:
 *                       type: string
 *                     count:
 *                       type: integer
 *                     jobs:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PrintJob'
 */
sessionPrintJobRoutes.get(
  '/:sessionId/print-jobs',
  sessionTokenForSession,
  asyncHandler(printJobController.getSessionJobs.bind(printJobController))
);

/**
 * @swagger
 * /print-jobs/{jobId}:
 *   get:
 *     summary: Get print job details
 *     description: Retrieve detailed information about a specific print job including settings, pricing, and status
 *     tags: [Print Jobs]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Print job ID
 *     responses:
 *       200:
 *         description: Print job details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     jobId:
 *                       type: string
 *                       format: uuid
 *                     sessionId:
 *                       type: string
 *                     documentId:
 *                       type: string
 *                       format: uuid
 *                     kioskId:
 *                       type: string
 *                       format: uuid
 *                     settings:
 *                       $ref: '#/components/schemas/PrintSettings'
 *                     pricing:
 *                       type: object
 *                       properties:
 *                         pricePerPage:
 *                           type: number
 *                         totalPages:
 *                           type: integer
 *                         totalAmount:
 *                           type: number
 *                     status:
 *                       type: string
 *                       enum: [pending, queued, printing, completed, failed, cancelled]
 *                     timestamps:
 *                       type: object
 *                       properties:
 *                         createdAt:
 *                           type: string
 *                           format: date-time
 *                         queuedAt:
 *                           type: string
 *                           format: date-time
 *                         startedPrintingAt:
 *                           type: string
 *                           format: date-time
 *                         completedAt:
 *                           type: string
 *                           format: date-time
 *       404:
 *         description: Print job not found
 */
router.get(
  '/print-jobs/:jobId',
  validateJobIdParam,
  sessionTokenForJob,
  asyncHandler(printJobController.getPrintJob.bind(printJobController))
);

/**
 * @swagger
 * /print-jobs/{jobId}/settings:
 *   patch:
 *     summary: Update print job settings
 *     description: Update settings for a pending print job and recalculate pricing. Only works for jobs in 'pending' status.
 *     tags: [Print Jobs]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Print job ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               colorMode:
 *                 type: string
 *                 enum: [bw, color]
 *               copies:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 100
 *               pageRange:
 *                 type: string
 *                 enum: [all, custom]
 *               customRange:
 *                 type: string
 *               printSides:
 *                 type: string
 *                 enum: [single, double]
 *               paperSize:
 *                 type: string
 *                 enum: [a4, letter]
 *               orientation:
 *                 type: string
 *                 enum: [portrait, landscape]
 *           examples:
 *             change-color:
 *               summary: Change to Color
 *               value:
 *                 colorMode: color
 *             increase-copies:
 *               summary: Increase Copies
 *               value:
 *                 copies: 3
 *     responses:
 *       200:
 *         description: Settings updated successfully with recalculated pricing
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Print job settings updated successfully
 *                 data:
 *                   $ref: '#/components/schemas/PrintJob'
 *       400:
 *         description: Cannot update (job not in pending status)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               not-pending:
 *                 summary: Job Not Pending
 *                 value:
 *                   status: error
 *                   message: Cannot update print job with status queued. Only pending jobs can be updated.
 *       404:
 *         description: Print job not found
 */
router.patch(
  '/print-jobs/:jobId/settings',
  validateJobIdParam,
  sessionTokenForJob,
  validate(updatePrintJobSettingsSchema, 'body'),
  asyncHandler(printJobController.updateSettings.bind(printJobController))
);

export default router;
