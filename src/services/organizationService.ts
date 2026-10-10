import { Database, QueryResultRow, db } from '../config/database';
import { AppError } from '../utils/errors';
import { Organization, OrganizationStatus } from '../types/admin';
import { BusinessModelId } from '../types/businessModels';
import logger from '../utils/logger';

interface OrganizationRow extends QueryResultRow {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  business_model: BusinessModelId | null;
  timezone: string;
  contact_email: string | null;
  contact_phone: string | null;
  kiosk_count?: string;
  admin_count?: string;
  created_at: Date;
}

interface CountRow extends QueryResultRow {
  count: string;
}

/**
 * What a shop may know about itself.
 *
 * Deliberately a separate, explicit shape rather than the Organization type:
 * that one is the platform's view of a partner (slug, commercial model, notes),
 * none of which belongs on a shop's own dashboard.
 */
export interface ShopProfile {
  name: string;
  status: OrganizationStatus;
  timezone: string;
  contactEmail: string | null;
  contactPhone: string | null;
  /** When the shop joined, as UTC ISO text (formatted in SQL, host-tz independent). */
  memberSince: string;
  fleet: { qrPoints: number; printers: number; stations: number };
  /** Everything since joining. Revenue is paid jobs, as on the other reports. */
  lifetime: {
    revenue: number;
    paidJobs: number;
    completedJobs: number;
    pagesPrinted: number;
    firstSaleAt: string | null;
  };
}

interface ShopProfileRow extends QueryResultRow {
  name: string;
  status: OrganizationStatus;
  timezone: string;
  contact_email: string | null;
  contact_phone: string | null;
  member_since: string;
  qr_points: string;
  printers: string;
  stations: string;
  revenue: string;
  paid_jobs: string;
  completed_jobs: string;
  pages_printed: string;
  first_sale_at: string | null;
}

interface KioskListRow extends QueryResultRow {
  id: string;
  kiosk_id: string;
  name: string;
  location: string;
  status: string;
  organization_id: string;
  organization_name: string | null;
  printers_online: string;
  printers_total: string;
}

