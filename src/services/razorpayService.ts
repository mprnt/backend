import crypto from 'crypto';
import https from 'https';
import env from '../config/environment';
import logger from '../utils/logger';
import { AppError } from '../utils/errors';
import { hmacSha256Hex, safeEqual } from '../utils/crypto';
import {
  IPaymentService,
  PaymentOrder,
  PaymentTransaction,
  CreatePaymentOrderParams,
  VerifyPaymentParams,
  PaymentMethod,
  PaymentStatus,
  RefundResult,
} from '../types/payment';

// Extends IPaymentService with simulation methods for local development/testing
export interface IRazorpayService extends IPaymentService {
  simulatePaymentSuccess(orderId: string): Promise<{ paymentId: string; signature: string }>;
  simulatePaymentFailure(orderId: string, errorCode?: string): Promise<void>;
}

interface RazorpayOrderResponse {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: string;
  created_at: number;
}

interface RazorpayPayment {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: string;
  method: string;
  order_id?: string;
  created_at: number;
}

interface RazorpayRefund {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: string;
  created_at: number;
}

/**
 * RazorpayService — production payment gateway integration.
 * Uses the real Razorpay REST API (no SDK dependency needed).
 *
 * Switch to live mode by setting RAZORPAY_KEY_ID to a key prefixed
 * with "rzp_live_" in your environment. Test mode keys start with "rzp_test_".
 */
export class RazorpayService implements IRazorpayService {
  private apiKey: string;
  private apiSecret: string;
  // In-memory store for simulating payments during local development/testing
  private mockOrders: Map<string, PaymentOrder> = new Map();

  constructor() {
    this.apiKey = env.payment.razorpay_key_id;
    this.apiSecret = env.payment.razorpay_key_secret;

    if (!this.apiKey || !this.apiSecret) {
      throw new AppError('Razorpay API credentials not configured', 500);
    }
  }

