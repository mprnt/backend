import { Router } from 'express';
import { leadController } from '../controllers/leadController';
import { validate } from '../middleware/validate';
import { leadRateLimiter } from '../middleware/rateLimiter';
import { createLeadSchema } from '../validators/leadValidator';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

/**
 * @swagger
 * /public/leads:
 *   post:
 *     summary: Submit a contact-form lead (MPrint Web)
 *     tags: [Public]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, message]
 *             properties:
 *               name: { type: string, maxLength: 100 }
 *               email: { type: string, format: email }
 *               message: { type: string, maxLength: 2000 }
 *               phone: { type: string, maxLength: 20 }
 *               company: { type: string, maxLength: 150 }
 *               source: { type: string, maxLength: 50, default: web }
 *               website: { type: string, description: Honeypot; leave empty }
 *     responses:
 *       201: { description: Lead stored }
 *       400: { description: Validation error }
 *       429: { description: Too many submissions }
 */
router.post(
  '/leads',
  leadRateLimiter,
  validate(createLeadSchema, 'body'),
  asyncHandler(leadController.createLead.bind(leadController))
);

export default router;
