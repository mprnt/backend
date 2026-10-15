-- Migration: Model 1 billing: hardware sale and monthly software subscription
-- Created: 2026-10-15
--
-- Three tables, and the database itself enforces the rules that matter money:
--
--   billing_plan_terms  What MPrnt charges, set by the platform. Append-only.
--                       Changing list prices never touches an existing contract.
--
--   partner_contracts   One per partner on Model 1. The prices and periods are
--                       copied from the plan at the moment of sale and then
--                       frozen by trigger. The only field that ever changes is
--                       the go-live date, and only once.
--
--   billing_charges     One row per amount owed: the hardware (period 0) and each
--                       billable software month (period 1..n). The amount and the
--                       period are frozen. Status moves only due -> paid or
--                       due -> waived, and never back.
--
-- Overdue is never stored. It is worked out from due date, grace and today, so
-- it cannot go stale.
--
-- All timestamps are timestamptz. Calendar dates (go-live, periods, due dates)
-- are DATE, and are India calendar dates by definition (see billingSchedule.ts).

-- ---------------------------------------------------------------------------
-- Plan terms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_plan_terms (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Only Model 1 for now. The column exists so later models add a value, not a table.
    business_model  VARCHAR(32) NOT NULL,
    hardware_price  NUMERIC(10,2) NOT NULL,
    monthly_price   NUMERIC(10,2) NOT NULL,
    free_months     INTEGER NOT NULL,
    grace_days      INTEGER NOT NULL,
    -- Every price MPrnt quotes is GST-inclusive. Stored, and fixed true, so the
    -- flag can never say something the price does not do.
    gst_inclusive   BOOLEAN NOT NULL DEFAULT TRUE,
    effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note            TEXT NOT NULL,
    created_by      UUID REFERENCES admin_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_plan_model CHECK (business_model = 'integration'),
    CONSTRAINT chk_plan_hardware CHECK (hardware_price > 0 AND hardware_price <= 1000000),
    CONSTRAINT chk_plan_monthly CHECK (monthly_price >= 0 AND monthly_price <= 100000),
    CONSTRAINT chk_plan_free CHECK (free_months BETWEEN 0 AND 12),
    CONSTRAINT chk_plan_grace CHECK (grace_days BETWEEN 0 AND 60),
    CONSTRAINT chk_plan_gst CHECK (gst_inclusive = TRUE),
    CONSTRAINT chk_plan_note CHECK (char_length(btrim(note)) >= 3)
);

CREATE INDEX IF NOT EXISTS idx_billing_plan_terms_effective
    ON billing_plan_terms(business_model, effective_from DESC);

