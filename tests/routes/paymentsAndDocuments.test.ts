import crypto from 'crypto';
import request from 'supertest';
import app from '../../src/app';
import env from '../../src/config/environment';
import { queueService } from '../../src/services/queueService';
import { sessionRule, useScriptedDb } from '../helpers/http';

jest.mock('../../src/config/database');
jest.mock('../../src/services/websocketService', () => ({
  websocketService: { broadcastJobStatus: jest.fn() },
}));
jest.mock('../../src/services/storageService', () => ({
  storageService: { deleteFile: jest.fn().mockResolvedValue(undefined) },
}));
// Never reach Razorpay: the gateway is a stub that accepts any signature.
jest.mock('../../src/services/razorpayService', () => ({
  RazorpayService: jest.fn().mockImplementation(() => ({
    createOrder: jest.fn(),
    verifyPayment: jest.fn().mockResolvedValue(true),
    refundPayment: jest.fn(),
  })),
}));

const API = '/api/v1';
const JOB = '66666666-6666-4666-8666-666666666666';
const DOC = '77777777-7777-4777-8777-777777777777';
const TOKEN = 'd'.repeat(64);

const orderRow = (over: Record<string, unknown> = {}) => ({
  job_id: JOB,
  amount: '10.00',
  currency: 'INR',
  status: 'created',
  total_amount: '10.00',
  payment_status: 'unpaid',
  ...over,
});

beforeEach(() => {
  jest.spyOn(queueService, 'enqueueJob').mockResolvedValue();
});
afterEach(() => jest.restoreAllMocks());

describe('PATCH /print-jobs/:jobId/settings', () => {
  it('409 JOB_SETTINGS_LOCKED once a payment order exists', async () => {
    const db = useScriptedDb([
      sessionRule(TOKEN),
      ['FROM print_jobs pj', [{ id: JOB, status: 'pending', payment_status: 'unpaid' }]],
      ['FROM payment_orders', [{ x: 1 }]],
    ]);

    const res = await request(app)
      .patch(`${API}/print-jobs/${JOB}/settings`)
      .set('X-Session-Token', TOKEN)
      .send({ copies: 100, colorMode: 'color' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_SETTINGS_LOCKED');
    expect(db.sqlFor('UPDATE print_jobs')).toHaveLength(0);
  });
});

describe('POST /payment/verify', () => {
  const body = { orderId: 'order_1', paymentId: 'pay_1', signature: 'sig' };

  it('captures and queues when amounts match', async () => {
    useScriptedDb([sessionRule(TOKEN), ['FROM payment_orders po', [orderRow()]]]);

    const res = await request(app)
      .post(`${API}/payment/verify`)
      .set('X-Session-Token', TOKEN)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.verified).toBe(true);
    expect(queueService.enqueueJob).toHaveBeenCalled();
  });

  it('409 AMOUNT_MISMATCH and no queue when the job grew after the order', async () => {
    useScriptedDb([
      sessionRule(TOKEN),
      ['FROM payment_orders po', [orderRow({ amount: '1.00', total_amount: '100.00' })]],
    ]);

    const res = await request(app)
      .post(`${API}/payment/verify`)
      .set('X-Session-Token', TOKEN)
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AMOUNT_MISMATCH');
    expect(queueService.enqueueJob).not.toHaveBeenCalled();
  });

  it('401 without the session token', async () => {
    useScriptedDb([sessionRule(TOKEN)]);
    const res = await request(app).post(`${API}/payment/verify`).send(body);
    expect(res.status).toBe(401);
  });
});

describe('POST /payment/failure', () => {
  it('409 ORDER_NOT_FAILABLE for a captured order', async () => {
    const db = useScriptedDb([
      sessionRule(TOKEN),
      ['SELECT status FROM payment_orders', [{ status: 'captured' }]],
    ]);

    const res = await request(app)
      .post(`${API}/payment/failure`)
      .set('X-Session-Token', TOKEN)
      .send({ orderId: 'order_1', errorCode: 'X', errorDescription: 'forged' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_NOT_FAILABLE');
    expect(db.sqlFor('UPDATE print_jobs')).toHaveLength(0);
  });
});

describe('POST /payment/webhook', () => {
  const SECRET = 'whsec_route_test';
  const original = env.payment.razorpay_webhook_secret;
  beforeAll(() => {
    env.payment.razorpay_webhook_secret = SECRET;
  });
  afterAll(() => {
    env.payment.razorpay_webhook_secret = original;
  });

  const payload = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_w',
          order_id: 'order_1',
          amount: 1000,
          status: 'captured',
          method: 'upi',
        },
      },
    },
  });
  const sign = (raw: string) => crypto.createHmac('sha256', SECRET).update(raw).digest('hex');

  it('captures with a valid signature over the raw body (no session token)', async () => {
    useScriptedDb([['FROM payment_orders po', [orderRow()]]]);

    const res = await request(app)
      .post(`${API}/payment/webhook`)
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', sign(payload))
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ handled: true, event: 'payment.captured' });
    expect(queueService.enqueueJob).toHaveBeenCalled();
  });

  it('400 for a forged signature', async () => {
    useScriptedDb([['FROM payment_orders po', [orderRow()]]]);

    const res = await request(app)
      .post(`${API}/payment/webhook`)
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', sign(payload + ' '))
      .send(payload);

    expect(res.status).toBe(400);
    expect(queueService.enqueueJob).not.toHaveBeenCalled();
  });
});

describe('DELETE /documents/:documentId', () => {
  it('409 DOCUMENT_IN_USE when its job is paid or queued', async () => {
    const db = useScriptedDb([
      sessionRule(TOKEN),
      ['FROM documents WHERE id', [{ id: DOC, s3_key: 'k', file_type: 'application/pdf' }]],
      ['FROM print_jobs', [{ x: 1 }]],
    ]);

    const res = await request(app).delete(`${API}/documents/${DOC}`).set('X-Session-Token', TOKEN);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOCUMENT_IN_USE');
    expect(db.sqlFor('DELETE FROM documents')).toHaveLength(0);
  });

  it('deletes a document with no paid job', async () => {
    const db = useScriptedDb([
      sessionRule(TOKEN),
      ['FROM documents WHERE id', [{ id: DOC, s3_key: 'k', file_type: 'application/pdf' }]],
    ]);

    const res = await request(app).delete(`${API}/documents/${DOC}`).set('X-Session-Token', TOKEN);

    expect(res.status).toBe(200);
    expect(db.sqlFor('DELETE FROM documents')).toHaveLength(1);
  });
});
