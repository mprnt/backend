import { Router } from 'express';
import { sessionController } from '../controllers/sessionController';
import { validate } from '../middleware/validate';
import { sessionRateLimiter } from '../middleware/rateLimiter';
import {
  createSessionSchema,
  getSessionSchema,
  cancelSessionSchema,
  listSessionsSchema,
} from '../validators/sessionValidator';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

/**
 * @swagger
 * /sessions:
 *   get:
 *     summary: List all sessions
 *     description: Get a paginated list of print sessions with filtering options
 *     tags: [Sessions]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, complete, expired, error]
 *         description: Filter by session status
 *       - in: query
 *         name: kioskId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by kiosk ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Number of sessions per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of sessions to skip
 *     responses:
 *       200:
 *         description: List of sessions retrieved successfully
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
 *                     sessions:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Session'
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         total:
 *                           type: integer
 *                         limit:
 *                           type: integer
 *                         offset:
 *                           type: integer
 */
router.get(
  '/',
  validate(listSessionsSchema, 'query'),
  asyncHandler(sessionController.listSessions.bind(sessionController))
);

/**
 * @swagger
 * /sessions:
 *   post:
 *     summary: Create a new print session
 *     description: Initialize a new print session for a kiosk
 *     tags: [Sessions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - kioskId
 *             properties:
 *               kioskId:
 *                 type: string
 *                 format: uuid
 *                 example: 550e8400-e29b-41d4-a716-446655440000
 *     responses:
 *       201:
 *         description: Session created successfully
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
 *                   example: Session created successfully
 *                 data:
 *                   $ref: '#/components/schemas/Session'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Rate limit exceeded
 */
router.post(
  '/',
  sessionRateLimiter,
  validate(createSessionSchema, 'body'),
  asyncHandler(sessionController.createSession.bind(sessionController))
);

/**
 * @swagger
 * /sessions/{sessionId}:
 *   get:
 *     summary: Get session details
 *     description: Retrieve details of a specific print session
 *     tags: [Sessions]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Session ID (e.g., S1727235636304)
 *     responses:
 *       200:
 *         description: Session details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/Session'
 *       404:
 *         description: Session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get(
  '/:sessionId',
  validate(getSessionSchema, 'params'),
  asyncHandler(sessionController.getSession.bind(sessionController))
);

/**
 * @swagger
 * /sessions/{sessionId}:
 *   delete:
 *     summary: Cancel/expire a session
 *     description: Mark a session as cancelled or expired
 *     tags: [Sessions]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Session ID to cancel
 *     responses:
 *       200:
 *         description: Session cancelled successfully
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
 *                   example: Session cancelled successfully
 *       404:
 *         description: Session not found
 */
router.delete(
  '/:sessionId',
  validate(cancelSessionSchema, 'params'),
  asyncHandler(sessionController.cancelSession.bind(sessionController))
);

export default router;
