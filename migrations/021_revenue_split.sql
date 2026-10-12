-- Migration: revenue share for Model 2 · Option A (partner gets a set %, MPrnt the rest)
-- Created: 2026-10-12
--
-- Two things are recorded here, and they answer different questions:
--
--   revenue_split_terms   What was agreed, and from when. Append-only: a change
--                         is a new row, never an edit, so the history of terms
--                         is itself an audit trail.
--
--   print_jobs.*_amount   What a specific paid sale earned, fixed at the moment
--                         the payment was captured. A later change to the terms
--                         cannot move money that has already been split.
--
-- Scope mirrors price_lists: an organisation-wide default, optionally overridden
-- for one QR point (kiosk). The most specific term in force wins.
--
-- Only partners on Model 2 · Option A (organizations.business_model =
-- 'revenue-share') are split. The check is made both when a term is written and
-- when a sale is captured, so moving a partner to another model stops new splits
-- without rewriting the old terms.

CREATE TABLE IF NOT EXISTS revenue_split_terms (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id   UUID NOT NULL REFERENCES organizations(id),
    -- NULL = the partner-wide default. Set = an override for that QR point only.
    kiosk_id          UUID REFERENCES kiosks(id),
    -- The partner's share, in percent. MPrnt's share is always 100 minus this.
    partner_share_pct NUMERIC(5,2) NOT NULL,
    effective_from    TIMESTAMP NOT NULL DEFAULT NOW(),
    -- Why the term was set. Required by the API: a commercial term needs a reason.
    note              TEXT NOT NULL,
    created_by        UUID REFERENCES admin_users(id),
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_split_pct CHECK (partner_share_pct >= 0 AND partner_share_pct <= 100),
    CONSTRAINT chk_split_note CHECK (char_length(btrim(note)) >= 3)
);

COMMENT ON TABLE revenue_split_terms IS
    'Agreed revenue share for Model 2 Option A. Append-only: rows are never updated or deleted.';
COMMENT ON COLUMN revenue_split_terms.kiosk_id IS
    'NULL = partner-wide default. Set = override for this QR point. The API checks the kiosk belongs to the organisation.';

-- Resolution reads "the newest term in force for this partner or QR point".
CREATE INDEX IF NOT EXISTS idx_revenue_split_terms_scope
    ON revenue_split_terms(organization_id, kiosk_id, effective_from DESC);

-- Append-only, enforced rather than promised. An edited commercial term would
-- silently rewrite the history that a partner was shown.
CREATE OR REPLACE FUNCTION revenue_split_terms_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'revenue_split_terms is append-only; insert a new term instead'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_revenue_split_terms_immutable ON revenue_split_terms;
CREATE TRIGGER trg_revenue_split_terms_immutable
    BEFORE UPDATE OR DELETE ON revenue_split_terms
    FOR EACH ROW EXECUTE FUNCTION revenue_split_terms_immutable();

-- The per-sale snapshot. All four are NULL for a sale that was not split: an
-- unpaid job, a partner not on Option A, or a sale made before this migration.
-- Those earlier sales are NOT backfilled, because no split was recorded for
-- them and guessing one would put a commercial term nobody agreed to into the
-- books.
ALTER TABLE print_jobs
    ADD COLUMN IF NOT EXISTS split_term_id      UUID REFERENCES revenue_split_terms(id),
    ADD COLUMN IF NOT EXISTS partner_share_pct  NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS partner_amount     NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS platform_amount    NUMERIC(10,2);

COMMENT ON COLUMN print_jobs.partner_share_pct IS
    'Partner share (%) in force when the payment was captured. NULL = not split.';
COMMENT ON COLUMN print_jobs.partner_amount IS
    'Partner share of total_amount, rounded to paise at capture. NULL = not split.';
COMMENT ON COLUMN print_jobs.platform_amount IS
    'MPrnt share: total_amount minus partner_amount, so the two always sum to the total.';

-- A snapshot is all four columns or none, and the two shares add up to the total.
ALTER TABLE print_jobs
    DROP CONSTRAINT IF EXISTS chk_print_jobs_split_complete;
ALTER TABLE print_jobs
    ADD CONSTRAINT chk_print_jobs_split_complete CHECK (
        (split_term_id IS NULL AND partner_share_pct IS NULL
            AND partner_amount IS NULL AND platform_amount IS NULL)
        OR
        (split_term_id IS NOT NULL AND partner_share_pct IS NOT NULL
            AND partner_amount IS NOT NULL AND platform_amount IS NOT NULL
            AND partner_amount + platform_amount = total_amount)
    );
