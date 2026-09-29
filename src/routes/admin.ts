import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { adminController as c } from '../controllers/adminController';
import { validate } from '../middleware/validate';
import {
  authenticateAdmin,
  requirePermission,
  requireSuperAdmin,
  resolveTenant,
  requireTenant,
} from '../middleware/adminAuth';
import { asyncHandler } from '../utils/asyncHandler';
import env from '../config/environment';
import { PERMISSIONS } from '../types/admin';
import {
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  createOrganizationSchema,
  updateOrganizationSchema,
  organizationStatusSchema,
  assignKioskSchema,
  createAdminSchema,
  updateAdminSchema,
  permissionOverrideSchema,
  createPriceListSchema,
  reportQuerySchema,
  idParamSchema,
} from '../validators/adminValidator';

const router = Router();
const h = asyncHandler;

/**
 * Admin API, backing two dashboards off one surface:
 *
 *  - Super admin (platform scope): organizations, staff, pricing, cross-shop reports.
 *  - Shop admin (single organization): their own sessions, printers and reports.
 *
 * Which one a caller gets is decided entirely by their token. `resolveTenant`
 * pins every request to an organization derived from the principal, so a shop
 * admin cannot widen their scope by editing a query parameter.
 */

/** Credential stuffing protection, keyed by email and IP together. */
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.admin.login_rate_limit_max,
  message: { status: 'error', message: 'Too many sign-in attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) =>
    `${req.ip || 'unknown'}:${String((req.body as { email?: string })?.email || '').toLowerCase()}`,
});

// ---------------------------------------------------------------------------
// Authentication (public)
// ---------------------------------------------------------------------------
router.post('/auth/login', loginRateLimiter, validate(loginSchema), h(c.login.bind(c)));
router.post('/auth/refresh', validate(refreshSchema), h(c.refresh.bind(c)));
router.post('/auth/logout', validate(refreshSchema), h(c.logout.bind(c)));

// Everything below requires a valid admin token.
router.use(authenticateAdmin);

router.get('/auth/me', h(c.me.bind(c)));
router.post('/auth/change-password', validate(changePasswordSchema), h(c.changePassword.bind(c)));

// ---------------------------------------------------------------------------
// Organizations — platform scope
// ---------------------------------------------------------------------------
router.post(
  '/organizations',
  requireSuperAdmin,
  validate(createOrganizationSchema),
  h(c.createOrganization.bind(c))
);
router.get('/organizations', requireSuperAdmin, h(c.listOrganizations.bind(c)));
router.get(
  '/organizations/:id',
  requireSuperAdmin,
  validate(idParamSchema, 'params'),
  h(c.getOrganization.bind(c))
);
router.patch(
  '/organizations/:id',
  requireSuperAdmin,
  validate(idParamSchema, 'params'),
  validate(updateOrganizationSchema),
  h(c.updateOrganization.bind(c))
);
router.post(
  '/organizations/:id/status',
  requireSuperAdmin,
  validate(idParamSchema, 'params'),
  validate(organizationStatusSchema),
  h(c.setOrganizationStatus.bind(c))
);
router.delete(
  '/organizations/:id',
  requireSuperAdmin,
  validate(idParamSchema, 'params'),
  h(c.deleteOrganization.bind(c))
);
router.post(
  '/organizations/:id/kiosks',
  requireSuperAdmin,
  validate(idParamSchema, 'params'),
  validate(assignKioskSchema),
  h(c.assignKiosk.bind(c))
);

/** Kiosks the caller may see: their own shop's, or all of them for a super admin. */
router.get(
  '/kiosks',
  resolveTenant,
  requirePermission(PERMISSIONS.PRINTERS_READ),
  h(c.listKiosks.bind(c))
);

// ---------------------------------------------------------------------------
// Admin users
//
// Creation is platform-only: a super admin issues the username and password.
// Shop owners can read their staff and adjust them within their own org.
// ---------------------------------------------------------------------------
router.post('/users', requireSuperAdmin, validate(createAdminSchema), h(c.createAdmin.bind(c)));

