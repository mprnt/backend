import { Database, db } from '../config/database';
import env from '../config/environment';
import { AppError } from '../utils/errors';
import { ReportPeriod } from '../types/admin';

/**
 * Reporting for both dashboards.
 *
 * Two rules hold throughout this service:
 *
 * 1. **Tenant scope is a parameter, never a filter the caller can omit.** Every
 *    query takes `organizationId`; passing null means "across all shops" and is
 *    only reachable by a super admin, which the route layer enforces.
 *
 * 2. **No customer content leaves this layer.** Shop staff see what was printed
 *    and what it cost, never the document, its filename, its storage key or the
 *    customer's IP. The columns simply are not selected, so a future endpoint
 *    cannot leak them by accident.
 */

/**
 * Buckets a naive UTC timestamp into a calendar day in the shop's own timezone.
 *
 * Columns are `timestamp without time zone` holding UTC, so the value is first
 * labelled UTC and then converted. Without this, a shop in Asia/Kolkata sees
 * takings from after 05:30 IST land on the previous day.
 */
const localDate = (column: string) => `((${column} AT TIME ZONE 'UTC') AT TIME ZONE $TZ)::date`;

export interface DashboardFilters {
  organizationId: string | null;
  kioskId?: string;
  /**
   * Narrow to one printer, by its printer_id (the string a Pi sends, not the
   * UUID). Attribution comes from the print queue: the row that records which
   * machine actually took the job.
   */
  printerId?: string;
  from?: string;
  to?: string;
  period?: ReportPeriod;
}

type DatabaseNumber = string;

interface DashboardRangeRow {
  start_date: string;
  end_date: string;
}

interface OrganizationTimezoneRow {
  timezone: string;
}

interface DashboardSummaryRow {
  total_jobs: DatabaseNumber;
  paid_jobs: DatabaseNumber;
  completed_jobs: DatabaseNumber;
  failed_jobs: DatabaseNumber;
  in_progress_jobs: DatabaseNumber;
  revenue: DatabaseNumber;
  pages_charged: DatabaseNumber;
  pages_printed: DatabaseNumber;
  color_pages: DatabaseNumber;
  bw_pages: DatabaseNumber;
  sessions: DatabaseNumber;
  avg_print_seconds: DatabaseNumber;
}

interface DashboardTimeSeriesRow {
  bucket: string;
  jobs: DatabaseNumber;
  completed: DatabaseNumber;
  failed: DatabaseNumber;
  revenue: DatabaseNumber;
  pages: DatabaseNumber;
}

interface KioskBreakdownRow {
  id: string;
  kiosk_id: string;
  name: string;
  location: string;
  jobs: DatabaseNumber;
  completed: DatabaseNumber;
  revenue: DatabaseNumber;
  pages: DatabaseNumber;
}

interface DashboardSessionDbRow {
  job_id: string;
  session_code: string | null;
  kiosk_id: string;
  kiosk_name: string;
  created_at: Date;
  completed_at: Date | null;
  status: string;
  payment_status: string;
  color_mode: string;
  print_sides: string;
  copies: number;
  total_pages: number;
  printed_pages: number | null;
  total_amount: DatabaseNumber;
  base_price_per_page: DatabaseNumber;
  error_message: string | null;
  print_duration_seconds: number | null;
  printer_id: string | null;
  printer_name: string | null;
}

interface DashboardSession {
  jobId: string;
  sessionCode: string | null;
  kiosk: { code: string; name: string };
  printer: { id: string; name: string | null } | null;
  createdAt: Date;
  completedAt: Date | null;
  status: string;
  paymentStatus: string;
  settings: { colorMode: string; printSides: string; copies: number };
  pages: { charged: number; printed: number; sheets: number };
  amount: number;
  pricePerPage: number;
  durationSeconds: number | null;
  errorMessage: string | null;
}

interface DashboardSessionCountRow {
  total: DatabaseNumber;
}

