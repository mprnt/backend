import { documentQueue, closeDocumentQueue } from '../queues/documentQueue';
import { documentProcessor } from './documentProcessor';
import logger from '../utils/logger';

/**
 * Worker process entry point
 * Processes background jobs from Bull queues
 */

// Process document queue jobs
documentQueue.process(async (job) => {
  return await documentProcessor.process(job);
});

// Graceful shutdown
const shutdown = async () => {
  logger.info('Worker shutting down gracefully...');

  try {
    await closeDocumentQueue();
    logger.info('Worker shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during worker shutdown', {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  }
};

// Handle shutdown signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection in worker', {
    reason,
    promise,
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception in worker', {
    error: error.message,
    stack: error.stack,
  });
  shutdown();
});

logger.info('Document processing worker started');
