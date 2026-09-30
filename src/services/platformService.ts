import { Database, db } from '../config/database';
import env from '../config/environment';
import { AppError } from '../utils/errors';
import { ReportPeriod } from '../types/admin';

/**
 * Period-over-period and per-shop reporting for the super admin.
 *
 * ## Like-for-like comparison
 *
 * "This month" on the 5th is five days of trading. Comparing it with all of
 * last month would show every shop down ~80% at the start of each month. So the
 * previous window is the same span, shifted back one period:
 *
 *     current:  start of this month      → now
 *     previous: start of last month      → this time last month
 *
 * The same shape applies to day, week and year.
 *
 * ## Timezones
 *
 * Every window is computed in the shop's own timezone, so a row in the
 * comparison table matches exactly what that shop sees on its own dashboard.
 * Columns hold naive UTC, so each boundary is built in local time and then
 * converted back to naive UTC before comparing:
 *
 *     (local_ts AT TIME ZONE tz) AT TIME ZONE 'UTC'
 */

const UNIT: Record<ReportPeriod, { trunc: string; step: string }> = {
  day: { trunc: 'day', step: '1 day' },
  week: { trunc: 'week', step: '1 week' },
  month: { trunc: 'month', step: '1 month' },
  year: { trunc: 'year', step: '1 year' },
};

/** Window boundaries as naive-UTC timestamps, for a timezone expression. */
const windows = (tz: string) => `
  (date_trunc($1, now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'                    AS cur_start,
  now() AT TIME ZONE 'UTC'                                                                             AS cur_end,
  ((date_trunc($1, now() AT TIME ZONE ${tz}) - $2::interval) AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'   AS prev_start,
  (((now() AT TIME ZONE ${tz}) - $2::interval) AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'                 AS prev_end
`;

/** The per-window aggregates, shared by both queries. `j` is the jobs alias, `w` the windows. */
const aggregates = (j: string, w: string) => {
  const cur = `${j}.created_at >= ${w}.cur_start AND ${j}.created_at < ${w}.cur_end`;
  const prev = `${j}.created_at >= ${w}.prev_start AND ${j}.created_at < ${w}.prev_end`;
  const paid = `${j}.payment_status = 'paid'`;
  return `
    COALESCE(SUM(${j}.total_amount) FILTER (WHERE ${paid} AND ${cur}), 0)  AS cur_revenue,
    COUNT(${j}.id) FILTER (WHERE ${paid} AND ${cur})                       AS cur_paid,
    COUNT(${j}.id) FILTER (WHERE ${j}.status = 'completed' AND ${cur})     AS cur_completed,
    COUNT(${j}.id) FILTER (WHERE ${j}.status = 'failed' AND ${cur})        AS cur_failed,
    COALESCE(SUM(${j}.total_pages) FILTER (WHERE ${paid} AND ${cur}), 0)   AS cur_pages,
    COALESCE(SUM(${j}.total_amount) FILTER (WHERE ${paid} AND ${prev}), 0) AS prev_revenue,
    COUNT(${j}.id) FILTER (WHERE ${paid} AND ${prev})                      AS prev_paid,
    COUNT(${j}.id) FILTER (WHERE ${j}.status = 'completed' AND ${prev})    AS prev_completed,
    COUNT(${j}.id) FILTER (WHERE ${j}.status = 'failed' AND ${prev})       AS prev_failed,
    COALESCE(SUM(${j}.total_pages) FILTER (WHERE ${paid} AND ${prev}), 0)  AS prev_pages
  `;
};

export interface WindowTotals {
  revenue: number;
  paidJobs: number;
  completedJobs: number;
  failedJobs: number;
  pages: number;
}

export interface Comparison {
  current: WindowTotals;
  previous: WindowTotals;
  /** Percentage change. null when the previous window was zero — growth from nothing is undefined, not infinite. */
  change: { revenuePct: number | null; paidJobsPct: number | null; pagesPct: number | null };
}

function pct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function totals(r: any, prefix: 'cur' | 'prev'): WindowTotals {
  return {
    revenue: Number(r[`${prefix}_revenue`]) || 0,
    paidJobs: parseInt(r[`${prefix}_paid`]) || 0,
    completedJobs: parseInt(r[`${prefix}_completed`]) || 0,
    failedJobs: parseInt(r[`${prefix}_failed`]) || 0,
    pages: parseInt(r[`${prefix}_pages`]) || 0,
  };
}

function compare(r: any): Comparison {
  const current = totals(r, 'cur');
  const previous = totals(r, 'prev');
  return {
    current,
    previous,
    change: {
      revenuePct: pct(current.revenue, previous.revenue),
      paidJobsPct: pct(current.paidJobs, previous.paidJobs),
      pagesPct: pct(current.pages, previous.pages),
    },
  };
}

export type ShopActivity = 'active' | 'inactive' | 'new' | 'suspended';

export class PlatformService {
  constructor(private database: Database = db) {}

