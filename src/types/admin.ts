/**
 * Admin dashboard domain types and the permission model.
 */

export type AdminRole = 'super_admin' | 'owner' | 'manager' | 'viewer';

export type OrganizationStatus = 'active' | 'suspended';

/**
 * Permissions are `resource:action` strings. Roles expand to a default set;
 * `admin_permission_overrides` can grant or deny an individual one on top.
 */
export const PERMISSIONS = {
  // Platform scope — super admin only
  ORGS_READ: 'orgs:read',
  ORGS_WRITE: 'orgs:write',
  PRICING_WRITE: 'pricing:write',
  PLATFORM_REPORTS: 'platform:reports',
  AUDIT_READ_ALL: 'audit:read_all',

  // Shop scope
  REPORTS_READ: 'reports:read',
  SESSIONS_READ: 'sessions:read',
  PRICING_READ: 'pricing:read',
  PRINTERS_READ: 'printers:read',
  PRINTERS_MANAGE: 'printers:manage',
  JOBS_CANCEL: 'jobs:cancel',
  REFUNDS_ISSUE: 'refunds:issue',
  STAFF_READ: 'staff:read',
  STAFF_WRITE: 'staff:write',
  AUDIT_READ: 'audit:read',
  EXPORT_DATA: 'export:data',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const SHOP_VIEWER: Permission[] = [
  PERMISSIONS.REPORTS_READ,
  PERMISSIONS.SESSIONS_READ,
  PERMISSIONS.PRICING_READ,
  PERMISSIONS.PRINTERS_READ,
];

const SHOP_MANAGER: Permission[] = [
  ...SHOP_VIEWER,
  PERMISSIONS.PRINTERS_MANAGE,
  PERMISSIONS.JOBS_CANCEL,
  PERMISSIONS.STAFF_READ,
  PERMISSIONS.EXPORT_DATA,
];

const SHOP_OWNER: Permission[] = [
  ...SHOP_MANAGER,
  PERMISSIONS.STAFF_WRITE,
  PERMISSIONS.REFUNDS_ISSUE,
  PERMISSIONS.AUDIT_READ,
];

/**
 * Pricing is set by the platform, so no shop role carries `pricing:write` —
 * shops can read the rates that apply to them and nothing more.
 */
export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  viewer: SHOP_VIEWER,
  manager: SHOP_MANAGER,
  owner: SHOP_OWNER,
  super_admin: [
    ...SHOP_OWNER,
    PERMISSIONS.ORGS_READ,
    PERMISSIONS.ORGS_WRITE,
    PERMISSIONS.PRICING_WRITE,
    PERMISSIONS.PLATFORM_REPORTS,
    PERMISSIONS.AUDIT_READ_ALL,
  ],
};

/** Roles a super admin may assign. Super admins are created by CLI, never over HTTP. */
export const ASSIGNABLE_ROLES: AdminRole[] = ['owner', 'manager', 'viewer'];

/**
 * Resolve a role's defaults against per-user overrides.
 * A `deny` override always beats a role default or a `grant`.
 */
export function resolvePermissions(
  role: AdminRole,
  overrides: { permission: string; effect: 'grant' | 'deny' }[] = []
): Permission[] {
  const granted = new Set<string>(ROLE_PERMISSIONS[role]);

  for (const o of overrides) {
    if (o.effect === 'grant') granted.add(o.permission);
  }
  for (const o of overrides) {
    if (o.effect === 'deny') granted.delete(o.permission);
  }

  return [...granted] as Permission[];
}

export interface AdminUser {
  id: string;
  email: string;
  fullName: string | null;
  role: AdminRole;
  /** null for a platform super admin. */
  organizationId: string | null;
  organizationName?: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
}

/** The authenticated caller, attached to the request by the admin auth middleware. */
export interface AdminPrincipal {
  id: string;
  email: string;
  role: AdminRole;
  organizationId: string | null;
  permissions: Permission[];
  isSuperAdmin: boolean;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  timezone: string;
  contactEmail: string | null;
  contactPhone: string | null;
  kioskCount?: number;
  adminCount?: number;
  createdAt: Date;
}

export interface AdminTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type ReportPeriod = 'day' | 'week' | 'month' | 'year';

export interface ReportRange {
  from: string;
  to: string;
  period: ReportPeriod;
}
