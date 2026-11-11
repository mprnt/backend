/**
 * Expiry, release, physical outcome and evidence — against a real PostgreSQL.
 *
 * Runs only when TEST_DATABASE_URL is set, and only against a database whose name
 * contains "test". It refuses anything else, so a production URL can never be used.
 *
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mprnt_test \
 *     npx jest tests/integration --coverage=false
 *
 * The schema must already be migrated (migrations/*.ts, then *.sql in order).
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { QueueService } from '../../src/services/queueService';
import { PhysicalOutcomeService } from '../../src/services/physicalOutcomeService';
import { AppError } from '../../src/utils/errors';
import type { Database } from '../../src/config/database';

jest.mock('../../src/config/database');
jest.mock('../../src/services/storageService', () => ({
  storageService: { getPresignedUrl: jest.fn(async () => 'https://signed.example/doc') },
}));
jest.mock('../../src/services/websocketService', () => ({
  websocketService: { broadcastJobStatus: jest.fn() },
}));

const DB_URL = process.env.TEST_DATABASE_URL;

function suiteFor(): jest.Describe {
  if (!DB_URL) return describe.skip;
  const name = new URL(DB_URL).pathname.replace(/^\//, '');
  if (!/test/i.test(name)) {
    throw new Error(`Refusing to run: "${name}" is not a test database`);
  }
  return describe;
}

const CAPS = {
  supportsColor: true,
  supportsDoubleSided: true,
  maxCopies: 50,
  supportedPaperSizes: ['a4'],
};

const MIGRATION_026 = fs.readFileSync(
  path.join(__dirname, '../../migrations/026_print_deadline_expiry.sql'),
  'utf8'
);

suiteFor()('expiry, release, physical outcome and evidence (real database)', () => {
  let pool: Pool;
  let queue: QueueService;
  let outcomes: PhysicalOutcomeService;
  let kioskId: string;
  const operatorId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    // Columns the poll query reads that the repo's documents migration lacks (test DB only).
    await pool.query(`ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS s3_key TEXT,
        ADD COLUMN IF NOT EXISTS file_type TEXT,
        ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT`);
    const adapter = {
      query: (text: string, params?: unknown[]) => pool.query(text, params as never),
      getClient: () => pool.connect(),
    } as unknown as Database;
    queue = new QueueService(adapter);
    outcomes = new PhysicalOutcomeService(adapter);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE print_physical_evidence, print_attempts, print_queue,
        print_jobs, documents, print_sessions, printers, kiosks RESTART IDENTITY CASCADE`);
    const k = await pool.query<{ id: string }>(
      `INSERT INTO kiosks (kiosk_id, location, name) VALUES ('M001', 'Test', 'Test kiosk') RETURNING id`
    );
    kioskId = k.rows[0].id;
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function printer(label: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO printers (printer_id, kiosk_id, name, status, supports_color,
              supports_double_sided, max_copies, supported_paper_sizes, last_heartbeat)
       VALUES ($1, $2, $1, 'online', true, true, 50, ARRAY['a4'], NOW())
       RETURNING id`,
      [label, kioskId]
    );
    return r.rows[0].id;
  }

  /** A paid, queued job whose deadline is `deadlineMinutes` from now (negative = already past). */
  async function job(deadlineMinutes = 10, totalPages = 6): Promise<string> {
    const s = await pool.query<{ id: string }>(
      `INSERT INTO print_sessions (session_id) VALUES ($1) RETURNING id`,
      [`S-${randomUUID().replace(/-/g, '').slice(0, 16)}`]
    );
    const d = await pool.query<{ id: string }>(
      `INSERT INTO documents (session_id, original_filename, file_size, mime_type,
              storage_path, page_count, s3_key, file_type, file_size_bytes)
       VALUES ($1, 'r.pdf', 1000, 'application/pdf', 'p', 3, 'k/r.pdf', 'application/pdf', 1000)
       RETURNING id`,
      [s.rows[0].id]
    );
    const j = await pool.query<{ id: string }>(
      `INSERT INTO print_jobs (session_id, document_id, kiosk_id, color_mode, copies,
              page_range, print_sides, paper_size, orientation, total_pages,
              base_price_per_page, total_amount, status, payment_status,
              paid_at, queued_at, print_deadline_at)
       VALUES ($1, $2, $3, 'bw', 2, 'all', 'single', 'a4', 'portrait', $4,
               1, 10, 'queued', 'paid',
               NOW() - make_interval(mins => 1), NOW(),
               NOW() + make_interval(mins => $5))
       RETURNING id`,
      [s.rows[0].id, d.rows[0].id, kioskId, totalPages, deadlineMinutes]
    );
    await pool.query(
      `INSERT INTO print_queue (job_id, status, priority, queued_at, max_retries)
       VALUES ($1, 'queued', 0, NOW(), 3)`,
      [j.rows[0].id]
    );
    return j.rows[0].id;
  }

  const deadlineOf = async (jobId: string) =>
    (
      await pool.query<{ d: Date }>(`SELECT print_deadline_at AS d FROM print_jobs WHERE id = $1`, [
        jobId,
      ])
    ).rows[0].d;

  const queueRow = async (jobId: string) =>
    (
      await pool.query(
        `SELECT pq.*, pj.status AS job_status FROM print_queue pq
           JOIN print_jobs pj ON pj.id = pq.job_id WHERE pq.job_id = $1`,
        [jobId]
      )
    ).rows[0];

  /** Move the database clock for one job: deadline now, or lease already expired. */
  const setDeadlineNow = (jobId: string) =>
    pool.query(`UPDATE print_jobs SET print_deadline_at = NOW() WHERE id = $1`, [jobId]);
  const expireLease = (jobId: string) =>
    pool.query(
      `UPDATE print_queue SET lease_expires_at = NOW() - interval '1 second' WHERE job_id = $1`,
      [jobId]
    );

  const poll = (printerUuid: string, label = 'RPI') =>
    queue.pollQueue({ printerId: label, printerUuid, capabilities: CAPS });

  /** Run a call that is expected to fail, and return the error. */
  async function failure(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
    try {
      await p;
    } catch (e) {
      const err = e as AppError;
      return { status: err.statusCode, code: err.code };
    }
    throw new Error('expected the call to fail');
  }

  const report = (
    printerUuid: string,
    jobId: string,
    body: Record<string, unknown> & { status: 'printing' | 'completed' | 'failed' | 'cancelled' }
  ) => queue.updateJobStatus({ jobId, printerUuid, ...body });

  const expiryReport = (printerUuid: string, jobId: string, attempt?: number) =>
    report(printerUuid, jobId, {
      status: 'failed',
      errorCode: 'PRINT_WINDOW_EXPIRED',
      printedPages: null,
      ...(attempt !== undefined ? { attempt } : {}),
    });

  // ---------------------------------------------------------------------------
  // 1. Deadline and retries
  // ---------------------------------------------------------------------------
  describe('1. deadline is fixed, and nothing renews or requeues a job at or after it', () => {
    it('the deadline stays the same across assignment, resume and lease renewal', async () => {
      const p = await printer('RPI_A');
      const j = await job(10);
      const stored = (await deadlineOf(j)).toISOString();

      const first = await poll(p);
      expect(first?.jobId).toBe(j);
      expect(first?.printDeadlineAt).toBe(stored);
      expect(first?.attempt).toBe(1);

      await report(p, j, { status: 'printing', attempt: 1 }); // renews the lease

      const resumed = await poll(p);
      expect(resumed?.jobId).toBe(j);
      expect(resumed?.attempt).toBe(2);
      expect(resumed?.printDeadlineAt).toBe(stored);
      expect((await deadlineOf(j)).toISOString()).toBe(stored);
    });

    it('at the exact deadline, poll cannot return or renew the held job, even before the sweep', async () => {
      const a = await printer('RPI_A');
      const b = await printer('RPI_B');
      const j = await job(10);
      await poll(a);
      await setDeadlineNow(j);

      expect(await poll(a)).toBeNull();
      const row = await queueRow(j);
      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('PRINT_WINDOW_EXPIRED');
      expect(row.printer_id).toBeNull();
      expect(row.last_printer_id).toBe(a);
      expect(row.lease_count).toBe(1); // not renewed
      expect(row.job_status).toBe('failed');
      expect(await poll(b)).toBeNull(); // not requeued to anyone else
    });

    it('a status update at the deadline cannot renew the lease', async () => {
      const a = await printer('RPI_A');
      const j = await job(10);
      await poll(a);
      await setDeadlineNow(j);

      const res = await report(a, j, { status: 'printing', attempt: 1 });

      expect(res).toEqual({
        applied: false,
        status: 'failed',
        printerReleased: true,
        expiredJobIds: [j],
      });
      const row = await queueRow(j);
      expect(row.status).toBe('failed');
      expect(row.lease_expires_at).toBeNull();
      expect(row.lease_count).toBe(1);
    });

    it('reclaim fails a job past its deadline instead of requeuing it', async () => {
      const a = await printer('RPI_A');
      const b = await printer('RPI_B');
      const j = await job(10);
      await poll(a);
      await expireLease(j);
      await setDeadlineNow(j);

      await queue.reclaimExpiredLeases();

      const row = await queueRow(j);
      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('PRINT_WINDOW_EXPIRED');
      expect(await poll(b)).toBeNull();
    });

    it('reclaim still requeues a job whose deadline is in the future (control)', async () => {
      const a = await printer('RPI_A');
      const j = await job(10);
      await poll(a);
      await expireLease(j);

      expect(await queue.reclaimExpiredLeases()).toBe(1);
      const row = await queueRow(j);
      expect(row.status).toBe('queued');
      expect(row.printer_id).toBeNull();
    });

    it('an expiry report before the deadline is refused and leaves the assignment intact', async () => {
      const a = await printer('RPI_A');
      const j = await job(10);
      await poll(a);
      const before = await queueRow(j);

      const err = await failure(expiryReport(a, j, 1));

      expect(err).toEqual({ status: 409, code: 'DEADLINE_NOT_REACHED' });
      const after = await queueRow(j);
      expect(after.status).toBe('assigned');
      expect(after.printer_id).toBe(a);
      expect(after.lease_count).toBe(before.lease_count);
      expect(after.lease_expires_at).toEqual(before.lease_expires_at);
      expect(after.updated_at).toEqual(before.updated_at);
    });

    it('the sweep also fails a printing job past its deadline (previously excluded)', async () => {
      const a = await printer('RPI_A');
      const late = await job(10);
      const onTime = await job(10);
      await poll(a);
      await report(a, late, { status: 'printing', attempt: 1 });
      // A second printer holds nothing, so only `late` is printing.
      await pool.query(
        `UPDATE print_jobs SET print_deadline_at = NOW() - interval '1 minute' WHERE id = $1`,
        [late]
      );

      expect(await queue.expireOutOfWindow()).toBe(1);
      expect((await queueRow(late)).status).toBe('failed');
      expect((await queueRow(onTime)).status).toBe('queued');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Assignment release
  // ---------------------------------------------------------------------------
  describe('2. release: 200 for the holder, 403 for others, 409 for old attempts', () => {
    it('the holder gets an idempotent 200 with printerReleased after the sweep expired the job', async () => {
      const a = await printer('RPI_A');
      const j = await job(10);
      await poll(a);
      await setDeadlineNow(j);
      await queue.expireOutOfWindow();

      const first = await expiryReport(a, j, 1);
      expect(first).toEqual({ applied: false, status: 'failed', printerReleased: true });

      const before = await queueRow(j);
      const second = await expiryReport(a, j, 1);
      expect(second).toEqual({ applied: false, status: 'failed', printerReleased: true });
      expect((await queueRow(j)).updated_at).toEqual(before.updated_at);
    });

    it('a holder whose own report triggers the expiry gets applied: true', async () => {
      const a = await printer('RPI_A');
      const j = await job(10);
      await poll(a);
      await setDeadlineNow(j);

      expect(await expiryReport(a, j, 1)).toEqual({
        applied: true,
        status: 'failed',
        printerReleased: true,
        expiredJobIds: [j],
      });
    });

    it('a printer that never held the job gets 403 JOB_NOT_ASSIGNED', async () => {
      const a = await printer('RPI_A');
      const b = await printer('RPI_B');
      const j = await job(10);
      await poll(a);
      await setDeadlineNow(j);
      await queue.expireOutOfWindow();

      expect(await failure(expiryReport(b, j))).toEqual({ status: 403, code: 'JOB_NOT_ASSIGNED' });
    });

    it('an old attempt of a printer gets 409 STALE_ATTEMPT, even after the job moved on', async () => {
      const a = await printer('RPI_A');
      const b = await printer('RPI_B');
      const j = await job(10);
      await poll(a); // attempt 1 on A
      await expireLease(j);
      await queue.reclaimExpiredLeases(); // back to queued, before the deadline
      expect((await poll(b))?.attempt).toBe(2); // attempt 2 on B

      expect(await failure(report(a, j, { status: 'printing', attempt: 1 }))).toEqual({
        status: 409,
        code: 'STALE_ATTEMPT',
      });
      await setDeadlineNow(j);
      expect(await failure(expiryReport(a, j, 1))).toEqual({ status: 409, code: 'STALE_ATTEMPT' });
    });

    it('the last holder of a completed job is released with the same answer on every retry', async () => {
      const a = await printer('RPI_A');
      const b = await printer('RPI_B');
      const j = await job(10);
      await poll(a);
      expect(await report(a, j, { status: 'completed', attempt: 1 })).toEqual({
        applied: true,
        status: 'completed',
        printerReleased: true,
      });

      expect(await report(a, j, { status: 'completed', attempt: 1 })).toEqual({
        applied: false,
        status: 'completed',
        printerReleased: true,
      });
      expect(await failure(report(b, j, { status: 'completed', attempt: 1 }))).toEqual({
        status: 403,
        code: 'JOB_NOT_ASSIGNED',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Physical outcome
  // ---------------------------------------------------------------------------
  describe('3. physical outcome stays unknown until an operator verifies it', () => {
    /** Attempt 1 by A, then final. `cups` decides how the printer reports it. */
    async function finalJob(cups: 'completed' | 'failed', totalPages = 6) {
      const a = await printer('RPI_A');
      const j = await job(10, totalPages);
      await poll(a);
      await pool.query(`UPDATE print_queue SET max_retries = 1 WHERE job_id = $1`, [j]);
      if (cups === 'completed') {
        await report(a, j, { status: 'completed', attempt: 1 });
      } else {
        await report(a, j, { status: 'failed', errorCode: 'CUPS_ERROR', attempt: 1 });
      }
      return { a, j };
    }

    const verify = (jobId: string, body: Record<string, unknown>) =>
      outcomes.recordOperatorOutcome({
        jobId,
        operatorId,
        method: 'physical inspection',
        reason: 'Checked the tray and the output bin at the kiosk',
        attemptFindings: [],
        outcome: 'blank',
        verifiedPages: 0,
        ...body,
      } as never);

    it('CUPS success leaves the outcome unknown, and the evidence is kept', async () => {
      const { a, j } = await finalJob('completed');

      const ev = await outcomes.recordEvidence({
        jobId: j,
        printerUuid: a,
        attempt: 1,
        cupsJobId: 'mprnt-1',
        cupsState: 'completed',
      });

      expect(ev).toEqual({ applied: true, physicalOutcome: 'unknown' });
      expect((await queueRow(j)).physical_outcome).toBe('unknown');
      expect((await queueRow(j)).status).toBe('completed');
    });

    it('cups_failed alone cannot finalize not_printed; a verified zero count can', async () => {
      const { j } = await finalJob('failed');
      const findings = [
        { attempt: 1, printerId: (await queueRow(j)).printer_id, finding: 'cups_failed' },
      ];

      const refused = await failure(
        verify(j, { outcome: 'not_printed', verifiedPages: null, attemptFindings: findings })
      );
      expect(refused).toEqual({ status: 400, code: 'PHYSICAL_OUTCOME_INVALID' });

      const ok = await verify(j, {
        outcome: 'not_printed',
        verifiedPages: 0,
        attemptFindings: findings,
      });
      expect(ok).toEqual({ applied: true, physicalOutcome: 'not_printed', verifiedPages: 0 });
      expect((await queueRow(j)).status).toBe('failed'); // job status unchanged
    });

    it('a failed CUPS job with verified partial output is recorded as partial, status unchanged', async () => {
      const { a, j } = await finalJob('failed', 6);
      const findings = [{ attempt: 1, printerId: a, finding: 'cups_failed' }];

      const res = await verify(j, {
        outcome: 'partial',
        verifiedPages: 2,
        attemptFindings: findings,
      });

      expect(res).toEqual({ applied: true, physicalOutcome: 'partial', verifiedPages: 2 });
      const row = await queueRow(j);
      expect(row.physical_outcome).toBe('partial');
      expect(row.physical_verified_pages).toBe(2);
      expect(row.status).toBe('failed');
      expect(row.printed_pages).toBe(0); // the printer's count was never guessed from CUPS
    });

    it('a successful CUPS job with verified blank output is recorded as blank, status stays completed', async () => {
      const { a, j } = await finalJob('completed', 6);
      const findings = [{ attempt: 1, printerId: a, finding: 'cups_completed_blank' }];

      const res = await verify(j, {
        outcome: 'blank',
        verifiedPages: 0,
        attemptFindings: findings,
      });

      expect(res).toEqual({ applied: true, physicalOutcome: 'blank', verifiedPages: 0 });
      expect((await queueRow(j)).status).toBe('completed');
    });

    it('not_printed is refused when CUPS reported the attempt completed', async () => {
      const { a, j } = await finalJob('completed');
      const findings = [{ attempt: 1, printerId: a, finding: 'cups_completed_blank' }];

      expect(
        await failure(
          verify(j, { outcome: 'not_printed', verifiedPages: 0, attemptFindings: findings })
        )
      ).toEqual({ status: 400, code: 'PHYSICAL_OUTCOME_INVALID' });
    });

    it('printed needs the full count; a wrong count is refused', async () => {
      const { a, j } = await finalJob('completed', 6);
      const findings = [{ attempt: 1, printerId: a, finding: 'cups_completed_printed' }];

      expect(
        await failure(
          verify(j, { outcome: 'printed', verifiedPages: 5, attemptFindings: findings })
        )
      ).toEqual({ status: 400, code: 'PHYSICAL_OUTCOME_INVALID' });
      expect(
        await verify(j, { outcome: 'printed', verifiedPages: 6, attemptFindings: findings })
      ).toEqual({ applied: true, physicalOutcome: 'printed', verifiedPages: 6 });
    });

    it('the first verified outcome is final: the same again is a no-op, a different one conflicts', async () => {
      const { a, j } = await finalJob('completed');
      const findings = [{ attempt: 1, printerId: a, finding: 'cups_completed_blank' }];

      await verify(j, { outcome: 'blank', verifiedPages: 0, attemptFindings: findings });
      expect(
        await verify(j, { outcome: 'blank', verifiedPages: 0, attemptFindings: findings })
      ).toEqual({ applied: false, physicalOutcome: 'blank', verifiedPages: 0 });
      expect(
        await failure(
          verify(j, { outcome: 'printed', verifiedPages: 6, attemptFindings: findings })
        )
      ).toEqual({ status: 409, code: 'PHYSICAL_OUTCOME_CONFLICT' });
    });

    it('an outcome cannot be recorded while the job is still in progress', async () => {
      const a = await printer('RPI_A');
      const j = await job(10);
      await poll(a);

      expect(
        await failure(
          verify(j, {
            outcome: 'blank',
            verifiedPages: 0,
            attemptFindings: [{ attempt: 1, printerId: a, finding: 'unknown' }],
          })
        )
      ).toEqual({ status: 409, code: 'JOB_STILL_ACTIVE' });
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Evidence from multiple printers
  // ---------------------------------------------------------------------------
  describe('4. evidence: each printer may attach evidence only for an attempt it held', () => {
    it('two printers, two attempts: each can report its own, neither can report the other’s', async () => {
      const a = await printer('RPI_A');
      const b = await printer('RPI_B');
      const c = await printer('RPI_C'); // never held the job
      const j = await job(10);

      await poll(a); // attempt 1 on A
      await expireLease(j);
      await queue.reclaimExpiredLeases(); // requeued, deadline still in the future
      expect((await poll(b))?.attempt).toBe(2); // attempt 2 on B

      const ev = (printerUuid: string, attempt: number, cupsJobId = `cups-${attempt}`) =>
        outcomes.recordEvidence({
          jobId: j,
          printerUuid,
          attempt,
          cupsJobId,
          cupsState: 'completed',
        });

      // Each printer for its own attempt.
      expect((await ev(a, 1)).applied).toBe(true);
      expect((await ev(b, 2)).applied).toBe(true);

      // Neither for the other's attempt.
      expect(await failure(ev(a, 2))).toEqual({ status: 409, code: 'STALE_ATTEMPT' });
      expect(await failure(ev(b, 1))).toEqual({ status: 409, code: 'STALE_ATTEMPT' });

      // A printer that never held the job.
      expect(await failure(ev(c, 1))).toEqual({ status: 403, code: 'JOB_NOT_ASSIGNED' });

      // A nonexistent attempt.
      expect(await failure(ev(b, 3))).toEqual({ status: 409, code: 'ATTEMPT_NOT_FOUND' });

      // A repeat is applied: false.
      expect((await ev(a, 1)).applied).toBe(false);

      // Evidence changes neither the outcome nor the assignment.
      const row = await queueRow(j);
      expect(row.physical_outcome).toBe('unknown');
      expect(row.printer_id).toBe(b);
      expect(row.status).toBe('assigned');
    });

    it('a printer cannot pass a physical outcome through the evidence endpoint', async () => {
      const a = await printer('RPI_A');
      const j = await job(10);
      await poll(a);

      // The controller refuses this; the service only ever stores evidence.
      const { queueController } = await import('../../src/controllers/queueController');
      const res = { json: jest.fn() };
      const req = {
        printer: { id: a },
        params: { jobId: j },
        body: {
          attempt: 1,
          outcome: 'printed',
          evidence: { cupsJobId: 'x', cupsState: 'completed' },
        },
      };
      const err = await queueController
        .recordEvidence(req as never, res as never)
        .catch((e: AppError) => e);
      expect((err as AppError).code).toBe('PHYSICAL_OUTCOME_NOT_PRINTER_SETTABLE');
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Existing jobs: backfill, first sweep, legacy attempt history
  // ---------------------------------------------------------------------------
  describe('5. existing jobs get a fixed deadline; legacy history stays unknown until reconciled', () => {
    /** Seed a pre-026 row: no deadline, paid `paidMinutesAgo` ago. */
    async function legacyJob(opts: {
      paidMinutesAgo: number;
      status: string;
      printerUuid?: string;
      leaseCount?: number;
    }): Promise<string> {
      const j = await job(10);
      await pool.query(
        `UPDATE print_jobs SET print_deadline_at = NULL,
                paid_at = NOW() - make_interval(mins => $2)
          WHERE id = $1`,
        [j, opts.paidMinutesAgo]
      );
      await pool.query(
        `UPDATE print_queue SET status = $2, printer_id = $3, lease_count = $4,
                lease_expires_at = NULL, assigned_at = NULL
          WHERE job_id = $1`,
        [j, opts.status, opts.printerUuid ?? null, opts.leaseCount ?? 0]
      );
      await pool.query(`UPDATE print_jobs SET status = $2 WHERE id = $1`, [j, opts.status]);
      return j;
    }

    it('the backfill sets paid_at + 15 minutes, and the first sweep expires only overdue jobs', async () => {
      const a = await printer('RPI_A');
      const overdue = await legacyJob({ paidMinutesAgo: 20, status: 'queued' });
      const fine = await legacyJob({ paidMinutesAgo: 5, status: 'queued' });
      const printingPast = await legacyJob({
        paidMinutesAgo: 30,
        status: 'printing',
        printerUuid: a,
        leaseCount: 1,
      });

      await pool.query(MIGRATION_026);

      const gap = await pool.query<{ gap: string }>(
        `SELECT EXTRACT(EPOCH FROM (print_deadline_at - paid_at))::int AS gap
           FROM print_jobs WHERE id = $1`,
        [fine]
      );
      expect(gap.rows[0].gap).toBe(15 * 60);

      expect(await queue.expireOutOfWindow()).toBe(2);

      expect((await queueRow(overdue)).status).toBe('failed');
      expect((await queueRow(overdue)).last_printer_id).toBeNull();
      expect((await queueRow(fine)).status).toBe('queued');

      // A legacy job that was printing past its deadline releases its printer.
      expect((await queueRow(printingPast)).last_printer_id).toBe(a);
      expect(await expiryReport(a, printingPast, 1)).toEqual({
        applied: false,
        status: 'failed',
        printerReleased: true,
      });
    });

    it('a legacy job with incomplete attempt history stays unknown until an operator reconciles it', async () => {
      const a = await printer('RPI_A');
      // Three attempts in the queue row, but only the last one was ever recorded.
      const j = await legacyJob({
        paidMinutesAgo: 2,
        status: 'completed',
        printerUuid: a,
        leaseCount: 3,
      });

      await pool.query(MIGRATION_026);

      expect((await queueRow(j)).physical_outcome).toBe('unknown');
      const before = await outcomes.getForOperator(j);
      expect(before.attemptsComplete).toBe(false);
      expect(before.missingAttemptHistory).toEqual([1, 2]);

      const blankOnly = [{ attempt: 3, printerId: a, finding: 'cups_completed_blank' as const }];
      expect(
        await failure(
          outcomes.recordOperatorOutcome({
            jobId: j,
            outcome: 'blank',
            verifiedPages: 0,
            method: 'physical inspection',
            reason: 'Checked the output bin at the kiosk',
            attemptFindings: blankOnly,
            operatorId,
          })
        )
      ).toEqual({ status: 409, code: 'ATTEMPTS_UNRECONCILED' });

      // The operator accounts for the unrecorded attempts with no printer.
      const reconciled = [
        { attempt: 1, printerId: null, finding: 'unknown' as const },
        { attempt: 2, printerId: null, finding: 'unknown' as const },
        ...blankOnly,
      ];
      expect(
        await outcomes.recordOperatorOutcome({
          jobId: j,
          outcome: 'blank',
          verifiedPages: 0,
          method: 'physical inspection',
          reason: 'Checked the output bin at the kiosk',
          attemptFindings: reconciled,
          operatorId,
        })
      ).toEqual({ applied: true, physicalOutcome: 'blank', verifiedPages: 0 });
    });
  });
});
