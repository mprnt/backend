-- Migration: record whether a printer sits inside an MPrnt station
-- Created: 2026-10-07
--
-- A "station" is the full MPrnt unit; a partner on Model 1 instead connects a
-- printer they already own. Commercially the two are different, but
-- operationally they are not: a station contains exactly one printer, and that
-- printer is what enrolls, heartbeats, holds a queue and earns revenue.
--
-- So this migration deliberately adds NO station table and NO station id.
-- Every join, every report and every job stays keyed on the printer. These two
-- columns are presentation: they let the dashboard say "Station" instead of
-- "Printer" and show the name the partner knows it by.
--
-- Doing it the other way — a stations table that owns printers — would mean
-- every revenue query had to decide whether to group by station or printer,
-- and would break the moment a partner had both kinds side by side.

ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS is_station BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS station_name VARCHAR(100);

COMMENT ON COLUMN printers.is_station IS
    'True when this printer is housed in an MPrnt station. Display only: all routing, queueing and revenue remain keyed on the printer.';

COMMENT ON COLUMN printers.station_name IS
    'Optional name the partner calls the station, e.g. "Front desk". NULL falls back to the printer name.';

-- A name without the flag would never be shown, which reads as data loss.
ALTER TABLE printers
    DROP CONSTRAINT IF EXISTS printers_station_name_requires_station;
ALTER TABLE printers
    ADD CONSTRAINT printers_station_name_requires_station
    CHECK (station_name IS NULL OR is_station);
