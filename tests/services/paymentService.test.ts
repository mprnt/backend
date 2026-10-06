import crypto from 'crypto';
import { PaymentService } from '../../src/services/paymentService';
import { queueService } from '../../src/services/queueService';
import env from '../../src/config/environment';
import { AppError } from '../../src/middleware/errorHandler';
import { IPaymentService } from '../../src/types/payment';
import { scriptedDb, ScriptedDb } from '../helpers/fakeDb';

jest.mock('../../src/config/database');
jest.mock('../../src/services/websocketService', () => ({
  websocketService: { broadcastJobStatus: jest.fn() },
}));

const JOB = '11111111-1111-4111-8111-111111111111';

function gateway(): jest.Mocked<IPaymentService> {
  return {
    createOrder: jest.fn(async (p) => ({
      id: 'po-1',
      orderId: 'order_1',
      amount: p.amount,
      currency: 'INR',
      status: 'created' as const,
      createdAt: new Date(),
    })),
    verifyPayment: jest.fn().mockResolvedValue(true),
    capturePayment: jest.fn(),
    getOrderStatus: jest.fn(),
    refundPayment: jest.fn(),
  };
}

/** The job row createPaymentOrder locks, joined with its session. */
const jobRow = (over: Record<string, unknown> = {}) => ({
  id: JOB,
  total_amount: '10',
  status: 'pending',
  payment_status: 'unpaid',
  document_id: 'doc-1',
  session_uuid: 'ps-1',
  session_status: 'draft',
  session_expires_at: new Date(Date.now() + 5 * 60_000),
  ...over,
});

const orderRow = (over: Record<string, unknown> = {}) => ({
  job_id: JOB,
  amount: '10.00',
  currency: 'INR',
  status: 'created',
  total_amount: '10.00',
  payment_status: 'unpaid',
  ...over,
});