interface PrinterHealthRow {
  printer_id: string;
  name: string;
  status: string;
  last_heartbeat: Date | null;
  kiosk_uuid: string;
  kiosk_id: string;
  kiosk_name: string;
  org_id: string | null;
  org_name: string | null;
  supports_color: boolean;
  supports_double_sided: boolean;
  api_key_prefix: string | null;
  api_key_issued_at: Date | null;
  revoked_at: Date | null;
  last_seen_ip: string | null;
  seconds_since_heartbeat: number | null;
  active_jobs: DatabaseNumber;
  paper_level: number | null;
  ink_black: number | null;
  is_station: boolean;
  station_name: string | null;
}

interface AttentionQueueRow {
  job_id: string;
  status: string;
  total_amount: DatabaseNumber;
  created_at: Date;
  queue_status: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number | null;
  kiosk_id: string;
  kiosk_name: string;
  age_seconds: number;
}

export class DashboardService {
  constructor(private database: Database = db) {}

  /**
   * Resolve a period into an explicit range, anchored in the shop's timezone so
   * "this month" means their month.
   */
  async resolveRange(
    organizationId: string | null,
    period: ReportPeriod = 'month',
    from?: string,
    to?: string
  ): Promise<{ from: string; to: string; timezone: string; period: ReportPeriod }> {
    const timezone = await this.getTimezone(organizationId);

    if (from && to) {
      if (new Date(from) > new Date(to)) {
        throw new AppError('`from` must not be after `to`', 400);
      }
      return { from, to, timezone, period };
    }

    const truncate: Record<ReportPeriod, string> = {
      day: 'day',
      week: 'week',
      month: 'month',
      year: 'year',
    };

    // Formatted to text in Postgres on purpose. Returning a `date` hands node a
    // JS Date at local midnight, and .toISOString() then shifts it back across
    // the UTC boundary — so "today" would silently query yesterday.
    const result = await this.database.query<DashboardRangeRow>(
      `SELECT to_char(date_trunc($1, (NOW() AT TIME ZONE $2)), 'YYYY-MM-DD') AS start_date,
              to_char((NOW() AT TIME ZONE $2)::date + 1, 'YYYY-MM-DD')       AS end_date`,
      [truncate[period], timezone]
    );

    return {
      from: result.rows[0].start_date,
      to: result.rows[0].end_date,
      timezone,
      period,
    };
  }

