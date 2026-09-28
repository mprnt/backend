import { queueService } from '../services/queueService';
import logger from '../utils/logger';

/**
 * Keeps the queue honest when a printer disappears.
 *
 * The system uses a pull model — printers claim their own work — so there is no
 * assignment step to run here. What does need a periodic sweep is failure:
 *
 *  1. A printer that stops heartbeating is marked offline.
 *  2. A job whose lease expired (the Pi died mid-print) is returned to the
 *     queue, or failed for good once retries are exhausted.
 *
 * Without step 2 a job stuck in `printing` would never complete, never fail,
 * and never refund.
 */
export async function runPrinterReaper(): Promise<void> {
  try {
    const [offline, reclaimed] = await Promise.all([
      queueService.markStaleAsOffline(),
      queueService.reclaimExpiredLeases(),
    ]);

    if (offline > 0 || reclaimed > 0) {
      logger.info('Printer reaper swept', {
        printersMarkedOffline: offline,
        jobsReclaimed: reclaimed,
      });
    }
  } catch (error) {
    logger.error('Printer reaper failed', { error });
  }
}

let timer: NodeJS.Timeout | undefined;

export function schedulePrinterReaper(intervalMs = 30000): void {
  if (timer) return;

  timer = setInterval(() => {
    void runPrinterReaper();
  }, intervalMs);

  // Do not hold the event loop open during shutdown.
  timer.unref();

  logger.info('Printer reaper scheduled', { intervalMs });
}

export function stopPrinterReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
