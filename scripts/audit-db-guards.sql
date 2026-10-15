-- audit_logs is append-only. Run inside a transaction that is rolled back.
-- Run: docker exec -i mprnt-postgres psql -U mprnt_user -d mprnt < scripts/audit-db-guards.sql
BEGIN;
DO $$
DECLARE
  inserted_id BIGINT;
BEGIN
  BEGIN
    INSERT INTO audit_logs (actor_scope, action, details, created_at)
      VALUES ('platform', 'guard.probe', '{}', NOW());
    RAISE NOTICE 'PASS  insert is allowed';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'FAIL  insert refused: %', SQLERRM;
  END;
  BEGIN
    UPDATE audit_logs SET action = 'tampered' WHERE action = 'guard.probe';
    RAISE NOTICE 'FAIL  update was allowed';
  EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS  update is refused';
  END;
  BEGIN
    DELETE FROM audit_logs WHERE action = 'guard.probe';
    RAISE NOTICE 'FAIL  delete was allowed';
  EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS  delete is refused';
  END;
  BEGIN
    TRUNCATE audit_logs;
    RAISE NOTICE 'FAIL  truncate was allowed';
  EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS  truncate is refused';
  END;
END $$;
ROLLBACK;
