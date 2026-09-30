import app from './app';
import env from './config/environment';
import { db } from './config/database';
import logger from './utils/logger';
import { scheduleSessionExpiryJob, stopSessionExpiryJob } from './jobs/sessionExpiryJob';
import { schedulePrinterReaper, stopPrinterReaper } from './jobs/printerReaperJob';
import { scheduleDailyStatsRollup, stopDailyStatsRollup } from './jobs/dailyStatsRollupJob';
import { scheduleDocumentSweep, stopDocumentSweep, documentsInFlight } from './jobs/documentJobs';
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

  // Background work. All of it runs on timers in this process, coordinated
  // through Postgres advisory locks — there is no Redis or separate worker.
  scheduleSessionExpiryJob();
  scheduleDocumentSweep();
  schedulePrinterReaper();
  scheduleDailyStatsRollup();
  logger.info('⏰ Background jobs started');
});

// ---------------------------------------------------------------------------
// Graceful shutdown
//
// Previously this called process.exit(0) straight after asking the server to
// close, so requests in flight during every deploy were cut off, and the
// forced-exit timeout written after it could never run. Now it stops taking
// new work, lets in-flight requests and document jobs finish, closes the pool,
// and only then exits — with a hard deadline in case something hangs.
// ---------------------------------------------------------------------------
const SHUTDOWN_DEADLINE_MS = 10_000;
let shuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received. Starting graceful shutdown...`);

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();

  stopSessionExpiryJob();
  stopDocumentSweep();
  stopPrinterReaper();
  stopDailyStatsRollup();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  logger.info('HTTP server closed');

  // Give document jobs already running a moment to finish. Any that do not are
  // still unprocessed in Postgres and will be picked up by the next sweep.
  const drainUntil = Date.now() + 5_000;
  while (documentsInFlight() > 0 && Date.now() < drainUntil) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  try {
    await db.close();
    logger.info('Database pool closed');
  } catch (error) {
    logger.error('Error closing database pool', error);
  }

  process.exit(0);
};

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

// A rejected promise nobody handled is a bug, but it does not by itself mean
// the process is corrupt. This used to re-throw, turning every such bug into a
// crash — which is how a Redis quota error in a background job took payments
// offline. Log it loudly and keep serving.
process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled Rejection', {
    error: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// A synchronous exception that escaped every handler can leave state
// half-updated; exiting and letting the platform restart is the safe response.
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});
