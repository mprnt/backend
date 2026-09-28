import { Request, Response } from 'express';
import { adminAuthService } from '../services/adminAuthService';
import { adminUserService } from '../services/adminUserService';
import { organizationService } from '../services/organizationService';
import { dashboardService } from '../services/dashboardService';
import { auditService } from '../services/auditService';
import { pricingService } from '../services/pricingService';
import { db } from '../config/database';
import { AppError } from '../utils/errors';
import { ReportPeriod, ROLE_PERMISSIONS, PERMISSIONS } from '../types/admin';
import logger from '../utils/logger';

/** Shared parsing of the report filters, after Joi has validated them. */
function reportFilters(req: Request) {
  const q = req.query as Record<string, string | undefined>;
  return {
    organizationId: req.tenantId ?? null,
    kioskId: q.kioskId,
    period: (q.period as ReportPeriod) || 'month',
    from: q.from,
    to: q.to,
  };
}

class AdminController {
  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  async login(req: Request, res: Response): Promise<void> {
    const { email, password } = req.body;

    const { tokens, principal, mustChangePassword } = await adminAuthService.login({
      email,
      password,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    await auditService.record({
      actorId: principal.id,
      organizationId: principal.organizationId,
      action: 'admin.login',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      status: 'success',
      data: {
        ...tokens,
        mustChangePassword,
        user: {
          id: principal.id,
          email: principal.email,
          role: principal.role,
          organizationId: principal.organizationId,
          permissions: principal.permissions,
        },
      },
    });
  }

  async refresh(req: Request, res: Response): Promise<void> {
    const tokens = await adminAuthService.refresh(
      req.body.refreshToken,
      req.ip,
      req.headers['user-agent']
    );

    res.json({ status: 'success', data: tokens });
  }

  async logout(req: Request, res: Response): Promise<void> {
    await adminAuthService.logout(req.body.refreshToken);
    await auditService.fromRequest(req, 'admin.logout');
    res.json({ status: 'success', message: 'Signed out' });
  }

  /** The signed-in admin's own profile, used to bootstrap the dashboard UI. */
  async me(req: Request, res: Response): Promise<void> {
    const admin = req.admin!;

    let organization = null;
    if (admin.organizationId) {
      const org = await organizationService.getById(admin.organizationId);
      organization = { id: org.id, name: org.name, timezone: org.timezone, status: org.status };
    }

    res.json({
      status: 'success',
      data: {
        id: admin.id,
        email: admin.email,
        role: admin.role,
        isSuperAdmin: admin.isSuperAdmin,
        permissions: admin.permissions,
        organization,
      },
    });
  }

  async changePassword(req: Request, res: Response): Promise<void> {
    const { currentPassword, newPassword } = req.body;

    await adminAuthService.changePassword(req.admin!.id, currentPassword, newPassword);
    await auditService.fromRequest(req, 'admin.password_changed');

    res.json({
      status: 'success',
      message: 'Password changed. Please sign in again.',
    });
  }

  // -------------------------------------------------------------------------
  // Organizations (super admin)
  // -------------------------------------------------------------------------

  async createOrganization(req: Request, res: Response): Promise<void> {
    const org = await organizationService.create(req.body);

    await auditService.fromRequest(req, 'organization.created', {
      resourceType: 'organization',
      resourceId: org.id,
      organizationId: org.id,
      details: { name: org.name },
    });

    res.status(201).json({ status: 'success', data: org });
  }

  async listOrganizations(req: Request, res: Response): Promise<void> {
    const orgs = await organizationService.list({
      status: req.query.status as 'active' | 'suspended' | undefined,
      search: req.query.search as string | undefined,
    });

    res.json({ status: 'success', data: { count: orgs.length, organizations: orgs } });
  }

  async getOrganization(req: Request, res: Response): Promise<void> {
    const org = await organizationService.getById(req.params.id);
    res.json({ status: 'success', data: org });
  }

  async updateOrganization(req: Request, res: Response): Promise<void> {
    const org = await organizationService.update(req.params.id, req.body);

    await auditService.fromRequest(req, 'organization.updated', {
      resourceType: 'organization',
      resourceId: org.id,
      organizationId: org.id,
      details: req.body,
    });

    res.json({ status: 'success', data: org });
  }

  async setOrganizationStatus(req: Request, res: Response): Promise<void> {
    const org = await organizationService.setStatus(req.params.id, req.body.status);

    await auditService.fromRequest(req, `organization.${req.body.status}`, {
      resourceType: 'organization',
      resourceId: org.id,
      organizationId: org.id,
    });

    res.json({ status: 'success', data: org });
  }

  async deleteOrganization(req: Request, res: Response): Promise<void> {
    await organizationService.softDelete(req.params.id);

    await auditService.fromRequest(req, 'organization.deleted', {
      resourceType: 'organization',
      resourceId: req.params.id,
      organizationId: req.params.id,
    });

    res.json({ status: 'success', message: 'Organization deleted' });
  }

  async assignKiosk(req: Request, res: Response): Promise<void> {
    await organizationService.assignKiosk(req.body.kioskId, req.params.id);

    await auditService.fromRequest(req, 'kiosk.assigned', {
      resourceType: 'kiosk',
      resourceId: req.body.kioskId,
      organizationId: req.params.id,
    });

    res.json({ status: 'success', message: 'Kiosk assigned' });
  }

  async listKiosks(req: Request, res: Response): Promise<void> {
    const kiosks = await organizationService.listKiosks(req.tenantId ?? null);
    res.json({ status: 'success', data: { count: kiosks.length, kiosks } });
  }

  // -------------------------------------------------------------------------
  // Admin users
  // -------------------------------------------------------------------------

  async createAdmin(req: Request, res: Response): Promise<void> {
    const { user, temporaryPassword } = await adminUserService.create({
      ...req.body,
      createdBy: req.admin!.id,
    });

    await auditService.fromRequest(req, 'admin_user.created', {
      resourceType: 'admin_user',
      resourceId: user.id,
      organizationId: user.organizationId,
      // The password itself is never logged.
      details: { email: user.email, role: user.role },
    });

    res.status(201).json({
      status: 'success',
      message: 'Admin created. Share this password securely — it will not be shown again.',
      data: { user, temporaryPassword },
    });
  }

  async listAdmins(req: Request, res: Response): Promise<void> {
    const users = await adminUserService.list({
      organizationId: req.tenantId ?? null,
      includeDeleted: req.query.includeDeleted === 'true',
    });

    res.json({ status: 'success', data: { count: users.length, users } });
  }

  async getAdmin(req: Request, res: Response): Promise<void> {
    const user = await adminUserService.getById(req.params.id, req.tenantId ?? null);
    res.json({ status: 'success', data: user });
  }

  async updateAdmin(req: Request, res: Response): Promise<void> {
    const user = await adminUserService.update(req.params.id, req.tenantId ?? null, req.body);

    await auditService.fromRequest(req, 'admin_user.updated', {
      resourceType: 'admin_user',
      resourceId: user.id,
      organizationId: user.organizationId,
      details: req.body,
    });

    res.json({ status: 'success', data: user });
  }

  async deleteAdmin(req: Request, res: Response): Promise<void> {
    await adminUserService.softDelete(req.params.id, req.tenantId ?? null, req.admin!.id);

    await auditService.fromRequest(req, 'admin_user.deleted', {
      resourceType: 'admin_user',
      resourceId: req.params.id,
    });

    res.json({ status: 'success', message: 'Admin removed' });
  }

  async resetAdminPassword(req: Request, res: Response): Promise<void> {
    const temporaryPassword = await adminUserService.resetPassword(
      req.params.id,
      req.tenantId ?? null
    );

    await auditService.fromRequest(req, 'admin_user.password_reset', {
      resourceType: 'admin_user',
      resourceId: req.params.id,
    });

    res.json({
      status: 'success',
      message: 'Password reset. Share it securely — it will not be shown again.',
      data: { temporaryPassword },
    });
  }

  async unlockAdmin(req: Request, res: Response): Promise<void> {
    await adminUserService.unlock(req.params.id, req.tenantId ?? null);
    await auditService.fromRequest(req, 'admin_user.unlocked', {
      resourceType: 'admin_user',
      resourceId: req.params.id,
    });
    res.json({ status: 'success', message: 'Account unlocked' });
  }

  async getAdminPermissions(req: Request, res: Response): Promise<void> {
    const data = await adminUserService.getPermissions(req.params.id, req.tenantId ?? null);
    res.json({ status: 'success', data });
  }

  async setAdminPermission(req: Request, res: Response): Promise<void> {
    await adminUserService.setPermissionOverride({
      adminUserId: req.params.id,
      organizationId: req.tenantId ?? null,
      permission: req.body.permission,
      effect: req.body.effect,
      grantedBy: req.admin!.id,
    });

    await auditService.fromRequest(req, 'admin_user.permission_changed', {
      resourceType: 'admin_user',
      resourceId: req.params.id,
      details: { permission: req.body.permission, effect: req.body.effect },
    });

    const data = await adminUserService.getPermissions(req.params.id, req.tenantId ?? null);
    res.json({ status: 'success', data });
  }

  /** The permission catalogue, so the UI can render a grid without hardcoding. */
  async listPermissionCatalogue(_req: Request, res: Response): Promise<void> {
    res.json({
      status: 'success',
      data: {
        permissions: Object.values(PERMISSIONS),
        roles: Object.entries(ROLE_PERMISSIONS).map(([role, perms]) => ({
          role,
          permissions: perms,
        })),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  async getSummary(req: Request, res: Response): Promise<void> {
    const f = reportFilters(req);
    const range = await dashboardService.resolveRange(f.organizationId, f.period, f.from, f.to);

    const summary = await dashboardService.getSummary({ ...f, ...range });

    res.json({ status: 'success', data: { range, summary } });
  }

  async getTimeSeries(req: Request, res: Response): Promise<void> {
    const f = reportFilters(req);
    const range = await dashboardService.resolveRange(f.organizationId, f.period, f.from, f.to);

    const bucket =
      (req.query.bucket as ReportPeriod) ||
      // A sensible default bucket for the chosen window.
      ({ day: 'day', week: 'day', month: 'day', year: 'month' }[f.period] as ReportPeriod);

    const series = await dashboardService.getTimeSeries({ ...f, ...range }, bucket);

    res.json({ status: 'success', data: { range, bucket, series } });
  }

  async getKioskBreakdown(req: Request, res: Response): Promise<void> {
    const f = reportFilters(req);
    const range = await dashboardService.resolveRange(f.organizationId, f.period, f.from, f.to);

    const kiosks = await dashboardService.getKioskBreakdown({ ...f, ...range });

    res.json({ status: 'success', data: { range, kiosks } });
  }

  async listSessions(req: Request, res: Response): Promise<void> {
    const f = reportFilters(req);
    const range = await dashboardService.resolveRange(f.organizationId, f.period, f.from, f.to);

    const { rows, total } = await dashboardService.listSessions({
      ...f,
      ...range,
      status: req.query.status as string | undefined,
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    });

    res.json({
      status: 'success',
      data: {
        range,
        total,
        limit: Number(req.query.limit) || 50,
        offset: Number(req.query.offset) || 0,
        sessions: rows,
      },
    });
  }

  async exportSessions(req: Request, res: Response): Promise<void> {
    const f = reportFilters(req);
    const range = await dashboardService.resolveRange(f.organizationId, f.period, f.from, f.to);

    const csv = await dashboardService.exportSessionsCsv({ ...f, ...range });

    await auditService.fromRequest(req, 'report.exported', {
      details: { from: range.from, to: range.to },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="mprnt-sessions-${range.from}-to-${range.to}.csv"`
    );
    res.send(csv);
  }

  async getPrinterHealth(req: Request, res: Response): Promise<void> {
    const printers = await dashboardService.getPrinterHealth(req.tenantId ?? null);
    res.json({ status: 'success', data: { count: printers.length, printers } });
  }

  async getAttentionQueue(req: Request, res: Response): Promise<void> {
    const jobs = await dashboardService.getAttentionQueue(req.tenantId ?? null);
    res.json({ status: 'success', data: { count: jobs.length, jobs } });
  }

  async listAudit(req: Request, res: Response): Promise<void> {
    const admin = req.admin!;

    // Only a holder of audit:read_all may read across organizations.
    const scope = admin.permissions.includes(PERMISSIONS.AUDIT_READ_ALL)
      ? (req.tenantId ?? null)
      : admin.organizationId;

    const { rows, total } = await auditService.list({
      organizationId: scope,
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    });

    res.json({ status: 'success', data: { total, entries: rows } });
  }

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  /** Rates in force. A shop sees what applies to it; the platform sees any scope. */
  async getPricing(req: Request, res: Response): Promise<void> {
    const kioskId = req.query.kioskId as string | undefined;
    const info = await pricingService.getPricingInfo(kioskId);

    res.json({ status: 'success', data: info });
  }

  async listPriceLists(req: Request, res: Response): Promise<void> {
    const scoped = req.tenantId !== null && req.tenantId !== undefined;

    const result = await db.query(
      `SELECT pl.*, o.name AS organization_name, k.kiosk_id AS kiosk_code
         FROM price_lists pl
         LEFT JOIN organizations o ON o.id = pl.organization_id
         LEFT JOIN kiosks k        ON k.id = pl.kiosk_id
        ${scoped ? 'WHERE pl.organization_id = $1 OR pl.organization_id IS NULL' : ''}
        ORDER BY pl.effective_from DESC
        LIMIT 200`,
      scoped ? [req.tenantId] : []
    );

    res.json({
      status: 'success',
      data: {
        priceLists: result.rows.map((r: any) => ({
          id: r.id,
          scope: r.kiosk_id ? 'kiosk' : r.organization_id ? 'organization' : 'platform',
          organizationId: r.organization_id,
          organizationName: r.organization_name,
          kioskId: r.kiosk_id,
          kioskCode: r.kiosk_code,
          bwPerPage: Number(r.bw_per_page),
          colorPerPage: Number(r.color_per_page),
          minCharge: Number(r.min_charge),
          effectiveFrom: r.effective_from,
          createdAt: r.created_at,
        })),
      },
    });
  }

  /**
   * Publish new rates. Prices are never edited in place — a new row supersedes
   * the old one from `effectiveFrom`, so quotes already given stay valid and
   * historical reporting keeps matching what customers actually paid.
   */
  async createPriceList(req: Request, res: Response): Promise<void> {
    const { organizationId, kioskId, bwPerPage, colorPerPage, minCharge, effectiveFrom } = req.body;

    if (kioskId) {
      const kiosk = await db.query(`SELECT organization_id FROM kiosks WHERE id = $1`, [kioskId]);
      if (kiosk.rows.length === 0) {
        throw new AppError('Kiosk not found', 404);
      }
      if (kiosk.rows[0].organization_id !== organizationId) {
        throw new AppError('That kiosk does not belong to the given organization', 400);
      }
    }

    const result = await db.query(
      `INSERT INTO price_lists (
         organization_id, kiosk_id, bw_per_page, color_per_page, min_charge,
         effective_from, created_by
       ) VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamp, NOW()), $7)
       RETURNING *`,
      [
        organizationId ?? null,
        kioskId ?? null,
        bwPerPage,
        colorPerPage,
        minCharge ?? 0,
        effectiveFrom ?? null,
        req.admin!.id,
      ]
    );

    await auditService.fromRequest(req, 'pricing.published', {
      resourceType: 'price_list',
      resourceId: result.rows[0].id,
      organizationId: organizationId ?? null,
      details: { bwPerPage, colorPerPage, minCharge, kioskId },
    });

    logger.info('Price list published', {
      id: result.rows[0].id,
      by: req.admin!.id,
      bwPerPage,
      colorPerPage,
    });

    res.status(201).json({ status: 'success', data: result.rows[0] });
  }
}

export const adminController = new AdminController();
