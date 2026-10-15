-- Migration: make audit_logs append-only
-- Created: 2026-10-15
--
-- The audit trail records who changed money, prices and access. Nothing in the
-- application ever updates or deletes a row, so the database refuses both (and
-- TRUNCATE), whatever code path or script asks. A later change to history then
-- has to be deliberate: it means dropping this trigger, which is itself visible.
--
-- Limit: the table's owner can still drop the trigger. The stronger control is to
-- run the application as a role that holds INSERT and SELECT on audit_logs only.

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs;
CREATE TRIGGER trg_audit_logs_append_only
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER trg_audit_logs_no_truncate
    BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();
