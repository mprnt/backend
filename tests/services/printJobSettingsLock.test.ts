import { PrintJobService } from '../../src/services/printJobService';
import { pricingService } from '../../src/services/pricingService';
import { AppError } from '../../src/middleware/errorHandler';
import { scriptedDb, ScriptedDb } from '../helpers/fakeDb';

jest.mock('../../src/config/database');

const JOB = '22222222-2222-4222-8222-222222222222';

const jobRow = (over: Record<string, unknown> = {}) => ({
  id: JOB,
  status: 'pending',
  payment_status: 'unpaid',
  color_mode: 'bw',
  copies: 1,
  page_range: 'all',
  custom_range: null,
  print_sides: 'single',
  paper_size: 'a4',
  orientation: 'portrait',
  page_count: 2,
  kiosk_id: 'k1',
  ...over,
});

describe('PrintJobService.updateSettings — settings lock', () => {
  let db: ScriptedDb;
  let service: PrintJobService;

  beforeEach(() => {
    jest.spyOn(pricingService, 'calculatePrice').mockResolvedValue({
      pricePerPage: 2,
      totalPages: 200,
      totalAmount: 400,
    } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  const build = (rules: Parameters<typeof scriptedDb>[0]) => {
    db = scriptedDb(rules);
    service = new PrintJobService(db as never);
  };

  it('locks the job row while reading it', async () => {
    build([
      ['FROM print_jobs pj', [jobRow()]],
      ['UPDATE print_jobs', [jobRow({ total_amount: '400', base_price_per_page: '2' })]],
    ]);

    await service.updateSettings({ jobId: JOB, settings: { copies: 100 } });

    expect(db.sqlFor('FROM print_jobs pj')[0].sql).toContain('FOR UPDATE OF pj');
    expect(db.sqlFor('UPDATE print_jobs')).toHaveLength(1);
  });

  it('refuses once a payment order exists (pay-less-print-more)', async () => {
    build([
      ['FROM print_jobs pj', [jobRow()]],
      ['FROM payment_orders', [{ '?column?': 1 }]],
    ]);

    const err = await service
      .updateSettings({ jobId: JOB, settings: { copies: 100, colorMode: 'color' } })
      .catch((e: AppError) => e);

    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('JOB_SETTINGS_LOCKED');
    expect(db.sqlFor("status <> 'failed'")).toHaveLength(1);
    expect(db.sqlFor('UPDATE print_jobs')).toHaveLength(0);
    expect(db.sqlFor('ROLLBACK')).toHaveLength(1);
  });

  it('refuses a paid job', async () => {
    build([['FROM print_jobs pj', [jobRow({ payment_status: 'paid' })]]]);

    await expect(
      service.updateSettings({ jobId: JOB, settings: { copies: 3 } })
    ).rejects.toMatchObject({ statusCode: 409, code: 'JOB_SETTINGS_LOCKED' });
  });

  it('allows changes when only failed orders exist', async () => {
    // The open-order query filters failed orders out, so it returns no rows.
    build([
      ['FROM print_jobs pj', [jobRow()]],
      ['UPDATE print_jobs', [jobRow({ total_amount: '400', base_price_per_page: '2' })]],
    ]);

    const res = await service.updateSettings({ jobId: JOB, settings: { copies: 100 } });

    expect(res.pricing.totalAmount).toBe(400);
  });
});
