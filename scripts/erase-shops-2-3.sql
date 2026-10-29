-- Erase two test shops completely, including their audit history.
--
-- The keep shop is named and checked, so it cannot be erased by mistake. The
-- script refuses to run if either target has a partner contract, billing
-- charge or partner document, because those rows are guarded by triggers that
-- forbid deleting them. Payments are deleted, since the owner confirmed the
-- targets' payments are test-mode only. Audit rows and revenue split terms are
-- erased too: their guard triggers come off for this transaction and go back on
-- before it commits.
--
-- Run it as ONE transaction that stops at the first error (-1 wraps it in
-- BEGIN/COMMIT; any error rolls everything back):
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -v keep='<shop 1 slug>' -v shop2='<shop 2 slug>' -v shop3='<shop 3 slug>' \
--     -f scripts/erase-shops-2-3.sql
--
-- Before running: take a pg_dump, and list the stored file paths of the targets'
-- documents (documents.storage_path, partner_documents.storage_key). SQL cannot
-- delete object-storage files, so those must be removed from S3/MinIO afterwards.

-- ---------------------------------------------------------------------------
-- Targets
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE keep_org AS
    SELECT id, name, slug FROM organizations WHERE slug = :'keep';

CREATE TEMP TABLE target_orgs AS
    SELECT id, name, slug FROM organizations WHERE slug IN (:'shop2', :'shop3');

CREATE TEMP TABLE target_kiosks AS
    SELECT id FROM kiosks WHERE organization_id IN (SELECT id FROM target_orgs);

CREATE TEMP TABLE target_sessions AS
    SELECT id FROM print_sessions WHERE kiosk_id IN (SELECT id FROM target_kiosks);

CREATE TEMP TABLE target_jobs AS
    SELECT id FROM print_jobs
     WHERE organization_id IN (SELECT id FROM target_orgs)
        OR kiosk_id IN (SELECT id FROM target_kiosks)
        OR session_id IN (SELECT id FROM target_sessions);

CREATE TEMP TABLE target_admins AS
    SELECT id FROM admin_users WHERE organization_id IN (SELECT id FROM target_orgs);

-- ---------------------------------------------------------------------------
-- Guards: stop before anything is deleted
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF (SELECT count(*) FROM target_orgs) <> 2 THEN
        RAISE EXCEPTION 'expected exactly 2 target shops, found %', (SELECT count(*) FROM target_orgs);
    END IF;

    IF (SELECT count(*) FROM keep_org) <> 1 THEN
        RAISE EXCEPTION 'keep shop slug must match exactly one shop';
    END IF;

    IF EXISTS (SELECT 1 FROM target_orgs t JOIN keep_org k ON k.id = t.id) THEN
        RAISE EXCEPTION 'the keep shop is in the target list; refusing to run';
    END IF;

    IF EXISTS (SELECT 1 FROM partner_contracts WHERE organization_id IN (SELECT id FROM target_orgs)) THEN
        RAISE EXCEPTION 'a target shop has a partner contract; contracts cannot be deleted';
    END IF;

    IF EXISTS (SELECT 1 FROM billing_charges bc
                 JOIN partner_contracts pc ON pc.id = bc.contract_id
                WHERE pc.organization_id IN (SELECT id FROM target_orgs)) THEN
        RAISE EXCEPTION 'a target shop has billing charges; charges cannot be deleted';
    END IF;

    IF EXISTS (SELECT 1 FROM partner_documents WHERE organization_id IN (SELECT id FROM target_orgs)) THEN
        RAISE EXCEPTION 'a target shop has partner documents; they cannot be deleted';
    END IF;
END $$;

-- What is about to be removed, for the record of this run.
SELECT 'before' AS stage, o.slug,
       (SELECT count(*) FROM kiosks k WHERE k.organization_id = o.id)   AS kiosks,
       (SELECT count(*) FROM printers p JOIN kiosks k ON k.id = p.kiosk_id
         WHERE k.organization_id = o.id)                               AS printers,
       (SELECT count(*) FROM print_sessions s JOIN kiosks k ON k.id = s.kiosk_id
         WHERE k.organization_id = o.id)                               AS sessions,
       (SELECT count(*) FROM print_jobs j WHERE j.organization_id = o.id) AS jobs,
       (SELECT count(*) FROM admin_users a WHERE a.organization_id = o.id) AS admins,
       (SELECT count(*) FROM audit_logs l WHERE l.organization_id = o.id
                                             OR l.admin_user_id IN
                                                (SELECT a.id FROM admin_users a WHERE a.organization_id = o.id)) AS audit_rows
  FROM target_orgs o;

-- ---------------------------------------------------------------------------
-- 1. Audit log: the append-only guards come off for this transaction only
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs;
DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON audit_logs;

-- Revenue split terms are append-only. Their guard comes off for this
-- transaction only; it is restored in step 8.
DROP TRIGGER IF EXISTS trg_revenue_split_terms_immutable ON revenue_split_terms;

-- ---------------------------------------------------------------------------
-- 2. Records of the targets' own activity, children first
-- ---------------------------------------------------------------------------
DELETE FROM analytics_events
 WHERE kiosk_id IN (SELECT id FROM target_kiosks)
    OR session_id IN (SELECT id FROM target_sessions);

