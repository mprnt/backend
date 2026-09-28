import {
  resolvePermissions,
  ROLE_PERMISSIONS,
  ASSIGNABLE_ROLES,
  PERMISSIONS,
  AdminRole,
} from '../../src/types/admin';

describe('Admin permission model', () => {
  describe('role defaults', () => {
    it('gives no shop role the ability to set pricing', () => {
      // Pricing is platform-owned. A shop that could set its own rates could
      // undercut the platform or charge its customers arbitrarily.
      for (const role of ASSIGNABLE_ROLES) {
        expect(ROLE_PERMISSIONS[role]).not.toContain(PERMISSIONS.PRICING_WRITE);
      }
      expect(ROLE_PERMISSIONS.super_admin).toContain(PERMISSIONS.PRICING_WRITE);
    });

    it('gives no shop role any platform-scope permission', () => {
      const platformOnly = [
        PERMISSIONS.ORGS_READ,
        PERMISSIONS.ORGS_WRITE,
        PERMISSIONS.PRICING_WRITE,
        PERMISSIONS.PLATFORM_REPORTS,
        PERMISSIONS.AUDIT_READ_ALL,
      ];

      for (const role of ASSIGNABLE_ROLES) {
        for (const p of platformOnly) {
          expect(ROLE_PERMISSIONS[role]).not.toContain(p);
        }
      }
    });

    it('nests the shop roles so each is a superset of the one below', () => {
      for (const p of ROLE_PERMISSIONS.viewer) {
        expect(ROLE_PERMISSIONS.manager).toContain(p);
      }
      for (const p of ROLE_PERMISSIONS.manager) {
        expect(ROLE_PERMISSIONS.owner).toContain(p);
      }
    });

    it('lets only an owner manage staff or issue refunds', () => {
      expect(ROLE_PERMISSIONS.owner).toContain(PERMISSIONS.STAFF_WRITE);
      expect(ROLE_PERMISSIONS.owner).toContain(PERMISSIONS.REFUNDS_ISSUE);
      expect(ROLE_PERMISSIONS.manager).not.toContain(PERMISSIONS.STAFF_WRITE);
      expect(ROLE_PERMISSIONS.manager).not.toContain(PERMISSIONS.REFUNDS_ISSUE);
      expect(ROLE_PERMISSIONS.viewer).not.toContain(PERMISSIONS.STAFF_WRITE);
    });

    it('keeps a viewer read-only', () => {
      const writes = [
        PERMISSIONS.STAFF_WRITE,
        PERMISSIONS.PRINTERS_MANAGE,
        PERMISSIONS.JOBS_CANCEL,
        PERMISSIONS.REFUNDS_ISSUE,
        PERMISSIONS.PRICING_WRITE,
        PERMISSIONS.ORGS_WRITE,
      ];
      for (const p of writes) {
        expect(ROLE_PERMISSIONS.viewer).not.toContain(p);
      }
    });

    it('excludes super_admin from the roles assignable over HTTP', () => {
      expect(ASSIGNABLE_ROLES).not.toContain('super_admin' as AdminRole);
    });
  });

  describe('resolvePermissions', () => {
    it('returns the role defaults when there are no overrides', () => {
      expect(resolvePermissions('viewer').sort()).toEqual([...ROLE_PERMISSIONS.viewer].sort());
    });

    it('adds a granted permission', () => {
      const perms = resolvePermissions('viewer', [
        { permission: PERMISSIONS.EXPORT_DATA, effect: 'grant' },
      ]);
      expect(perms).toContain(PERMISSIONS.EXPORT_DATA);
    });

    it('removes a denied permission that the role would otherwise have', () => {
      expect(ROLE_PERMISSIONS.owner).toContain(PERMISSIONS.REFUNDS_ISSUE);

      const perms = resolvePermissions('owner', [
        { permission: PERMISSIONS.REFUNDS_ISSUE, effect: 'deny' },
      ]);
      expect(perms).not.toContain(PERMISSIONS.REFUNDS_ISSUE);
    });

    it('lets deny win over a grant for the same permission', () => {
      // Order of the overrides must not change the outcome — deny is absolute.
      const a = resolvePermissions('viewer', [
        { permission: PERMISSIONS.EXPORT_DATA, effect: 'grant' },
        { permission: PERMISSIONS.EXPORT_DATA, effect: 'deny' },
      ]);
      const b = resolvePermissions('viewer', [
        { permission: PERMISSIONS.EXPORT_DATA, effect: 'deny' },
        { permission: PERMISSIONS.EXPORT_DATA, effect: 'grant' },
      ]);

      expect(a).not.toContain(PERMISSIONS.EXPORT_DATA);
      expect(b).not.toContain(PERMISSIONS.EXPORT_DATA);
    });

    it('never mutates the shared role definition', () => {
      const before = [...ROLE_PERMISSIONS.viewer];
      resolvePermissions('viewer', [{ permission: 'reports:read', effect: 'deny' }]);
      resolvePermissions('viewer', [{ permission: 'something:new', effect: 'grant' }]);
      expect(ROLE_PERMISSIONS.viewer).toEqual(before);
    });

    it('returns no duplicates when a grant repeats a role default', () => {
      const perms = resolvePermissions('owner', [
        { permission: PERMISSIONS.REPORTS_READ, effect: 'grant' },
      ]);
      expect(perms.filter((p) => p === PERMISSIONS.REPORTS_READ)).toHaveLength(1);
    });

    it('ignores an override for a permission the role never had', () => {
      const perms = resolvePermissions('viewer', [
        { permission: PERMISSIONS.STAFF_WRITE, effect: 'deny' },
      ]);
      expect(perms).not.toContain(PERMISSIONS.STAFF_WRITE);
      expect(perms).toContain(PERMISSIONS.REPORTS_READ);
    });
  });
});