describe('PaymentService', () => {
  let db: ScriptedDb;
  let gw: jest.Mocked<IPaymentService>;
  let service: PaymentService;
  let enqueue: jest.SpyInstance;

  beforeEach(() => {
    gw = gateway();
    enqueue = jest.spyOn(queueService, 'enqueueJob').mockResolvedValue();
  });

  afterEach(() => jest.restoreAllMocks());

  const build = (rules: Parameters<typeof scriptedDb>[0]) => {
    db = scriptedDb(rules);
    service = new PaymentService(db as never, gw);
  };

  describe('createPaymentOrder', () => {
    it('prices the order from the locked job row, not the caller', async () => {
      build([['FROM print_jobs', [jobRow({ total_amount: '42.50' })]]]);

      await service.createPaymentOrder({ jobId: JOB, amount: 1 });

      expect(db.sqlFor('FROM print_jobs')[0].sql).toContain('FOR UPDATE');
      expect(gw.createOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 42.5 }));
    });

    it('refuses a second order while one is open', async () => {
      build([
        ['FROM print_jobs', [jobRow()]],
        ['FROM payment_orders', [{ order_id: 'order_old', status: 'created' }]],
      ]);

      const err = await service
        .createPaymentOrder({ jobId: JOB, amount: 10 })
        .catch((e: AppError) => e);

      expect((err as AppError).message).toMatch(/already exists/);
      expect((err as AppError).code).toBe('PAYMENT_ORDER_EXISTS');
      expect(gw.createOrder).not.toHaveBeenCalled();
    });

    it('extends the session by the payment grace period once the order exists', async () => {
      build([['FROM print_jobs', [jobRow()]]]);

      const before = Date.now();
      await service.createPaymentOrder({ jobId: JOB, amount: 10 });

      const [extend] = db.sqlFor('UPDATE print_sessions SET expires_at = GREATEST');
      expect(extend.params[0]).toBe('ps-1');
      const graceMs = env.security.session_payment_grace_minutes * 60_000;
      expect((extend.params[1] as Date).getTime()).toBeGreaterThanOrEqual(before + graceMs);
      expect(db.sqlFor('COMMIT')).toHaveLength(1);
    });

    it.each([
      ['the window has passed', { session_expires_at: new Date(Date.now() - 1000) }],
      ['the customer cancelled', { session_status: 'expired' }],
    ])('410 SESSION_EXPIRED when %s', async (_label, over) => {
      build([['FROM print_jobs', [jobRow(over)]]]);

      const err = await service
        .createPaymentOrder({ jobId: JOB, amount: 10 })
        .catch((e: AppError) => e);

      expect((err as AppError).statusCode).toBe(410);
      expect((err as AppError).code).toBe('SESSION_EXPIRED');
      expect(gw.createOrder).not.toHaveBeenCalled();
    });

    it('409 DOCUMENT_MISSING when the upload was already deleted', async () => {
      build([['FROM print_jobs', [jobRow({ document_id: null })]]]);

      const err = await service
        .createPaymentOrder({ jobId: JOB, amount: 10 })
        .catch((e: AppError) => e);

      expect((err as AppError).code).toBe('DOCUMENT_MISSING');
      expect(gw.createOrder).not.toHaveBeenCalled();
    });
  });

  describe('verifyAndCapturePayment', () => {
    const params = { orderId: 'order_1', paymentId: 'pay_1', signature: 'sig' };

    it('queues the job when the order amount equals the job total', async () => {
      build([['FROM payment_orders po', [orderRow()]]]);

      const res = await service.verifyAndCapturePayment(params);

      expect(res.success).toBe(true);
      expect(db.sqlFor('INSERT INTO payment_transactions')).toHaveLength(1);
      expect(db.sqlFor('status = $2, queued_at')).toHaveLength(1);
      expect(enqueue).toHaveBeenCalledWith(JOB, 0, db.client);
      expect(db.sqlFor('COMMIT')).toHaveLength(1);
    });

    it('pay-less-print-more: refuses to queue when the job total grew after the order', async () => {
      build([['FROM payment_orders po', [orderRow({ amount: '2.00', total_amount: '200.00' })]]]);

      const err = await service.verifyAndCapturePayment(params).catch((e: AppError) => e);

      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(409);
      expect((err as AppError).code).toBe('AMOUNT_MISMATCH');
      expect(enqueue).not.toHaveBeenCalled();
      // Money is still recorded (committed) so the job can be refunded.
      expect(db.sqlFor('INSERT INTO payment_transactions')).toHaveLength(1);
      expect(db.sqlFor('COMMIT')).toHaveLength(1);
      const mark = db.sqlFor("payment_status = 'paid', paid_at = NOW(), error_message");
      expect(mark).toHaveLength(1);
    });

    it('is idempotent for an already captured order', async () => {
      build([
        ['FROM payment_orders po', [orderRow({ status: 'captured', payment_status: 'paid' })]],
        [
          'FROM payment_transactions',
          [
            {
              id: 't1',
              payment_id: 'pay_1',
              amount: '10.00',
              currency: 'INR',
              method: 'mock',
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        ],
      ]);

      const res = await service.verifyAndCapturePayment(params);

      expect(res.transaction.id).toBe('t1');
      expect(db.sqlFor('INSERT INTO payment_transactions')).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('does not queue a job twice when a second order is paid', async () => {
      build([['FROM payment_orders po', [orderRow({ payment_status: 'paid' })]]]);

      await service.verifyAndCapturePayment(params);

      expect(enqueue).not.toHaveBeenCalled();
      expect(db.sqlFor('UPDATE print_jobs')).toHaveLength(0);
    });

    it('does not queue a job whose document was deleted before the money arrived', async () => {
      build([['FROM payment_orders po', [orderRow({ document_id: null, job_status: 'pending' })]]]);

      const err = await service.verifyAndCapturePayment(params).catch((e: AppError) => e);

      expect((err as AppError).statusCode).toBe(409);
      expect((err as AppError).code).toBe('DOCUMENT_MISSING');
      expect(enqueue).not.toHaveBeenCalled();
      // The money is recorded and the job marked paid, so it shows as a refund candidate.
      expect(db.sqlFor('INSERT INTO payment_transactions')).toHaveLength(1);
      expect(db.sqlFor("payment_status = 'paid', paid_at = NOW(), error_message")).toHaveLength(1);
      expect(db.sqlFor('COMMIT')).toHaveLength(1);
    });

    it('a repeat verify after printing and cleanup is still a success', async () => {
      build([
        [
          'FROM payment_orders po',
          [
            orderRow({
              status: 'captured',
              payment_status: 'paid',
              document_id: null,
              job_status: 'completed',
            }),
          ],
        ],
      ]);

      const res = await service.verifyAndCapturePayment(params);

      expect(res.success).toBe(true);
    });

    it('rejects when the gateway rejects the signature', async () => {
      build([]);
      gw.verifyPayment.mockResolvedValue(false);

      await expect(service.verifyAndCapturePayment(params)).rejects.toThrow(/verification failed/);
      expect(db.getClient).not.toHaveBeenCalled();
    });
  });

  describe('handlePaymentFailure', () => {
    it('moves an open order to failed', async () => {
      build([['UPDATE payment_orders', [{ job_id: JOB }]]]);

      await service.handlePaymentFailure('order_1', 'E', 'declined');

      const update = db.sqlFor('UPDATE payment_orders')[0].sql;
      expect(update).toContain("status IN ('created', 'attempted', 'pending')");
      expect(db.sqlFor('UPDATE print_jobs')).toHaveLength(1);
    });

    it('refuses to mark a captured order as failed', async () => {
      build([['SELECT status FROM payment_orders', [{ status: 'captured' }]]]);

      const err = await service.handlePaymentFailure('order_1', 'E', 'x').catch((e: AppError) => e);

      expect((err as AppError).statusCode).toBe(409);
      expect((err as AppError).code).toBe('ORDER_NOT_FAILABLE');
      expect(db.sqlFor('UPDATE print_jobs')).toHaveLength(0);
      expect(db.sqlFor('ROLLBACK')).toHaveLength(1);
    });

    it('404s for an unknown order', async () => {
      build([]);
      await expect(service.handlePaymentFailure('nope', 'E', 'x')).rejects.toThrow(/not found/);
    });
  });

  describe('handleWebhook', () => {
    const SECRET = 'whsec_test_only';
    const original = env.payment.razorpay_webhook_secret;
    const sign = (body: Buffer) => crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    const event = (name: string, payment: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ event: name, payload: { payment: { entity: payment } } }));

    beforeEach(() => {
      env.payment.razorpay_webhook_secret = SECRET;
    });
    afterAll(() => {
      env.payment.razorpay_webhook_secret = original;
    });

    it('503s when no webhook secret is configured', async () => {
      build([]);
      env.payment.razorpay_webhook_secret = '';
      const body = event('payment.captured', {});
      await expect(service.handleWebhook(body, sign(body))).rejects.toMatchObject({
        statusCode: 503,
      });
    });

    it('rejects a bad signature', async () => {
      build([]);
      const body = event('payment.captured', {});
      await expect(service.handleWebhook(body, 'deadbeef')).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_SIGNATURE',
      });
      await expect(service.handleWebhook(body, undefined)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('captures payment.captured through the shared path', async () => {
      build([['FROM payment_orders po', [orderRow()]]]);
      const body = event('payment.captured', {
        id: 'pay_9',
        order_id: 'order_1',
        amount: 1000,
        status: 'captured',
        method: 'upi',
      });

      const res = await service.handleWebhook(body, sign(body));

      expect(res).toEqual({ handled: true, event: 'payment.captured', reason: undefined });
      expect(enqueue).toHaveBeenCalledWith(JOB, 0, db.client);
      const tx = db.sqlFor('INSERT INTO payment_transactions')[0];
      expect(tx.params[2]).toBe('pay_9');
      expect(tx.params[7]).toBeNull(); // no client signature
    });

    it('does not queue when Razorpay reports a different paid amount', async () => {
      build([['FROM payment_orders po', [orderRow()]]]);
      const body = event('order.paid', {
        id: 'pay_9',
        order_id: 'order_1',
        amount: 100,
        status: 'captured',
      });

      const res = await service.handleWebhook(body, sign(body));

      expect(res.reason).toBe('amount_mismatch');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('acknowledges a replay without capturing twice', async () => {
      build([['FROM payment_orders po', [orderRow({ status: 'captured' })]]]);
      const body = event('payment.captured', {
        id: 'pay_9',
        order_id: 'order_1',
        amount: 1000,
        status: 'captured',
      });

      const res = await service.handleWebhook(body, sign(body));

      expect(res.reason).toBe('already_captured');
      expect(db.sqlFor('INSERT INTO payment_transactions')).toHaveLength(0);
    });

    it('a webhook after a refund neither re-captures nor re-queues', async () => {
      build([
        ['FROM payment_orders po', [orderRow({ status: 'refunded', payment_status: 'refunded' })]],
      ]);
      const body = event('payment.captured', {
        id: 'pay_9',
        order_id: 'order_1',
        amount: 1000,
        status: 'captured',
      });

      const res = await service.handleWebhook(body, sign(body));

      expect(res).toEqual({ handled: false, event: 'payment.captured', reason: 'refunded' });
      expect(enqueue).not.toHaveBeenCalled();
      expect(db.sqlFor('INSERT INTO payment_transactions')).toHaveLength(0);
      expect(db.sqlFor('UPDATE payment_orders')).toHaveLength(0);
      expect(db.sqlFor('UPDATE print_jobs')).toHaveLength(0);
    });

    it('a late payment on an older order of a refunded job is recorded but not queued', async () => {
      build([
        ['FROM payment_orders po', [orderRow({ status: 'failed', payment_status: 'refunded' })]],
      ]);
      const body = event('payment.captured', {
        id: 'pay_late',
        order_id: 'order_1',
        amount: 1000,
        status: 'captured',
      });

      const res = await service.handleWebhook(body, sign(body));

      expect(res.reason).toBe('job_refunded');
      expect(enqueue).not.toHaveBeenCalled();
      expect(db.sqlFor('INSERT INTO payment_transactions')).toHaveLength(1);
      expect(db.sqlFor('UPDATE print_jobs')).toHaveLength(0);
      await expect(
        service.verifyAndCapturePayment({
          orderId: 'order_1',
          paymentId: 'pay_late',
          signature: 's',
        })
      ).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_REFUNDED' });
    });

    it('ignores other events and unknown orders', async () => {
      build([]);
      const other = event('refund.created', {});
      expect((await service.handleWebhook(other, sign(other))).reason).toBe('ignored_event');

      const unknown = event('payment.captured', {
        id: 'pay_x',
        order_id: 'order_other',
        amount: 100,
        status: 'captured',
      });
      expect((await service.handleWebhook(unknown, sign(unknown))).reason).toBe('unknown_order');
    });
  });
});