  /**
   * Current vs previous window for one shop, or for the whole platform when
   * organizationId is null.
   */
  async getComparison(
    organizationId: string | null,
    period: ReportPeriod
  ): Promise<Comparison & { timezone: string }> {
    let timezone = 'Asia/Kolkata';

    if (organizationId) {
      const org = await this.database.query(
        `SELECT timezone FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
        [organizationId]
      );
      if (org.rows.length === 0) throw new AppError('Organization not found', 404);
      timezone = org.rows[0].timezone;
    }

    const { trunc, step } = UNIT[period];

    const result = await this.database.query(
      `WITH w AS (SELECT ${windows('$3')})
       SELECT ${aggregates('pj', 'w')}
         FROM w
         LEFT JOIN kiosks k ON ($4::uuid IS NULL OR k.organization_id = $4::uuid)
         LEFT JOIN print_jobs pj ON pj.kiosk_id = k.id
                                AND pj.created_at >= w.prev_start
                                AND pj.created_at < w.cur_end`,
      [trunc, step, timezone, organizationId]
    );

    return { ...compare(result.rows[0]), timezone };
  }

  /**
   * One row per shop: this period against the same span of the previous one,
   * plus the operational signals a platform operator scans for — printers
   * offline, and shops that have gone quiet.
   */
  async getOrganizationComparison(period: ReportPeriod): Promise<{
    period: ReportPeriod;
    inactiveAfterDays: number;
    organizations: unknown[];
    totals: Comparison;
  }> {
    const { trunc, step } = UNIT[period];
    const inactiveDays = env.thresholds.inactive_shop_days;

    const result = await this.database.query(
      `WITH w AS (
         SELECT o.id, o.name, o.slug, o.status, o.timezone, o.created_at,
                ${windows('o.timezone')}
           FROM organizations o
          WHERE o.deleted_at IS NULL
       ),
       agg AS (
         SELECT w.id, ${aggregates('pj', 'w')}
           FROM w
           LEFT JOIN kiosks k ON k.organization_id = w.id
           LEFT JOIN print_jobs pj ON pj.kiosk_id = k.id
                                  AND pj.created_at >= w.prev_start
                                  AND pj.created_at < w.cur_end
          GROUP BY w.id
       ),
       last_paid AS (
         SELECT k.organization_id AS id, MAX(pj.created_at) AS at
           FROM print_jobs pj
           JOIN kiosks k ON k.id = pj.kiosk_id
          WHERE pj.payment_status = 'paid'
          GROUP BY k.organization_id
       ),
       fleet AS (
         SELECT k.organization_id AS id,
                COUNT(DISTINCT k.id)                                                   AS kiosks,
                COUNT(p.id) FILTER (WHERE p.revoked_at IS NULL)                        AS printers_total,
                COUNT(p.id) FILTER (WHERE p.revoked_at IS NULL AND p.status = 'online') AS printers_online
           FROM kiosks k
           LEFT JOIN printers p ON p.kiosk_id = k.id
          GROUP BY k.organization_id
       )
       SELECT w.id, w.name, w.slug, w.status, w.timezone, agg.*,
              -- Formatted as text in SQL so the value is host-timezone independent.
              to_char(lp.at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')                            AS last_paid_at,
              EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - lp.at)) / 86400.0     AS days_since_paid,
              EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - w.created_at)) / 86400.0 AS age_days,
              COALESCE(f.kiosks, 0)          AS kiosks,
              COALESCE(f.printers_total, 0)  AS printers_total,
              COALESCE(f.printers_online, 0) AS printers_online
         FROM w
         JOIN agg ON agg.id = w.id
         LEFT JOIN last_paid lp ON lp.id = w.id
         LEFT JOIN fleet f ON f.id = w.id
        ORDER BY agg.cur_revenue DESC, w.name`,
      [trunc, step]
    );

    const organizations = result.rows.map((r: any) => {
      const comparison = compare(r);
      const daysSincePaid = r.days_since_paid === null ? null : Number(r.days_since_paid);
      const ageDays = Number(r.age_days) || 0;

      let activity: ShopActivity;
      if (r.status === 'suspended') activity = 'suspended';
      else if (daysSincePaid === null) activity = ageDays < inactiveDays ? 'new' : 'inactive';
      else activity = daysSincePaid >= inactiveDays ? 'inactive' : 'active';

      const paid = comparison.current.paidJobs;

      return {
        organization: {
          id: r.id,
          name: r.name,
          slug: r.slug,
          status: r.status,
          timezone: r.timezone,
        },
        ...comparison,
        fulfilmentRate:
          paid > 0 ? Math.round((comparison.current.completedJobs / paid) * 1000) / 10 : null,
        kiosks: parseInt(r.kiosks) || 0,
        printersOnline: parseInt(r.printers_online) || 0,
        printersTotal: parseInt(r.printers_total) || 0,
        lastPaidAt: r.last_paid_at,
        daysSinceLastPaid: daysSincePaid === null ? null : Math.floor(daysSincePaid),
        activity,
      };
    });

    // Platform totals are the sum of the rows, so the table and its footer can
    // never disagree.
    const sum = (key: keyof WindowTotals, which: 'current' | 'previous') =>
      organizations.reduce((acc: number, o: any) => acc + o[which][key], 0);
    const keys: (keyof WindowTotals)[] = [
      'revenue',
      'paidJobs',
      'completedJobs',
      'failedJobs',
      'pages',
    ];
    const current = Object.fromEntries(
      keys.map((k) => [k, sum(k, 'current')])
    ) as unknown as WindowTotals;
    const previous = Object.fromEntries(
      keys.map((k) => [k, sum(k, 'previous')])
    ) as unknown as WindowTotals;
    current.revenue = Math.round(current.revenue * 100) / 100;
    previous.revenue = Math.round(previous.revenue * 100) / 100;

    return {
      period,
      inactiveAfterDays: inactiveDays,
      organizations,
      totals: {
        current,
        previous,
        change: {
          revenuePct: pct(current.revenue, previous.revenue),
          paidJobsPct: pct(current.paidJobs, previous.paidJobs),
          pagesPct: pct(current.pages, previous.pages),
        },
      },
    };
  }
}

export const platformService = new PlatformService();