  private request(method: string, endpoint: string, body?: unknown): Promise<unknown> {
    const auth = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64');

    const options: https.RequestOptions = {
      hostname: 'api.razorpay.com',
      path: `/v1${endpoint}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const errorDesc =
                typeof parsed.error === 'object' &&
                parsed.error !== null &&
                'description' in parsed.error &&
                typeof (parsed.error as { description?: unknown }).description === 'string'
                  ? (parsed.error as { description: string }).description
                  : 'Razorpay API error';
              const err = new Error(errorDesc) as Error & { statusCode?: number };
              err.statusCode = res.statusCode || 500;
              reject(err);
            }
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  private isTestKey(): boolean {
    return !this.apiKey.startsWith('rzp_');
  }

  /**
   * Create a payment order via Razorpay
   */
  async createOrder(params: CreatePaymentOrderParams): Promise<PaymentOrder> {
    if (this.isTestKey()) {
      return this.createMockOrder(params);
    }

    const body = {
      amount: Math.round(params.amount * 100), // Razorpay accepts amount in paise
      currency: params.currency || 'INR',
      receipt: `job_${params.jobId}_${Date.now()}`,
      payment_capture: true, // Auto-capture
    };

    const response = (await this.request('POST', '/orders', body)) as RazorpayOrderResponse;

    const order: PaymentOrder = {
      id: crypto.randomUUID(),
      orderId: response.id,
      amount: response.amount / 100, // Convert back to rupees
      currency: response.currency,
      status: 'created',
      createdAt: new Date(response.created_at * 1000),
    };

    // Store in memory for simulation endpoints (local dev only)
    this.storeOrder(order);

    logger.info('Razorpay order created', { orderId: response.id, amount: response.amount });

    return order;
  }

  /**
   * Create a mock payment order for local development/testing.
   * Used when RAZORPAY_KEY_ID is a placeholder or test key.
   */
  private createMockOrder(params: CreatePaymentOrderParams): PaymentOrder {
    const orderId = `order_mock_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const order: PaymentOrder = {
      id: crypto.randomUUID(),
      orderId,
      amount: params.amount,
      currency: params.currency || 'INR',
      status: 'created',
      createdAt: new Date(),
    };

    this.storeOrder(order);

    logger.info('Mock payment order created', { orderId, amount: params.amount });

    return order;
  }

  /**
   * Verify payment signature against Razorpay's HMAC
   */
  async verifyPayment(params: VerifyPaymentParams): Promise<boolean> {
    const { orderId, paymentId, signature } = params;

    if (this.isTestKey()) {
      const order = this.getMockOrder(orderId);
      if (!order) {
        throw new AppError('Payment order not found', 404);
      }

      const generatedSignature = hmacSha256Hex(this.apiSecret, `${orderId}|${paymentId}`);

      if (!safeEqual(generatedSignature, signature)) {
        throw new AppError('Invalid payment signature', 400);
      }

      logger.info('Mock payment verified', { orderId, paymentId });
      return true;
    }

    // Fetch payment details to get the actual amount for signature verification
    const payment = (await this.request('GET', `/payments/${paymentId}`)) as RazorpayPayment;

    if (payment.order_id !== orderId) {
      throw new AppError('Payment does not belong to this order', 400);
    }

    // Razorpay signature verification
    const generatedSignature = hmacSha256Hex(this.apiSecret, `${orderId}|${paymentId}`);

    const isSignatureValid = safeEqual(generatedSignature, signature);

    if (!isSignatureValid) {
      throw new AppError('Invalid payment signature', 400);
    }

    // Verify the payment is actually captured
    if (payment.status !== 'captured') {
      throw new AppError(`Payment not captured, status: ${payment.status}`, 400);
    }

    logger.info('Razorpay payment verified', { orderId, paymentId });
    return true;
  }

  /**
   * Capture a payment (for manual capture mode)
   */
  async capturePayment(paymentId: string, amount: number): Promise<PaymentTransaction> {
    const body = {
      amount: Math.round(amount * 100),
    };

    const response = (await this.request(
      'POST',
      `/payments/${paymentId}/capture`,
      body
    )) as RazorpayPayment;

    if (!response.order_id) {
      throw new AppError('Payment does not have an associated order', 400);
    }

    const order = await this.getOrderStatus(response.order_id);

    return {
      id: crypto.randomUUID(),
      orderId: order.orderId,
      paymentId,
      amount: response.amount / 100,
      currency: response.currency,
      method: this.mapPaymentMethod(response.method),
      status: this.mapPaymentStatus(response.status),
      createdAt: new Date(response.created_at * 1000),
      updatedAt: new Date(),
    };
  }

  /**
   * Get order status from Razorpay
   */
  async getOrderStatus(orderId: string): Promise<PaymentOrder> {
    const response = (await this.request('GET', `/orders/${orderId}`)) as RazorpayOrderResponse;

    return {
      id: crypto.randomUUID(),
      orderId: response.id,
      amount: response.amount / 100,
      currency: response.currency,
      status:
        response.status === 'created'
          ? 'created'
          : response.status === 'attempted'
            ? 'pending'
            : 'captured',
      createdAt: new Date(response.created_at * 1000),
    };
  }

  /**
   * Refund a captured payment (full refund when amount is omitted).
   * With a placeholder key (mock mode) no request leaves the process.
   */
  async refundPayment(
    paymentId: string,
    amount?: number,
    notes?: Record<string, string>
  ): Promise<RefundResult> {
    if (this.isTestKey()) {
      const refundId = `rfnd_mock_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      logger.info('Mock refund issued', { paymentId, refundId, amount });
      return { refundId, paymentId, amount: amount ?? 0, currency: 'INR', status: 'processed' };
    }

    const body: { amount?: number; notes?: Record<string, string> } = {};
    if (amount) {
      body.amount = Math.round(amount * 100);
    }
    if (notes) {
      body.notes = notes;
    }

    const response = (await this.request(
      'POST',
      `/payments/${paymentId}/refund`,
      body
    )) as RazorpayRefund;

    return {
      refundId: response.id,
      paymentId,
      amount: response.amount / 100,
      currency: response.currency,
      status: response.status,
    };
  }

  private mapPaymentMethod(method: string): PaymentMethod {
    switch (method) {
      case 'upi':
        return 'upi';
      case 'netbanking':
        return 'netbanking';
      case 'wallet':
        return 'wallet';
      case 'card':
      case 'card_network':
        return 'card';
      default:
        return 'card';
    }
  }

  private mapPaymentStatus(status: string): PaymentStatus {
    switch (status) {
      case 'captured':
        return 'captured';
      case 'refunded':
        return 'refunded';
      case 'failed':
        return 'failed';
      default:
        return 'pending';
    }
  }

  /**
   * For local development: store orders in memory so simulation endpoints work
   * without making real API calls. In production, orders are fetched from Razorpay.
   */
  private storeOrder(order: PaymentOrder): void {
    this.mockOrders.set(order.orderId, order);
  }

  private getMockOrder(orderId: string): PaymentOrder | undefined {
    return this.mockOrders.get(orderId);
  }

  /**
   * Simulate a successful payment (local dev/testing only).
   * Returns a paymentId and signature that frontend can use to verify.
   */
  async simulatePaymentSuccess(orderId: string): Promise<{ paymentId: string; signature: string }> {
    const order = this.getMockOrder(orderId);

    if (!order) {
      // Try fetching from Razorpay if not in mock store
      try {
        const razorpayOrder = (await this.request(
          'GET',
          `/orders/${orderId}`
        )) as RazorpayOrderResponse;
        if (razorpayOrder) {
          const mapped: PaymentOrder = {
            id: crypto.randomUUID(),
            orderId: razorpayOrder.id,
            amount: razorpayOrder.amount / 100,
            currency: razorpayOrder.currency,
            status: 'created',
            createdAt: new Date(razorpayOrder.created_at * 1000),
          };
          this.storeOrder(mapped);
        }
      } catch {
        throw new AppError('Payment order not found', 404);
      }
    }

    const paymentId = `pay_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    logger.info('Mock payment success simulated', { orderId, paymentId });

    return { paymentId, signature };
  }

  /**
   * Simulate a payment failure (local dev/testing only).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async simulatePaymentFailure(
    orderId: string,
    errorCode: string = 'PAYMENT_FAILED'
  ): Promise<void> {
    const order = this.getMockOrder(orderId);

    if (!order) {
      throw new AppError('Payment order not found', 404);
    }

    order.status = 'failed';
    this.mockOrders.set(orderId, order);

    logger.info('Mock payment failure simulated', { orderId, errorCode });
  }
}
