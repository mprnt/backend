import { Request, Response } from 'express';
import env from '../config/environment';
import { getPaymentService, paymentService } from '../services/paymentService';
import { RazorpayService } from '../services/razorpayService';
import { AppError } from '../utils/errors';
import logger from '../utils/logger';

function getRazorpayService(): RazorpayService {
  const service = getPaymentService() as unknown as {
    getGateway: () => RazorpayService;
  };
  return service.getGateway();
}

class PaymentController {
  /**
   * POST /api/v1/print-jobs/:jobId/payment/order
   * Create payment order for a print job
   */
  async createOrder(req: Request, res: Response): Promise<void> {
    const { jobId } = req.params;

    logger.info('Creating payment order', { jobId });

    // Get job details to determine amount
    const jobResult = await paymentService['database'].query<{
      total_amount: string;
    }>(`SELECT total_amount FROM print_jobs WHERE id = $1`, [jobId]);

    if (jobResult.rows.length === 0) {
      throw new AppError('Print job not found', 404);
    }

    const amount = parseFloat(jobResult.rows[0].total_amount);

    const { order, jobId: createdJobId } = await paymentService.createPaymentOrder({
      jobId,
      amount,
      currency: 'INR',
    });

    res.status(201).json({
      status: 'success',
      message: 'Payment order created successfully',
      data: {
        keyId: env.payment.razorpay_key_id,
        orderId: order.orderId,
        amount: order.amount,
        currency: order.currency,
        jobId: createdJobId,
        status: order.status,
        createdAt: order.createdAt,
      },
    });
  }

  /**
   * POST /api/v1/payment/verify
   * Verify payment and capture
   */
  async verifyPayment(req: Request, res: Response): Promise<void> {
    const { orderId, paymentId, signature } = req.body as {
      orderId: string;
      paymentId: string;
      signature: string;
    };

    logger.info('Verifying payment', { orderId, paymentId });

    const { success, transaction } = await paymentService.verifyAndCapturePayment({
      orderId,
      paymentId,
      signature,
    });

    res.json({
      status: 'success',
      message: 'Payment verified and captured successfully',
      data: {
        verified: success,
        paymentId: transaction.paymentId,
        orderId: transaction.orderId,
        amount: transaction.amount,
        currency: transaction.currency,
        method: transaction.method,
        status: transaction.status,
        capturedAt: transaction.updatedAt,
      },
    });
  }

  /**
   * GET /api/v1/payment/order/:orderId
   * Get payment order details
   */
  async getOrder(req: Request, res: Response): Promise<void> {
    const { orderId } = req.params;

    logger.info('Getting payment order', { orderId });

    const order = await paymentService.getPaymentOrder(orderId);

    if (!order) {
      throw new AppError('Payment order not found', 404);
    }

    res.json({
      status: 'success',
      data: {
        orderId: order.orderId,
        amount: order.amount,
        currency: order.currency,
        status: order.status,
        createdAt: order.createdAt,
      },
    });
  }

  /**
   * GET /api/v1/print-jobs/:jobId/payment
   * Get payment details for a job
   */
  async getJobPayment(req: Request, res: Response): Promise<void> {
    const { jobId } = req.params;

    logger.info('Getting job payment details', { jobId });

    const order = await paymentService.getJobPaymentOrder(jobId);

    if (!order) {
      throw new AppError('No payment order found for this job', 404);
    }

    res.json({
      status: 'success',
      data: {
        orderId: order.orderId,
        amount: order.amount,
        currency: order.currency,
        status: order.status,
        createdAt: order.createdAt,
      },
    });
  }

  /**
   * GET /api/v1/payment/order/:orderId/status
   * Poll payment status — useful for async payment flows (UPI, netbanking)
   * where the user returns to the app after completing payment externally.
   */
  async getPaymentStatus(req: Request, res: Response): Promise<void> {
    const { orderId } = req.params;

    logger.info('Polling payment status', { orderId });

    const found = await paymentService.getPaymentOrderStatus(orderId);

    if (!found) {
      throw new AppError('Payment order not found', 404);
    }

    const { order, amountMismatch, jobRefunded } = found;

    res.json({
      status: 'success',
      data: {
        orderId: order.orderId,
        amount: order.amount,
        currency: order.currency,
        status: order.status,
        createdAt: order.createdAt,
        // A payment that landed after the job was refunded did not queue it.
        isPaid: order.status === 'captured' && !jobRefunded,
        // Paid but not queued: a refund case, not a print (409 AMOUNT_MISMATCH on verify).
        amountMismatch,
      },
    });
  }

  /**
   * POST /api/v1/payment/mock/simulate-success
   * Simulate successful payment (mock only)
   */
  async simulateSuccess(req: Request, res: Response): Promise<void> {
    const { orderId } = req.body as { orderId: string };

    logger.info('Simulating payment success', { orderId });

    const { paymentId, signature } = await getRazorpayService().simulatePaymentSuccess(orderId);

    res.json({
      status: 'success',
      message: 'Payment success simulated',
      data: {
        orderId,
        paymentId,
        signature,
        note: 'Use these values to verify the payment via /api/v1/payment/verify endpoint',
      },
    });
  }

  /**
   * POST /api/v1/payment/mock/simulate-failure
   * Simulate payment failure (mock only)
   */
  async simulateFailure(req: Request, res: Response): Promise<void> {
    const { orderId, errorCode } = req.body as { orderId: string; errorCode?: string };

    logger.info('Simulating payment failure', { orderId, errorCode });

    await getRazorpayService().simulatePaymentFailure(orderId, errorCode);

    await paymentService.handlePaymentFailure(
      orderId,
      errorCode || 'PAYMENT_FAILED',
      'Mock payment failure simulation'
    );

    res.json({
      status: 'success',
      message: 'Payment failure simulated',
      data: {
        orderId,
        errorCode: errorCode || 'PAYMENT_FAILED',
      },
    });
  }

  /**
   * POST /api/v1/payment/webhook
   * Razorpay webhook (payment.captured / order.paid). Authenticated by
   * X-Razorpay-Signature, not by a session token.
   */
  async handleWebhook(req: Request, res: Response): Promise<void> {
    const result = await paymentService.handleWebhook(
      req.rawBody,
      req.header('X-Razorpay-Signature')
    );

    logger.info('Razorpay webhook processed', result);

    res.json({ status: 'success', data: result });
  }

  /**
   * POST /api/v1/payment/failure
   * Handle payment failure webhook
   */
  async handleFailure(req: Request, res: Response): Promise<void> {
    const { orderId, errorCode, errorDescription } = req.body as {
      orderId: string;
      errorCode: string;
      errorDescription: string;
    };

    logger.info('Handling payment failure', { orderId, errorCode });

    await paymentService.handlePaymentFailure(orderId, errorCode, errorDescription);

    res.json({
      status: 'success',
      message: 'Payment failure recorded',
    });
  }
}

export const paymentController = new PaymentController();
