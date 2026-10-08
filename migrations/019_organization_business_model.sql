-- Migration: record which commercial model each partner is on
-- Created: 2026-10-07
--
-- "Organization" in this schema is what the business calls a partner. The
-- four models are the ones published on /for-businesses, and the ids match
-- MPrnt/main/src/lib/models.ts exactly so the website, the admin dashboard
-- and this table cannot drift apart:
--
--   integration    Model 1            Printer Integration (partner's own printer)
--   revenue-share  Model 2 Option A   Station, revenue share
--   own-station    Model 2 Option B   Station, purchase + monthly software
--   full-purchase  Model 3            Station, full purchase & support
--
-- Nullable on purpose. Partners created before this migration have no model
-- recorded, and guessing one would put a commercial term in the database that
-- nobody agreed to. The dashboard shows those as "Not set" so they can be
-- corrected deliberately.

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS business_model VARCHAR(32);

COMMENT ON COLUMN organizations.business_model IS
    'Commercial model from /for-businesses: integration | revenue-share | own-station | full-purchase. NULL = not yet recorded.';

-- Enforced here rather than only in the API: a typo'd model would quietly
-- vanish from every "partners by model" count instead of failing loudly.
ALTER TABLE organizations
    DROP CONSTRAINT IF EXISTS organizations_business_model_check;
ALTER TABLE organizations
    ADD CONSTRAINT organizations_business_model_check
    CHECK (business_model IS NULL OR business_model IN (
        'integration', 'revenue-share', 'own-station', 'full-purchase'
    ));

-- The partners list is filtered and counted by model on every load.
CREATE INDEX IF NOT EXISTS idx_organizations_business_model
    ON organizations(business_model)
    WHERE deleted_at IS NULL;
