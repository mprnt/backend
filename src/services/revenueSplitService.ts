import { Database, PoolClient, db } from '../config/database';
import { AppError } from '../utils/errors';
import { ReportPeriod } from '../types/admin';
import { dashboardService } from './dashboardService';

/**
 * Revenue share for partners on Model 2 · Option A.
 *
 * The partner keeps `partnerSharePct` of each paid sale and MPrnt keeps the
 * rest. Two rules make the numbers defensible:
 *
 *   1. A sale is split at the moment its payment is captured, using the term in
 *      force then, and the result is written onto the job. Changing the terms
 *      later never moves money that was already split.
 *   2. Money is computed in Postgres NUMERIC, and MPrnt's share is the total
 *      minus the partner's share, so the two always add back to the sale.
 */

export const SPLIT_BUSINESS_MODEL = 'revenue-share';

/** Only partners on this model are split. Anyone else keeps all of the revenue. */
export function platformSharePct(partnerSharePct: number): number {
  return Math.round((100 - partnerSharePct) * 100) / 100;
}

export type TermStatus = 'active' | 'scheduled' | 'superseded';

export interface TermRecord {
  id: string;
  /** null = the partner-wide default; otherwise the QR point it overrides. */
  kioskId: string | null;
  partnerSharePct: number;
  effectiveFrom: Date;
  createdAt: Date;
}

export interface ClassifiedTerm extends TermRecord {
  status: TermStatus;
}

/**
 * Says which term is in force, which is queued, and which were replaced, for
 * each scope (the partner default, and each QR point).
 *
 * Within a scope the newest term whose start has passed is active, anything
 * starting later is scheduled, and older ones are superseded. This mirrors the
 * SQL in `resolveTerm`, so the view and the captured sales cannot disagree.
 */
export function classifyTerms(terms: TermRecord[], now: Date): ClassifiedTerm[] {
  const byScope = new Map<string, TermRecord[]>();
  for (const t of terms) {
    const key = t.kioskId ?? 'partner';
    byScope.set(key, [...(byScope.get(key) ?? []), t]);
  }

  const classified = new Map<string, TermStatus>();
  for (const scoped of byScope.values()) {
    const newestFirst = [...scoped].sort(
      (a, b) =>
        b.effectiveFrom.getTime() - a.effectiveFrom.getTime() ||
        b.createdAt.getTime() - a.createdAt.getTime()
    );
    let activeFound = false;
    for (const t of newestFirst) {
      if (t.effectiveFrom.getTime() > now.getTime()) {
        classified.set(t.id, 'scheduled');
      } else if (!activeFound) {
        classified.set(t.id, 'active');
        activeFound = true;
      } else {
        classified.set(t.id, 'superseded');
      }
    }
  }

  return terms.map((t) => ({ ...t, status: classified.get(t.id) ?? 'superseded' }));
}

/** The term that applies to a QR point: its own override if one is active, else the partner default. */
export function effectiveTerm(
  classified: ClassifiedTerm[],
  kioskId: string
): { term: ClassifiedTerm; source: 'qr_point' | 'partner' } | null {
  const own = classified.find((t) => t.kioskId === kioskId && t.status === 'active');
  if (own) return { term: own, source: 'qr_point' };
  const fallback = classified.find((t) => t.kioskId === null && t.status === 'active');
  return fallback ? { term: fallback, source: 'partner' } : null;
}

export interface SplitTermOut {
  id: string;
  scope: 'partner' | 'qr_point';
  kioskId: string | null;
  kioskName: string | null;
  partnerSharePct: number;
  platformSharePct: number;
  effectiveFrom: string;
  status: TermStatus;
  note: string;
  createdAt: string;
  /** Only sent to super admins. The shop sees what applies, not who set it. */
  createdBy?: string | null;
}

/** The split a QR point earns on right now. Null shares = no term applies yet. */
export interface QrPointSplit {
  kioskId: string;
  kioskName: string;
  partnerSharePct: number | null;
  platformSharePct: number | null;
  source: 'qr_point' | 'partner' | null;
  effectiveFrom: string | null;
}

