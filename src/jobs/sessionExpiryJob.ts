import { db } from '../config/database';
import logger from '../utils/logger';
import { withAdvisoryLock, LOCKS } from '../utils/advisoryLock';

/**
 * Process expired sessions
 * This job runs every minute to find and clean up expired sessions
 */
export async function processSessionExpiry(): Promise<{
  expiredCount: number;
  documentsDeleted: number;
}> {
  const startTime = Date.now();

  logger.info('Starting session expiry job');

  try {
    // Find expired sessions that are safe to clean up.
    //
    // A session whose customer has paid but whose job has not finished is
    // skipped entirely — not marked expired either, so it is re-evaluated on
    // the next sweep and cleaned up once the job reaches a terminal state.
    //
    // This matters because the cleanup deletes the uploaded file from S3. A
    // paid job whose document has been deleted can never print: the Pi
    // downloads that exact object. Retaining a file for longer than the session
    // window is the lesser problem by a wide margin.
    //
    // A session the customer cancelled is already 'expired' but still holds its
    // upload; it is picked up here too, or that file would never be deleted.
    const expiredSessionsResult = await db.query<{
      id: string;
      session_id: string;
      expires_at: Date;
      status: string;
    }>(
      `SELECT ps.id, ps.session_id, ps.expires_at, ps.status
       FROM print_sessions ps
       WHERE (
               (ps.expires_at < CURRENT_TIMESTAMP AND ps.status NOT IN ('expired', 'complete'))
               OR (ps.status = 'expired'
                   AND EXISTS (SELECT 1 FROM documents d WHERE d.session_id = ps.id))
             )
         AND NOT EXISTS (
           SELECT 1
             FROM print_jobs pj
            WHERE pj.session_id = ps.id
              AND pj.payment_status = 'paid'
              AND pj.status NOT IN ('completed', 'cancelled')
         )
       ORDER BY ps.expires_at ASC`
    );

    const expiredSessions = expiredSessionsResult.rows;

    if (expiredSessions.length === 0) {
      logger.debug('No expired sessions found');
      return { expiredCount: 0, documentsDeleted: 0 };
    }

    logger.info(`Found ${expiredSessions.length} expired sessions`);

    let documentsDeleted = 0;

    // Process each expired session
    for (const session of expiredSessions) {
      try {
        // Start a transaction for each session
        await db.transaction(async (client) => {
          // Find associated documents
          const documentsResult = await client.query<{
            id: string;
            s3_key: string | null;
            file_type: string | null;
          }>('SELECT id, s3_key, file_type FROM documents WHERE session_id = $1', [session.id]);

          const documents = documentsResult.rows;

          // Delete documents from S3/MinIO
          if (documents.length > 0) {
            logger.info('Documents to delete from S3', {
              sessionId: session.session_id,
              documentCount: documents.length,
              s3Keys: documents.map((d) => d.s3_key),
            });

            for (const doc of documents) {
              if (doc.s3_key) {
                try {
                  const { storageService } = await import('../services/storageService');
                  await storageService.deleteFile(doc.s3_key);
                  // The background processor writes a thumbnail for images
                  // (documentProcessor.generateThumbnail); it is customer data too.
                  if (doc.file_type?.startsWith('image/')) {
                    await storageService.deleteFile(`${doc.s3_key}-thumb.jpg`);
                  }
                } catch (err) {
                  logger.error(`Failed to delete document from S3: ${doc.s3_key}`, {
                    error: err instanceof Error ? err.message : err,
                  });
                }
              }
            }

            // NOTE: this previously deleted the session's payment_orders first,
            // to work around a foreign key. That is now removed — deleting
            // payment records as part of a privacy cleanup is exactly the bug
            // that wiped every transaction in production. Migration 013 changed
            // the constraints so a document delete no longer reaches them:
            // print_jobs.document_id is SET NULL, and payment rows are RESTRICT.

            // Delete the document rows. Any job still referencing one simply
            // has its document_id cleared; the job and its payments survive.
            await client.query('DELETE FROM documents WHERE session_id = $1', [session.id]);

            documentsDeleted += documents.length;
          }

          // Update session status to expired
          await client.query(
            `UPDATE print_sessions
             SET status = 'expired', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
             WHERE id = $1`,
            [session.id]
          );

          logger.info('Session expired and cleaned up', {
            sessionId: session.session_id,
            previousStatus: session.status,
            documentsDeleted: documents.length,
          });
        });
      } catch (error) {
        logger.error('Failed to process expired session', {
          sessionId: session.session_id,
          error: error instanceof Error ? error.message : error,
        });
        // Continue processing other sessions even if one fails
      }
    }

    const duration = Date.now() - startTime;

    logger.info('Session expiry job completed', {
      expiredCount: expiredSessions.length,
      documentsDeleted,
      durationMs: duration,
    });

    return {
      expiredCount: expiredSessions.length,
      documentsDeleted,
    };
  } catch (error) {
    logger.error('Session expiry job failed', {
      error: error instanceof Error ? error.message : error,
    });
    throw error;
  }
}

const INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | undefined;

/**
 * One guarded pass. Never throws: a failed sweep is logged and retried on the
 * next tick, and must not take the process down with it.
 */
export async function runSessionExpiry(): Promise<void> {
  try {
    await withAdvisoryLock(LOCKS.SESSION_EXPIRY, processSessionExpiry);
  } catch (error) {
    logger.error('Session expiry sweep failed', {
      error: error instanceof Error ? error.message : error,
    });
  }
}

/**
 * Run the session sweep every minute.
 *
 * This used to be a Bull repeatable job, which kept Redis busy around the
 * clock just to trigger one SQL query a minute — enough on its own to exhaust
 * a hosted Redis free tier, whose quota error then crashed the API. A timer
 * plus a Postgres advisory lock does the same job with nothing extra to run.
 */
export function scheduleSessionExpiryJob(): void {
  if (timer) return;

  // First pass shortly after boot, then every minute.
  setTimeout(() => void runSessionExpiry(), 10_000).unref();
  timer = setInterval(() => void runSessionExpiry(), INTERVAL_MS);
  timer.unref();

  logger.info('Session expiry job scheduled (runs every minute)');
}

export function stopSessionExpiryJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/**
 * Manually trigger session expiry (useful for testing)
 */
export async function triggerSessionExpiry(): Promise<{
  expiredCount: number;
  documentsDeleted: number;
} | null> {
  logger.info('Manually triggering session expiry job');
  return withAdvisoryLock(LOCKS.SESSION_EXPIRY, processSessionExpiry);
}
