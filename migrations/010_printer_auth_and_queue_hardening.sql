-- Migration: Printer API-key auth + print queue hardening
-- Created: 2026-09-28
--
-- 1. Per-printer API credentials so /queue/* can authenticate Raspberry Pi devices.
-- 2. Lease columns on print_queue so a job claimed by a Pi that dies is recoverable.
-- 3. printed_pages on print_queue for live progress without touching print_jobs.
-- 4. Status CHECK constraints so a bad status can never be written.

-- ---------------------------------------------------------------------------
-- Printer credentials
-- ---------------------------------------------------------------------------
ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS api_key_hash   CHAR(64),
    ADD COLUMN IF NOT EXISTS api_key_prefix VARCHAR(16),
    ADD COLUMN IF NOT EXISTS api_key_issued_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS revoked_at     TIMESTAMP,
    ADD COLUMN IF NOT EXISTS last_seen_ip   VARCHAR(45);

COMMENT ON COLUMN printers.api_key_hash IS
    'SHA-256 hex digest of the printer API key. The plaintext key is shown once at enrollment and never stored.';
COMMENT ON COLUMN printers.api_key_prefix IS
    'First 8 chars of the key, stored for log correlation and key identification only.';
COMMENT ON COLUMN printers.revoked_at IS
    'When set, the printer is denied on every authenticated endpoint.';

CREATE INDEX IF NOT EXISTS idx_printers_api_key_hash ON printers(api_key_hash);

-- ---------------------------------------------------------------------------
-- Print queue: leases, progress, idempotency
-- ---------------------------------------------------------------------------
ALTER TABLE print_queue
    ADD COLUMN IF NOT EXISTS printed_pages      INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lease_expires_at   TIMESTAMP,
    ADD COLUMN IF NOT EXISTS lease_count        INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS error_code         VARCHAR(50),
    ADD COLUMN IF NOT EXISTS last_reported_at   TIMESTAMP;

COMMENT ON COLUMN print_queue.lease_expires_at IS
    'A claimed job whose lease has expired is returned to the queue by the reaper job.';
COMMENT ON COLUMN print_queue.lease_count IS
    'How many times this job has been leased to a printer. Guards against infinite reclaim loops.';

CREATE INDEX IF NOT EXISTS idx_print_queue_lease_expires_at
    ON print_queue(lease_expires_at)
    WHERE status IN ('assigned', 'printing');

-- Ordering index used by the poll query's hot path.
CREATE INDEX IF NOT EXISTS idx_print_queue_poll
    ON print_queue(status, priority DESC, queued_at ASC);

-- ---------------------------------------------------------------------------
-- Status integrity
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_print_queue_status'
    ) THEN
        ALTER TABLE print_queue ADD CONSTRAINT chk_print_queue_status
            CHECK (status IN ('queued', 'assigned', 'printing', 'completed', 'failed', 'cancelled'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_printers_status'
    ) THEN
        ALTER TABLE printers ADD CONSTRAINT chk_printers_status
            CHECK (status IN ('online', 'offline', 'busy', 'error', 'maintenance'));
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Backfill: any paid job that never made it into print_queue
-- ---------------------------------------------------------------------------
INSERT INTO print_queue (job_id, status, priority, queued_at, created_at, updated_at)
SELECT pj.id, 'queued', 0, COALESCE(pj.queued_at, NOW()), NOW(), NOW()
FROM print_jobs pj
LEFT JOIN print_queue pq ON pq.job_id = pj.id
WHERE pj.status = 'queued'
  AND pj.payment_status = 'paid'
  AND pq.id IS NULL
ON CONFLICT (job_id) DO NOTHING;
