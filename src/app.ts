import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import 'express-async-errors';
import { setupSwagger } from './config/swagger';

import env from './config/environment';
import logger from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { globalRateLimiter } from './middleware/rateLimiter';
import sessionRoutes from './routes/sessions';
import documentRoutes from './routes/documents';
import documentRoutesStandalone from './routes/documentRoutes';
import printJobRoutes from './routes/printJobs';
import paymentRoutes from './routes/payment';
import queueRoutes from './routes/queue';
import setupRoutes from './routes/setup';
import adminRoutes from './routes/admin';

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

// Rate limiting
app.use(globalRateLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
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

// Swagger documentation
setupSwagger(app);

// API routes
app.use(`/api/${env.api_version}/sessions`, sessionRoutes);
app.use(`/api/${env.api_version}/sessions`, documentRoutes);
app.use(`/api/${env.api_version}/sessions`, printJobRoutes);
app.use(`/api/${env.api_version}`, printJobRoutes);
app.use(`/api/${env.api_version}`, paymentRoutes);
app.use(`/api/${env.api_version}/queue`, queueRoutes);
app.use(`/api/${env.api_version}/documents`, documentRoutesStandalone);
app.use(`/api/${env.api_version}/setup`, setupRoutes);
app.use(`/api/${env.api_version}/admin`, adminRoutes);

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
