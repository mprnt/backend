-- Migration: shop payout details and who last set the shop's contact details
-- Additive and idempotent: safe to run against a live database, and safe to run again.
--
-- Model 1 shops are paid into their own bank account or UPI ID, so the platform needs
-- both on file. A shop may be onboarded without them and add them later, either from
-- the platform side or from its own dashboard. The *_by_scope columns record who did
-- it, so the platform can see at a glance whether a detail came from MPRNT or from the
-- shop itself.
--
-- The full account number is stored encrypted (see src/utils/payoutCrypto.ts). Only its
-- last four digits are kept in clear, for display.

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS bank_account_holder     VARCHAR(255),
    ADD COLUMN IF NOT EXISTS bank_name               VARCHAR(255),
    ADD COLUMN IF NOT EXISTS bank_ifsc               VARCHAR(11),
    ADD COLUMN IF NOT EXISTS bank_account_last4      VARCHAR(4),
    ADD COLUMN IF NOT EXISTS bank_account_number_enc TEXT,
    ADD COLUMN IF NOT EXISTS upi_id                  VARCHAR(255),
    ADD COLUMN IF NOT EXISTS payout_updated_at       TIMESTAMP,
    ADD COLUMN IF NOT EXISTS payout_updated_by_scope VARCHAR(10),
    ADD COLUMN IF NOT EXISTS contact_updated_at      TIMESTAMP,
    ADD COLUMN IF NOT EXISTS contact_updated_by_scope VARCHAR(10);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payout_scope') THEN
        ALTER TABLE organizations
            ADD CONSTRAINT chk_payout_scope
            CHECK (payout_updated_by_scope IS NULL OR payout_updated_by_scope IN ('platform', 'shop'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_contact_scope') THEN
        ALTER TABLE organizations
            ADD CONSTRAINT chk_contact_scope
            CHECK (contact_updated_by_scope IS NULL OR contact_updated_by_scope IN ('platform', 'shop'));
    END IF;
END
$$;
