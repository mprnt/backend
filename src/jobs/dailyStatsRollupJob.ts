import { db } from '../config/database';
import { adminAuthService } from '../services/adminAuthService';
import logger from '../utils/logger';

/**
 * Pre-aggregates each kiosk's day into `daily_stats`.
 *
 * A yearly report over raw `print_jobs` means scanning every job ever taken.
 * One row per kiosk per day turns every range filter into a cheap SUM, and the
 * cost is bounded by kiosks × days rather than by volume.
 *
 * Days are bucketed in each organization's own timezone — a shop's Monday is
 * their local Monday, not UTC's.
 *
 * Re-runnable by design: it recomputes a rolling window and upserts, so a missed
 * run heals itself on the next pass rather than leaving a hole.
 */
export async function rollupDailyStats(daysBack = 3): Promise<number> {
  const result = await db.query(
    `
    WITH bounds AS (
      SELECT k.id AS kiosk_id,
             k.organization_id,
             COALESCE(o.timezone, 'Asia/Kolkata') AS tz
        FROM kiosks k
        LEFT JOIN organizations o ON o.id = k.organization_id
    ),
    jobs AS (
      SELECT b.kiosk_id,
             b.organization_id,
             ((pj.created_at AT TIME ZONE 'UTC') AT TIME ZONE b.tz)::date AS local_date,
             pj.id,
             pj.status,
             pj.payment_status,
             pj.color_mode,
             pj.total_pages,
             pj.total_amount,
             pj.session_id,
             pj.print_duration_seconds
        FROM print_jobs pj
        JOIN bounds b ON b.kiosk_id = pj.kiosk_id
       WHERE pj.created_at >= NOW() - ($1 || ' days')::interval
    )
    INSERT INTO daily_stats (
      date, kiosk_id, organization_id,
      total_sessions, completed_sessions, total_prints, total_pages,
      total_revenue, bw_pages, color_pages, failed_prints,
      avg_session_duration_seconds, last_updated_at
    )
    SELECT local_date,
           kiosk_id,
           organization_id,
           COUNT(DISTINCT session_id),
           COUNT(DISTINCT session_id) FILTER (WHERE status = 'completed'),
           COUNT(*) FILTER (WHERE payment_status = 'paid'),
           COALESCE(SUM(total_pages) FILTER (WHERE payment_status = 'paid'), 0),
           COALESCE(SUM(total_amount) FILTER (WHERE payment_status = 'paid'), 0),
           COALESCE(SUM(total_pages) FILTER (WHERE payment_status = 'paid' AND color_mode <> 'color'), 0),
           COALESCE(SUM(total_pages) FILTER (WHERE payment_status = 'paid' AND color_mode = 'color'), 0),
           COUNT(*) FILTER (WHERE status = 'failed'),
           COALESCE(AVG(print_duration_seconds) FILTER (WHERE print_duration_seconds IS NOT NULL), 0)::int,
           NOW()
      FROM jobs
     GROUP BY local_date, kiosk_id, organization_id
    ON CONFLICT (date, kiosk_id) DO UPDATE SET
      organization_id              = EXCLUDED.organization_id,
      total_sessions               = EXCLUDED.total_sessions,
      completed_sessions           = EXCLUDED.completed_sessions,
      total_prints                 = EXCLUDED.total_prints,
      total_pages                  = EXCLUDED.total_pages,
      total_revenue                = EXCLUDED.total_revenue,
      bw_pages                     = EXCLUDED.bw_pages,
      color_pages                  = EXCLUDED.color_pages,
      failed_prints                = EXCLUDED.failed_prints,
      avg_session_duration_seconds = EXCLUDED.avg_session_duration_seconds,
      last_updated_at              = NOW()
    `,
    [String(daysBack)]
  );

  return result.rowCount || 0;
}

export async function runDailyStatsRollup(): Promise<void> {
  try {
    const rows = await rollupDailyStats();
    if (rows > 0) {
      logger.debug('Daily stats rolled up', { rows });
    }

    const pruned = await adminAuthService.pruneExpiredTokens();
    if (pruned > 0) {
      logger.info('Pruned expired admin refresh tokens', { pruned });
    }
  } catch (error) {
    logger.error('Daily stats rollup failed', { error });
  }
}

let timer: NodeJS.Timeout | undefined;

export function scheduleDailyStatsRollup(intervalMs = 15 * 60 * 1000): void {
  if (timer) return;

  // Run once shortly after boot so a freshly deployed instance has data, then
  // on the interval. Today's figures are read live from print_jobs, so this
  // lagging behind by a few minutes only affects historical buckets.
  setTimeout(() => void runDailyStatsRollup(), 20_000).unref();

  timer = setInterval(() => void runDailyStatsRollup(), intervalMs);
  timer.unref();

  logger.info('Daily stats rollup scheduled', { intervalMs });
}

export function stopDailyStatsRollup(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
