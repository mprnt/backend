-- Migration: Multi-tenant admin dashboard
-- Created: 2026-09-28
--
-- Introduces the "shop" (organization) that owns kiosks and staff, the auth and
-- permission tables behind the two dashboards, and data-driven pricing.
--
-- Commission and settlements are deliberately NOT part of this migration; the
-- prototype does not split revenue.

-- ---------------------------------------------------------------------------
-- Organizations — the shop or business running one or more kiosks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(255) NOT NULL,
    slug        VARCHAR(64)  UNIQUE NOT NULL,
    status      VARCHAR(20)  NOT NULL DEFAULT 'active',
    -- Reports roll up by calendar day in the shop's own timezone. "Monday" in
    -- Asia/Kolkata is not "Monday" in UTC, and an owner reads their local days.
    timezone    VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata',
    contact_email VARCHAR(255),
    contact_phone VARCHAR(32),
    notes       TEXT,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMP,

    CONSTRAINT chk_org_status CHECK (status IN ('active', 'suspended'))
);

CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug_live
    ON organizations(slug) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Tenancy: every kiosk belongs to exactly one organization
-- ---------------------------------------------------------------------------
ALTER TABLE kiosks
    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS idx_kiosks_organization_id ON kiosks(organization_id);

-- ---------------------------------------------------------------------------
-- Admin users
--
-- organization_id IS NULL marks a platform-level super admin. Everyone else is
-- scoped to exactly one shop, and that scope is enforced server-side.
-- ---------------------------------------------------------------------------
ALTER TABLE admin_users
    ADD COLUMN IF NOT EXISTS organization_id      UUID REFERENCES organizations(id),
    ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMP NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS deleted_at           TIMESTAMP,
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS password_changed_at  TIMESTAMP,
    ADD COLUMN IF NOT EXISTS created_by           UUID REFERENCES admin_users(id),
    ADD COLUMN IF NOT EXISTS last_login_ip        VARCHAR(45);

COMMENT ON COLUMN admin_users.deleted_at IS
    'Soft delete. Rows are never removed so audit_logs.admin_user_id always resolves.';
COMMENT ON COLUMN admin_users.organization_id IS
    'NULL = platform super admin with global scope. Otherwise scoped to one shop.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_admin_role') THEN
        ALTER TABLE admin_users ADD CONSTRAINT chk_admin_role
            CHECK (role IN ('super_admin', 'owner', 'manager', 'viewer'));
    END IF;
END $$;

-- A super admin has no org; every other role must have one.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_admin_scope') THEN
        ALTER TABLE admin_users ADD CONSTRAINT chk_admin_scope
            CHECK (
                (role = 'super_admin' AND organization_id IS NULL)
                OR (role <> 'super_admin' AND organization_id IS NOT NULL)
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_admin_users_organization_id ON admin_users(organization_id);
-- Email is unique among live accounts only, so a deleted address can be reused.
-- The original UNIQUE is backed by a constraint, so dropping the constraint is
-- what removes the index; a bare DROP INDEX is refused.
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_email_live
    ON admin_users(lower(email)) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Refresh tokens
--
-- Stored as a SHA-256 digest. Access tokens are short-lived and stateless;
-- revoking a refresh token is what actually cuts off a removed admin.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_refresh_tokens (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    token_hash    CHAR(64) NOT NULL,
    expires_at    TIMESTAMP NOT NULL,
    revoked_at    TIMESTAMP,
    replaced_by   UUID REFERENCES admin_refresh_tokens(id),
    user_agent    TEXT,
    ip_address    VARCHAR(45),
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_refresh_token_hash
    ON admin_refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_admin_refresh_user
    ON admin_refresh_tokens(admin_user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Permission overrides
--
-- Roles supply the default permission set. This table grants or revokes a single
-- permission for one admin without inventing a new role.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_permission_overrides (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    permission    VARCHAR(64) NOT NULL,
    effect        VARCHAR(10) NOT NULL,
    granted_by    UUID REFERENCES admin_users(id),
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_override_effect CHECK (effect IN ('grant', 'deny')),
    CONSTRAINT unique_admin_permission UNIQUE (admin_user_id, permission)
);

-- ---------------------------------------------------------------------------
-- Pricing
--
-- Platform-set. A NULL kiosk_id row is the organization default; a NULL
-- organization_id row is the platform default. Rows are never updated — a price
-- change inserts a new row, so a quote already shown to a customer cannot move
-- and historical reporting stays truthful.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_lists (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id),
    kiosk_id        UUID REFERENCES kiosks(id),
    bw_per_page     NUMERIC(10,2) NOT NULL,
    color_per_page  NUMERIC(10,2) NOT NULL,
    min_charge      NUMERIC(10,2) NOT NULL DEFAULT 0,
    effective_from  TIMESTAMP NOT NULL DEFAULT NOW(),
    created_by      UUID REFERENCES admin_users(id),
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_price_positive CHECK (bw_per_page >= 0 AND color_per_page >= 0),
    -- A kiosk-scoped row must name its organization too, so resolution is unambiguous.
    CONSTRAINT chk_price_scope CHECK (kiosk_id IS NULL OR organization_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_price_lists_resolution
    ON price_lists(organization_id, kiosk_id, effective_from DESC);

-- Platform default, matching the constants previously hardcoded in pricingService.
INSERT INTO price_lists (organization_id, kiosk_id, bw_per_page, color_per_page, effective_from)
SELECT NULL, NULL, 2.00, 5.00, NOW() - INTERVAL '1 year'
WHERE NOT EXISTS (
    SELECT 1 FROM price_lists WHERE organization_id IS NULL AND kiosk_id IS NULL
);

-- ---------------------------------------------------------------------------
-- Audit log scoping
-- ---------------------------------------------------------------------------
ALTER TABLE audit_logs
    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_time
    ON audit_logs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_time
    ON audit_logs(admin_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Daily stats: scope rollups by organization as well as kiosk
-- ---------------------------------------------------------------------------
ALTER TABLE daily_stats
    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS idx_daily_stats_org_date
    ON daily_stats(organization_id, date DESC);

-- ---------------------------------------------------------------------------
-- Reporting indexes on the hot paths the dashboard queries
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_print_jobs_kiosk_created ON print_jobs(kiosk_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status        ON print_jobs(status);
CREATE INDEX IF NOT EXISTS idx_print_sessions_kiosk     ON print_sessions(kiosk_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Backfill: adopt every existing kiosk into a default organization
-- ---------------------------------------------------------------------------
INSERT INTO organizations (name, slug, status, timezone)
SELECT 'Default Organization', 'default', 'active', 'Asia/Kolkata'
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'default');

UPDATE kiosks
   SET organization_id = (SELECT id FROM organizations WHERE slug = 'default')
 WHERE organization_id IS NULL;

UPDATE daily_stats ds
   SET organization_id = k.organization_id
  FROM kiosks k
 WHERE ds.kiosk_id = k.id AND ds.organization_id IS NULL;
