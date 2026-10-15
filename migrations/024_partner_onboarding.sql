-- Migration: partner onboarding (business identity, GST, drafts, documents)
-- Created: 2026-10-15
--
-- The onboarding wizard saves a server-side draft as the super admin works, so a
-- refresh, a closed tab or a second person can pick it up. A draft becomes a
-- partner in one transaction, or not at all.
--
--   organizations           gains the business identity: legal and trading names,
--                           type, address, GST and PAN. Existing partners keep NULLs.
--   partner_onboarding_drafts  the wizard's saved answers. Expires; never holds a password.
--   partner_documents          GST certificates and agreements. Staged against a draft
--                              first, attached to the partner on completion, then frozen.

-- ---------------------------------------------------------------------------
-- Business identity on the partner
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS legal_name      VARCHAR(255),
    ADD COLUMN IF NOT EXISTS trading_name    VARCHAR(255),
    ADD COLUMN IF NOT EXISTS business_type   VARCHAR(32),
    ADD COLUMN IF NOT EXISTS address_line1   VARCHAR(255),
    ADD COLUMN IF NOT EXISTS address_line2   VARCHAR(255),
    ADD COLUMN IF NOT EXISTS city            VARCHAR(120),
    ADD COLUMN IF NOT EXISTS state           VARCHAR(64),
    ADD COLUMN IF NOT EXISTS pincode         VARCHAR(6),
    ADD COLUMN IF NOT EXISTS contact_name    VARCHAR(120),
    ADD COLUMN IF NOT EXISTS gst_registered  BOOLEAN,
    ADD COLUMN IF NOT EXISTS gst_number      VARCHAR(15),
    ADD COLUMN IF NOT EXISTS pan             VARCHAR(10),
    ADD COLUMN IF NOT EXISTS onboarded_at    TIMESTAMP,
    ADD COLUMN IF NOT EXISTS onboarded_by    UUID REFERENCES admin_users(id);

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS chk_org_business_type;
ALTER TABLE organizations ADD CONSTRAINT chk_org_business_type CHECK (
    business_type IS NULL OR business_type IN
        ('stationery', 'cyber_cafe', 'photocopy', 'college', 'library', 'office', 'other')
);

-- A GSTIN is 15 characters: state code, PAN, entity number, Z, check character.
-- The check character itself is verified in the application, where the message can say why.
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS chk_org_gst_format;
ALTER TABLE organizations ADD CONSTRAINT chk_org_gst_format CHECK (
    gst_number IS NULL OR gst_number ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
);

-- Registered means a GSTIN; not registered means none. NULL = a partner from before this.
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS chk_org_gst_pair;
ALTER TABLE organizations ADD CONSTRAINT chk_org_gst_pair CHECK (
    (gst_registered IS NOT TRUE OR gst_number IS NOT NULL)
    AND (gst_registered IS NOT FALSE OR gst_number IS NULL)
);

-- One live partner per GSTIN. A second registration with the same number is a mistake.
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_gst_live
    ON organizations(gst_number)
    WHERE gst_number IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN organizations.gst_number IS
    'GSTIN, format- and check-character-validated by the application. Unique among live partners.';

-- ---------------------------------------------------------------------------
-- Drafts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_onboarding_drafts (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    status           VARCHAR(16) NOT NULL DEFAULT 'open',
    -- The wizard's answers. Never a password: the temporary password is made on completion.
    payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Optimistic lock: a save names the version it read, and loses if it is stale.
    version          INTEGER NOT NULL DEFAULT 1,
    created_by       UUID REFERENCES admin_users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ NOT NULL,
    organization_id  UUID REFERENCES organizations(id),
    completed_at     TIMESTAMPTZ,
    completed_by     UUID REFERENCES admin_users(id),
    CONSTRAINT chk_draft_status CHECK (status IN ('open', 'completed', 'expired')),
    CONSTRAINT chk_draft_completed CHECK (
        status <> 'completed' OR (organization_id IS NOT NULL AND completed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_onboarding_drafts_open
    ON partner_onboarding_drafts(status, expires_at)
    WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_documents (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Staged against a draft first; organization_id is set when the partner is created.
    draft_id          UUID REFERENCES partner_onboarding_drafts(id),
    organization_id   UUID REFERENCES organizations(id),
    kind              VARCHAR(32) NOT NULL,
    storage_key       TEXT NOT NULL UNIQUE,
    original_filename VARCHAR(255) NOT NULL,
    content_type      VARCHAR(64) NOT NULL,
    size_bytes        INTEGER NOT NULL,
    sha256            CHAR(64) NOT NULL,
    uploaded_by       UUID REFERENCES admin_users(id),
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_doc_kind CHECK (kind IN ('gst_certificate', 'agreement', 'other')),
    CONSTRAINT chk_doc_type CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
    CONSTRAINT chk_doc_size CHECK (size_bytes > 0 AND size_bytes <= 5242880),
    CONSTRAINT chk_doc_owner CHECK (draft_id IS NOT NULL OR organization_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_partner_documents_org ON partner_documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_partner_documents_draft ON partner_documents(draft_id);

-- A staged document can be removed. Once attached to a partner it is kept: a GST
-- certificate on file is evidence, so it cannot be edited or deleted.
CREATE OR REPLACE FUNCTION partner_documents_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.organization_id IS NOT NULL THEN
            RAISE EXCEPTION 'a document held for a partner cannot be deleted'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.organization_id IS NOT NULL THEN
        RAISE EXCEPTION 'a document held for a partner cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Attaching to the partner happens once, when the draft completes.
    IF NEW.organization_id IS NULL THEN
        RAISE EXCEPTION 'a staged document cannot lose its partner link'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.sha256 IS DISTINCT FROM OLD.sha256
        OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
        OR NEW.content_type IS DISTINCT FROM OLD.content_type THEN
        RAISE EXCEPTION 'only the partner link of a staged document can be set'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_partner_documents_guard ON partner_documents;
CREATE TRIGGER trg_partner_documents_guard
    BEFORE UPDATE OR DELETE ON partner_documents
    FOR EACH ROW EXECUTE FUNCTION partner_documents_guard();
