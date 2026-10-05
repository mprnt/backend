import request from 'supertest';
import app from '../../src/app';
import { adminToken, useScriptedDb } from '../helpers/http';

jest.mock('../../src/config/database');
const refundPayment = jest.fn();
jest.mock('../../src/services/razorpayService', () => ({
  RazorpayService: jest.fn().mockImplementation(() => ({ refundPayment })),
}));

const API = '/api/v1';
const JOB = '88888888-8888-4888-8888-888888888888';
const lead = { name: 'Ada', email: 'ada@example.com', message: 'Need 3 kiosks' };

describe('POST /public/leads', () => {
  // All requests share one IP and the limiter allows 5 per 15 minutes; the
  // order of these tests is part of the contract being checked.
  it('stores a valid lead and returns 201', async () => {
    const db = useScriptedDb([
      ['INSERT INTO leads', [{ id: 'lead-1', created_at: new Date('2026-10-05T00:00:00Z') }]],
    ]);

    const res = await request(app)
      .post(`${API}/public/leads`)
      .send({ ...lead, phone: '', extra: 'stripped' });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ leadId: 'lead-1', createdAt: '2026-10-05T00:00:00.000Z' });
    const params = db.sqlFor('INSERT INTO leads')[0].params;
    expect(params.slice(0, 6)).toEqual([
      'Ada',
      'ada@example.com',
      null,
      null,
      'Need 3 kiosks',
      'web',
    ]);
  });

  it('400 on invalid input', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .post(`${API}/public/leads`)
      .send({ name: '', email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('honeypot: answers 201 but stores nothing', async () => {
    const db = useScriptedDb([]);
    const res = await request(app)
      .post(`${API}/public/leads`)
      .send({ ...lead, website: 'http://spam.test' });
    expect(res.status).toBe(201);
    expect(db.sqlFor('INSERT INTO leads')).toHaveLength(0);
  });

  it('429 after 5 submissions from one IP', async () => {
    useScriptedDb([['INSERT INTO leads', [{ id: 'l', created_at: new Date() }]]]);
    await request(app).post(`${API}/public/leads`).send(lead);
    await request(app).post(`${API}/public/leads`).send(lead);
    const res = await request(app).post(`${API}/public/leads`).send(lead);
    expect(res.status).toBe(429);
  });
});

describe('GET /admin/leads', () => {
  it('401 without a token, 403 for shop staff', async () => {
    useScriptedDb([]);
    expect((await request(app).get(`${API}/admin/leads`)).status).toBe(401);
    const res = await request(app)
      .get(`${API}/admin/leads`)
      .set('Authorization', `Bearer ${adminToken({ role: 'owner', org: 'org-1' })}`);
    expect(res.status).toBe(403);
  });

  it('lists leads for a super admin', async () => {
    const db = useScriptedDb([
      ['COUNT(*) AS total FROM leads', [{ total: '1' }]],
      [
        'FROM leads ORDER BY',
        [
          {
            id: 'lead-1',
            name: 'Ada',
            email: 'ada@example.com',
            phone: null,
            company: null,
            message: 'hi',
            source: 'web',
            created_at: new Date('2026-10-05T00:00:00Z'),
          },
        ],
      ],
    ]);

    const res = await request(app)
      .get(`${API}/admin/leads?limit=10&offset=0`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.pagination).toEqual({ total: 1, limit: 10, offset: 0 });
    expect(res.body.data.leads[0]).toMatchObject({
      id: 'lead-1',
      createdAt: '2026-10-05T00:00:00.000Z',
    });
    expect(db.sqlFor('FROM leads ORDER BY')[0].params).toEqual([10, 0]);
  });
});

describe('POST /admin/print-jobs/:jobId/refund', () => {
  const owner = () => adminToken({ role: 'owner', org: 'org-1', perms: ['refunds:issue'] });
  const rules = (refundExists = false) =>
    [
      [
        'FROM print_jobs WHERE id',
        [{ id: JOB, status: 'queued', payment_status: 'paid', organization_id: 'org-1' }],
      ],
      [
        'FROM payment_refunds',
        refundExists
          ? [
              {
                job_id: JOB,
                refund_id: 'rfnd_1',
                payment_id: 'pay_1',
                order_id: 'order_1',
                amount: '12.00',
                currency: 'INR',
                status: 'processed',
                created_at: new Date(),
              },
            ]
          : [],
      ],
      ['FROM print_queue', [{ status: 'queued' }]],
      [
        'FROM payment_transactions',
        [{ payment_id: 'pay_1', order_id: 'order_1', amount: '12.00', currency: 'INR' }],
      ],
      [
        'INSERT INTO payment_refunds',
        [
          {
            job_id: JOB,
            refund_id: 'rfnd_1',
            payment_id: 'pay_1',
            order_id: 'order_1',
            amount: '12.00',
            currency: 'INR',
            status: 'processed',
            created_at: new Date(),
          },
        ],
      ],
    ] as never;

  beforeEach(() => {
    refundPayment.mockReset().mockResolvedValue({
      refundId: 'rfnd_1',
      paymentId: 'pay_1',
      amount: 12,
      currency: 'INR',
      status: 'processed',
    });
  });

  it('403 without refunds:issue', async () => {
    useScriptedDb(rules());
    const res = await request(app)
      .post(`${API}/admin/print-jobs/${JOB}/refund`)
      .set('Authorization', `Bearer ${adminToken({ role: 'manager', org: 'org-1', perms: [] })}`)
      .send({ reason: 'jammed' });
    expect(res.status).toBe(403);
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it('400 without a reason', async () => {
    useScriptedDb(rules());
    const res = await request(app)
      .post(`${API}/admin/print-jobs/${JOB}/refund`)
      .set('Authorization', `Bearer ${owner()}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('refunds, audits, and returns the refund', async () => {
    const db = useScriptedDb(rules());

    const res = await request(app)
      .post(`${API}/admin/print-jobs/${JOB}/refund`)
      .set('Authorization', `Bearer ${owner()}`)
      .send({ reason: 'printer jammed' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      jobId: JOB,
      refundId: 'rfnd_1',
      amount: 12,
      alreadyRefunded: false,
    });
    expect(res.body.data.organizationId).toBeUndefined();
    const audit = db.sqlFor('INSERT INTO audit_logs');
    expect(audit).toHaveLength(1);
    expect(audit[0].params).toContain('payment.refunded');
  });

  it('is idempotent: no second gateway call, no second audit row', async () => {
    const db = useScriptedDb(rules(true));

    const res = await request(app)
      .post(`${API}/admin/print-jobs/${JOB}/refund`)
      .set('Authorization', `Bearer ${owner()}`)
      .send({ reason: 'printer jammed' });

    expect(res.status).toBe(200);
    expect(res.body.data.alreadyRefunded).toBe(true);
    expect(refundPayment).not.toHaveBeenCalled();
    expect(db.sqlFor('INSERT INTO audit_logs')).toHaveLength(0);
  });
});
