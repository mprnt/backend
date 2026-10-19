import { QueueService } from '../../src/services/queueService';
import { SessionService } from '../../src/services/sessionService';
import { scriptedDb } from '../helpers/fakeDb';
import { AppError } from '../../src/middleware/errorHandler';
import { db as sharedDb } from '../../src/config/database';
import env from '../../src/config/environment';

jest.mock('../../src/config/database');

const PRINTER = '7d00a3fe-55f5-4dc5-9fce-cb0ed84ee0ab';

describe('print window: a paid job prints within the window or not at all', () => {
  describe('polling', () => {
    it('only offers queued jobs whose paid_at is inside the window', async () => {
      const db = scriptedDb([
        [
          'FROM printers',
          [
            {
              id: PRINTER,
              kiosk_id: 'k1',
              status: 'online',
              supports_color: true,
              supports_double_sided: true,
              max_copies: 50,
            },
          ],
        ],
        ["pq.status IN ('assigned', 'printing')", []],
      ]);
      const service = new QueueService(db as never);

      await service.pollQueue({
        printerId: 'RPI_M001_01',
        printerUuid: PRINTER,
        capabilities: {
          supportsColor: true,
          supportsDoubleSided: true,
          maxCopies: 50,
          supportedPaperSizes: ['a4'],
        },
      });

      const jobQuery = db.sqlFor('AND pj.paid_at >')[0];
      expect(jobQuery.sql).toContain('make_interval(mins => 15)');
      expect(jobQuery.sql).toContain("pq.status = 'queued'");
    });
  });

  describe('expireOutOfWindow', () => {
    it('fails queued and assigned jobs whose window has closed, and never printing ones', async () => {
      const db = scriptedDb([
        ['UPDATE print_queue pq SET', [{ job_id: 'job-old' }]],
        ['UPDATE print_jobs SET status', []],
      ]);
      const service = new QueueService(db as never);

      const count = await service.expireOutOfWindow();

      expect(count).toBe(1);
      const sql = db.sqlFor('UPDATE print_queue pq SET')[0].sql;
      expect(sql).toContain("pq.status IN ('queued', 'assigned')");
      expect(sql).toContain("error_code = 'PRINT_WINDOW_EXPIRED'");
      expect(sql).toContain('pj.paid_at < NOW() - make_interval(mins => 15)');
      expect(sql).not.toContain("'printing'");
      // The job is failed, but its payment stays 'paid' so it is flagged for refund.
      const jobSql = db.sqlFor('UPDATE print_jobs SET status')[0];
      expect(jobSql.sql).toContain("status = 'failed'");
      expect(jobSql.sql).not.toContain('payment_status');
      expect(jobSql.params).toEqual([['job-old']]);
    });

    it('does nothing when no job is outside its window', async () => {
      const db = scriptedDb([]);
      const service = new QueueService(db as never);

      expect(await service.expireOutOfWindow()).toBe(0);
      expect(db.sqlFor('UPDATE print_jobs SET status')).toHaveLength(0);
    });
  });

  describe('session creation with an offline printer', () => {
    it('refuses with 503 PRINTER_OFFLINE when no printer at the kiosk has heartbeated', async () => {
      const kiosk = {
        id: 'k1',
        kiosk_id: 'M001',
        status: 'active',
        location: 'L',
        capabilities: {},
      };
      const db = scriptedDb([
        ['FROM kiosks WHERE kiosk_id', [kiosk]],
        ['FROM printers', []],
      ]);
      // SessionService reads the shared database module, so route it to the fake.
      (sharedDb.query as unknown as jest.Mock).mockImplementation(db.query);
      const service = new SessionService();

      const err = await service.createSession('M001').catch((e: AppError) => e);

      expect((err as AppError).statusCode).toBe(503);
      expect((err as AppError).code).toBe('PRINTER_OFFLINE');
      expect(db.sqlFor('INSERT INTO print_sessions')).toHaveLength(0);
    });
  });
});

describe('PRINTER_HEARTBEAT_REQUIRED (testing switch)', () => {
  const kiosk = { id: 'k1', kiosk_id: 'M001', status: 'active', location: 'L', capabilities: {} };
  const original = env.printer.heartbeat_required;
  afterEach(() => {
    env.printer.heartbeat_required = original;
  });

  it('when false, a session is created without any heartbeat check', async () => {
    env.printer.heartbeat_required = false;
    const db = scriptedDb([
      ['FROM kiosks WHERE kiosk_id', [kiosk]],
      [
        'INSERT INTO print_sessions',
        [{ id: 'ps-1', session_id: 'S1', status: 'draft', expires_at: new Date() }],
      ],
    ]);
    (sharedDb.query as unknown as jest.Mock).mockImplementation(db.query);

    await expect(new SessionService().createSession('M001')).resolves.toBeDefined();
    expect(db.sqlFor('FROM printers')).toHaveLength(0);
  });
});
