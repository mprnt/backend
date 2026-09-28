import { Job } from 'bull';
import { db } from '../config/database';
import logger from '../utils/logger';
import { sessionExpiryQueue } from '../queues/sessionExpiryQueue';

/**
 * Process expired sessions
 * This job runs every minute to find and clean up expired sessions
 */
export async function processSessionExpiry(_job: Job): Promise<{
  expiredCount: number;
  documentsDeleted: number;
}> {
  const startTime = Date.now();

  logger.info('Starting session expiry job');

  try {
    // Find all expired sessions that are not already marked as expired
    const expiredSessionsResult = await db.query(
      `SELECT ps.id, ps.session_id, ps.expires_at, ps.status
       FROM print_sessions ps
       WHERE ps.expires_at < CURRENT_TIMESTAMP
         AND ps.status NOT IN ('expired', 'complete')
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
          const documentsResult = await client.query(
            'SELECT id, s3_key FROM documents WHERE session_id = $1',
            [session.id]
          );

          const documents = documentsResult.rows;

          // Delete documents from S3/MinIO
          if (documents.length > 0) {
            logger.info('Documents to delete from S3', {
              sessionId: session.session_id,
              documentCount: documents.length,
              s3Keys: documents.map((d: any) => d.s3_key),
            });

            for (const doc of documents) {
              if (doc.s3_key) {
                try {
                  const { storageService } = await import('../services/storageService');
                  await storageService.deleteFile(doc.s3_key);
                } catch (err) {
                  logger.error(`Failed to delete document from S3: ${doc.s3_key}`, {
                    error: err instanceof Error ? err.message : err,
                  });
                }
              }
            }

            // Remove payment orders before document deletion for databases created
            // with the legacy duplicate foreign key constraint.
            await client.query(
              `DELETE FROM payment_orders
               WHERE job_id IN (
                 SELECT id FROM print_jobs WHERE document_id = ANY($1::uuid[])
               )`,
              [documents.map((document: any) => document.id)]
            );

            // Mark documents as deleted in database
            await client.query('DELETE FROM documents WHERE session_id = $1', [session.id]);

            documentsDeleted += documents.length;
          }

          // Update session status to expired
          await client.query(
            `UPDATE print_sessions
             SET status = 'expired', completed_at = CURRENT_TIMESTAMP
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

/**
 * Schedule the session expiry job to run every minute
 */
export function scheduleSessionExpiryJob(): void {
  // Add repeating job that runs every minute
  sessionExpiryQueue.add(
    'expire-sessions',
    {},
    {
      repeat: {
        cron: '* * * * *', // Every minute
      },
      jobId: 'session-expiry-recurring',
    }
  );

  logger.info('Session expiry job scheduled (runs every minute)');
}

/**
 * Process jobs from the queue
 */
sessionExpiryQueue.process('expire-sessions', processSessionExpiry);

/**
 * Manually trigger session expiry (useful for testing)
 */
export async function triggerSessionExpiry(): Promise<{
  expiredCount: number;
  documentsDeleted: number;
}> {
  logger.info('Manually triggering session expiry job');
  const job = await sessionExpiryQueue.add('expire-sessions', {});
  const result = await job.finished();
  return result as { expiredCount: number; documentsDeleted: number };
}
