import { QueueService } from '../../src/services/queueService';
import { db } from '../../src/config/database';
import { AppError } from '../../src/middleware/errorHandler';

jest.mock('../../src/config/database');
jest.mock('../../src/services/storageService', () => ({
  storageService: {
    getPresignedUrl: jest.fn().mockResolvedValue('https://s3.example/signed'),
  },
}));

const mockDb = db as jest.Mocked<typeof db>;

const result = (rows: any[], rowCount?: number) => ({
  rows,
  command: 'SELECT',
  rowCount: rowCount ?? rows.length,
  oid: 0,
  fields: [],
});

/** A stand-in for a pooled client that records every statement it is given. */
function makeClient() {
  const query = jest.fn().mockResolvedValue(result([]));
  return {
    query,
    release: jest.fn(),
    sqlFor: (fragment: string) =>
      query.mock.calls.filter(([sql]) => String(sql).includes(fragment)),
  };
}

describe('QueueService', () => {
  let service: QueueService;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    service = new QueueService();
    client = makeClient();
    jest.clearAllMocks();
    (mockDb.getClient as jest.Mock) = jest.fn().mockResolvedValue(client);
  });

  describe('enqueueJob', () => {
    it('inserts a queue row and tolerates a replayed payment', async () => {
      mockDb.query.mockResolvedValueOnce(result([]));

      await service.enqueueJob('job-1');

      const [sql, params] = mockDb.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO print_queue');
      // A duplicate webhook must not raise; the unique constraint is absorbed.
      expect(sql).toContain('ON CONFLICT (job_id) DO NOTHING');
      expect(params).toEqual(['job-1', 0]);
    });

    it('runs on a caller-supplied client so it can join the payment transaction', async () => {
      const txClient = { query: jest.fn().mockResolvedValue(undefined) };

      await service.enqueueJob('job-1', 5, txClient);

      expect(txClient.query).toHaveBeenCalled();
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });

  describe('updateJobStatus', () => {
    const heldBy = 'printer-uuid-1';
    const queueRow = {
      status: 'printing',
      printer_id: heldBy,
      printed_pages: 4,
      retry_count: 0,
      max_retries: 3,
      total_pages: 10,
      copies: 1,
    };

    it('refuses an update for a job held by a different printer', async () => {
      client.query.mockResolvedValueOnce(result([])); // BEGIN
      client.query.mockResolvedValueOnce(result([queueRow])); // SELECT ... FOR UPDATE

      await expect(
        service.updateJobStatus({
          jobId: 'job-1',
          status: 'completed',
          printerUuid: 'a-different-printer',
        })
      ).rejects.toThrow(AppError);

      expect(client.sqlFor('UPDATE print_queue SET')).toHaveLength(0);
    });

    it('ignores an update to an already-completed job so retries are safe', async () => {
      client.query.mockResolvedValueOnce(result([])); // BEGIN
      client.query.mockResolvedValueOnce(result([{ ...queueRow, status: 'completed' }]));

      const res = await service.updateJobStatus({
        jobId: 'job-1',
        status: 'completed',
        printerUuid: heldBy,
      });

      expect(res).toEqual({ applied: false, status: 'completed' });
      expect(client.sqlFor('UPDATE print_queue SET')).toHaveLength(0);
    });

    it('never moves printed pages backwards', async () => {
      client.query.mockResolvedValueOnce(result([])); // BEGIN
      client.query.mockResolvedValueOnce(result([queueRow])); // printed_pages = 4

      await service.updateJobStatus({
        jobId: 'job-1',
        status: 'printing',
        printedPages: 2, // stale update arriving late
        printerUuid: heldBy,
      });

      const [, params] = client.sqlFor('UPDATE print_queue SET')[0];
      expect(params[1]).toBe(4);
    });

    it('clamps printed pages to total_pages, which already counts every copy', async () => {
      client.query.mockResolvedValueOnce(result([]));
      // 10 pages x 2 copies is stored by pricing as total_pages = 20; copies must not double it.
      client.query.mockResolvedValueOnce(result([{ ...queueRow, total_pages: 20, copies: 2 }]));

      await service.updateJobStatus({
        jobId: 'job-1',
        status: 'printing',
        printedPages: 999,
        printerUuid: heldBy,
      });

      const [, params] = client.sqlFor('UPDATE print_queue SET')[0];
      expect(params[1]).toBe(20);
    });

    it('stamps started_at only once across repeated printing updates', async () => {
      client.query.mockResolvedValueOnce(result([]));
      client.query.mockResolvedValueOnce(result([queueRow]));

      await service.updateJobStatus({
        jobId: 'job-1',
        status: 'printing',
        printerUuid: heldBy,
      });

      const [sql] = client.sqlFor('UPDATE print_queue SET')[0];
      expect(sql).toContain('COALESCE(started_at, NOW())');
    });

    it('requeues a failure while retries remain', async () => {
      client.query.mockResolvedValueOnce(result([]));
      client.query.mockResolvedValueOnce(result([{ ...queueRow, retry_count: 0, max_retries: 3 }]));

      const res = await service.updateJobStatus({
        jobId: 'job-1',
        status: 'failed',
        errorCode: 'PAPER_JAM',
        printerUuid: heldBy,
      });

      expect(res.status).toBe('queued');
      expect(client.sqlFor("status = 'queued'").length).toBeGreaterThan(0);
    });

    it('fails permanently once retries are exhausted', async () => {
      client.query.mockResolvedValueOnce(result([]));
      client.query.mockResolvedValueOnce(result([{ ...queueRow, retry_count: 2, max_retries: 3 }]));

      const res = await service.updateJobStatus({
        jobId: 'job-1',
        status: 'failed',
        errorCode: 'CUPS_ERROR',
        printerUuid: heldBy,
      });

      expect(res.status).toBe('failed');
      expect(client.sqlFor("UPDATE print_jobs SET status = 'failed'").length).toBeGreaterThan(0);
    });

    it('rolls back and reports 404 for an unknown job', async () => {
      client.query.mockResolvedValueOnce(result([]));
      client.query.mockResolvedValueOnce(result([]));

      await expect(
        service.updateJobStatus({ jobId: 'nope', status: 'completed', printerUuid: heldBy })
      ).rejects.toThrow('Job not found in print queue');

      expect(client.sqlFor('ROLLBACK')).toHaveLength(1);
    });
  });

  describe('pollQueue', () => {
    const printerRow = {
      id: 'printer-uuid-1',
      kiosk_id: 'kiosk-uuid-1',
      status: 'online',
      supports_color: false,
      supports_double_sided: false,
      max_copies: 100,
    };

    const jobRow = {
      job_id: 'job-1',
      priority: 0,
      lease_count: 0,
      color_mode: 'bw',
      copies: 2,
      page_range: 'all',
      custom_range: null,
      print_sides: 'single',
      paper_size: 'a4',
      orientation: 'portrait',
      // Charged pages across both copies; the printer is told 10 per copy.
      total_pages: 20,
      s3_key: 'documents/abc.pdf',
      original_filename: 'report.pdf',
      file_size_bytes: '204800',
      file_type: 'application/pdf',
    };

    it('returns null when the queue is empty', async () => {
      client.query
        .mockResolvedValueOnce(result([])) // BEGIN
        .mockResolvedValueOnce(result([printerRow])) // printer lookup
        .mockResolvedValueOnce(result([])) // in-flight check
        .mockResolvedValueOnce(result([])); // job lookup

      const assignment = await service.pollQueue({
        printerId: 'RPI_M001_01',
        printerUuid: printerRow.id,
        capabilities: {} as any,
      });

      expect(assignment).toBeNull();
    });

    it('claims a job with a lease and returns a signed document URL', async () => {
      client.query
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([printerRow]))
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([jobRow]));

      const assignment = await service.pollQueue({
        printerId: 'RPI_M001_01',
        printerUuid: printerRow.id,
        capabilities: {} as any,
      });

      expect(assignment).toMatchObject({
        jobId: 'job-1',
        documentUrl: 'https://s3.example/signed',
        fileName: 'report.pdf',
        fileSizeBytes: 204800,
        mimeType: 'application/pdf',
        totalPages: 10,
        attempt: 1,
      });
      expect(assignment!.settings.copies).toBe(2);
      expect(client.sqlFor('lease_expires_at').length).toBeGreaterThan(0);
    });

    it('matches on capabilities read from the database, not from the request body', async () => {
      client.query
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([printerRow])) // supports_color = false
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([]));

      await service.pollQueue({
        printerId: 'RPI_M001_01',
        printerUuid: printerRow.id,
        // A lying client claiming colour support must not influence matching.
        capabilities: { supportsColor: true, supportsDoubleSided: true } as any,
      });

      const [, params] = client.sqlFor('JOIN print_jobs pj')[0];
      expect(params).toEqual([printerRow.kiosk_id, false, false]);
    });

    it('only ever hands out jobs that were paid for', async () => {
      client.query
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([printerRow]))
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([]));

      await service.pollQueue({
        printerId: 'RPI_M001_01',
        printerUuid: printerRow.id,
        capabilities: {} as any,
      });

      const [sql] = client.sqlFor('JOIN print_jobs pj')[0];
      expect(sql).toContain("pj.payment_status = 'paid'");
      expect(sql).toContain('SKIP LOCKED');
    });

    it('re-hands the same job to a printer that restarted mid-print', async () => {
      client.query
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([printerRow]))
        .mockResolvedValueOnce(result([{ job_id: 'job-in-flight' }]))
        .mockResolvedValueOnce(result([{ ...jobRow, job_id: 'job-in-flight', lease_count: 1 }]));

      const assignment = await service.pollQueue({
        printerId: 'RPI_M001_01',
        printerUuid: printerRow.id,
        capabilities: {} as any,
      });

      expect(assignment!.jobId).toBe('job-in-flight');
      expect(assignment!.attempt).toBe(2);
      const [sql, params] = client.sqlFor('JOIN print_jobs pj')[0];
      expect(sql).toContain('pq.job_id = $4');
      expect(params[3]).toBe('job-in-flight');
    });

    it('gives no work to a printer in maintenance', async () => {
      client.query
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([{ ...printerRow, status: 'maintenance' }]));

      const assignment = await service.pollQueue({
        printerId: 'RPI_M001_01',
        printerUuid: printerRow.id,
        capabilities: {} as any,
      });

      expect(assignment).toBeNull();
    });

    it('rejects a revoked or unknown printer', async () => {
      client.query.mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([]));

      await expect(
        service.pollQueue({
          printerId: 'RPI_M001_01',
          printerUuid: 'gone',
          capabilities: {} as any,
        })
      ).rejects.toThrow('Printer not registered');
    });
  });

  describe('reclaimExpiredLeases', () => {
    it('requeues jobs whose printer stopped reporting', async () => {
      mockDb.query.mockResolvedValueOnce(result([{ job_id: 'job-1', status: 'queued' }], 1));
      mockDb.query.mockResolvedValueOnce(result([]));

      await expect(service.reclaimExpiredLeases()).resolves.toBe(1);

      const [sql] = mockDb.query.mock.calls[0];
      expect(sql).toContain('lease_expires_at < NOW()');
      expect(sql).toContain("error_code = 'LEASE_EXPIRED'");
    });

    it('does nothing when every lease is healthy', async () => {
      mockDb.query.mockResolvedValueOnce(result([], 0));

      await expect(service.reclaimExpiredLeases()).resolves.toBe(0);
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
  });
});