export interface SplitView {
  applies: boolean;
  partnerDefault: {
    partnerSharePct: number;
    platformSharePct: number;
    effectiveFrom: string;
  } | null;
  byQrPoint: QrPointSplit[];
  history: SplitTermOut[];
}

interface TermRow {
  id: string;
  kiosk_id: string | null;
  kiosk_name: string | null;
  partner_share_pct: string;
  effective_from: Date;
  note: string;
  created_at: Date;
  created_by_email: string | null;
}

interface KioskRow {
  id: string;
  name: string;
}

export interface SplitSummary {
  range: { from: string; to: string; timezone: string };
  paidJobs: number;
  /** Paid sales made after a split was recorded for the partner. */
  splitJobs: number;
  grossRevenue: number;
  partnerRevenue: number;
  platformRevenue: number;
  /** Paid sales with no split recorded: before the terms, or outside Option A. */
  unsplitRevenue: number;
}

export interface SplitWriteInput {
  organizationId: string;
  kioskId: string | null;
  partnerSharePct: number;
  effectiveFrom: Date | null;
  note: string;
  actorId: string;
}

type Queryable = Pick<PoolClient, 'query'>;

export class RevenueSplitService {
  constructor(private database: Database = db) {}

  /**
   * The split that applies to a sale right now: a QR point override if one is
   * in force, else the partner default. Null if the partner is not on Option A
   * or no term has started yet.
   */
  async resolveTerm(
    client: Queryable,
    organizationId: string,
    kioskId: string | null
  ): Promise<{ termId: string; partnerSharePct: number } | null> {
    const result = await client.query<{ id: string; partner_share_pct: string }>(
      `SELECT t.id, t.partner_share_pct
         FROM revenue_split_terms t
         JOIN organizations o ON o.id = t.organization_id
        WHERE t.organization_id = $1
          AND (t.kiosk_id IS NULL OR t.kiosk_id = $2)
          AND t.effective_from <= NOW()
          AND o.business_model = $3
          AND o.deleted_at IS NULL
        ORDER BY (t.kiosk_id IS NOT NULL) DESC, t.effective_from DESC, t.created_at DESC
        LIMIT 1`,
      [organizationId, kioskId, SPLIT_BUSINESS_MODEL]
    );

    if (result.rows.length === 0) return null;
    return { termId: result.rows[0].id, partnerSharePct: Number(result.rows[0].partner_share_pct) };
  }

  /**
   * Writes the split onto a sale whose payment has just been captured. Called
   * inside the payment transaction, so a sale is never paid without its split.
   * A sale with no applicable term is left unsplit rather than guessed at.
   */
  async snapshotPaidJob(client: Queryable, jobId: string): Promise<boolean> {
    const job = await client.query<{ organization_id: string | null; kiosk_id: string | null }>(
      `SELECT organization_id, kiosk_id FROM print_jobs WHERE id = $1`,
      [jobId]
    );
    const row = job.rows[0];
    if (!row?.organization_id) return false;

    const term = await this.resolveTerm(client, row.organization_id, row.kiosk_id);
    if (!term) return false;

    // The guard on split_term_id makes this write-once: a sale already split
    // matches no row, so a later call reports false and changes nothing.
    const written = await client.query(
      `UPDATE print_jobs pj
          SET split_term_id     = $2,
              partner_share_pct = $3,
              partner_amount    = ROUND(pj.total_amount * $3 / 100, 2),
              platform_amount   = pj.total_amount - ROUND(pj.total_amount * $3 / 100, 2)
        WHERE pj.id = $1
          AND pj.split_term_id IS NULL`,
      [jobId, term.termId, term.partnerSharePct]
    );
    return (written.rowCount ?? 0) > 0;
  }

