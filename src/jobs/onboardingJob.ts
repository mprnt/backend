import logger from '../utils/logger';
import { withAdvisoryLock, LOCKS } from '../utils/advisoryLock';
import { onboardingService } from '../services/onboardingService';

/**
 * Expires abandoned onboarding drafts and removes the documents staged for them.
 * A draft is only expired after its lifetime, so nothing in progress is touched.
 */
const INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_MS = 30_000;

let timer: NodeJS.Timeout | undefined;

export async function runOnboardingSweep(now: Date = new Date()) {
  return withAdvisoryLock(LOCKS.ONBOARDING_SWEEP, () => onboardingService.expireDrafts(now));
}

function tick(): void {
  runOnboardingSweep().catch((error: unknown) =>
    logger.error('Onboarding sweep failed', { error })
  );
}

export function scheduleOnboardingSweep(): void {
  if (timer) return;
  setTimeout(tick, FIRST_RUN_MS).unref();
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  logger.info('Onboarding sweep scheduled (runs hourly)');
}

export function stopOnboardingSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
