-- Remove every print session of one shop, and keep the shop itself.
--
-- The shop, its kiosks and printers are not touched, so its name, printer ID and
-- printer API key stay exactly as they are.
--
-- Print jobs that have a payment record are kept as financial records. They are
-- detached from their session (session_id is cleared), which lets the session be
-- deleted, while the job keeps its kiosk, its shop, its payment rows and its
-- revenue. Unpaid jobs are deleted with their session.
--
-- Run as ONE transaction that stops at the first error (-1 wraps it in
-- BEGIN/COMMIT; any error rolls everything back):
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -v keep='<shop slug>' \
--     -v skip='<session_id>,<session_id>' -f scripts/trim-shop-1-sessions.sql
--
-- `skip` lists session_id values (the S-prefixed codes) to leave alone. Pass
-- an empty string to skip nothing.
--
-- Before running: take a pg_dump, and export the stored file paths of the shop's
-- documents (documents.storage_path) so they can be removed from object storage
-- afterwards. SQL cannot delete object-storage files.

-- ---------------------------------------------------------------------------
-- Targets
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE keep_org AS
    SELECT id, name, slug FROM organizations WHERE slug = :'keep';

CREATE TEMP TABLE keep_kiosks AS
    SELECT id FROM kiosks WHERE organization_id IN (SELECT id FROM keep_org);

-- Sessions named in `skip` stay exactly as they are, with their jobs and payments.
CREATE TEMP TABLE skip_sessions AS
    SELECT unnest(string_to_array(:'skip', ',')) AS session_id;

CREATE TEMP TABLE keep_sessions AS
    SELECT id FROM print_sessions
     WHERE kiosk_id IN (SELECT id FROM keep_kiosks)
       AND session_id NOT IN (SELECT session_id FROM skip_sessions);

CREATE TEMP TABLE keep_jobs AS
    SELECT id FROM print_jobs
     WHERE session_id IN (SELECT id FROM keep_sessions);

CREATE TEMP TABLE paid_jobs AS
    SELECT id FROM print_jobs
     WHERE id IN (SELECT id FROM keep_jobs)
       AND (payment_status = 'paid'
            OR id IN (SELECT job_id FROM payment_orders));

CREATE TEMP TABLE unpaid_jobs AS
    SELECT id FROM print_jobs
     WHERE id IN (SELECT id FROM keep_jobs)
       AND id NOT IN (SELECT id FROM paid_jobs);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF (SELECT count(*) FROM keep_org) <> 1 THEN
        RAISE EXCEPTION 'the shop slug must match exactly one shop';
    END IF;

    -- Every session named in `skip` must belong to the shop, or the name is wrong.
    IF EXISTS (SELECT 1 FROM skip_sessions s
                WHERE NOT EXISTS (SELECT 1 FROM print_sessions p
                                   WHERE p.session_id = s.session_id
                                     AND p.kiosk_id IN (SELECT id FROM keep_kiosks))) THEN
        RAISE EXCEPTION 'a skip session is not a session of this shop; check the names';
    END IF;

    -- An unpaid job with a legacy payment row would be deleted out from under it.
    IF EXISTS (SELECT 1 FROM payments
                WHERE print_job_id IN (SELECT id FROM unpaid_jobs)) THEN
        RAISE EXCEPTION 'an unpaid job has a legacy payment row; review it first';
    END IF;

    IF EXISTS (SELECT 1 FROM payment_refunds
                WHERE job_id IN (SELECT id FROM unpaid_jobs)) THEN
        RAISE EXCEPTION 'an unpaid job has a refund; review it first';
    END IF;
END $$;

-- The paid jobs that will be kept. Check each one before the run: a paid job whose
-- document is deleted here can no longer be printed.
SELECT 'kept paid job' AS stage, j.id, j.payment_status, j.total_amount, j.created_at
  FROM print_jobs j
 WHERE j.id IN (SELECT id FROM paid_jobs)
 ORDER BY j.created_at;

-- What is about to be removed.
SELECT 'before' AS stage,
       (SELECT count(*) FROM keep_sessions)  AS sessions,
       (SELECT count(*) FROM paid_jobs)      AS paid_jobs_kept,
       (SELECT count(*) FROM unpaid_jobs)    AS unpaid_jobs_deleted,
       (SELECT count(*) FROM documents
         WHERE session_id IN (SELECT id FROM keep_sessions)) AS documents;

-- ---------------------------------------------------------------------------
-- 1. Keep the paid jobs, detached from their sessions
-- ---------------------------------------------------------------------------
UPDATE print_jobs SET session_id = NULL
 WHERE id IN (SELECT id FROM paid_jobs);

UPDATE payments SET session_id = NULL
 WHERE session_id IN (SELECT id FROM keep_sessions);

-- ---------------------------------------------------------------------------
-- 2. Delete the unpaid jobs and the session-level records of the shop
-- ---------------------------------------------------------------------------
DELETE FROM analytics_events
 WHERE session_id IN (SELECT id FROM keep_sessions);

DELETE FROM print_queue WHERE job_id IN (SELECT id FROM unpaid_jobs);

DELETE FROM print_jobs WHERE id IN (SELECT id FROM unpaid_jobs);

DELETE FROM documents WHERE session_id IN (SELECT id FROM keep_sessions);

DELETE FROM print_sessions WHERE id IN (SELECT id FROM keep_sessions);

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
SELECT 'after' AS stage, o.slug,
       (SELECT count(*) FROM print_sessions s JOIN kiosks k ON k.id = s.kiosk_id
         WHERE k.organization_id = o.id)                                  AS sessions,
       (SELECT count(*) FROM kiosks k WHERE k.organization_id = o.id)     AS kiosks,
       (SELECT count(*) FROM printers p JOIN kiosks k ON k.id = p.kiosk_id
         WHERE k.organization_id = o.id)                                  AS printers,
       (SELECT count(*) FROM print_jobs j WHERE j.organization_id = o.id) AS jobs_kept
  FROM keep_org o;
