import Queue, { Job } from 'bull';
import env from '../config/environment';
import logger from '../utils/logger';

/**
 * Bull Queue for document processing
 * Handles background jobs for:
 * - PDF page extraction
 * - Thumbnail generation
 * - Document format conversion
 */

interface DocumentJobData {
  documentId: string;
  sessionId: string;
  s3Key: string;
  fileType: string;
  originalFilename: string;
}

// Create document processing queue
export const documentQueue = new Queue<DocumentJobData>('document-processing', {
  redis: {
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password || undefined,
    db: env.redis.db,
    tls: env.redis.tls ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  },

  defaultJobOptions: {
    attempts: 3,

    backoff: {
      type: 'exponential',
      delay: 2000,
    },

    removeOnComplete: {
      age: 24 * 3600,
      count: 1000,
    },

    removeOnFail: {
      age: 7 * 24 * 3600,
    },
  },
});

// Queue event handlers

documentQueue.on('completed', (job: Job<DocumentJobData>) => {
  logger.info('Document processing completed', {
    jobId: job.id,
    documentId: job.data.documentId,
  });
});

documentQueue.on('failed', (job: Job<DocumentJobData> | undefined, err: Error) => {
  logger.error('Document processing failed', {
    jobId: job?.id,
    documentId: job?.data.documentId,
    error: err.message,
    stack: err.stack,
    attempts: job?.attemptsMade,
  });
});

documentQueue.on('stalled', (job: Job<DocumentJobData>) => {
  logger.warn('Document processing stalled', {
    jobId: job.id,
    documentId: job.data.documentId,
  });
});

// Add job to queue
export const addDocumentProcessingJob = async (data: DocumentJobData) => {
  const job = await documentQueue.add(data, {
    priority: 1,
  });

  logger.info('Document processing job added to queue', {
    jobId: job.id,
    documentId: data.documentId,
  });

  return job;
};

// Graceful shutdown
export const closeDocumentQueue = async () => {
  await documentQueue.close();
  logger.info('Document queue closed');
};
