import { QueueService } from '../../src/services/queueService';
import { scriptedDb } from '../helpers/fakeDb';

jest.mock('../../src/config/database');

const JOB = '11111111-2222-4333-8444-555555555555';
const PRINTER = '7d00a3fe-55f5-4dc5-9fce-cb0ed84ee0ab';

const row = (over: Record<string, unknown> = {}) => ({
  status: 'printing',
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
});