-- ---------------------------------------------------------------------------
-- Contracts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_contracts (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- One contract per partner. A second sale to the same partner is a new
    -- decision, not a silent duplicate.
    organization_id       UUID NOT NULL UNIQUE REFERENCES organizations(id),
    plan_term_id          UUID NOT NULL REFERENCES billing_plan_terms(id),
    -- Snapshots, frozen once written.
    business_model        VARCHAR(32) NOT NULL,
    hardware_price        NUMERIC(10,2) NOT NULL,
    monthly_price         NUMERIC(10,2) NOT NULL,
    free_months           INTEGER NOT NULL,
    grace_days            INTEGER NOT NULL,
    sold_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sold_by               UUID REFERENCES admin_users(id),
    sale_note             TEXT NOT NULL,
    -- The clock starts here. NULL until the partner is live; set once.
    go_live_on            DATE,
    go_live_recorded_at   TIMESTAMPTZ,
    go_live_recorded_by   UUID REFERENCES admin_users(id),
    go_live_note          TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_contract_model CHECK (business_model = 'integration'),
    CONSTRAINT chk_contract_hardware CHECK (hardware_price > 0),
    CONSTRAINT chk_contract_monthly CHECK (monthly_price >= 0),
    CONSTRAINT chk_contract_free CHECK (free_months BETWEEN 0 AND 12),
    CONSTRAINT chk_contract_grace CHECK (grace_days BETWEEN 0 AND 60),
    CONSTRAINT chk_contract_sale_note CHECK (char_length(btrim(sale_note)) >= 3),
    CONSTRAINT chk_contract_live_note CHECK (go_live_on IS NULL OR char_length(btrim(go_live_note)) >= 3),
    CONSTRAINT chk_contract_live_pair CHECK (
        (go_live_on IS NULL AND go_live_recorded_at IS NULL AND go_live_recorded_by IS NULL)
        OR (go_live_on IS NOT NULL AND go_live_recorded_at IS NOT NULL AND go_live_recorded_by IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- Charges
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_charges (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contract_id        UUID NOT NULL REFERENCES partner_contracts(id),
    kind               VARCHAR(16) NOT NULL,
    -- 0 = the hardware; 1..n = subscription month n. Unique per contract, which
    -- is what makes the monthly job safe to run twice.
    period_index       INTEGER NOT NULL,
    period_start       DATE NOT NULL,
    period_end         DATE NOT NULL,
    amount             NUMERIC(10,2) NOT NULL,
    due_on             DATE NOT NULL,
    status             VARCHAR(16) NOT NULL DEFAULT 'due',
    settled_at         TIMESTAMPTZ,
    settled_by         UUID REFERENCES admin_users(id),
    payment_method     VARCHAR(16),
    payment_reference  VARCHAR(120),
    settle_note        TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_billing_charge_period UNIQUE (contract_id, kind, period_index),
    CONSTRAINT chk_charge_kind CHECK (kind IN ('hardware', 'software')),
    CONSTRAINT chk_charge_index CHECK (
        (kind = 'hardware' AND period_index = 0) OR (kind = 'software' AND period_index >= 1)
    ),
    CONSTRAINT chk_charge_amount CHECK (amount > 0),
    CONSTRAINT chk_charge_period CHECK (period_end >= period_start),
    CONSTRAINT chk_charge_status CHECK (status IN ('due', 'paid', 'waived')),
    CONSTRAINT chk_charge_method CHECK (
        payment_method IS NULL
        OR payment_method IN ('bank_transfer', 'upi', 'cash', 'cheque', 'other')
    ),
    -- A payment is only recorded with who took it, when, and how.
    CONSTRAINT chk_charge_paid CHECK (
        status <> 'paid'
        OR (settled_at IS NOT NULL AND settled_by IS NOT NULL AND payment_method IS NOT NULL)
    ),
    -- Bank and UPI payments must carry the reference that proves them.
    CONSTRAINT chk_charge_reference CHECK (
        status <> 'paid'
        OR payment_method NOT IN ('bank_transfer', 'upi', 'cheque')
        OR char_length(btrim(COALESCE(payment_reference, ''))) >= 3
    ),
    -- A waiver is only recorded with who waived it and why.
    CONSTRAINT chk_charge_waived CHECK (
        status <> 'waived'
        OR (settled_at IS NOT NULL AND settled_by IS NOT NULL
            AND char_length(btrim(COALESCE(settle_note, ''))) >= 3)
    ),
    CONSTRAINT chk_charge_unsettled CHECK (
        status <> 'due'
        OR (settled_at IS NULL AND settled_by IS NULL AND payment_method IS NULL
            AND payment_reference IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_billing_charges_contract
    ON billing_charges(contract_id, kind, period_index);
CREATE INDEX IF NOT EXISTS idx_billing_charges_owed
    ON billing_charges(status, due_on)
    WHERE status = 'due';

-- ---------------------------------------------------------------------------
-- Enforcement. The API checks these too; the database checks them regardless
-- of which code path, script or console session wrote the row.
-- ---------------------------------------------------------------------------

-- Plan terms: never edited, never deleted.
CREATE OR REPLACE FUNCTION billing_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_billing_plan_terms_immutable ON billing_plan_terms;
CREATE TRIGGER trg_billing_plan_terms_immutable
    BEFORE UPDATE OR DELETE ON billing_plan_terms
    FOR EACH ROW EXECUTE FUNCTION billing_append_only();

-- Contracts: snapshots frozen; go-live settable once; never deleted.
CREATE OR REPLACE FUNCTION partner_contracts_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'partner_contracts cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.plan_term_id IS DISTINCT FROM OLD.plan_term_id
        OR NEW.business_model IS DISTINCT FROM OLD.business_model
        OR NEW.hardware_price IS DISTINCT FROM OLD.hardware_price
        OR NEW.monthly_price IS DISTINCT FROM OLD.monthly_price
        OR NEW.free_months IS DISTINCT FROM OLD.free_months
        OR NEW.grace_days IS DISTINCT FROM OLD.grace_days
        OR NEW.sold_at IS DISTINCT FROM OLD.sold_at
        OR NEW.sold_by IS DISTINCT FROM OLD.sold_by
        OR NEW.sale_note IS DISTINCT FROM OLD.sale_note
    THEN
        RAISE EXCEPTION 'the terms of a sale are fixed once it is recorded'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.go_live_on IS NOT NULL AND NEW.go_live_on IS DISTINCT FROM OLD.go_live_on THEN
        RAISE EXCEPTION 'the go-live date is set once and cannot change'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_partner_contracts_guard ON partner_contracts;
CREATE TRIGGER trg_partner_contracts_guard
    BEFORE UPDATE OR DELETE ON partner_contracts
    FOR EACH ROW EXECUTE FUNCTION partner_contracts_guard();

-- Charges: amounts and periods frozen; status moves once, from due; never deleted.
CREATE OR REPLACE FUNCTION billing_charges_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'billing_charges cannot be deleted; waive the charge instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.contract_id IS DISTINCT FROM OLD.contract_id
        OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW.period_index IS DISTINCT FROM OLD.period_index
        OR NEW.period_start IS DISTINCT FROM OLD.period_start
        OR NEW.period_end IS DISTINCT FROM OLD.period_end
        OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.due_on IS DISTINCT FROM OLD.due_on
    THEN
        RAISE EXCEPTION 'a charge''s amount and period are fixed once it is raised'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.status <> 'due' AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'a charge that is % cannot change status', OLD.status
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.status <> 'due' AND (
        NEW.settled_at IS DISTINCT FROM OLD.settled_at
        OR NEW.settled_by IS DISTINCT FROM OLD.settled_by
        OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
        OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
        OR NEW.settle_note IS DISTINCT FROM OLD.settle_note
    ) THEN
        RAISE EXCEPTION 'the record of a settled charge cannot be altered'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_billing_charges_guard ON billing_charges;
CREATE TRIGGER trg_billing_charges_guard
    BEFORE UPDATE OR DELETE ON billing_charges
    FOR EACH ROW EXECUTE FUNCTION billing_charges_guard();
