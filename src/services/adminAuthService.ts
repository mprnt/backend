import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Database, db } from '../config/database';
import env from '../config/environment';
import { AppError } from '../utils/errors';
import {
  AdminPrincipal,
  AdminRole,
  AdminTokenPair,
  Permission,
  resolvePermissions,
} from '../types/admin';
import logger from '../utils/logger';

interface AdminRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  role: AdminRole;
  organization_id: string | null;
  is_active: boolean;
  must_change_password: boolean;
  failed_login_attempts: number;
  locked_until: Date | null;
  deleted_at: Date | null;
  org_status: OrganizationStatus | null;
}

type OrganizationStatus = 'active' | 'suspended';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: AdminRole;
  org: string | null;
  perms: Permission[];
  typ: 'admin_access';
}

export class AdminAuthService {
  constructor(private database: Database = db) {}

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * Authenticate an admin by email and password.
   *
   * Timing and messaging are deliberately uniform: an unknown email, a wrong
   * password and a soft-deleted account all produce the same error, so the
   * endpoint cannot be used to discover which addresses have accounts.
   */
  async login(params: {
    email: string;
    password: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ tokens: AdminTokenPair; principal: AdminPrincipal; mustChangePassword: boolean }> {
    const result = await this.database.query<AdminRow>(
      // The lock check is evaluated by Postgres. These columns are
      // `timestamp without time zone`, so reading one into JS interprets it in
      // the process's local zone — on a non-UTC host a future lock reads as
      // past and the lockout silently stops working.
      `SELECT au.id, au.email, au.password_hash, au.full_name, au.role, au.organization_id,
              au.is_active, au.must_change_password, au.failed_login_attempts,
              au.locked_until, au.deleted_at, o.status AS org_status,
              (au.locked_until IS NOT NULL AND au.locked_until > NOW()) AS is_locked
         FROM admin_users au
         LEFT JOIN organizations o ON o.id = au.organization_id
        WHERE lower(au.email) = lower($1) AND au.deleted_at IS NULL`,
      [params.email]
    );

    const invalid = new AppError('Invalid email or password', 401);

    if (result.rows.length === 0) {
      // Spend comparable time to a real verification so absence is not detectable
      // from response latency alone.
      await bcrypt.compare(params.password, '$2b$12$' + 'x'.repeat(53));
      throw invalid;
    }

    const row = result.rows[0];

    if ((row as AdminRow & { is_locked: boolean }).is_locked) {
      throw new AppError(
        'Account temporarily locked after repeated failed sign-ins. Try again later.',
        423
      );
    }

    const passwordOk = await bcrypt.compare(params.password, row.password_hash);

    if (!passwordOk) {
      await this.registerFailedAttempt(row.id, row.failed_login_attempts);
      throw invalid;
    }

    if (!row.is_active) {
      throw new AppError('This account has been deactivated', 403);
    }

    // A suspended shop cannot be signed into at all — including by its owner.
    if (row.role !== 'super_admin' && row.org_status === 'suspended') {
      throw new AppError('This organization is suspended. Contact support.', 403);
    }

    await this.database.query(
      `UPDATE admin_users
          SET failed_login_attempts = 0, locked_until = NULL,
              last_login_at = NOW(), last_login_ip = $2, updated_at = NOW()
        WHERE id = $1`,
      [row.id, params.ipAddress ?? null]
    );

    const principal = await this.toPrincipal(row);
    const tokens = await this.issueTokens(principal, params.ipAddress, params.userAgent);

    logger.info('Admin signed in', { adminId: row.id, role: row.role, org: row.organization_id });

    return { tokens, principal, mustChangePassword: row.must_change_password };
  }

  private async registerFailedAttempt(adminId: string, current: number): Promise<void> {
    const attempts = (current || 0) + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;

    await this.database.query(
      `UPDATE admin_users
          SET failed_login_attempts = $2,
              locked_until = CASE WHEN $3 THEN NOW() + ($4 || ' minutes')::interval ELSE locked_until END,
              updated_at = NOW()
        WHERE id = $1`,
      [adminId, attempts, lock, String(LOCKOUT_MINUTES)]
    );

    if (lock) {
      logger.warn('Admin account locked after repeated failures', { adminId, attempts });
    }
  }

  private async toPrincipal(row: AdminRow): Promise<AdminPrincipal> {
    const overrides = await this.database.query<{ permission: string; effect: 'grant' | 'deny' }>(
      `SELECT permission, effect FROM admin_permission_overrides WHERE admin_user_id = $1`,
      [row.id]
    );

    return {
      id: row.id,
      email: row.email,
      role: row.role,
      organizationId: row.organization_id,
      permissions: resolvePermissions(row.role, overrides.rows),
      isSuperAdmin: row.role === 'super_admin',
    };
  }

  private async issueTokens(
    principal: AdminPrincipal,
    ipAddress?: string,
    userAgent?: string
  ): Promise<AdminTokenPair> {
    const claims: AccessTokenClaims = {
      sub: principal.id,
      email: principal.email,
      role: principal.role,
      org: principal.organizationId,
      perms: principal.permissions,
      typ: 'admin_access',
    };

    const accessToken = jwt.sign(claims, env.jwt.secret, {
      expiresIn: env.admin.access_token_ttl,
    } as jwt.SignOptions);

    const refreshToken = crypto.randomBytes(48).toString('base64url');

    await this.database.query(
      `INSERT INTO admin_refresh_tokens (
         admin_user_id, token_hash, expires_at, user_agent, ip_address
       ) VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval, $4, $5)`,
      [
        principal.id,
        this.hashToken(refreshToken),
        String(env.admin.refresh_token_ttl_seconds),
        userAgent ?? null,
        ipAddress ?? null,
      ]
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: env.admin.access_token_ttl_seconds,
    };
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * The presented token is rotated: it is revoked and linked to its replacement,
   * so a token that is ever replayed after use is detectable.
   */
  async refresh(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<AdminTokenPair> {
    const hash = this.hashToken(refreshToken);

    const stored = await this.database.query(
      // au.id is aliased over rt.id deliberately: the row is fed to
      // toPrincipal(), which reads `id` and must see the admin, not the token.
      // Expiry is compared by Postgres for the same timezone reason as above.
      `SELECT rt.id AS token_id, rt.admin_user_id, rt.revoked_at,
              (rt.expires_at < NOW()) AS is_expired,
              au.id, au.email, au.password_hash, au.full_name, au.role,
              au.organization_id, au.is_active, au.must_change_password,
              au.failed_login_attempts, au.locked_until, au.deleted_at,
              o.status AS org_status
         FROM admin_refresh_tokens rt
         JOIN admin_users au ON au.id = rt.admin_user_id
         LEFT JOIN organizations o ON o.id = au.organization_id
        WHERE rt.token_hash = $1`,
      [hash]
    );

    if (stored.rows.length === 0) {
      throw new AppError('Invalid refresh token', 401);
    }

    const row = stored.rows[0];

    if (row.revoked_at) {
      // A revoked token being presented again means it leaked. Cut every session
      // for that account rather than just refusing this one request.
      logger.warn('Replayed refresh token — revoking all sessions', {
        adminId: row.admin_user_id,
      });
      await this.revokeAllForUser(row.admin_user_id);
      throw new AppError('Invalid refresh token', 401);
    }

    if (row.is_expired) {
      throw new AppError('Refresh token expired', 401);
    }

    if (row.deleted_at || !row.is_active) {
      throw new AppError('Account is no longer active', 403);
    }

    if (row.role !== 'super_admin' && row.org_status === 'suspended') {
      throw new AppError('This organization is suspended', 403);
    }

    const principal = await this.toPrincipal(row as AdminRow);
    const tokens = await this.issueTokens(principal, ipAddress, userAgent);

    await this.database.query(
      `UPDATE admin_refresh_tokens
          SET revoked_at = NOW(),
              replaced_by = (SELECT id FROM admin_refresh_tokens
                              WHERE token_hash = $2 ORDER BY created_at DESC LIMIT 1)
        WHERE id = $1`,
      [row.token_id, this.hashToken(tokens.refreshToken)]
    );

    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.database.query(
      `UPDATE admin_refresh_tokens SET revoked_at = NOW()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [this.hashToken(refreshToken)]
    );
  }

  /**
   * Revoke every live session for an admin. Called when an account is
   * deactivated, deleted, has its password changed, or replays a refresh token.
   */
  async revokeAllForUser(adminUserId: string): Promise<number> {
    const result = await this.database.query(
      `UPDATE admin_refresh_tokens SET revoked_at = NOW()
        WHERE admin_user_id = $1 AND revoked_at IS NULL`,
      [adminUserId]
    );
    return result.rowCount || 0;
  }

  /**
   * Verify an access token and rebuild the principal from its claims.
   *
   * Permissions are read from the token rather than the database so the hot path
   * stays a single signature check. The cost is that a permission change takes
   * effect on the next refresh, at most `access_token_ttl` later; revoking the
   * refresh token closes that window immediately when it matters.
   */
  verifyAccessToken(token: string): AdminPrincipal {
    let claims: AccessTokenClaims;

    try {
      claims = jwt.verify(token, env.jwt.secret) as AccessTokenClaims;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new AppError('Session expired', 401);
      }
      throw new AppError('Invalid token', 401);
    }

    if (claims.typ !== 'admin_access') {
      throw new AppError('Invalid token', 401);
    }

    return {
      id: claims.sub,
      email: claims.email,
      role: claims.role,
      organizationId: claims.org,
      permissions: claims.perms || [],
      isSuperAdmin: claims.role === 'super_admin',
    };
  }

  async changePassword(
    adminUserId: string,
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    const result = await this.database.query(
      `SELECT password_hash FROM admin_users WHERE id = $1 AND deleted_at IS NULL`,
      [adminUserId]
    );

    if (result.rows.length === 0) {
      throw new AppError('Account not found', 404);
    }

    const ok = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!ok) {
      throw new AppError('Current password is incorrect', 401);
    }

    const hash = await bcrypt.hash(newPassword, env.security.bcrypt_rounds);

    await this.database.query(
      `UPDATE admin_users
          SET password_hash = $2, must_change_password = false,
              password_changed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [adminUserId, hash]
    );

    // Every other session for this account is now stale.
    await this.revokeAllForUser(adminUserId);

    logger.info('Admin password changed', { adminId: adminUserId });
  }

  /** Housekeeping: drop refresh tokens that expired or were revoked long ago. */
  async pruneExpiredTokens(): Promise<number> {
    const result = await this.database.query(
      `DELETE FROM admin_refresh_tokens
        WHERE expires_at < NOW() - INTERVAL '30 days'
           OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '30 days')`
    );
    return result.rowCount || 0;
  }
}

export const adminAuthService = new AdminAuthService();
