import { Router } from 'express';
import { paymentController } from '../controllers/paymentController';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  verifyPaymentSchema,
  simulatePaymentSchema,
  paymentFailureSchema,
} from '../validators/paymentValidator';

const router = Router();

/**
 * @swagger
 * /print-jobs/{jobId}/payment/order:
 *   post:
 *     summary: Create payment order
 *     description: Create a payment order for a print job. Returns order details that can be used for payment processing.
 *     tags: [Payment]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Print job ID
 *     responses:
 *       201:
 *         description: Payment order created successfully
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
 *                   example: Payment order created successfully
 *                 data:
 *                   $ref: '#/components/schemas/PaymentOrder'
 *       400:
 *         description: Payment already exists or job not in pending status
 *       404:
 *         description: Print job not found
 */
router.post(
  '/print-jobs/:jobId/payment/order',
  asyncHandler(paymentController.createOrder.bind(paymentController))
);

/**
 * @swagger
 * /print-jobs/{jobId}/payment:
 *   get:
 *     summary: Get job payment details
 *     description: Retrieve payment information for a print job
 *     tags: [Payment]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Payment details retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 data:
 *                   $ref: '#/components/schemas/PaymentOrder'
 *       404:
 *         description: Payment order not found
 */
router.get(
  '/print-jobs/:jobId/payment',
  asyncHandler(paymentController.getJobPayment.bind(paymentController))
);

/**
 * @swagger
 * /payment/verify:
 *   post:
 *     summary: Verify payment
 *     description: Verify payment signature and capture payment. On success, the print job status will be updated to 'queued'.
 *     tags: [Payment]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orderId
 *               - paymentId
 *               - signature
 *             properties:
 *               orderId:
 *                 type: string
 *                 example: order_mock_1727235636304_abc123
 *                 description: Order ID from payment order creation
 *               paymentId:
 *                 type: string
 *                 example: pay_mock_1727235636304_xyz789
 *                 description: Payment ID from payment gateway
 *               signature:
 *                 type: string
 *                 example: generated_signature_hash
 *                 description: Payment signature for verification
 *     responses:
 *       200:
 *         description: Payment verified and captured successfully
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
 *                   example: Payment verified and captured successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     verified:
 *                       type: boolean
 *                     paymentId:
 *                       type: string
 *                     orderId:
 *                       type: string
 *                     amount:
 *                       type: number
 *                     currency:
 *                       type: string
 *                     method:
 *                       type: string
 *                     status:
 *                       type: string
 *                     capturedAt:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Payment verification failed
 *       404:
 *         description: Payment order not found
 */
router.post(
  '/payment/verify',
  validate(verifyPaymentSchema, 'body'),
  asyncHandler(paymentController.verifyPayment.bind(paymentController))
);

/**
 * @swagger
 * /payment/order/{orderId}:
 *   get:
 *     summary: Get payment order details
 *     description: Retrieve details of a payment order by order ID
 *     tags: [Payment]
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: Payment order ID
 *     responses:
 *       200:
 *         description: Payment order details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 data:
 *                   $ref: '#/components/schemas/PaymentOrder'
 *       404:
 *         description: Payment order not found
 */
router.get(
  '/payment/order/:orderId',
  asyncHandler(paymentController.getOrder.bind(paymentController))
);

/**
 * @swagger
 * /payment/failure:
 *   post:
 *     summary: Handle payment failure
 *     description: Record payment failure for an order
 *     tags: [Payment]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orderId
 *               - errorCode
 *               - errorDescription
 *             properties:
 *               orderId:
 *                 type: string
 *               errorCode:
 *                 type: string
 *               errorDescription:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment failure recorded
 */
router.post(
  '/payment/failure',
  validate(paymentFailureSchema, 'body'),
  asyncHandler(paymentController.handleFailure.bind(paymentController))
);

/**
 * @swagger
 * /payment/order/{orderId}/status:
 *   get:
 *     summary: Poll payment status
 *     description: |
 *       Check if a payment has been completed.
 *
 *       Useful for asynchronous payment methods (UPI, netbanking) where the
 *       user completes the payment outside your app and returns.
 *
 *       Polling this endpoint lets the frontend know when to proceed to
 *       document upload or print job queue.
 *     tags: [Payment]
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: Payment order ID
 *     responses:
 *       200:
 *         description: Payment status retrieved
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
 *                     orderId:
 *                       type: string
 *                     amount:
 *                       type: number
 *                     currency:
 *                       type: string
 *                     status:
 *                       type: string
 *                       enum: [created, authorized, captured, failed, refunded]
 *                     isPaid:
 *                       type: boolean
 *                       example: false
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *       404:
 *         description: Payment order not found
 */
router.get(
  '/payment/order/:orderId/status',
  asyncHandler(paymentController.getPaymentStatus.bind(paymentController))
);

/**
 * @swagger
 * /payment/mock/simulate-success:
 *   post:
 *     summary: Simulate payment success (Mock only)
 *     description: |
 *       **Development/Testing Only**
 *
 *       Simulates a successful payment and returns mock payment credentials that can be used to verify the payment.
 *
 *       **Workflow:**
 *       1. Create payment order
 *       2. Call this endpoint with orderId
 *       3. Use returned paymentId and signature in verify payment endpoint
 *     tags: [Payment]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orderId
 *             properties:
 *               orderId:
 *                 type: string
 *                 example: order_mock_1727235636304_abc123
 *                 description: Order ID from create payment order
 *     responses:
 *       200:
 *         description: Payment success simulated
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
 *                   example: Payment success simulated
 *                 data:
 *                   type: object
 *                   properties:
 *                     orderId:
 *                       type: string
 *                     paymentId:
 *                       type: string
 *                       example: pay_mock_1727235636304_xyz789
 *                     signature:
 *                       type: string
 *                       example: generated_signature_hash
 *                     note:
 *                       type: string
 *                       example: Use these values to verify the payment via /api/v1/payment/verify endpoint
 *       404:
 *         description: Payment order not found
 */
router.post(
  '/payment/mock/simulate-success',
  validate(simulatePaymentSchema, 'body'),
  asyncHandler(paymentController.simulateSuccess.bind(paymentController))
);

/**
 * @swagger
 * /payment/mock/simulate-failure:
 *   post:
 *     summary: Simulate payment failure (Mock only)
 *     description: |
 *       **Development/Testing Only**
 *
 *       Simulates a payment failure for testing error handling.
 *     tags: [Payment]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orderId
 *             properties:
 *               orderId:
 *                 type: string
 *               errorCode:
 *                 type: string
 *                 example: PAYMENT_DECLINED
 *     responses:
 *       200:
 *         description: Payment failure simulated
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
 *                   example: Payment failure simulated
 *                 data:
 *                   type: object
 *                   properties:
 *                     orderId:
 *                       type: string
 *                     errorCode:
 *                       type: string
 */
router.post(
  '/payment/mock/simulate-failure',
  validate(simulatePaymentSchema, 'body'),
  asyncHandler(paymentController.simulateFailure.bind(paymentController))
);

export default router;
