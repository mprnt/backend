import { Database, db } from '../config/database';
import { AppError } from '../utils/errors';
import { Organization, OrganizationStatus } from '../types/admin';
import logger from '../utils/logger';

export class OrganizationService {
  constructor(private database: Database = db) {}

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  private map(row: any): Organization {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
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

    const result = await this.database.query(
      `INSERT INTO organizations (name, slug, timezone, contact_email, contact_phone, notes)
       VALUES ($1, $2, COALESCE($3, 'Asia/Kolkata'), $4, $5, $6)
       RETURNING *`,
      [
        params.name,
        slug,
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
    params: { status?: OrganizationStatus; search?: string } = {}
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

    const result = await this.database.query(
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

  async getById(id: string): Promise<Organization> {
    const result = await this.database.query(
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
    assign('timezone', params.timezone);
    assign('contact_email', params.contactEmail);
    assign('contact_phone', params.contactPhone);
    assign('notes', params.notes);

    if (sets.length === 0) {
      return this.getById(id);
    }

    sets.push('updated_at = NOW()');

    const result = await this.database.query(
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
    const result = await this.database.query(
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
    const kiosks = await this.database.query(
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
    const result = await this.database.query(
      `SELECT k.id, k.kiosk_id, k.name, k.location, k.status, k.organization_id,
              o.name AS organization_name,
              (SELECT COUNT(*) FROM printers p
                WHERE p.kiosk_id = k.id AND p.status = 'online') AS printers_online,
              (SELECT COUNT(*) FROM printers p WHERE p.kiosk_id = k.id) AS printers_total
         FROM kiosks k
         LEFT JOIN organizations o ON o.id = k.organization_id
        ${scoped ? 'WHERE k.organization_id = $1' : ''}
        ORDER BY k.kiosk_id`,
      scoped ? [organizationId] : []
    );

    return result.rows.map((r: any) => ({
      id: r.id,
      kioskId: r.kiosk_id,
      name: r.name,
      location: r.location,
      status: r.status,
      organizationId: r.organization_id,
      organizationName: r.organization_name,
      printersOnline: parseInt(r.printers_online) || 0,
      printersTotal: parseInt(r.printers_total) || 0,
    }));
  }
}

export const organizationService = new OrganizationService();
