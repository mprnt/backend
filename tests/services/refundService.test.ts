import { RefundService } from '../../src/services/refundService';
import { AppError } from '../../src/middleware/errorHandler';
import { scriptedDb, ScriptedDb, Rule } from '../helpers/fakeDb';

jest.mock('../../src/config/database');

const JOB = '33333333-3333-4333-8333-333333333333';
const ORG = 'org-1';

const job = (over: Record<string, unknown> = {}) => ({
  id: JOB,
  status: 'queued',
  payment_status: 'paid',
  organization_id: ORG,
  ...over,
});
const captured = { payment_id: 'pay_1', order_id: 'order_1', amount: '12.00', currency: 'INR' };
const refundRow = {
  job_id: JOB,
  refund_id: 'rfnd_1',
  payment_id: 'pay_1',
  order_id: 'order_1',
  amount: '12.00',
  currency: 'INR',
  status: 'processed',
  created_at: new Date('2026-10-05T00:00:00Z'),
};

describe('RefundService.refundJob', () => {
  let db: ScriptedDb;
  let gateway: { refundPayment: jest.Mock };
  let service: RefundService;

  const build = (rules: Rule[]) => {
    db = scriptedDb(rules);
    gateway = {
      refundPayment: jest.fn().mockResolvedValue({
        refundId: 'rfnd_1',
        paymentId: 'pay_1',
        amount: 12,
        currency: 'INR',
        status: 'processed',
      }),
    };
    service = new RefundService(db as never, gateway);
  };

  const call = (over: Partial<Parameters<RefundService['refundJob']>[0]> = {}) =>
    service.refundJob({
      jobId: JOB,
      reason: 'printer jammed',
      tenantId: ORG,
      requestedBy: 'a1',
      ...over,
    });

  it('refunds a paid, unprinted job and cancels it', async () => {
    build([
      ['FROM print_jobs WHERE id', [job()]],
      ['FROM print_queue', [{ status: 'queued' }]],
      ['FROM payment_transactions', [captured]],
      ['INSERT INTO payment_refunds', [refundRow]],
    ]);

    const res = await call();

    expect(gateway.refundPayment).toHaveBeenCalledWith('pay_1', 12, { job_id: JOB });
    expect(res).toMatchObject({ refundId: 'rfnd_1', amount: 12, alreadyRefunded: false });
    expect(db.sqlFor("payment_status = 'refunded'")).toHaveLength(1);
    expect(db.sqlFor("UPDATE print_queue SET status = 'cancelled'")).toHaveLength(1);
    expect(db.sqlFor('COMMIT')).toHaveLength(1);
    expect(db.sqlFor('FROM print_jobs WHERE id')[0].sql).toContain('FOR UPDATE');
  });

  it('is idempotent: a second call returns the stored refund without the gateway', async () => {
    build([
      ['FROM print_jobs WHERE id', [job({ payment_status: 'refunded', status: 'cancelled' })]],
      ['FROM payment_refunds', [refundRow]],
    ]);

    const res = await call();

    expect(res.alreadyRefunded).toBe(true);
    expect(gateway.refundPayment).not.toHaveBeenCalled();
    expect(db.sqlFor('INSERT INTO payment_refunds')).toHaveLength(0);
  });

  it.each([
    ['unpaid job', job({ payment_status: 'unpaid', status: 'pending' }), []],
    ['job printing', job({ status: 'printing' }), [{ status: 'printing' }]],
    ['queue row claimed by a printer', job(), [{ status: 'assigned' }]],
    ['completed job', job({ status: 'completed' }), [{ status: 'completed' }]],
  ])('refuses a %s with 409 NOT_REFUNDABLE', async (_label, jobRow, queueRows) => {
    build([
      ['FROM print_jobs WHERE id', [jobRow]],
      ['FROM print_queue', queueRows],
      ['FROM payment_transactions', [captured]],
    ]);

    await expect(call()).rejects.toMatchObject({ statusCode: 409, code: 'NOT_REFUNDABLE' });
    expect(gateway.refundPayment).not.toHaveBeenCalled();
  });

  it("hides another shop's job behind a 404", async () => {
    build([['FROM print_jobs WHERE id', [job({ organization_id: 'org-2' })]]]);

    await expect(call()).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lets a super admin (no tenant) refund any shop', async () => {
    build([
      ['FROM print_jobs WHERE id', [job({ organization_id: 'org-2' })]],
      ['FROM payment_transactions', [captured]],
      ['INSERT INTO payment_refunds', [refundRow]],
    ]);

    await expect(call({ tenantId: null })).resolves.toMatchObject({ refundId: 'rfnd_1' });
  });

  it('rolls back and reports 502 when the gateway refuses', async () => {
    build([
      ['FROM print_jobs WHERE id', [job()]],
      ['FROM payment_transactions', [captured]],
    ]);
    gateway.refundPayment.mockRejectedValue(new Error('BAD_REQUEST_ERROR'));

    const err = await call().catch((e: AppError) => e);

    expect((err as AppError).statusCode).toBe(502);
    expect((err as AppError).code).toBe('REFUND_FAILED');
    expect(db.sqlFor('INSERT INTO payment_refunds')).toHaveLength(0);
    expect(db.sqlFor('ROLLBACK')).toHaveLength(1);
  });
});
