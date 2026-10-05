import request from 'supertest';
import app from '../../src/app';
import { sessionRule, useScriptedDb } from '../helpers/http';

jest.mock('../../src/config/database');

// What the QR app reads after a reload to learn whether money was taken, and
// whether that payment actually queued the job (AMOUNT_MISMATCH did not).

const API = '/api/v1';
const JOB = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'a'.repeat(64);
const ORDER = 'order_1';

const orderRow = (status: string, amount: string, total: string, paymentStatus = 'paid') => ({
  id: 'po-1',
  order_id: ORDER,
  amount,
  currency: 'INR',
  status,
  created_at: new Date('2026-10-05T00:00:00Z'),
  total_amount: total,
  payment_status: paymentStatus,
});

describe('GET /payment/order/:orderId/status', () => {
  it.each([
    ['captured', '10.00', '10.00', true, false],
    ['captured', '10.00', '40.00', true, true],
    ['created', '10.00', '40.00', false, false],
    ['refunded', '10.00', '10.00', false, false],
  ])('%s order %s vs job %s -> isPaid %s, amountMismatch %s', async (st, amt, total, paid, mm) => {
    useScriptedDb([sessionRule(TOKEN), ['po.created_at,', [orderRow(st, amt, total)]]]);
    const res = await request(app)
      .get(`${API}/payment/order/${ORDER}/status`)
      .set('X-Session-Token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orderId: ORDER, isPaid: paid, amountMismatch: mm });
  });

  it('a capture on an already refunded job is not reported as paid', async () => {
    useScriptedDb([
      sessionRule(TOKEN),
      ['po.created_at,', [orderRow('captured', '10.00', '10.00', 'refunded')]],
    ]);
    const res = await request(app)
      .get(`${API}/payment/order/${ORDER}/status`)
      .set('X-Session-Token', TOKEN);
    expect(res.body.data.isPaid).toBe(false);
  });

  it('404 for an unknown order', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .get(`${API}/payment/order/${ORDER}/status`)
      .set('X-Session-Token', TOKEN);
    expect(res.status).toBe(404);
  });
});

describe('GET /sessions/:sessionId payment', () => {
  const base = (payment: unknown[]) =>
    [
      sessionRule(TOKEN),
      [
        'SELECT * FROM print_sessions WHERE session_id',
        [
          {
            id: 'ps-1',
            session_id: 'S1',
            kiosk_id: 'k1',
            status: 'active',
            expires_at: new Date(Date.now() + 600_000),
          },
        ],
      ],
      ['FROM kiosks WHERE id', [{ kiosk_id: 'M001', location: 'L', status: 'active' }]],
      [
        'FROM print_jobs WHERE session_id',
        [{ id: JOB, status: 'queued', total_amount: '10.00', base_price_per_page: '5.00' }],
      ],
      ['AS amount_mismatch', payment],
    ] as Parameters<typeof useScriptedDb>[0];

  it('reports the captured payment from payment_transactions', async () => {
    const db = useScriptedDb(
      base([
        {
          transaction_id: 'pay_1',
          status: 'captured',
          amount: '10.00',
          payment_method: 'upi',
          completed_at: new Date('2026-10-05T00:00:00Z'),
          amount_mismatch: false,
        },
      ])
    );
    const res = await request(app).get(`${API}/sessions/S1`).set('X-Session-Token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.data.payment).toMatchObject({
      transactionId: 'pay_1',
      status: 'captured',
      amount: 10,
      amountMismatch: false,
    });
    expect(db.sqlFor('FROM payments ')).toHaveLength(0);
    expect(db.sqlFor('AS amount_mismatch')[0].params).toEqual([JOB]);
  });

  it('flags a payment that was taken but not queued', async () => {
    useScriptedDb(
      base([
        {
          transaction_id: 'pay_1',
          status: 'captured',
          amount: '10.00',
          payment_method: 'upi',
          completed_at: new Date(),
          amount_mismatch: true,
        },
      ])
    );
    const res = await request(app).get(`${API}/sessions/S1`).set('X-Session-Token', TOKEN);
    expect(res.body.data.payment.amountMismatch).toBe(true);
  });

  it('payment is null before any capture', async () => {
    useScriptedDb(base([]));
    const res = await request(app).get(`${API}/sessions/S1`).set('X-Session-Token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.data.payment).toBeNull();
  });
});
