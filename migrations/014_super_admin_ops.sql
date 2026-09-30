-- Migration: super admin operations
-- Created: 2026-09-30
--
-- Separates platform audit entries from shop audit entries, and adds the
-- indexes the new audit filters and per-shop reports rely on.
--
-- Additive and idempotent: safe to run against a live database, and safe to
-- run again.

-- ---------------------------------------------------------------------------
-- Audit scope
--
-- Until now an audit entry was tagged only with the organization it concerned.
-- A super admin publishing pricing for a shop therefore produced an entry in
-- that shop's log, complete with the super admin's email and IP address.
--
-- actor_scope records who acted, fixed at write time:
--   'platform' — a super admin, or an event not tied to any shop's staff
--   'shop'     — a member of the shop's own staff
--
-- It is stored rather than derived from the actor's current role, because a
-- role can change later and the audit trail must reflect who they were when
-- they acted.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_logs
    ADD COLUMN IF NOT EXISTS actor_scope VARCHAR(10);

UPDATE audit_logs al
   SET actor_scope = CASE WHEN au.role = 'super_admin' THEN 'platform' ELSE 'shop' END
  FROM admin_users au
 WHERE al.admin_user_id = au.id
   AND al.actor_scope IS NULL;

-- Entries with no actor (e.g. a failed sign-in for an unknown address) are
-- platform-level security events.
UPDATE audit_logs SET actor_scope = 'platform' WHERE actor_scope IS NULL;

ALTER TABLE audit_logs ALTER COLUMN actor_scope SET DEFAULT 'platform';
ALTER TABLE audit_logs ALTER COLUMN actor_scope SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_audit_actor_scope') THEN
        ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_actor_scope
            CHECK (actor_scope IN ('platform', 'shop'));
    END IF;
END $$;

COMMENT ON COLUMN audit_logs.actor_scope IS
    'Who acted: platform (super admin / system) or shop (the shop''s own staff). Shops only ever see shop-scoped entries.';

-- The shop view filters on both columns; the platform view filters on scope,
-- action and time.
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_scope_time
    ON audit_logs(organization_id, actor_scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time
    ON audit_logs(action, created_at DESC);

-- ---------------------------------------------------------------------------
-- Per-shop reporting
--
-- The shop comparison looks up the most recent paid job per organization and
-- sums revenue over two windows per shop; both walk print_jobs by kiosk and
-- time.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_print_jobs_kiosk_paid_created
    ON print_jobs(kiosk_id, created_at DESC)
    WHERE payment_status = 'paid';
