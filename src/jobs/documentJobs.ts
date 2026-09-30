import { db } from '../config/database';
import logger from '../utils/logger';
import { withAdvisoryLock, LOCKS } from '../utils/advisoryLock';
import { documentProcessor, DocumentJobData } from '../workers/documentProcessor';

/**
 * Background document processing, without Redis.
 *
 * This used to be a Bull queue. Bull polls Redis every few seconds even when
 * idle, which by itself exceeded a hosted Redis free tier's monthly command
 * limit; the quota error then crashed the whole API.
 *
 * What the queue actually provided was retries and durability across
 * restarts. Both come from what we already have:
 *
 *  - Retries: each job runs in this process with exponential backoff.
 *  - Durability: `documents.processed = false` is the backlog. A job lost to
 *    a restart is still unprocessed in Postgres, so a periodic sweep finds it.
 *
 * Processing is idempotent — it only records the page count and sets
 * `processed` — so a job that happens to run twice is harmless.
 *
 * It is also non-critical: upload already extracts the page count inline for
 * normal files. This fills gaps (thumbnails, PDFs the inline parse could not
 * read); it is not on the path of a customer's upload.
 */

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 2_000;

/** Documents already being worked on in this process. */
const inFlight = new Set<string>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWithRetries(data: DocumentJobData): Promise<void> {
  if (inFlight.has(data.documentId)) return;
  inFlight.add(data.documentId);

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await documentProcessor.process(data, attempt);
        return;
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) {
          logger.error('Document processing gave up after retries', {
            documentId: data.documentId,
            attempts: attempt,
            error: error instanceof Error ? error.message : error,
          });
          return;
        }
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  } finally {
    inFlight.delete(data.documentId);
  }
}

/**
 * Start processing a document in the background and return immediately.
 * The upload request never waits on this, and a failure never reaches it.
 */
export function enqueueDocumentProcessing(data: DocumentJobData): void {
  logger.info('Document processing scheduled', { documentId: data.documentId });
  void runWithRetries(data).catch((error) => {
    // runWithRetries handles its own errors; this only guards against a bug in it.
    logger.error('Unexpected document processing failure', {
      documentId: data.documentId,
      error: error instanceof Error ? error.message : error,
    });
  });
}

/**
 * Pick up documents whose processing was interrupted, e.g. by a restart.
 *
 * Bounded on both sides: skips anything uploaded in the last two minutes, which
 * is probably still being handled inline, and anything older than half an
 * hour, by which point its session has expired and the file has been removed.
 */
export async function sweepUnprocessedDocuments(): Promise<number> {
  const result = await withAdvisoryLock(LOCKS.DOCUMENT_SWEEP, async () => {
    const pending = await db.query<{
      id: string;
      session_id: string;
      s3_key: string;
      file_type: string;
      original_filename: string;
    }>(
      `SELECT id, session_id, s3_key, file_type, original_filename
         FROM documents
        WHERE processed = false
          AND uploaded_at < (now() AT TIME ZONE 'UTC') - INTERVAL '2 minutes'
          AND uploaded_at > (now() AT TIME ZONE 'UTC') - INTERVAL '30 minutes'
        ORDER BY uploaded_at
        LIMIT 20`
    );

    for (const d of pending.rows) {
      enqueueDocumentProcessing({
        documentId: d.id,
        sessionId: d.session_id,
        s3Key: d.s3_key,
        fileType: d.file_type,
        originalFilename: d.original_filename,
      });
    }

    return pending.rows.length;
  });

  if (result) logger.info('Recovered unprocessed documents', { count: result });
  return result ?? 0;
}

let timer: NodeJS.Timeout | undefined;

export function scheduleDocumentSweep(intervalMs = 5 * 60_000): void {
  if (timer) return;

  const run = () =>
    void sweepUnprocessedDocuments().catch((error) => {
      logger.error('Document sweep failed', {
        error: error instanceof Error ? error.message : error,
      });
    });

  // Once shortly after boot, to recover anything a restart interrupted.
  setTimeout(run, 15_000).unref();
  timer = setInterval(run, intervalMs);
  timer.unref();

  logger.info('Document sweep scheduled', { intervalMs });
}

export function stopDocumentSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** Documents still being processed; used to drain on shutdown. */
export function documentsInFlight(): number {
  return inFlight.size;
}
