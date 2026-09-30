import { Request } from 'express';
import { Database, db } from '../config/database';
import { AdminPrincipal, PERMISSIONS } from '../types/admin';
import logger from '../utils/logger';

export type ActorScope = 'platform' | 'shop';

export interface AuditEntry {
  actorId: string | null;
  /** Who acted. Fixed at write time; see migration 014. */
  actorScope: ActorScope;
  organizationId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Sign-in and credential events. Shown as their own "Security" view, because
 * they answer a different question ("is someone trying to get in?") from the
 * rest of the log ("who changed what?").
 */
export const SECURITY_ACTIONS = [
  'admin.login',
  'admin.login_failed',
  'admin.account_locked',
  'admin.logout',
  'admin.password_changed',
  'admin_user.password_reset',
  'admin_user.unlocked',
  'printer.enrolled',
  'printer.key_rotated',
  'printer.key_revoked',
] as const;

export interface AuditListParams {
  viewer: AdminPrincipal;
  /** Super admin only: narrow to one organization. Ignored for shop staff. */
  organizationId?: string | null;
  /** Super admin only. */
  actorScope?: ActorScope;
  category?: 'all' | 'security';
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/**
 * Append-only record of every administrative action.
 *
 * Two audiences read it, and they must see different things:
 *
 *  - A shop sees what its own staff did. Nothing a platform operator did is
 *    visible to them — not the action, not the actor, not the IP address.
 *  - The platform sees everything, with filters to find it.
 *
 * That boundary is enforced in `list`, from the viewer's principal, so no
 * caller can widen a shop's view by passing a parameter.
 *
 * Writes never break the operation being audited: a failed insert is logged
 * loudly and swallowed. Refusing a legitimate action because its audit row
 * could not be written is the worse outcome.
 */
export class AuditService {
  constructor(private database: Database = db) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.database.query(
        `INSERT INTO audit_logs (
           admin_user_id, actor_scope, organization_id, action, resource_type, resource_id,
           ip_address, user_agent, details, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8, $9, NOW())`,
        [
          entry.actorId,
          entry.actorScope,
          entry.organizationId ?? null,
          entry.action,
          entry.resourceType ?? null,
          entry.resourceId ?? null,
          entry.ipAddress ?? null,
          entry.userAgent ?? null,
          entry.details ? JSON.stringify(entry.details) : null,
        ]
      );
    } catch (error) {
      logger.error('Failed to write audit log', { error, action: entry.action });
    }
  }

  /** Lift the actor, their scope and request metadata off an authenticated request. */
  async fromRequest(
    req: Request,
    action: string,
    opts: {
      resourceType?: string;
      resourceId?: string | null;
      organizationId?: string | null;
      details?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    await this.record({
      actorId: req.admin?.id ?? null,
      actorScope: req.admin && !req.admin.isSuperAdmin ? 'shop' : 'platform',
      organizationId: opts.organizationId ?? req.admin?.organizationId ?? null,
      action,
      resourceType: opts.resourceType,
      resourceId: opts.resourceId,
      details: opts.details,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  async list(params: AuditListParams): Promise<{ rows: unknown[]; total: number }> {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    const seesPlatform = params.viewer.permissions.includes(PERMISSIONS.AUDIT_READ_ALL);

    const conditions: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      args.push(value);
      conditions.push(sql.replace('?', `$${args.length}`));
    };

    if (seesPlatform) {
      if (params.organizationId) add('al.organization_id = ?', params.organizationId);
      if (params.actorScope) add('al.actor_scope = ?', params.actorScope);
    } else {
      // A shop sees its own staff's actions and nothing else. Both conditions
      // come from the principal, never from the request.
      add('al.organization_id = ?', params.viewer.organizationId);
      conditions.push(`al.actor_scope = 'shop'`);
    }

    if (params.category === 'security') {
      add('al.action = ANY(?::text[])', [...SECURITY_ACTIONS]);
    }
    if (params.action) add('al.action = ?', params.action);
    if (params.from) add('al.created_at >= ?::timestamp', params.from);
    if (params.to) add('al.created_at < ?::timestamp', params.to);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await this.database.query(
      `SELECT al.id, al.action, al.actor_scope, al.resource_type, al.resource_id,
              al.details, al.ip_address, al.created_at, al.organization_id,
              au.email AS actor_email, au.full_name AS actor_name, au.role AS actor_role,
              o.name AS organization_name
         FROM audit_logs al
         LEFT JOIN admin_users au ON au.id = al.admin_user_id
         LEFT JOIN organizations o ON o.id = al.organization_id
         ${where}
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      args
    );

    const count = await this.database.query(
      `SELECT COUNT(*) AS total FROM audit_logs al ${where}`,
      args
    );

    return {
      rows: rows.rows.map((r: any) => ({
        id: String(r.id),
        action: r.action,
        actorScope: r.actor_scope,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        details: r.details,
        // Safe to return to a shop: their view only ever contains their own
        // staff's rows, and seeing the IP behind a failed sign-in on one of
        // their accounts is exactly how they would notice an intruder.
        ipAddress: r.ip_address,
        createdAt: r.created_at,
        organization: r.organization_id
          ? { id: r.organization_id, name: r.organization_name }
          : null,
        actor: r.actor_email
          ? { email: r.actor_email, name: r.actor_name, role: r.actor_role }
          : null,
      })),
      total: parseInt(count.rows[0].total) || 0,
    };
  }

  /** Distinct actions the viewer can see, for the filter dropdown. */
  async listActions(viewer: AdminPrincipal): Promise<string[]> {
    const seesPlatform = viewer.permissions.includes(PERMISSIONS.AUDIT_READ_ALL);

    const result = seesPlatform
      ? await this.database.query(`SELECT DISTINCT action FROM audit_logs ORDER BY action`)
      : await this.database.query(
          `SELECT DISTINCT action FROM audit_logs
            WHERE organization_id = $1 AND actor_scope = 'shop'
            ORDER BY action`,
          [viewer.organizationId]
        );

    return result.rows.map((r: { action: string }) => r.action);
  }
}

export const auditService = new AuditService();