  private async getTimezone(organizationId: string | null): Promise<string> {
    if (!organizationId) return 'Asia/Kolkata';

    const result = await this.database.query<OrganizationTimezoneRow>(
      `SELECT timezone FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
      [organizationId]
    );

    if (result.rows.length === 0) {
      throw new AppError('Organization not found', 404);
    }

    return result.rows[0].timezone;
  }

  /**
   * Build the shared WHERE clause. Returns positional args starting at $1 and a
   * `$TZ` placeholder the caller substitutes, so the timezone is bound once.
   */
  private scope(filters: DashboardFilters, tz: string): { where: string; args: unknown[] } {
    const args: unknown[] = [tz];
    const conditions: string[] = [];

    if (filters.organizationId) {
      args.push(filters.organizationId);
      // Revenue belongs to the shop that served the job, fixed at creation —
      // not to whoever owns the kiosk now. See migration 015.
      conditions.push(`pj.organization_id = $${args.length}`);
    }
    if (filters.kioskId) {
      args.push(filters.kioskId);
      conditions.push(`k.id = $${args.length}`);
    }
    if (filters.printerId) {
      args.push(filters.printerId);
      // EXISTS rather than a join: a job can have more than one queue row
      // after a retry, and joining would count its revenue twice.
      //
      // A paid job that never reached a printer belongs to no printer, so it
      // is absent from every per-printer figure while still counting at the
      // QR point and for the partner. That is the honest answer to "what did
      // this machine earn", and the dashboard says so where it shows it.
      conditions.push(
        `EXISTS (SELECT 1 FROM print_queue pq
                   JOIN printers pr ON pr.id = pq.printer_id
                  WHERE pq.job_id = pj.id AND pr.printer_id = $${args.length})`
      );
    }
    if (filters.from) {
      args.push(filters.from);
      conditions.push(`${localDate('pj.created_at')} >= $${args.length}::date`);
    }
    if (filters.to) {
      args.push(filters.to);
      conditions.push(`${localDate('pj.created_at')} < $${args.length}::date`);
    }

    return {
      where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
      args,
    };
  }

  private q(sql: string): string {
    return sql.replace(/\$TZ/g, '$1');
  }

  /**
   * Headline numbers for the selected range.
   *
   * Revenue counts paid jobs only. A job that was created but never paid for is
   * a funnel metric, not money, and conflating the two makes a dashboard lie.
   */
  async getSummary(filters: DashboardFilters): Promise<Record<string, unknown>> {
    const tz = await this.getTimezone(filters.organizationId);
    const { where, args } = this.scope(filters, tz);

    const result = await this.database.query<DashboardSummaryRow>(
      this.q(`
        SELECT
          COUNT(*)                                                    AS total_jobs,
          COUNT(*) FILTER (WHERE pj.payment_status = 'paid')          AS paid_jobs,
          COUNT(*) FILTER (WHERE pj.status = 'completed')             AS completed_jobs,
          COUNT(*) FILTER (WHERE pj.status = 'failed')                AS failed_jobs,
          COUNT(*) FILTER (WHERE pj.status IN ('queued','printing'))  AS in_progress_jobs,
          COALESCE(SUM(pj.total_amount) FILTER (WHERE pj.payment_status = 'paid'), 0) AS revenue,
          COALESCE(SUM(pj.total_pages)  FILTER (WHERE pj.payment_status = 'paid'), 0) AS pages_charged,
          COALESCE(SUM(pj.printed_pages), 0)                          AS pages_printed,
          COALESCE(SUM(pj.total_pages) FILTER (
            WHERE pj.payment_status = 'paid' AND pj.color_mode = 'color'), 0)         AS color_pages,
          COALESCE(SUM(pj.total_pages) FILTER (
            WHERE pj.payment_status = 'paid' AND pj.color_mode <> 'color'), 0)        AS bw_pages,
          COUNT(DISTINCT pj.session_id)                               AS sessions,
          COALESCE(AVG(pj.print_duration_seconds) FILTER (
            WHERE pj.print_duration_seconds IS NOT NULL), 0)          AS avg_print_seconds
        FROM print_jobs pj
        JOIN kiosks k ON k.id = pj.kiosk_id
        ${where}
      `),
      args
    );

    const r = result.rows[0];
    const paid = parseInt(r.paid_jobs) || 0;
    const completed = parseInt(r.completed_jobs) || 0;

    return {
      totalJobs: parseInt(r.total_jobs) || 0,
      paidJobs: paid,
      completedJobs: completed,
      failedJobs: parseInt(r.failed_jobs) || 0,
      inProgressJobs: parseInt(r.in_progress_jobs) || 0,
      sessions: parseInt(r.sessions) || 0,
      revenue: Number(r.revenue) || 0,
      pagesCharged: parseInt(r.pages_charged) || 0,
      pagesPrinted: parseInt(r.pages_printed) || 0,
      colorPages: parseInt(r.color_pages) || 0,
      bwPages: parseInt(r.bw_pages) || 0,
      avgPrintSeconds: Math.round(Number(r.avg_print_seconds) || 0),
      // Of the jobs that were paid for, how many actually printed.
      fulfilmentRate: paid > 0 ? Math.round((completed / paid) * 1000) / 10 : null,
      averageOrderValue: paid > 0 ? Math.round((Number(r.revenue) / paid) * 100) / 100 : 0,
    };
  }

  /**
   * Revenue and volume bucketed by day, week, month or year in the shop's
   * timezone — the series behind the dashboard chart.
   */
  async getTimeSeries(filters: DashboardFilters, bucket: ReportPeriod = 'day'): Promise<unknown[]> {
    const tz = await this.getTimezone(filters.organizationId);
    const { where, args } = this.scope(filters, tz);

    const unit = { day: 'day', week: 'week', month: 'month', year: 'year' }[bucket];

    const result = await this.database.query<DashboardTimeSeriesRow>(
      this.q(`
        SELECT to_char(
                 date_trunc('${unit}', (pj.created_at AT TIME ZONE 'UTC') AT TIME ZONE $TZ),
                 'YYYY-MM-DD'
               ) AS bucket,
               COUNT(*)                                           AS jobs,
               COUNT(*) FILTER (WHERE pj.status = 'completed')     AS completed,
               COUNT(*) FILTER (WHERE pj.status = 'failed')        AS failed,
               COALESCE(SUM(pj.total_amount) FILTER (WHERE pj.payment_status = 'paid'), 0) AS revenue,
               COALESCE(SUM(pj.total_pages)  FILTER (WHERE pj.payment_status = 'paid'), 0) AS pages
          FROM print_jobs pj
          JOIN kiosks k ON k.id = pj.kiosk_id
          ${where}
         GROUP BY bucket
         ORDER BY bucket
      `),
      args
    );

    return result.rows.map((r) => ({
      date: r.bucket,
      jobs: parseInt(r.jobs) || 0,
      completed: parseInt(r.completed) || 0,
      failed: parseInt(r.failed) || 0,
      revenue: Number(r.revenue) || 0,
      pages: parseInt(r.pages) || 0,
    }));
  }

  /**
   * Per-kiosk breakdown, so an owner with several kiosks can see which earns.
   */
  async getKioskBreakdown(filters: DashboardFilters): Promise<unknown[]> {
    const tz = await this.getTimezone(filters.organizationId);
    const { where, args } = this.scope(filters, tz);

    const result = await this.database.query<KioskBreakdownRow>(
      this.q(`
        SELECT k.id, k.kiosk_id, k.name, k.location,
               COUNT(pj.id)                                        AS jobs,
               COUNT(pj.id) FILTER (WHERE pj.status = 'completed')  AS completed,
               COALESCE(SUM(pj.total_amount) FILTER (WHERE pj.payment_status = 'paid'), 0) AS revenue,
               COALESCE(SUM(pj.total_pages)  FILTER (WHERE pj.payment_status = 'paid'), 0) AS pages
          FROM kiosks k
          LEFT JOIN print_jobs pj ON pj.kiosk_id = k.id
          ${where}
         GROUP BY k.id, k.kiosk_id, k.name, k.location
         ORDER BY revenue DESC
      `),
      args
    );

    return result.rows.map((r) => ({
      kioskId: r.id,
      code: r.kiosk_id,
      name: r.name,
      location: r.location,
      jobs: parseInt(r.jobs) || 0,
      completed: parseInt(r.completed) || 0,
      revenue: Number(r.revenue) || 0,
      pages: parseInt(r.pages) || 0,
    }));
  }

  /**
   * The session/job list.
   *
   * Deliberately excluded: document filename, S3 key, page previews, the
   * customer's IP and user agent. A shop needs to know a job happened, what it
   * cost and whether it printed — not what the customer was printing.
   */
  async listSessions(
    filters: DashboardFilters & { status?: string; limit?: number; offset?: number }
  ): Promise<{ rows: DashboardSession[]; total: number }> {
    const tz = await this.getTimezone(filters.organizationId);
    const { where, args } = this.scope(filters, tz);

    const conditions = where ? [where.replace(/^WHERE /, '')] : [];
    const listArgs = [...args];

    if (filters.status) {
      listArgs.push(filters.status);
      conditions.push(`pj.status = $${listArgs.length}`);
    }

    const finalWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    const rows = await this.database.query<DashboardSessionDbRow>(
      this.q(`
        SELECT pj.id                AS job_id,
               ps.session_id        AS session_code,
               k.kiosk_id, k.name   AS kiosk_name,
               pj.created_at, pj.completed_at,
               pj.status, pj.payment_status,
               pj.color_mode, pj.print_sides, pj.copies,
               pj.total_pages, pj.printed_pages, pj.total_amount,
               pj.base_price_per_page, pj.error_message,
               pj.print_duration_seconds,
               p.printer_id, p.name AS printer_name
          FROM print_jobs pj
          JOIN kiosks k          ON k.id = pj.kiosk_id
          LEFT JOIN print_sessions ps ON ps.id = pj.session_id
          LEFT JOIN print_queue pq    ON pq.job_id = pj.id
          LEFT JOIN printers p        ON p.id = pq.printer_id
          ${finalWhere}
         ORDER BY pj.created_at DESC
         LIMIT ${limit} OFFSET ${offset}
      `),
      listArgs
    );

    const count = await this.database.query<DashboardSessionCountRow>(
      this.q(`
        SELECT COUNT(*) AS total
          FROM print_jobs pj
          JOIN kiosks k ON k.id = pj.kiosk_id
          ${finalWhere}
      `),
      listArgs
    );

    return {
      rows: rows.rows.map((r) => ({
        jobId: r.job_id,
        sessionCode: r.session_code,
        kiosk: { code: r.kiosk_id, name: r.kiosk_name },
        printer: r.printer_id ? { id: r.printer_id, name: r.printer_name } : null,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        status: r.status,
        paymentStatus: r.payment_status,
        settings: {
          colorMode: r.color_mode,
          printSides: r.print_sides,
          copies: r.copies,
        },
        pages: {
          charged: r.total_pages,
          printed: r.printed_pages || 0,
          // total_pages already includes copies; multiplying again doubled it.
          sheets: r.total_pages || 0,
        },
        amount: Number(r.total_amount) || 0,
        pricePerPage: Number(r.base_price_per_page) || 0,
        durationSeconds: r.print_duration_seconds,
        errorMessage: r.error_message,
      })),
      total: parseInt(count.rows[0].total) || 0,
    };
  }

  /**
   * Printer health — the screen a shop owner actually checks during the day.
   */
  async getPrinterHealth(organizationId: string | null): Promise<unknown[]> {
    const scoped = organizationId !== null;

    const result = await this.database.query<PrinterHealthRow>(
      `SELECT p.printer_id, p.name, p.status, p.last_heartbeat, p.is_station, p.station_name,
              k.id AS kiosk_uuid, k.kiosk_id, k.name AS kiosk_name,
              o.id AS org_id, o.name AS org_name,
              p.supports_color, p.supports_double_sided,
              p.api_key_prefix, p.api_key_issued_at, p.revoked_at, p.last_seen_ip,
              -- Both sides naive UTC, so the result does not depend on the
              -- database session's timezone setting.
              EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - p.last_heartbeat))::int AS seconds_since_heartbeat,
              (SELECT COUNT(*) FROM print_queue pq
                WHERE pq.printer_id = p.id AND pq.status IN ('assigned','printing')) AS active_jobs,
              (SELECT h.paper_level FROM printer_heartbeats h
                WHERE h.printer_id = p.id ORDER BY h.received_at DESC LIMIT 1) AS paper_level,
              (SELECT h.ink_level_black FROM printer_heartbeats h
                WHERE h.printer_id = p.id ORDER BY h.received_at DESC LIMIT 1) AS ink_black
         FROM printers p
         JOIN kiosks k ON k.id = p.kiosk_id
         LEFT JOIN organizations o ON o.id = k.organization_id
        ${scoped ? 'WHERE k.organization_id = $1' : ''}
        ORDER BY (p.revoked_at IS NOT NULL), o.name, k.kiosk_id, p.name`,
      scoped ? [organizationId] : []
    );

    const warnAfter = env.thresholds.printer_offline_warn_minutes * 60;

    return result.rows.map((r) => ({
      printerId: r.printer_id,
      name: r.name,
      // A revoked printer's last reported status is meaningless — it can no
      // longer authenticate, whatever it last claimed.
      status: r.revoked_at ? 'revoked' : r.status,
      kiosk: { id: r.kiosk_uuid, code: r.kiosk_id, name: r.kiosk_name },
      organization: r.org_id ? { id: r.org_id, name: r.org_name } : null,
      enrollment: {
        // The prefix is a non-secret fragment, shown so an operator can match a
        // Pi's configured key to this row without ever seeing the key.
        keyPrefix: r.api_key_prefix,
        keyIssuedAt: r.api_key_issued_at,
        enrolled: Boolean(r.api_key_prefix) && !r.revoked_at,
        revokedAt: r.revoked_at,
        lastSeenIp: r.last_seen_ip,
      },
      // A station is one printer in an MPrnt enclosure. Nothing downstream
      // branches on this: it only changes what the dashboard calls the row.
      station: {
        isStation: r.is_station,
        name: r.station_name,
        /** What to call this unit on screen. */
        label: r.is_station ? r.station_name || r.name : r.name,
      },
      lastHeartbeat: r.last_heartbeat,
      secondsSinceHeartbeat: r.seconds_since_heartbeat,
      silent:
        !r.revoked_at &&
        r.seconds_since_heartbeat !== null &&
        r.seconds_since_heartbeat > warnAfter,
      activeJobs: parseInt(r.active_jobs) || 0,
      paperLevel: r.paper_level,
      inkLevelBlack: r.ink_black,
      capabilities: {
        color: r.supports_color,
        doubleSided: r.supports_double_sided,
      },
    }));
  }

  /**
   * Jobs needing attention: paid but not printed, or failed outright. This is
   * the queue that turns into refunds if nobody looks at it.
   */
  async getAttentionQueue(organizationId: string | null): Promise<unknown[]> {
    const scoped = organizationId !== null;

    const result = await this.database.query<AttentionQueueRow>(
      `SELECT pj.id AS job_id, pj.status, pj.total_amount, pj.created_at,
              pq.status AS queue_status, pq.error_code, pq.error_message, pq.retry_count,
              k.kiosk_id, k.name AS kiosk_name,
              EXTRACT(EPOCH FROM (NOW() - pj.created_at))::int AS age_seconds
         FROM print_jobs pj
         JOIN kiosks k ON k.id = pj.kiosk_id
         LEFT JOIN print_queue pq ON pq.job_id = pj.id
        WHERE pj.payment_status = 'paid'
          AND pj.status <> 'completed'
          ${scoped ? 'AND pj.organization_id = $1' : ''}
        ORDER BY pj.created_at ASC
        LIMIT 100`,
      scoped ? [organizationId] : []
    );

    return result.rows.map((r) => ({
      jobId: r.job_id,
      status: r.status,
      queueStatus: r.queue_status,
      amount: Number(r.total_amount) || 0,
      kiosk: { code: r.kiosk_id, name: r.kiosk_name },
      createdAt: r.created_at,
      ageSeconds: r.age_seconds,
      retryCount: r.retry_count ?? 0,
      errorCode: r.error_code,
      errorMessage: r.error_message,
      // A paid job older than an hour that still has not printed is a refund
      // candidate, not a transient queue state.
      refundCandidate: r.age_seconds > env.thresholds.refund_candidate_minutes * 60,
    }));
  }

  /** CSV for accounting. Same privacy boundary as the session list. */
  async exportSessionsCsv(filters: DashboardFilters): Promise<string> {
    const { rows } = await this.listSessions({ ...filters, limit: 200 });

    const header = [
      'job_id',
      'created_at',
      'kiosk',
      'printer',
      'status',
      'payment_status',
      'color_mode',
      'sides',
      'copies',
      'pages_charged',
      'pages_printed',
      'price_per_page',
      'amount',
    ];

    const escape = (v: string | number | boolean | Date | null | undefined): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = rows.map((r) =>
      [
        r.jobId,
        r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        r.kiosk.code,
        r.printer?.name ?? '',
        r.status,
        r.paymentStatus,
        r.settings.colorMode,
        r.settings.printSides,
        r.settings.copies,
        r.pages.charged,
        r.pages.printed,
        r.pricePerPage,
        r.amount,
      ]
        .map(escape)
        .join(',')
    );

    return [header.join(','), ...lines].join('\n');
  }
}

export const dashboardService = new DashboardService();