  /**
   * Records a new term. Terms are never edited: a change is a new row with its
   * own start time, so the history a partner was shown cannot be rewritten.
   */
  async setTerm(
    input: SplitWriteInput
  ): Promise<{ id: string; effectiveFrom: Date; previous: number | null }> {
    const org = await this.database.query<{ business_model: string | null }>(
      `SELECT business_model FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
      [input.organizationId]
    );
    if (org.rows.length === 0) {
      throw new AppError('Partner not found', 404);
    }
    if (org.rows[0].business_model !== SPLIT_BUSINESS_MODEL) {
      throw new AppError(
        'A revenue split applies only to partners on Model 2 · Option A. Change the partner’s model first.',
        409,
        'NOT_REVENUE_SHARE'
      );
    }

    if (input.kioskId) {
      const kiosk = await this.database.query<{ organization_id: string | null }>(
        `SELECT organization_id FROM kiosks WHERE id = $1`,
        [input.kioskId]
      );
      if (kiosk.rows.length === 0) throw new AppError('QR point not found', 404);
      if (kiosk.rows[0].organization_id !== input.organizationId) {
        throw new AppError('That QR point does not belong to this partner', 400);
      }
    }

    const previous = await this.currentPartnerShare(input.organizationId, input.kioskId);

    const inserted = await this.database.query<{ id: string; effective_from: Date }>(
      `INSERT INTO revenue_split_terms (
         organization_id, kiosk_id, partner_share_pct, effective_from, note, created_by
       ) VALUES ($1, $2, $3, COALESCE($4::timestamp, NOW()), $5, $6)
       RETURNING id, effective_from`,
      [
        input.organizationId,
        input.kioskId,
        input.partnerSharePct,
        input.effectiveFrom,
        input.note.trim(),
        input.actorId,
      ]
    );

    return { id: inserted.rows[0].id, effectiveFrom: inserted.rows[0].effective_from, previous };
  }

  /** The partner share in force now for a scope, or null if none. */
  private async currentPartnerShare(
    organizationId: string,
    kioskId: string | null
  ): Promise<number | null> {
    const terms = await this.listTermRows(organizationId);
    const classified = classifyTerms(terms.map(toRecord), new Date());
    const scoped = classified.find(
      (t) => t.status === 'active' && (kioskId ? t.kioskId === kioskId : t.kioskId === null)
    );
    return scoped ? scoped.partnerSharePct : null;
  }

  private async listTermRows(organizationId: string): Promise<TermRow[]> {
    const result = await this.database.query<TermRow>(
      `SELECT t.id, t.kiosk_id, k.name AS kiosk_name, t.partner_share_pct,
              t.effective_from, t.note, t.created_at, a.email AS created_by_email
         FROM revenue_split_terms t
         LEFT JOIN kiosks k ON k.id = t.kiosk_id
         LEFT JOIN admin_users a ON a.id = t.created_by
        WHERE t.organization_id = $1
        ORDER BY t.effective_from DESC, t.created_at DESC`,
      [organizationId]
    );
    return result.rows;
  }

  /**
   * What a partner sees of its split, and what the console edits. The shop gets
   * the same figures without the name of the person who set each term.
   */
  async getView(
    organizationId: string,
    includeAuthors: boolean,
    now = new Date()
  ): Promise<SplitView> {
    const org = await this.database.query<{ business_model: string | null }>(
      `SELECT business_model FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
      [organizationId]
    );
    if (org.rows.length === 0) throw new AppError('Partner not found', 404);

    const kiosks = await this.database.query<KioskRow>(
      `SELECT id, name FROM kiosks WHERE organization_id = $1 ORDER BY name`,
      [organizationId]
    );
    const rows = await this.listTermRows(organizationId);
    const classified = classifyTerms(rows.map(toRecord), now);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const partnerActive =
      classified.find((t) => t.kioskId === null && t.status === 'active') ?? null;

    return {
      applies: org.rows[0].business_model === SPLIT_BUSINESS_MODEL,
      partnerDefault: partnerActive
        ? {
            partnerSharePct: partnerActive.partnerSharePct,
            platformSharePct: platformSharePct(partnerActive.partnerSharePct),
            effectiveFrom: partnerActive.effectiveFrom.toISOString(),
          }
        : null,
      byQrPoint: kiosks.rows.map((k): QrPointSplit => {
        const eff = effectiveTerm(classified, k.id);
        if (!eff) {
          return {
            kioskId: k.id,
            kioskName: k.name,
            partnerSharePct: null,
            platformSharePct: null,
            source: null,
            effectiveFrom: null,
          };
        }
        return {
          kioskId: k.id,
          kioskName: k.name,
          partnerSharePct: eff.term.partnerSharePct,
          platformSharePct: platformSharePct(eff.term.partnerSharePct),
          source: eff.source,
          effectiveFrom: eff.term.effectiveFrom.toISOString(),
        };
      }),
      history: classified.map((t) => {
        const row = byId.get(t.id)!;
        const out: SplitTermOut = {
          id: t.id,
          scope: t.kioskId ? 'qr_point' : 'partner',
          kioskId: t.kioskId,
          kioskName: row.kiosk_name,
          partnerSharePct: t.partnerSharePct,
          platformSharePct: platformSharePct(t.partnerSharePct),
          effectiveFrom: t.effectiveFrom.toISOString(),
          status: t.status,
          note: row.note,
          createdAt: t.createdAt.toISOString(),
        };
        if (includeAuthors) out.createdBy = row.created_by_email;
        return out;
      }),
    };
  }

