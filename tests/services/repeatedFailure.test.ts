import { QueueService } from '../../src/services/queueService';
import { scriptedDb } from '../helpers/fakeDb';
import { AppError } from '../../src/middleware/errorHandler';

jest.mock('../../src/config/database');

const JOB = '11111111-2222-4333-8444-555555555555';
const PRINTER = '7d00a3fe-55f5-4dc5-9fce-cb0ed84ee0ab';

const row = (over: Record<string, unknown> = {}) => ({
  status: 'printing',
  lease_count: 1,
  printer_id: PRINTER,
  printed_pages: 0,
  retry_count: 0,
  max_retries: 3,
  total_pages: 6,
  copies: 2,
  ...over,
});

describe('repeated failed reports', () => {
  it('a repeat failure after the final failure is acknowledged as not applied and changes nothing', async () => {
    const db = scriptedDb([['FOR UPDATE OF pq', [row({ status: 'failed', retry_count: 3 })]]]);
    const service = new QueueService(db as never);

    const result = await service.updateJobStatus({
      jobId: JOB,
      status: 'failed',
      errorCode: 'CUPS_ERROR',
      printerUuid: PRINTER,
    });

    expect(result).toEqual({ applied: false, status: 'failed' });
    expect(db.sqlFor('UPDATE print_queue')).toHaveLength(0);
    expect(db.sqlFor('UPDATE print_jobs')).toHaveLength(0);
  });

  it('the first failure while retries remain is still applied and requeues the job', async () => {
    const db = scriptedDb([['FOR UPDATE OF pq', [row({ status: 'printing', retry_count: 0 })]]]);
    const service = new QueueService(db as never);

    const result = await service.updateJobStatus({
      jobId: JOB,
      status: 'failed',
      errorCode: 'CUPS_ERROR',
      printerUuid: PRINTER,
    });

    expect(result).toEqual({ applied: true, status: 'queued' });
    // The requeue touches the queue row and the job row.
    expect(db.sqlFor("status = 'queued'")).toHaveLength(2);
  });

  it('a completed report after a permanent failure does not flip the job', async () => {
    const db = scriptedDb([['FOR UPDATE OF pq', [row({ status: 'failed', retry_count: 3 })]]]);
    const service = new QueueService(db as never);

    const result = await service.updateJobStatus({
      jobId: JOB,
      status: 'completed',
      printedPages: 6,
      printerUuid: PRINTER,
    });

    expect(result).toEqual({ applied: false, status: 'failed' });
    expect(db.sqlFor('UPDATE print_queue')).toHaveLength(0);
    expect(db.sqlFor('UPDATE print_jobs')).toHaveLength(0);
  });

  it('rejects a report for an earlier attempt with 409 STALE_ATTEMPT and changes nothing', async () => {
    const db = scriptedDb([['FOR UPDATE OF pq', [row({ status: 'assigned', lease_count: 2 })]]]);
    const service = new QueueService(db as never);

    const err = await service
      .updateJobStatus({
        jobId: JOB,
        status: 'failed',
        errorCode: 'CUPS_ERROR',
        attempt: 1,
        printerUuid: PRINTER,
      })
      .catch((e: AppError) => e);

    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('STALE_ATTEMPT');
    expect(db.sqlFor('UPDATE print_queue')).toHaveLength(0);
  });

  it('applies a report for the current attempt', async () => {
    const db = scriptedDb([['FOR UPDATE OF pq', [row({ status: 'assigned', lease_count: 2 })]]]);
    const service = new QueueService(db as never);

    const result = await service.updateJobStatus({
      jobId: JOB,
      status: 'printing',
      attempt: 2,
      printerUuid: PRINTER,
    });

    expect(result).toEqual({ applied: true, status: 'printing' });
  });

  it('still applies reports without an attempt (older printers)', async () => {
    const db = scriptedDb([['FOR UPDATE OF pq', [row({ status: 'assigned', lease_count: 2 })]]]);
    const service = new QueueService(db as never);

    const result = await service.updateJobStatus({
      jobId: JOB,
      status: 'printing',
      printerUuid: PRINTER,
    });

    expect(result).toEqual({ applied: true, status: 'printing' });
  });
});
