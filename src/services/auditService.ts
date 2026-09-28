import { Request } from 'express';
import { Database, db } from '../config/database';
import logger from '../utils/logger';

export interface AuditEntry {
  actorId: string | null;
  organizationId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Append-only record of every administrative mutation.
 *
 * Writes here must never break the operation being audited — a failure to log is
 * reported loudly but swallowed, because refusing a legitimate action because the
 * audit insert failed is the worse outcome. The trade-off is deliberate: the log
 * is for accountability, not authorization.
 */
export class AuditService {
  constructor(private database: Database = db) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.database.query(
        `INSERT INTO audit_logs (
           admin_user_id, organization_id, action, resource_type, resource_id,
           ip_address, user_agent, details, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::inet, $7, $8, NOW())`,
        [
          entry.actorId,
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

  /**
   * Convenience wrapper that lifts actor and request metadata off the request.
   */
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
      organizationId: opts.organizationId ?? req.admin?.organizationId ?? null,
      action,
      resourceType: opts.resourceType,
      resourceId: opts.resourceId,
      details: opts.details,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  /**
   * Read the log. A shop admin only ever sees their own organization's entries;
   * the caller passes null for organizationId only when it has already checked
   * that the principal holds audit:read_all.
   */
  async list(params: {
    organizationId: string | null;
    limit?: number;
    offset?: number;
  }): Promise<{ rows: unknown[]; total: number }> {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;

    const scoped = params.organizationId !== null;
    const where = scoped ? 'WHERE al.organization_id = $1' : '';
    const args = scoped ? [params.organizationId] : [];

    const rows = await this.database.query(
      `SELECT al.id, al.action, al.resource_type, al.resource_id, al.details,
              al.ip_address, al.created_at,
              au.email AS actor_email, au.full_name AS actor_name
         FROM audit_logs al
         LEFT JOIN admin_users au ON au.id = al.admin_user_id
         ${where}
        ORDER BY al.created_at DESC
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
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        details: r.details,
        ipAddress: r.ip_address,
        createdAt: r.created_at,
        actor: r.actor_email ? { email: r.actor_email, name: r.actor_name } : null,
      })),
      total: parseInt(count.rows[0].total) || 0,
    };
  }
}

export const auditService = new AuditService();