  /**
   * Revenue for a period, split between partner and MPrnt. Keyed on the sale's
   * created_at in the partner's own timezone, as every other report is.
   */
  async getSummary(organizationId: string, period: ReportPeriod): Promise<SplitSummary> {
    const range = await dashboardService.resolveRange(organizationId, period);

    const result = await this.database.query<{
      paid_jobs: string;
      split_jobs: string;
      gross: string;
      partner: string;
      platform: string;
      unsplit: string;
    }>(
      `SELECT COUNT(*) FILTER (WHERE pj.payment_status = 'paid')                             AS paid_jobs,
              COUNT(*) FILTER (WHERE pj.payment_status = 'paid' AND pj.split_term_id IS NOT NULL) AS split_jobs,
              COALESCE(SUM(pj.total_amount) FILTER (WHERE pj.payment_status = 'paid'), 0)    AS gross,
              COALESCE(SUM(pj.partner_amount) FILTER (WHERE pj.payment_status = 'paid'), 0)  AS partner,
              COALESCE(SUM(pj.platform_amount) FILTER (WHERE pj.payment_status = 'paid'), 0) AS platform,
              COALESCE(SUM(pj.total_amount) FILTER (
                WHERE pj.payment_status = 'paid' AND pj.split_term_id IS NULL
              ), 0)                                                                           AS unsplit
         FROM print_jobs pj
        WHERE pj.organization_id = $1
          AND (pj.created_at AT TIME ZONE $2)::date >= $3::date
          AND (pj.created_at AT TIME ZONE $2)::date <  $4::date`,
      [organizationId, range.timezone, range.from, range.to]
    );

    const r = result.rows[0];
    return {
      range: { from: range.from, to: range.to, timezone: range.timezone },
      paidJobs: Number(r.paid_jobs) || 0,
      splitJobs: Number(r.split_jobs) || 0,
      grossRevenue: money(r.gross),
      partnerRevenue: money(r.partner),
      platformRevenue: money(r.platform),
      unsplitRevenue: money(r.unsplit),
    };
  }
}

function toRecord(row: TermRow): TermRecord {
  return {
    id: row.id,
    kioskId: row.kiosk_id,
    partnerSharePct: Number(row.partner_share_pct),
    effectiveFrom: new Date(row.effective_from),
    createdAt: new Date(row.created_at),
  };
}

function money(value: string | number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export const revenueSplitService = new RevenueSplitService();
