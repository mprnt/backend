import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { Database, db } from '../config/database';
import env from '../config/environment';
import { AppError } from '../utils/errors';
import {
  AdminRole,
  AdminUser,
  ASSIGNABLE_ROLES,
  Permission,
  PERMISSIONS,
  resolvePermissions,
} from '../types/admin';
import { adminAuthService } from './adminAuthService';
import logger from '../utils/logger';

export interface CreatedAdmin {
  user: AdminUser;
  /** Shown once at creation. Never stored in plaintext, never recoverable. */
  temporaryPassword: string;
}

export class AdminUserService {
  constructor(private database: Database = db) {}

  private map(row: any): AdminUser {
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      organizationId: row.organization_id,
      organizationName: row.organization_name ?? null,
      isActive: row.is_active,
      mustChangePassword: row.must_change_password,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    };
  }

  /**
   * Generate a readable but high-entropy temporary password.
   *
   * Avoids characters that are easily confused when read aloud or off a screen,
   * because these get handed over verbally more often than anyone admits.
   */
  private generatePassword(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(16);
    let out = '';
    for (const b of bytes) out += alphabet[b % alphabet.length];
    return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
  }

  /**
   * Create a shop admin. Only a super admin reaches this, and only the three
   * shop roles can be assigned — super admins are created by CLI, never by HTTP.
   */
  async create(params: {
    email: string;
    fullName?: string;
    role: AdminRole;
    organizationId: string;
    createdBy: string;
  }): Promise<CreatedAdmin> {
    if (!ASSIGNABLE_ROLES.includes(params.role)) {
      throw new AppError(
        `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}. Super admins are created via CLI.`,
        400
      );
    }

    const org = await this.database.query(
      `SELECT id FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
      [params.organizationId]
    );
    if (org.rows.length === 0) {
      throw new AppError('Organization not found', 404);
    }

    const existing = await this.database.query(
      `SELECT 1 FROM admin_users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
      [params.email]
    );
    if (existing.rows.length > 0) {
      throw new AppError('An account with this email already exists', 409);
    }

    const temporaryPassword = this.generatePassword();
    const hash = await bcrypt.hash(temporaryPassword, env.security.bcrypt_rounds);

    const result = await this.database.query(
      `INSERT INTO admin_users (
         email, password_hash, full_name, role, organization_id,
         is_active, must_change_password, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, true, true, $6, NOW(), NOW())
       RETURNING *`,
      [
        params.email.toLowerCase(),
        hash,
        params.fullName ?? null,
        params.role,
        params.organizationId,
        params.createdBy,
      ]
    );

    logger.info('Admin user created', {
      id: result.rows[0].id,
      role: params.role,
      org: params.organizationId,
    });

    return { user: this.map(result.rows[0]), temporaryPassword };
  }

  /**
   * @param organizationId null lists across every organization (super admin only;
   *                       the caller is responsible for having checked that).
   */
  async list(params: {
    organizationId: string | null;
    includeDeleted?: boolean;
  }): Promise<AdminUser[]> {
    const conditions: string[] = [];
    const args: unknown[] = [];

    if (!params.includeDeleted) conditions.push('au.deleted_at IS NULL');

    if (params.organizationId !== null) {
      args.push(params.organizationId);
      conditions.push(`au.organization_id = $${args.length}`);
    }

    const result = await this.database.query(
      `SELECT au.*, o.name AS organization_name
         FROM admin_users au
         LEFT JOIN organizations o ON o.id = au.organization_id
        ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
        ORDER BY au.created_at DESC`,
      args
    );

    return result.rows.map((r) => this.map(r));
  }

  async getById(id: string, organizationId: string | null): Promise<AdminUser> {
    const args: unknown[] = [id];
    let scope = '';

    // A shop admin may only read staff inside their own organization.
    if (organizationId !== null) {
      args.push(organizationId);
      scope = `AND au.organization_id = $2`;
    }

    const result = await this.database.query(
      `SELECT au.*, o.name AS organization_name
         FROM admin_users au
         LEFT JOIN organizations o ON o.id = au.organization_id
        WHERE au.id = $1 AND au.deleted_at IS NULL ${scope}`,
      args
    );

    if (result.rows.length === 0) {
      throw new AppError('Admin user not found', 404);
    }

    return this.map(result.rows[0]);
  }

  async update(
    id: string,
    organizationId: string | null,
    params: { fullName?: string; role?: AdminRole; isActive?: boolean }
  ): Promise<AdminUser> {
    const target = await this.getById(id, organizationId);

    if (target.role === 'super_admin') {
      throw new AppError('Super admin accounts cannot be modified here', 403);
    }

    if (params.role && !ASSIGNABLE_ROLES.includes(params.role)) {
      throw new AppError(`Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`, 400);
    }

    const sets: string[] = [];
    const args: unknown[] = [id];

    const assign = (column: string, value: unknown) => {
      if (value !== undefined) {
        args.push(value);
        sets.push(`${column} = $${args.length}`);
      }
    };

    assign('full_name', params.fullName);
    assign('role', params.role);
    assign('is_active', params.isActive);

    if (sets.length === 0) return target;

    sets.push('updated_at = NOW()');

    const result = await this.database.query(
      `UPDATE admin_users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      args
    );

    // A role change alters the permissions baked into live access tokens, and
    // deactivation must take effect now rather than at token expiry.
    if (params.role !== undefined || params.isActive === false) {
      await adminAuthService.revokeAllForUser(id);
    }

    return this.map(result.rows[0]);
  }

  /**
   * Soft delete. The row stays so audit_logs.admin_user_id keeps resolving, and
   * the partial unique index frees the email address for reuse.
   */
  async softDelete(id: string, organizationId: string | null, actorId: string): Promise<void> {
    if (id === actorId) {
      throw new AppError('You cannot delete your own account', 400);
    }

    const target = await this.getById(id, organizationId);

    if (target.role === 'super_admin') {
      throw new AppError('Super admin accounts cannot be deleted here', 403);
    }

    await this.database.query(
      `UPDATE admin_users
          SET deleted_at = NOW(), is_active = false, updated_at = NOW()
        WHERE id = $1`,
      [id]
    );

    await adminAuthService.revokeAllForUser(id);

    logger.warn('Admin user soft-deleted', { id, by: actorId });
  }

  /**
   * Issue a new temporary password. Returned once; all sessions are cut.
   */
  async resetPassword(id: string, organizationId: string | null): Promise<string> {
    const target = await this.getById(id, organizationId);

    if (target.role === 'super_admin') {
      throw new AppError('Super admin passwords cannot be reset here', 403);
    }

    const temporaryPassword = this.generatePassword();
    const hash = await bcrypt.hash(temporaryPassword, env.security.bcrypt_rounds);

    await this.database.query(
      `UPDATE admin_users
          SET password_hash = $2, must_change_password = true,
              failed_login_attempts = 0, locked_until = NULL,
              password_changed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [id, hash]
    );

    await adminAuthService.revokeAllForUser(id);

    logger.warn('Admin password reset', { id });
    return temporaryPassword;
  }

  /** Unlock an account locked by repeated failed sign-ins. */
  async unlock(id: string, organizationId: string | null): Promise<void> {
    await this.getById(id, organizationId);
    await this.database.query(
      `UPDATE admin_users
          SET failed_login_attempts = 0, locked_until = NULL, updated_at = NOW()
        WHERE id = $1`,
      [id]
    );
  }

  async getPermissions(
    id: string,
    organizationId: string | null
  ): Promise<{ role: AdminRole; effective: Permission[]; overrides: unknown[] }> {
    const user = await this.getById(id, organizationId);

    const overrides = await this.database.query(
      `SELECT permission, effect, created_at FROM admin_permission_overrides
        WHERE admin_user_id = $1 ORDER BY permission`,
      [id]
    );

    return {
      role: user.role,
      effective: resolvePermissions(user.role, overrides.rows as any),
      overrides: overrides.rows,
    };
  }

  /**
   * Grant or deny one permission for one admin.
   *
   * Platform-scope permissions are refused for shop staff outright — granting
   * `orgs:write` to a shop viewer would escalate them past their own tenant.
   */
  async setPermissionOverride(params: {
    adminUserId: string;
    organizationId: string | null;
    permission: string;
    effect: 'grant' | 'deny' | 'inherit';
    grantedBy: string;
  }): Promise<void> {
    const target = await this.getById(params.adminUserId, params.organizationId);

    if (target.role === 'super_admin') {
      throw new AppError('Super admin permissions cannot be overridden', 403);
    }

    const known = Object.values(PERMISSIONS) as string[];
    if (!known.includes(params.permission)) {
      throw new AppError(`Unknown permission: ${params.permission}`, 400);
    }

    const platformOnly: string[] = [
      PERMISSIONS.ORGS_READ,
      PERMISSIONS.ORGS_WRITE,
      PERMISSIONS.PRICING_WRITE,
      PERMISSIONS.PLATFORM_REPORTS,
      PERMISSIONS.AUDIT_READ_ALL,
    ];

    if (params.effect === 'grant' && platformOnly.includes(params.permission)) {
      throw new AppError(
        `${params.permission} is a platform permission and cannot be granted to shop staff`,
        400
      );
    }

    if (params.effect === 'inherit') {
      await this.database.query(
        `DELETE FROM admin_permission_overrides WHERE admin_user_id = $1 AND permission = $2`,
        [params.adminUserId, params.permission]
      );
    } else {
      await this.database.query(
        `INSERT INTO admin_permission_overrides (admin_user_id, permission, effect, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (admin_user_id, permission)
         DO UPDATE SET effect = EXCLUDED.effect, granted_by = EXCLUDED.granted_by,
                       created_at = NOW()`,
        [params.adminUserId, params.permission, params.effect, params.grantedBy]
      );
    }

    // Live tokens carry the old permission set.
    await adminAuthService.revokeAllForUser(params.adminUserId);

    logger.info('Permission override set', {
      adminUserId: params.adminUserId,
      permission: params.permission,
      effect: params.effect,
    });
  }
}

export const adminUserService = new AdminUserService();
