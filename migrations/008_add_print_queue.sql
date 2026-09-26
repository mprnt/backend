-- Migration: Add printers and print queue tables
-- Created: 2026-09-25

-- Printers Table (Raspberry Pi devices)
CREATE TABLE IF NOT EXISTS printers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    printer_id VARCHAR(100) UNIQUE NOT NULL,
    kiosk_id UUID NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'offline',
    ip_address VARCHAR(45),
    last_heartbeat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Capabilities
    supports_color BOOLEAN DEFAULT false,
    supports_double_sided BOOLEAN DEFAULT false,
    max_copies INTEGER DEFAULT 100,
    supported_paper_sizes TEXT[] DEFAULT ARRAY['a4'],

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_kiosk FOREIGN KEY (kiosk_id) REFERENCES kiosks(id)
);

-- Print Queue Table
CREATE TABLE IF NOT EXISTS print_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES print_jobs(id) ON DELETE CASCADE,
    printer_id UUID REFERENCES printers(id) ON DELETE SET NULL,
    priority INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'queued',

    -- Timestamps
    queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assigned_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    failed_at TIMESTAMP,

    -- Error handling
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,

    -- Tracking
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_job FOREIGN KEY (job_id) REFERENCES print_jobs(id),
    CONSTRAINT fk_printer FOREIGN KEY (printer_id) REFERENCES printers(id),
    CONSTRAINT unique_job_queue UNIQUE (job_id)
);

-- Printer Heartbeat Log (optional, for monitoring)
CREATE TABLE IF NOT EXISTS printer_heartbeats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    printer_id UUID NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL,
    current_job_id UUID REFERENCES print_jobs(id) ON DELETE SET NULL,
    error_message TEXT,
    paper_level INTEGER,
    ink_level_black INTEGER,
    ink_level_color INTEGER,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_printer_heartbeat FOREIGN KEY (printer_id) REFERENCES printers(id)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_printers_printer_id ON printers(printer_id);
CREATE INDEX IF NOT EXISTS idx_printers_kiosk_id ON printers(kiosk_id);
CREATE INDEX IF NOT EXISTS idx_printers_status ON printers(status);
CREATE INDEX IF NOT EXISTS idx_print_queue_job_id ON print_queue(job_id);
CREATE INDEX IF NOT EXISTS idx_print_queue_printer_id ON print_queue(printer_id);
CREATE INDEX IF NOT EXISTS idx_print_queue_status ON print_queue(status);
CREATE INDEX IF NOT EXISTS idx_print_queue_priority ON print_queue(priority DESC);
CREATE INDEX IF NOT EXISTS idx_printer_heartbeats_printer_id ON printer_heartbeats(printer_id);
CREATE INDEX IF NOT EXISTS idx_printer_heartbeats_received_at ON printer_heartbeats(received_at DESC);

-- Update trigger for updated_at columns
CREATE TRIGGER update_printers_updated_at
    BEFORE UPDATE ON printers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_print_queue_updated_at
    BEFORE UPDATE ON print_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger: Auto-queue jobs when payment is captured
CREATE OR REPLACE FUNCTION auto_queue_paid_jobs()
RETURNS TRIGGER AS $$
BEGIN
    -- When a print job is marked as queued (payment captured)
    IF NEW.status = 'queued' AND OLD.status != 'queued' THEN
        -- Add to print queue if not already there
        INSERT INTO print_queue (job_id, priority, status, queued_at)
        VALUES (NEW.id, 0, 'queued', NOW())
        ON CONFLICT (job_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_auto_queue_jobs
    AFTER UPDATE ON print_jobs
    FOR EACH ROW
    WHEN (NEW.status = 'queued')
    EXECUTE FUNCTION auto_queue_paid_jobs();

-- Comments for documentation
COMMENT ON TABLE printers IS 'Raspberry Pi printer devices registered with kiosks';
COMMENT ON TABLE print_queue IS 'Queue of print jobs waiting to be assigned and printed';
COMMENT ON TABLE printer_heartbeats IS 'Log of printer status updates for monitoring';
COMMENT ON COLUMN printers.printer_id IS 'Unique identifier from Raspberry Pi device';
COMMENT ON COLUMN printers.last_heartbeat IS 'Last time printer sent status update';
COMMENT ON COLUMN print_queue.priority IS 'Higher priority jobs are assigned first';
COMMENT ON COLUMN print_queue.retry_count IS 'Number of times job has been retried after failure';
