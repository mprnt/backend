import Queue from 'bull';
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
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // Start with 2 seconds
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 1000, // Keep last 1000 jobs
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  },
});

// Queue event handlers
documentQueue.on('completed', (job, result) => {
  logger.info('Document processing completed', {
    jobId: job.id,
    documentId: job.data.documentId,
    result,
  });
});

documentQueue.on('failed', (job, err) => {
  logger.error('Document processing failed', {
    jobId: job?.id,
    documentId: job?.data.documentId,
    error: err.message,
    stack: err.stack,
    attempts: job?.attemptsMade,
  });
});

documentQueue.on('stalled', (job) => {
  logger.warn('Document processing stalled', {
    jobId: job.id,
    documentId: job.data.documentId,
  });
});

// Add job to queue
export const addDocumentProcessingJob = async (data: DocumentJobData) => {
  const job = await documentQueue.add(data, {
    priority: 1, // Higher priority for user-facing operations
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
