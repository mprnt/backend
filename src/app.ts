import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import 'express-async-errors';
import { setupSwagger } from './config/swagger';

import env from './config/environment';
import { db } from './config/database';
import logger from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { globalRateLimiter } from './middleware/rateLimiter';
import { trustedProxy } from './middleware/trustedProxy';
import sessionRoutes from './routes/sessions';
import documentRoutes from './routes/documents';
import documentRoutesStandalone from './routes/documentRoutes';
import printJobRoutes, { sessionPrintJobRoutes } from './routes/printJobs';
import paymentRoutes from './routes/payment';
import queueRoutes from './routes/queue';
import setupRoutes from './routes/setup';
import adminRoutes from './routes/admin';
import publicRoutes from './routes/public';

const app: Application = express();
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());
app.use(
  cors({
    origin: env.cors.origin,
    credentials: env.cors.credentials,
  })
);

// Restore the real client IP for dashboard-relayed requests. Must precede the
// rate limiter so limits key on the admin, not on the dashboard server.
app.use(trustedProxy);

// Rate limiting
app.use(globalRateLimiter);

// Body parsing middleware
app.use(
  express.json({
    limit: '10mb',
    // The Razorpay webhook signs the exact bytes it sent, so keep them.
    verify: (req, _res, buf) => {
      if ((req as express.Request).originalUrl?.endsWith('/payment/webhook')) {
        (req as express.Request).rawBody = buf;
      }
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression middleware
app.use(compression());

// Logging middleware
if (env.node_env === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(
    morgan('combined', {
      stream: {
        write: (message: string) => logger.info(message.trim()),
      },
    })
  );
}

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: Check if the API server is running and healthy
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: 2026-09-25T07:09:32.781Z
 *                 uptime:
 *                   type: number
 *                   example: 3600.5
 *                   description: Server uptime in seconds
 *                 environment:
 *                   type: string
 *                   example: development
 */
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: env.node_env,
  });
});

/**
 * @swagger
 * /health/ready:
 *   get:
 *     summary: Readiness check
 *     description: |
 *       Unlike /health, which only shows the process is up, this checks that
 *       the database answers. Use it for uptime monitoring — /health stays
 *       green while every real request is failing on a dead database.
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Database reachable
 *       503:
 *         description: Database unreachable or too slow
 */
const READY_DB_TIMEOUT_MS = 2_000;

async function readiness(res: Response): Promise<void> {
  const started = Date.now();
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out')), READY_DB_TIMEOUT_MS);
      }),
    ]);

    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: { database: { status: 'ok', latencyMs: Date.now() - started } },
    });
  } catch (error) {
    logger.warn('Readiness check failed', {
      error: error instanceof Error ? error.message : error,
    });
    // Deliberately no error detail in the body: this endpoint is public.
    res.status(503).json({
      status: 'unavailable',
      timestamp: new Date().toISOString(),
      checks: { database: { status: 'down' } },
    });
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/health/ready', (_req: Request, res: Response) => {
  void readiness(res);
});

// Swagger documentation
setupSwagger(app);

// API routes
app.use(`/api/${env.api_version}/sessions`, sessionRoutes);
app.use(`/api/${env.api_version}/sessions`, documentRoutes);
app.use(`/api/${env.api_version}/sessions`, sessionPrintJobRoutes);
app.use(`/api/${env.api_version}`, printJobRoutes);
app.use(`/api/${env.api_version}`, paymentRoutes);
app.use(`/api/${env.api_version}/queue`, queueRoutes);
app.use(`/api/${env.api_version}/documents`, documentRoutesStandalone);
app.use(`/api/${env.api_version}/setup`, setupRoutes);
app.use(`/api/${env.api_version}/admin`, adminRoutes);
app.use(`/api/${env.api_version}/public`, publicRoutes);

// Root endpoint
app.get('/', (_req: Request, res: Response) => {
  res.json({
    message: 'MPrnt Backend API',
    version: env.api_version,
    status: 'running',
  });
});

// Error handlers (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
