-- Delete the unpaid print sessions of one shop, and nothing else.
--
-- A session is unpaid when none of its jobs was paid. Sessions with a paid job
-- (including refunds still owed) are kept whole, with their jobs and payments.
-- Sessions named in `skip` are kept whole too, paid or not.
--
-- The shop, its kiosks and printers are not touched.
--
-- Run as ONE transaction that stops at the first error (-1 wraps it in
-- BEGIN/COMMIT; any error rolls everything back):
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -v keep='<shop slug>' \
--     -v skip='<session_id>,<session_id>' -f scripts/delete-unpaid-shop-1-sessions.sql
--
-- `skip` lists session_id values (the S-prefixed codes) to leave alone. Pass an
-- empty string to skip nothing.

-- ---------------------------------------------------------------------------
-- Targets
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE keep_org AS
    SELECT id, name, slug FROM organizations WHERE slug = :'keep';

CREATE TEMP TABLE keep_kiosks AS
    SELECT id FROM kiosks WHERE organization_id IN (SELECT id FROM keep_org);

CREATE TEMP TABLE skip_sessions AS
    SELECT unnest(string_to_array(:'skip', ',')) AS session_id;

CREATE TEMP TABLE target_sessions AS
    SELECT s.id FROM print_sessions s
     WHERE s.kiosk_id IN (SELECT id FROM keep_kiosks)
       AND s.session_id NOT IN (SELECT session_id FROM skip_sessions)
       AND NOT EXISTS (
           SELECT 1 FROM print_jobs j
            WHERE j.session_id = s.id
              AND (j.payment_status = 'paid'
                   OR j.id IN (SELECT po.job_id
                                 FROM payment_orders po
                                 JOIN payment_transactions pt ON pt.order_id = po.order_id
                                WHERE pt.status = 'captured')));

CREATE TEMP TABLE target_jobs AS
    SELECT id FROM print_jobs WHERE session_id IN (SELECT id FROM target_sessions);

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

    -- Nothing money-related may be attached to what is about to go.
    IF EXISTS (SELECT 1 FROM payments WHERE print_job_id IN (SELECT id FROM target_jobs)
                                         OR session_id IN (SELECT id FROM target_sessions)) THEN
        RAISE EXCEPTION 'a session to delete has a legacy payment row; review it first';
    END IF;

    IF EXISTS (SELECT 1 FROM payment_refunds WHERE job_id IN (SELECT id FROM target_jobs)) THEN
        RAISE EXCEPTION 'a session to delete has a refund; review it first';
    END IF;

    IF EXISTS (SELECT 1 FROM payment_orders po
                JOIN payment_transactions pt ON pt.order_id = po.order_id
               WHERE po.job_id IN (SELECT id FROM target_jobs)
                 AND pt.status = 'captured') THEN
        RAISE EXCEPTION 'a session to delete has a captured payment; review it first';
    END IF;
END $$;

-- What is about to be removed.
SELECT 'to delete' AS stage,
       (SELECT count(*) FROM target_sessions) AS sessions,
       (SELECT count(*) FROM target_jobs)     AS jobs,
       (SELECT coalesce(sum(total_amount), 0) FROM print_jobs
         WHERE id IN (SELECT id FROM target_jobs)) AS amount_unpaid;

-- ---------------------------------------------------------------------------
-- Delete, children first
-- ---------------------------------------------------------------------------
DELETE FROM analytics_events WHERE session_id IN (SELECT id FROM target_sessions);

DELETE FROM print_queue WHERE job_id IN (SELECT id FROM target_jobs);

-- Abandoned checkouts: orders that never captured. Guarded above.
DELETE FROM payment_transactions
 WHERE order_id IN (SELECT order_id FROM payment_orders WHERE job_id IN (SELECT id FROM target_jobs));

DELETE FROM payment_orders WHERE job_id IN (SELECT id FROM target_jobs);

DELETE FROM print_jobs WHERE id IN (SELECT id FROM target_jobs);

DELETE FROM documents WHERE session_id IN (SELECT id FROM target_sessions);

DELETE FROM print_sessions WHERE id IN (SELECT id FROM target_sessions);

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
SELECT 'after' AS stage, o.slug,
       (SELECT count(*) FROM print_sessions s JOIN kiosks k ON k.id = s.kiosk_id
         WHERE k.organization_id = o.id)                                  AS sessions,
       (SELECT count(*) FROM kiosks k WHERE k.organization_id = o.id)     AS kiosks,
       (SELECT count(*) FROM printers p JOIN kiosks k ON k.id = p.kiosk_id
         WHERE k.organization_id = o.id)                                  AS printers,
       (SELECT count(*) FROM print_jobs j WHERE j.organization_id = o.id) AS jobs
  FROM keep_org o;
