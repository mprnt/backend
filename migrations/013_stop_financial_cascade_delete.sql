-- Migration: stop document cleanup from destroying financial records
-- Created: 2026-09-29
--
-- URGENT DATA-LOSS FIX.
--
-- The session expiry job deletes a session's documents 15 minutes after the
-- session was created. Migration 007 had wired a cascade chain:
--
--     documents -> print_jobs -> payment_orders -> payment_transactions
--
-- so that privacy cleanup silently destroyed the entire financial trail. In
-- production this had already removed every print job and every payment record
-- (0 jobs, 0 transactions against 26 sessions), while the money remained
-- captured at the gateway. Reconciliation was impossible from our own data.
--
-- Deleting a customer's document after their session ends is correct. Deleting
-- the record of what they were charged is not: the order has to outlive the
-- file. This migration keeps the privacy behaviour and removes the collateral.
--
-- Safe to run against a live database: it only alters constraint actions, never
-- touches rows, and each step is guarded.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Deleting a document must not delete the job.
--
--    document_id is nullable, so the reference is simply cleared. The job keeps
--    its settings, page count, amount and payment status — everything needed
--    for accounting and refunds — and merely loses the pointer to a file that
--    no longer exists.
-- ---------------------------------------------------------------------------
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_document_id_fkey;

ALTER TABLE print_jobs
    ADD CONSTRAINT print_jobs_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES documents(id)
    ON DELETE SET NULL;

COMMENT ON CONSTRAINT print_jobs_document_id_fkey ON print_jobs IS
    'SET NULL: a document may be cleaned up for privacy, but the job and its financial record survive.';

-- ---------------------------------------------------------------------------
-- 2. Deleting a job must not delete its payment orders.
--
--    job_id is NOT NULL, so SET NULL is unavailable — and RESTRICT is the
--    better answer anyway: a job that has taken money should not be deletable
--    at all. The delete fails loudly instead of quietly shredding the evidence.
--
--    Both the legacy duplicate (fk_job) and the cascading constraint go.
-- ---------------------------------------------------------------------------
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_job_id_fkey;
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS fk_job;

ALTER TABLE payment_orders
    ADD CONSTRAINT payment_orders_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES print_jobs(id)
    ON DELETE RESTRICT;

COMMENT ON CONSTRAINT payment_orders_job_id_fkey ON payment_orders IS
    'RESTRICT: refuse to delete a job that has payment orders against it.';

-- ---------------------------------------------------------------------------
-- 3. Same for the transactions themselves — the innermost financial record,
--    and the last thing that should ever disappear automatically.
-- ---------------------------------------------------------------------------
ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_order_id_fkey;
ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS fk_order;

ALTER TABLE payment_transactions
    ADD CONSTRAINT payment_transactions_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES payment_orders(order_id)
    ON DELETE RESTRICT;

COMMENT ON CONSTRAINT payment_transactions_order_id_fkey ON payment_transactions IS
    'RESTRICT: captured payments are never removed as a side effect of another delete.';

-- ---------------------------------------------------------------------------
-- 4. Documents still cascade from their session. That one is intentional and
--    stays: it is how a customer's uploaded file stops existing. With the above
--    in place it no longer reaches anything financial.
-- ---------------------------------------------------------------------------

COMMIT;
