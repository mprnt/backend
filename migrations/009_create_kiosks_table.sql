-- Migration: Create kiosks table
-- Created: 2026-09-25

-- Kiosks Table
CREATE TABLE IF NOT EXISTS kiosks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kiosk_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',

    -- Capabilities
    capabilities JSONB DEFAULT '{}',

    -- Printer status
    printer_status VARCHAR(20) DEFAULT 'idle',

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_maintenance TIMESTAMP,

    CONSTRAINT chk_kiosk_status CHECK (status IN ('active', 'inactive', 'maintenance', 'offline'))
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_kiosks_kiosk_id ON kiosks(kiosk_id);
CREATE INDEX IF NOT EXISTS idx_kiosks_status ON kiosks(status);
CREATE INDEX IF NOT EXISTS idx_kiosks_location ON kiosks(location);

-- Update trigger
CREATE TRIGGER update_kiosks_updated_at
    BEFORE UPDATE ON kiosks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Insert default kiosks for development
INSERT INTO kiosks (kiosk_id, name, location, status, capabilities) VALUES
    ('KIOSK001', 'Main Library Kiosk', 'Library - Ground Floor', 'active', '{"supportsColor": true, "supportsDoubleSided": true, "paperSizes": ["a4", "letter"]}'),
    ('M001', 'Engineering Block Kiosk', 'Engineering Building - 1st Floor', 'active', '{"supportsColor": false, "supportsDoubleSided": true, "paperSizes": ["a4"]}'),
    ('M002', 'Student Center Kiosk', 'Student Center - Lobby', 'active', '{"supportsColor": true, "supportsDoubleSided": false, "paperSizes": ["a4", "letter"]}')
ON CONFLICT (kiosk_id) DO NOTHING;

-- Comments
COMMENT ON TABLE kiosks IS 'Physical kiosk locations with printers';
COMMENT ON COLUMN kiosks.kiosk_id IS 'Human-readable kiosk identifier (e.g., M001, KIOSK001)';
COMMENT ON COLUMN kiosks.capabilities IS 'JSON object describing kiosk capabilities';
COMMENT ON COLUMN kiosks.printer_status IS 'Current printer status (idle, busy, error, maintenance)';
