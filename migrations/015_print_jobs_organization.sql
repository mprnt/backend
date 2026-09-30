-- Migration: attribute each print job to the shop that served it
-- Created: 2026-09-30
--
-- Reports used to find a job's shop through its kiosk's *current* owner:
--
--     print_jobs -> kiosks.organization_id
--
-- So moving a kiosk from one shop to another silently transferred all of its
-- historical revenue to the new shop and removed it from the old one's books.
-- Revenue has to stay with the shop that actually earned it.
--
-- A job now records its organization at the moment it is created. A trigger
-- sets it, so every insert path is covered without any of them having to
-- remember; it fires on INSERT only, so later updates can never re-attribute.

ALTER TABLE print_jobs
    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

COMMENT ON COLUMN print_jobs.organization_id IS
    'The shop that served this job, fixed at creation. Reports attribute revenue by this, never by the kiosk''s current owner.';

-- Backfill from each kiosk's present owner. That is the best information
-- available for history, and matches what every report showed until now.
UPDATE print_jobs pj
   SET organization_id = k.organization_id
  FROM kiosks k
 WHERE pj.kiosk_id = k.id
   AND pj.organization_id IS NULL;

CREATE OR REPLACE FUNCTION set_print_job_organization() RETURNS trigger AS $$
BEGIN
    IF NEW.organization_id IS NULL AND NEW.kiosk_id IS NOT NULL THEN
        SELECT organization_id INTO NEW.organization_id FROM kiosks WHERE id = NEW.kiosk_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_print_jobs_organization ON print_jobs;
CREATE TRIGGER trg_print_jobs_organization
    BEFORE INSERT ON print_jobs
    FOR EACH ROW EXECUTE FUNCTION set_print_job_organization();

CREATE INDEX IF NOT EXISTS idx_print_jobs_org_created
    ON print_jobs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_jobs_org_paid_created
    ON print_jobs(organization_id, created_at DESC)
    WHERE payment_status = 'paid';
