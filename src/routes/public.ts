import { Request, Response, Router } from 'express';
import { leadController } from '../controllers/leadController';
import { validate } from '../middleware/validate';
import { leadRateLimiter } from '../middleware/rateLimiter';
import { createLeadSchema } from '../validators/leadValidator';
import { asyncHandler } from '../utils/asyncHandler';
import { pricingService } from '../services/pricingService';
import { sessionService } from '../services/sessionService';

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

/**
 * Current per-page rates for a kiosk (by its code, e.g. KIOSK001), as set from
 * the admin dashboard. The QR app shows its estimate from these, so the number
 * a customer sees before the job is created matches what they are charged.
 * An unknown or missing kiosk gets the platform default.
 */
router.get(
  '/pricing',
  asyncHandler(async (req: Request, res: Response) => {
    const code = typeof req.query.kioskId === 'string' ? req.query.kioskId : undefined;
    const kiosk = code ? await sessionService.getKioskByKioskId(code) : null;
    const prices = await pricingService.resolvePrices(kiosk?.id);

    res.json({
      status: 'success',
      data: {
        bwPerPage: prices.bwPerPage,
        colorPerPage: prices.colorPerPage,
        minCharge: prices.minCharge,
        currency: 'INR',
      },
    });
  })
);

export default router;
