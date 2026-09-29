import app from './app';
import env from './config/environment';
import logger from './utils/logger';
import { scheduleSessionExpiryJob } from './jobs/sessionExpiryJob';
import { schedulePrinterReaper, stopPrinterReaper } from './jobs/printerReaperJob';
import { scheduleDailyStatsRollup, stopDailyStatsRollup } from './jobs/dailyStatsRollupJob';
import { sessionExpiryQueue } from './queues/sessionExpiryQueue';
import { documentQueue } from './queues/documentQueue';
import { documentProcessor } from './workers/documentProcessor';
import { websocketService } from './services/websocketService';

const PORT = env.port;

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info(`📍 Environment: ${env.node_env}`);
  logger.info(`🔗 API Version: ${env.api_version}`);
  logger.info(`🏥 Health check: http://localhost:${PORT}/health`);

  // Initialize WebSocket
  websocketService.initialize(server, env.websocket.path);
  logger.info(`📡 WebSocket server initialized on ${env.websocket.path}`);

  // Process document jobs in this process so uploads do not wait on a separate worker
  void documentQueue.process(async (job) => {
    return documentProcessor.process(job);
  });
  logger.info('📄 Document processing worker attached to API process');

  // Start background jobs
  scheduleSessionExpiryJob();
  schedulePrinterReaper();
  scheduleDailyStatsRollup();
  logger.info('⏰ Background jobs started');
});

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  // Stop background sweeps before tearing down the pool
  stopPrinterReaper();
  stopDailyStatsRollup();

  // Close HTTP server
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Close Bull queue
  try {
    await sessionExpiryQueue.close();
    logger.info('Bull queue closed');
  } catch (error) {
    logger.error('Error closing Bull queue', error);
  }

  // Close database connections, redis, etc.
  process.exit(0);

  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: Error) => {
  logger.error('Unhandled Rejection:', reason);
  throw reason;
});

process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});
