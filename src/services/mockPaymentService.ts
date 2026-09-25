import crypto from 'crypto';
import {
  IPaymentService,
  PaymentOrder,
  PaymentTransaction,
  CreatePaymentOrderParams,
  VerifyPaymentParams,
  // PaymentStatus,
} from '../types/payment';
import logger from '../utils/logger';
import { AppError } from '../utils/errors';

/**
 * Mock Payment Service
 * Simulates Razorpay payment gateway for development and testing
 * Can be easily swapped with real RazorpayService in production
 */
export class MockPaymentService implements IPaymentService {
  private orders: Map<string, PaymentOrder> = new Map();
  private transactions: Map<string, PaymentTransaction> = new Map();

  /**
   * Create a payment order (simulates Razorpay order creation)
   */
  async createOrder(params: CreatePaymentOrderParams): Promise<PaymentOrder> {
    const orderId = `order_mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const currency = params.currency || 'INR';

    const order: PaymentOrder = {
      id: crypto.randomUUID(),
      orderId,
      amount: params.amount,
      currency,
      status: 'created',
      createdAt: new Date(),
    };

    this.orders.set(orderId, order);

    logger.info('Mock payment order created', {
      orderId: order.orderId,
      amount: order.amount,
      jobId: params.jobId,
    });

    return order;
  }

  /**
   * Verify payment signature (simulates Razorpay signature verification)
   * In mock mode, we accept any signature and mark payment as successful
   */
  async verifyPayment(params: VerifyPaymentParams): Promise<boolean> {
    const order = this.orders.get(params.orderId);

    if (!order) {
      throw new AppError('Payment order not found', 404);
    }

    // In mock mode, we simulate successful payment
    // In real Razorpay, this would verify HMAC signature
    logger.info('Mock payment verified', {
      orderId: params.orderId,
      paymentId: params.paymentId,
    });

    // Update order status
    order.status = 'captured';
    this.orders.set(params.orderId, order);

    // Create transaction record
    const transaction: PaymentTransaction = {
      id: crypto.randomUUID(),
      orderId: params.orderId,
      paymentId: params.paymentId,
      amount: order.amount,
      currency: order.currency,
      method: 'mock',
      status: 'captured',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.transactions.set(params.paymentId, transaction);

    return true;
  }

  /**
   * Capture payment (simulates Razorpay payment capture)
   */
  async capturePayment(
    paymentId: string,
    amount: number
  ): Promise<PaymentTransaction> {
    const transaction = this.transactions.get(paymentId);

    if (!transaction) {
      throw new AppError('Payment transaction not found', 404);
    }

    if (transaction.status === 'captured') {
      logger.warn('Payment already captured', { paymentId });
      return transaction;
    }

    transaction.status = 'captured';
    transaction.updatedAt = new Date();
    this.transactions.set(paymentId, transaction);

    logger.info('Mock payment captured', {
      paymentId,
      amount,
    });

    return transaction;
  }

  /**
   * Get order status
   */
  async getOrderStatus(orderId: string): Promise<PaymentOrder> {
    const order = this.orders.get(orderId);

    if (!order) {
      throw new AppError('Payment order not found', 404);
    }

    return order;
  }

  /**
   * Refund payment (simulates Razorpay refund)
   */
  async refundPayment(
    paymentId: string,
    amount?: number
  ): Promise<PaymentTransaction> {
    const transaction = this.transactions.get(paymentId);

    if (!transaction) {
      throw new AppError('Payment transaction not found', 404);
    }

    if (transaction.status !== 'captured') {
      throw new AppError(
        'Can only refund captured payments',
        400
      );
    }

    const refundAmount = amount || transaction.amount;

    if (refundAmount > transaction.amount) {
      throw new AppError(
        'Refund amount cannot exceed payment amount',
        400
      );
    }

    const refundTransaction: PaymentTransaction = {
      id: crypto.randomUUID(),
      orderId: transaction.orderId,
      paymentId: `refund_mock_${Date.now()}`,
      amount: refundAmount,
      currency: transaction.currency,
      method: transaction.method,
      status: 'refunded',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Update original transaction status
    transaction.status = 'refunded';
    transaction.updatedAt = new Date();
    this.transactions.set(paymentId, transaction);
    this.transactions.set(refundTransaction.paymentId, refundTransaction);

    logger.info('Mock payment refunded', {
      paymentId,
      refundAmount,
    });

    return refundTransaction;
  }

  /**
   * Generate mock payment signature (for testing)
   */
  generateMockSignature(orderId: string, paymentId: string): string {
    const data = `${orderId}|${paymentId}`;
    return crypto
      .createHmac('sha256', 'mock_secret')
      .update(data)
      .digest('hex');
  }

  /**
   * Simulate payment success (for testing)
   * Returns mock payment details that can be used to verify payment
   */
  async simulatePaymentSuccess(orderId: string): Promise<{
    paymentId: string;
    signature: string;
  }> {
    const order = this.orders.get(orderId);

    if (!order) {
      throw new AppError('Payment order not found', 404);
    }

    const paymentId = `pay_mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const signature = this.generateMockSignature(orderId, paymentId);

    logger.info('Mock payment simulated', {
      orderId,
      paymentId,
    });

    return { paymentId, signature };
  }

  /**
   * Simulate payment failure (for testing)
   */
  async simulatePaymentFailure(orderId: string, errorCode: string = 'PAYMENT_FAILED'): Promise<void> {
    const order = this.orders.get(orderId);

    if (!order) {
      throw new AppError('Payment order not found', 404);
    }

    order.status = 'failed';
    this.orders.set(orderId, order);

    logger.info('Mock payment failed', {
      orderId,
      errorCode,
    });
  }
}

export const mockPaymentService = new MockPaymentService();
