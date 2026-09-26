import { jobAssignmentService } from '../services/jobAssignmentService';
import { printerService } from '../services/printerService';
import logger from '../utils/logger';

/**
 * Periodically:
 * 1. Assign pending jobs to available printers
 * 2. Mark stale printers as offline
 */
export async function runJobAssignmentJob(): Promise<void> {
  try {
    // Assign pending jobs every 10 seconds
    const assigned = await jobAssignmentService.assignPendingJobs();
    if (assigned > 0) {
      logger.debug('Job assignment job ran', { assigned });
    }

    // Mark stale printers as offline every 5 minutes
    const now = Date.now();
    if (now % 300000 === 0) {
      await printerService.markStaleAsOffline();
    }
  } catch (error) {
    logger.error('Job assignment job failed', { error });
  }
}

export function scheduleJobAssignmentJob(): void {
  // Run every 10 seconds
  setInterval(() => {
    runJobAssignmentJob();
  }, 10000);

  logger.info('Job assignment job scheduled');
}
