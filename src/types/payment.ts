export type PaymentStatus = 'created' | 'pending' | 'authorized' | 'captured' | 'failed' | 'refunded';
export type PaymentMethod = 'upi' | 'card' | 'netbanking' | 'wallet' | 'mock';

export interface PaymentOrder {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  createdAt: Date;
}

export interface PaymentTransaction {
  id: string;
  orderId: string;
  paymentId: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  status: PaymentStatus;
  errorCode?: string;
  errorDescription?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePaymentOrderParams {
  jobId: string;
  amount: number;
  currency?: string;
}

export interface VerifyPaymentParams {
  orderId: string;
  paymentId: string;
  signature: string;
}

export interface IPaymentService {
  createOrder(params: CreatePaymentOrderParams): Promise<PaymentOrder>;
  verifyPayment(params: VerifyPaymentParams): Promise<boolean>;
  capturePayment(paymentId: string, amount: number): Promise<PaymentTransaction>;
  getOrderStatus(orderId: string): Promise<PaymentOrder>;
  refundPayment(paymentId: string, amount?: number): Promise<PaymentTransaction>;
}
