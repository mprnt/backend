import logger from '../utils/logger';
import { withAdvisoryLock, LOCKS } from '../utils/advisoryLock';
import { billingService } from '../services/billingService';

/**
 * Raises the monthly software charges as their months begin. Runs hourly, which is
 * enough: a charge is due on the first of its month, and a missed run is caught up
 * on the next one, since each month is raised by its own unique key.
 */
const INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_MS = 20_000;

let timer: NodeJS.Timeout | undefined;

export async function runBillingJob(now: Date = new Date()) {
  const result = await withAdvisoryLock(LOCKS.BILLING_CHARGES, () =>
    billingService.raiseDueCharges(now)
  );
  if (result === null) return null;

  if (result.created > 0 || result.skipped.length > 0) {
    logger.info('Billing run complete', {
      created: result.created,
      contracts: result.contracts,
      skipped: result.skipped.length,
    });
  }
  return result;
}

export function scheduleBillingJob(): void {
  if (timer) return;
  setTimeout(
    () =>
      void runBillingJob().catch((error: unknown) => logger.error('Billing job failed', { error })),
    FIRST_RUN_MS
  ).unref();
  timer = setInterval(
    () =>
      void runBillingJob().catch((error: unknown) => logger.error('Billing job failed', { error })),
    INTERVAL_MS
  );
  timer.unref();
  logger.info('Billing job scheduled (runs hourly)');
}

export function stopBillingJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