router.get(
  '/users',
  resolveTenant,
  requirePermission(PERMISSIONS.STAFF_READ),
  h(c.listAdmins.bind(c))
);
router.get(
  '/users/:id',
  resolveTenant,
  requirePermission(PERMISSIONS.STAFF_READ),
  validate(idParamSchema, 'params'),
  h(c.getAdmin.bind(c))
);
router.patch(
  '/users/:id',
  resolveTenant,
  requirePermission(PERMISSIONS.STAFF_WRITE),
  validate(idParamSchema, 'params'),
  validate(updateAdminSchema),
  h(c.updateAdmin.bind(c))
);
router.delete(
  '/users/:id',
  resolveTenant,
  requirePermission(PERMISSIONS.STAFF_WRITE),
  validate(idParamSchema, 'params'),
  h(c.deleteAdmin.bind(c))
);
router.post(
  '/users/:id/reset-password',
  resolveTenant,
  requirePermission(PERMISSIONS.STAFF_WRITE),
  validate(idParamSchema, 'params'),
  h(c.resetAdminPassword.bind(c))
);
router.post(
  '/users/:id/unlock',
  resolveTenant,
  requirePermission(PERMISSIONS.STAFF_WRITE),
  validate(idParamSchema, 'params'),
  h(c.unlockAdmin.bind(c))
);
router.get(
  '/users/:id/permissions',
  resolveTenant,
  requirePermission(PERMISSIONS.STAFF_READ),
  validate(idParamSchema, 'params'),
  h(c.getAdminPermissions.bind(c))
);
router.put(
  '/users/:id/permissions',
  resolveTenant,
  requirePermission(PERMISSIONS.STAFF_WRITE),
  validate(idParamSchema, 'params'),
  validate(permissionOverrideSchema),
  h(c.setAdminPermission.bind(c))
);

router.get('/permissions', h(c.listPermissionCatalogue.bind(c)));

// ---------------------------------------------------------------------------
// Reports — the shop dashboard
// ---------------------------------------------------------------------------
router.get(
  '/reports/summary',
  validate(reportQuerySchema, 'query'),
  resolveTenant,
  requirePermission(PERMISSIONS.REPORTS_READ),
  h(c.getSummary.bind(c))
);
router.get(
  '/reports/series',
  validate(reportQuerySchema, 'query'),
  resolveTenant,
  requirePermission(PERMISSIONS.REPORTS_READ),
  h(c.getTimeSeries.bind(c))
);
router.get(
  '/reports/kiosks',
  validate(reportQuerySchema, 'query'),
  resolveTenant,
  requirePermission(PERMISSIONS.REPORTS_READ),
  h(c.getKioskBreakdown.bind(c))
);
router.get(
  '/reports/sessions',
  validate(reportQuerySchema, 'query'),
  resolveTenant,
  requirePermission(PERMISSIONS.SESSIONS_READ),
  h(c.listSessions.bind(c))
);
router.get(
  '/reports/sessions/export',
  validate(reportQuerySchema, 'query'),
  resolveTenant,
  requirePermission(PERMISSIONS.EXPORT_DATA),
  h(c.exportSessions.bind(c))
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
router.get(
  '/printers',
  resolveTenant,
  requirePermission(PERMISSIONS.PRINTERS_READ),
  h(c.getPrinterHealth.bind(c))
);
router.get(
  '/attention',
  resolveTenant,
  requirePermission(PERMISSIONS.REPORTS_READ),
  h(c.getAttentionQueue.bind(c))
);
router.get(
  '/audit',
  resolveTenant,
  requirePermission(PERMISSIONS.AUDIT_READ),
  h(c.listAudit.bind(c))
);

// ---------------------------------------------------------------------------
// Pricing — readable by shops, writable only by the platform
// ---------------------------------------------------------------------------
router.get(
  '/pricing',
  resolveTenant,
  requirePermission(PERMISSIONS.PRICING_READ),
  h(c.getPricing.bind(c))
);
router.get(
  '/pricing/lists',
  resolveTenant,
  requirePermission(PERMISSIONS.PRICING_READ),
  h(c.listPriceLists.bind(c))
);
router.post(
  '/pricing/lists',
  requirePermission(PERMISSIONS.PRICING_WRITE),
  validate(createPriceListSchema),
  h(c.createPriceList.bind(c))
);

// Kept for symmetry with requireTenant's intended use in future endpoints that
// cannot be answered platform-wide.
export { requireTenant };

export default router;