export class OrganizationService {
  constructor(private database: Database = db) {}

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  private map(row: OrganizationRow): Organization {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      businessModel: row.business_model ?? null,
      timezone: row.timezone,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      kioskCount: row.kiosk_count !== undefined ? parseInt(row.kiosk_count) : undefined,
      adminCount: row.admin_count !== undefined ? parseInt(row.admin_count) : undefined,
      createdAt: row.created_at,
    };
  }

  async create(params: {
    name: string;
    businessModel?: BusinessModelId | null;
    timezone?: string;
    contactEmail?: string;
    contactPhone?: string;
    notes?: string;
  }): Promise<Organization> {
    const base = this.slugify(params.name);
    if (!base) {
      throw new AppError('Organization name must contain at least one letter or digit', 400);
    }

    // Slugs must be unique among live organizations; append a suffix if taken.
    let slug = base;
    for (let attempt = 1; attempt < 50; attempt++) {
      const clash = await this.database.query(
        `SELECT 1 FROM organizations WHERE slug = $1 AND deleted_at IS NULL`,
        [slug]
      );
      if (clash.rows.length === 0) break;
      slug = `${base}-${attempt + 1}`;
    }

    const result = await this.database.query<OrganizationRow>(
      `INSERT INTO organizations
         (name, slug, business_model, timezone, contact_email, contact_phone, notes)
       VALUES ($1, $2, $3, COALESCE($4, 'Asia/Kolkata'), $5, $6, $7)
       RETURNING *`,
      [
        params.name,
        slug,
        params.businessModel ?? null,
        params.timezone ?? null,
        params.contactEmail ?? null,
        params.contactPhone ?? null,
        params.notes ?? null,
      ]
    );

    logger.info('Organization created', { id: result.rows[0].id, slug });
    return this.map(result.rows[0]);
  }

  async list(
    params: {
      status?: OrganizationStatus;
      search?: string;
      /** 'none' selects partners with no model recorded yet. */
      businessModel?: BusinessModelId | 'none';
    } = {}
  ): Promise<Organization[]> {
    const conditions = ['o.deleted_at IS NULL'];
    const args: unknown[] = [];

    if (params.status) {
      args.push(params.status);
      conditions.push(`o.status = $${args.length}`);
    }
    if (params.search) {
      args.push(`%${params.search}%`);
      conditions.push(`(o.name ILIKE $${args.length} OR o.slug ILIKE $${args.length})`);
    }
    if (params.businessModel === 'none') {
      conditions.push('o.business_model IS NULL');
    } else if (params.businessModel) {
      args.push(params.businessModel);
      conditions.push(`o.business_model = $${args.length}`);
    }

    const result = await this.database.query<OrganizationRow>(
      `SELECT o.*,
              (SELECT COUNT(*) FROM kiosks k WHERE k.organization_id = o.id) AS kiosk_count,
              (SELECT COUNT(*) FROM admin_users au
                WHERE au.organization_id = o.id AND au.deleted_at IS NULL) AS admin_count
         FROM organizations o
        WHERE ${conditions.join(' AND ')}
        ORDER BY o.created_at DESC`,
      args
    );

    return result.rows.map((r) => this.map(r));
  }

  /**
   * The signed-in shop's own profile and lifetime figures.
   *
   * Takes the organization id from the authenticated principal and from
   * nowhere else: there is no parameter, query string or body field that can
   * point it at a different shop. Every subquery below is bound to that one id.
   */
  async getOwnProfile(organizationId: string): Promise<ShopProfile> {
    const result = await this.database.query<ShopProfileRow>(
      `SELECT o.name, o.status, o.timezone, o.contact_email, o.contact_phone,
              to_char(o.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS member_since,
              (SELECT COUNT(*) FROM kiosks k WHERE k.organization_id = o.id) AS qr_points,
              (SELECT COUNT(*) FROM printers p JOIN kiosks k ON k.id = p.kiosk_id
                WHERE k.organization_id = o.id AND p.revoked_at IS NULL) AS printers,
              (SELECT COUNT(*) FROM printers p JOIN kiosks k ON k.id = p.kiosk_id
                WHERE k.organization_id = o.id AND p.revoked_at IS NULL AND p.is_station) AS stations,
              COALESCE(j.revenue, 0)        AS revenue,
              COALESCE(j.paid_jobs, 0)      AS paid_jobs,
              COALESCE(j.completed_jobs, 0) AS completed_jobs,
              COALESCE(j.pages_printed, 0)  AS pages_printed,
              to_char(j.first_sale, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_sale_at
         FROM organizations o
         LEFT JOIN LATERAL (
           SELECT SUM(pj.total_amount) FILTER (WHERE pj.payment_status = 'paid') AS revenue,
                  COUNT(*)             FILTER (WHERE pj.payment_status = 'paid') AS paid_jobs,
                  COUNT(*)             FILTER (WHERE pj.status = 'completed')    AS completed_jobs,
                  SUM(pj.printed_pages)                                          AS pages_printed,
                  MIN(pj.created_at)   FILTER (WHERE pj.payment_status = 'paid') AS first_sale
             FROM print_jobs pj
            WHERE pj.organization_id = o.id
         ) j ON true
        WHERE o.id = $1 AND o.deleted_at IS NULL`,
      [organizationId]
    );

    const r = result.rows[0];
    if (!r) throw new AppError('Shop not found', 404);

    return {
      name: r.name,
      status: r.status,
      timezone: r.timezone,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      memberSince: r.member_since,
      fleet: {
        qrPoints: parseInt(r.qr_points) || 0,
        printers: parseInt(r.printers) || 0,
        stations: parseInt(r.stations) || 0,
      },
      lifetime: {
        revenue: Math.round((Number(r.revenue) || 0) * 100) / 100,
        paidJobs: parseInt(r.paid_jobs) || 0,
        completedJobs: parseInt(r.completed_jobs) || 0,
        pagesPrinted: parseInt(r.pages_printed) || 0,
        firstSaleAt: r.first_sale_at,
      },
    };
  }

  async getById(id: string): Promise<Organization> {
    const result = await this.database.query<OrganizationRow>(
      `SELECT o.*,
              (SELECT COUNT(*) FROM kiosks k WHERE k.organization_id = o.id) AS kiosk_count,
              (SELECT COUNT(*) FROM admin_users au
                WHERE au.organization_id = o.id AND au.deleted_at IS NULL) AS admin_count
         FROM organizations o
        WHERE o.id = $1 AND o.deleted_at IS NULL`,
      [id]
    );

    if (result.rows.length === 0) {
      throw new AppError('Organization not found', 404);
    }

    return this.map(result.rows[0]);
  }

  async update(
    id: string,
    params: {
      name?: string;
      businessModel?: BusinessModelId | null;
      timezone?: string;
      contactEmail?: string;
      contactPhone?: string;
      notes?: string;
    }
  ): Promise<Organization> {
    const sets: string[] = [];
    const args: unknown[] = [id];

    const assign = (column: string, value: unknown) => {
      if (value !== undefined) {
        args.push(value);
        sets.push(`${column} = $${args.length}`);
      }
    };

    assign('name', params.name);
    assign('business_model', params.businessModel);
    assign('timezone', params.timezone);
    assign('contact_email', params.contactEmail);
    assign('contact_phone', params.contactPhone);
    assign('notes', params.notes);

    if (sets.length === 0) {
      return this.getById(id);
    }

    sets.push('updated_at = NOW()');

    const result = await this.database.query<OrganizationRow>(
      `UPDATE organizations SET ${sets.join(', ')}
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      args
    );

    if (result.rows.length === 0) {
      throw new AppError('Organization not found', 404);
    }

    return this.map(result.rows[0]);
  }

  /**
   * Suspending a shop blocks its staff from signing in and stops its kiosks
   * taking new work, without destroying any history.
   */
  async setStatus(id: string, status: OrganizationStatus): Promise<Organization> {
    const result = await this.database.query<OrganizationRow>(
      `UPDATE organizations SET status = $2, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, status]
    );

    if (result.rows.length === 0) {
      throw new AppError('Organization not found', 404);
    }

    if (status === 'suspended') {
      // Cut live sessions immediately rather than waiting for tokens to expire.
      await this.database.query(
        `UPDATE admin_refresh_tokens SET revoked_at = NOW()
          WHERE revoked_at IS NULL
            AND admin_user_id IN (SELECT id FROM admin_users WHERE organization_id = $1)`,
        [id]
      );
    }

    logger.warn('Organization status changed', { id, status });
    return this.map(result.rows[0]);
  }

  /**
   * Soft delete. Refuses while kiosks are still attached, because orphaning a
   * live kiosk would leave printers serving a shop that no longer exists.
   */
  async softDelete(id: string): Promise<void> {
    const kiosks = await this.database.query<CountRow>(
      `SELECT COUNT(*) AS count FROM kiosks WHERE organization_id = $1`,
      [id]
    );

    if (parseInt(kiosks.rows[0].count) > 0) {
      throw new AppError('Reassign or remove this organization’s kiosks before deleting it', 409);
    }

    const result = await this.database.query(
      `UPDATE organizations SET deleted_at = NOW(), status = 'suspended', updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );

    if (result.rowCount === 0) {
      throw new AppError('Organization not found', 404);
    }

    await this.database.query(
      `UPDATE admin_users SET deleted_at = NOW(), is_active = false, updated_at = NOW()
        WHERE organization_id = $1 AND deleted_at IS NULL`,
      [id]
    );

    await this.database.query(
      `UPDATE admin_refresh_tokens SET revoked_at = NOW()
        WHERE revoked_at IS NULL
          AND admin_user_id IN (SELECT id FROM admin_users WHERE organization_id = $1)`,
      [id]
    );

    logger.warn('Organization soft-deleted', { id });
  }

  /** Assign a kiosk to an organization, or move it between them. */
  async assignKiosk(kioskId: string, organizationId: string): Promise<void> {
    await this.getById(organizationId);

    const result = await this.database.query(
      `UPDATE kiosks SET organization_id = $2, updated_at = NOW() WHERE id = $1`,
      [kioskId, organizationId]
    );

    if (result.rowCount === 0) {
      throw new AppError('Kiosk not found', 404);
    }

    logger.info('Kiosk assigned to organization', { kioskId, organizationId });
  }

  async listKiosks(organizationId: string | null): Promise<unknown[]> {
    const scoped = organizationId !== null;
    const result = await this.database.query<KioskListRow>(
      `SELECT k.id, k.kiosk_id, k.name, k.location, k.status, k.organization_id,
              o.name AS organization_name,
              -- 'busy' is a printer mid-job, which is working; only offline or
              -- revoked means work cannot reach it.
              (SELECT COUNT(*) FROM printers p
                WHERE p.kiosk_id = k.id AND p.revoked_at IS NULL
                  AND p.status IN ('online', 'busy')) AS printers_online,
              (SELECT COUNT(*) FROM printers p
                WHERE p.kiosk_id = k.id AND p.revoked_at IS NULL) AS printers_total
         FROM kiosks k
         LEFT JOIN organizations o ON o.id = k.organization_id
        ${scoped ? 'WHERE k.organization_id = $1' : ''}
        ORDER BY k.kiosk_id`,
      scoped ? [organizationId] : []
    );

    return result.rows.map((r) => ({
      id: r.id,
      kioskId: r.kiosk_id,
      name: r.name,
      location: r.location,
      status: r.status,
      organizationId: r.organization_id,
      organizationName: r.organization_name,
      printersOnline: parseInt(r.printers_online, 10) || 0,
      printersTotal: parseInt(r.printers_total, 10) || 0,
    }));
  }
}

export const organizationService = new OrganizationService();
