-- 026: fixed print deadline per paid job, former-holder tracking, per-attempt
-- history, and physical-output evidence kept apart from the job's status.
--
-- Nothing here changes a job's status. Existing paid jobs get a fixed deadline
-- of paid_at + 15 minutes (the window the system already enforces). Attempt
-- history is backfilled only where the current row shows it; legacy jobs with
-- missing attempts stay 'unknown' until an operator reconciles them.

-- 1. Fixed deadline, stored on the job at payment capture.
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_deadline_at TIMESTAMPTZ;

UPDATE print_jobs
   SET print_deadline_at = COALESCE(paid_at, queued_at, created_at) + INTERVAL '15 minutes'
 WHERE payment_status = 'paid'
   AND print_deadline_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_print_jobs_deadline
  ON print_jobs (print_deadline_at)
  WHERE payment_status = 'paid';

-- 2. Queue row: last holder and physical outcome (default 'unknown').
ALTER TABLE print_queue
  ADD COLUMN IF NOT EXISTS last_printer_id UUID REFERENCES printers(id),
  ADD COLUMN IF NOT EXISTS physical_outcome VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (physical_outcome IN ('unknown', 'printed', 'partial', 'blank', 'not_printed')),
  ADD COLUMN IF NOT EXISTS physical_verified_pages INTEGER CHECK (physical_verified_pages >= 0),
  ADD COLUMN IF NOT EXISTS physical_method VARCHAR(100),
  ADD COLUMN IF NOT EXISTS physical_reason TEXT,
  ADD COLUMN IF NOT EXISTS physical_recorded_by UUID,
  ADD COLUMN IF NOT EXISTS physical_recorded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS physical_attempt_findings JSONB;

-- 3. Every assignment, one row per attempt.
CREATE TABLE IF NOT EXISTS print_attempts (
  job_id      UUID NOT NULL REFERENCES print_jobs(id) ON DELETE CASCADE,
  attempt     INTEGER NOT NULL CHECK (attempt >= 1),
  printer_id  UUID REFERENCES printers(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source      VARCHAR(20) NOT NULL DEFAULT 'poll' CHECK (source IN ('poll', 'legacy_backfill')),
  PRIMARY KEY (job_id, attempt)
);

-- Backfill only attempts the current row proves: the last claim, when a printer is recorded.
INSERT INTO print_attempts (job_id, attempt, printer_id, assigned_at, source)
SELECT pq.job_id, pq.lease_count, pq.printer_id,
       COALESCE(pq.assigned_at, pq.updated_at, NOW()), 'legacy_backfill'
  FROM print_queue pq
 WHERE pq.lease_count >= 1
   AND pq.printer_id IS NOT NULL
ON CONFLICT (job_id, attempt) DO NOTHING;

-- 4. Printer-reported CUPS evidence. Append-only; never changes the outcome.
CREATE TABLE IF NOT EXISTS print_physical_evidence (
  id          BIGSERIAL PRIMARY KEY,
  job_id      UUID NOT NULL REFERENCES print_jobs(id) ON DELETE CASCADE,
  attempt     INTEGER NOT NULL CHECK (attempt >= 1),
  printer_id  UUID NOT NULL REFERENCES printers(id),
  cups_job_id VARCHAR(200) NOT NULL,
  cups_state  VARCHAR(50) NOT NULL,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, attempt, printer_id, cups_job_id, cups_state)
);
