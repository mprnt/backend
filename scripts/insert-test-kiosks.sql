-- MPrnt Backend - Test Data for Postman Testing
-- Run this script to populate your database with test data

-- =====================================================
-- 1. INSERT TEST KIOSKS
-- =====================================================

-- Main test kiosk (M001)
INSERT INTO kiosks (kiosk_id, location, status, capabilities, printer_status, ip_address)
VALUES (
  'M001',
  'Main Building - Floor 1',
  'active',
  '{"color": true, "duplex": true, "paper_sizes": ["a4", "letter", "legal"]}'::jsonb,
  'idle',
  '192.168.1.100'
)
ON CONFLICT (kiosk_id) DO UPDATE SET
  location = EXCLUDED.location,
  status = EXCLUDED.status,
  capabilities = EXCLUDED.capabilities,
  printer_status = EXCLUDED.printer_status,
  ip_address = EXCLUDED.ip_address,
  updated_at = CURRENT_TIMESTAMP;

-- Secondary test kiosk (M002) - in maintenance
INSERT INTO kiosks (kiosk_id, location, status, capabilities, printer_status, ip_address)
VALUES (
  'M002',
  'Library - Floor 2',
  'maintenance',
  '{"color": false, "duplex": true, "paper_sizes": ["a4"]}'::jsonb,
  'offline',
  '192.168.1.101'
)
ON CONFLICT (kiosk_id) DO UPDATE SET
  location = EXCLUDED.location,
  status = EXCLUDED.status,
  capabilities = EXCLUDED.capabilities,
  printer_status = EXCLUDED.printer_status,
  ip_address = EXCLUDED.ip_address,
  updated_at = CURRENT_TIMESTAMP;

-- Third test kiosk (M003) - offline
INSERT INTO kiosks (kiosk_id, location, status, capabilities, printer_status, ip_address)
VALUES (
  'M003',
  'Cafeteria - Ground Floor',
  'offline',
  '{"color": true, "duplex": false, "paper_sizes": ["a4", "letter"]}'::jsonb,
  'offline',
  '192.168.1.102'
)
ON CONFLICT (kiosk_id) DO UPDATE SET
  location = EXCLUDED.location,
  status = EXCLUDED.status,
  capabilities = EXCLUDED.capabilities,
  printer_status = EXCLUDED.printer_status,
  ip_address = EXCLUDED.ip_address,
  updated_at = CURRENT_TIMESTAMP;

-- Numeric kiosk ID for testing (101)
INSERT INTO kiosks (kiosk_id, location, status, capabilities, printer_status, ip_address)
VALUES (
  '101',
  'Test Location - Numeric ID',
  'active',
  '{"color": true, "duplex": true, "paper_sizes": ["a4"]}'::jsonb,
  'idle',
  '192.168.1.201'
)
ON CONFLICT (kiosk_id) DO UPDATE SET
  location = EXCLUDED.location,
  status = EXCLUDED.status,
  capabilities = EXCLUDED.capabilities,
  printer_status = EXCLUDED.printer_status,
  ip_address = EXCLUDED.ip_address,
  updated_at = CURRENT_TIMESTAMP;

-- =====================================================
-- 2. VERIFY KIOSKS WERE INSERTED
-- =====================================================

SELECT
  kiosk_id,
  location,
  status,
  capabilities,
  printer_status,
  created_at
FROM kiosks
ORDER BY kiosk_id;

-- =====================================================
-- NOTES:
-- =====================================================
-- After running this script, you can test with:
-- - "M001" (active, color printer)
-- - "M002" (maintenance - should return 400 error)
-- - "M003" (offline - should return 400 error)
-- - "101" (active, numeric ID)
-- - "INVALID" (doesn't exist - should return 404 error)
