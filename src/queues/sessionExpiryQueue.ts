import Queue from 'bull';
import env from '../config/environment';
import logger from '../utils/logger';

/**
 * Session Expiry Queue
 * Processes expired sessions every minute
 */
export const sessionExpiryQueue = new Queue('session-expiry', {
  redis: {
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 1000, // Keep last 1000 failed jobs for debugging
  },
});

// Log queue events
sessionExpiryQueue.on('completed', (job) => {
  logger.debug('Session expiry job completed', {
    jobId: job.id,
    returnValue: job.returnvalue,
  });
});

sessionExpiryQueue.on('failed', (job, err) => {
  logger.error('Session expiry job failed', {
    jobId: job.id,
    error: err.message,
  });
});

sessionExpiryQueue.on('stalled', (job) => {
  logger.warn('Session expiry job stalled', {
    jobId: job.id,
  });
});

logger.info('Session expiry queue initialized');
