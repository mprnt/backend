-- Migration: add the kiosks.name column properly
-- Created: 2026-09-29
--
-- `kiosks.name` is read all over the application — the dashboard's session
-- list, printer health, attention queue and kiosk breakdown all select it — but
-- nothing ever created it in a migration. The only code that added it was the
-- development-only `POST /setup/kiosks` endpoint, so the column existed on
-- developer machines and was silently absent in production. Every query that
-- selected it failed there with SQLSTATE 42703.
--
-- This migration makes the column part of the schema properly, backfilling from
-- kiosk_id so no row is left without a display name.

ALTER TABLE kiosks
    ADD COLUMN IF NOT EXISTS name VARCHAR(255);

-- Existing rows predate the column. The short code is a reasonable default and
-- can be edited afterwards.
UPDATE kiosks SET name = kiosk_id WHERE name IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'kiosks' AND column_name = 'name' AND is_nullable = 'YES'
    ) AND NOT EXISTS (SELECT 1 FROM kiosks WHERE name IS NULL) THEN
        ALTER TABLE kiosks ALTER COLUMN name SET NOT NULL;
    END IF;
END $$;

-- The same endpoint was the only thing that added this one, for the same
-- reason. Nothing reads it yet, but the schema should match migration 009's
-- definition rather than differ by environment.
ALTER TABLE kiosks
    ADD COLUMN IF NOT EXISTS last_maintenance TIMESTAMP;

COMMENT ON COLUMN kiosks.name IS
    'Human-readable kiosk name shown in the admin dashboard. Backfilled from kiosk_id.';