-- Payments: the targets' payments are test-mode only (confirmed by the owner).
-- Children first: refunds and transactions reference orders, orders reference jobs.
DELETE FROM payment_refunds WHERE job_id IN (SELECT id FROM target_jobs);

DELETE FROM payment_transactions
 WHERE order_id IN (SELECT order_id FROM payment_orders WHERE job_id IN (SELECT id FROM target_jobs));

DELETE FROM payment_orders WHERE job_id IN (SELECT id FROM target_jobs);

DELETE FROM payments
 WHERE print_job_id IN (SELECT id FROM target_jobs)
    OR session_id IN (SELECT id FROM target_sessions);

DELETE FROM print_queue WHERE job_id IN (SELECT id FROM target_jobs);

DELETE FROM print_jobs WHERE id IN (SELECT id FROM target_jobs);

DELETE FROM documents WHERE session_id IN (SELECT id FROM target_sessions);

DELETE FROM print_sessions WHERE id IN (SELECT id FROM target_sessions);

DELETE FROM daily_stats
 WHERE kiosk_id IN (SELECT id FROM target_kiosks)
    OR organization_id IN (SELECT id FROM target_orgs);

DELETE FROM price_lists
 WHERE organization_id IN (SELECT id FROM target_orgs)
    OR kiosk_id IN (SELECT id FROM target_kiosks);

-- print_jobs.split_term_id pointed at these terms; the jobs are gone above.
DELETE FROM revenue_split_terms
 WHERE organization_id IN (SELECT id FROM target_orgs)
    OR kiosk_id IN (SELECT id FROM target_kiosks);

-- ---------------------------------------------------------------------------
-- 3. Partner onboarding drafts that belong to the targets
-- ---------------------------------------------------------------------------
DELETE FROM partner_onboarding_drafts
 WHERE organization_id IN (SELECT id FROM target_orgs);

-- ---------------------------------------------------------------------------
-- 4. Hardware: printers (heartbeats cascade), then kiosks
-- ---------------------------------------------------------------------------
DELETE FROM printer_heartbeats
 WHERE printer_id IN (SELECT p.id FROM printers p WHERE p.kiosk_id IN (SELECT id FROM target_kiosks));

DELETE FROM printers WHERE kiosk_id IN (SELECT id FROM target_kiosks);

DELETE FROM kiosks WHERE id IN (SELECT id FROM target_kiosks);

-- ---------------------------------------------------------------------------
-- 5. Audit rows for the targets (the trigger is off, see step 1)
-- ---------------------------------------------------------------------------
DELETE FROM audit_logs
 WHERE organization_id IN (SELECT id FROM target_orgs)
    OR admin_user_id IN (SELECT id FROM target_admins);

-- ---------------------------------------------------------------------------
-- 6. References from other rows to the targets' admins: clear them, so the
--    admins can go. The rows themselves belong to other shops or the platform.
--    Append-only tables (billing_plan_terms) are not touched here; if they
--    point at a target admin, the admin delete below fails and nothing is kept.
-- ---------------------------------------------------------------------------
UPDATE admin_users SET created_by = NULL WHERE created_by IN (SELECT id FROM target_admins);
UPDATE organizations SET onboarded_by = NULL WHERE onboarded_by IN (SELECT id FROM target_admins);
UPDATE price_lists SET created_by = NULL WHERE created_by IN (SELECT id FROM target_admins);
UPDATE partner_onboarding_drafts SET created_by = NULL WHERE created_by IN (SELECT id FROM target_admins);
UPDATE partner_onboarding_drafts SET completed_by = NULL WHERE completed_by IN (SELECT id FROM target_admins);
UPDATE admin_permission_overrides SET granted_by = NULL WHERE granted_by IN (SELECT id FROM target_admins);

-- ---------------------------------------------------------------------------
-- 7. Admins (refresh tokens and permission overrides cascade), then the shops
-- ---------------------------------------------------------------------------
DELETE FROM admin_users WHERE id IN (SELECT id FROM target_admins);

DELETE FROM organizations WHERE id IN (SELECT id FROM target_orgs);

-- ---------------------------------------------------------------------------
-- 8. Restore the audit guards, so the trail is append-only again from here on
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_audit_logs_append_only
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

CREATE TRIGGER trg_audit_logs_no_truncate
    BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();

CREATE TRIGGER trg_revenue_split_terms_immutable
    BEFORE UPDATE OR DELETE ON revenue_split_terms
    FOR EACH ROW EXECUTE FUNCTION revenue_split_terms_immutable();

-- ---------------------------------------------------------------------------
-- Verification: the targets are gone. The keep shop's counts are printed for
-- comparison with the earlier run; trimming its sessions is a separate step.
-- ---------------------------------------------------------------------------
SELECT 'remaining targets' AS check, count(*) AS rows
  FROM organizations WHERE slug IN (:'shop2', :'shop3');

SELECT 'keep shop' AS stage, o.slug,
       (SELECT count(*) FROM kiosks k WHERE k.organization_id = o.id)   AS kiosks,
       (SELECT count(*) FROM printers p JOIN kiosks k ON k.id = p.kiosk_id
         WHERE k.organization_id = o.id)                               AS printers,
       (SELECT count(*) FROM print_sessions s JOIN kiosks k ON k.id = s.kiosk_id
         WHERE k.organization_id = o.id)                               AS sessions,
       (SELECT count(*) FROM print_jobs j WHERE j.organization_id = o.id) AS jobs
  FROM keep_org o;
