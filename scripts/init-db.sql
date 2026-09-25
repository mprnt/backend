-- Initialize MPrnt Database Schema
-- This script runs automatically when the PostgreSQL container starts

\c mprnt;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create tables based on architecture document

-- Kiosks Table
CREATE TABLE IF NOT EXISTS kiosks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kiosk_id VARCHAR(10) UNIQUE NOT NULL,
    location VARCHAR(255) NOT NULL,
    raspberry_pi_id VARCHAR(50) UNIQUE,
    status VARCHAR(20) DEFAULT 'active',
    printer_status JSONB,
    ip_address INET,
    last_heartbeat TIMESTAMP,
    capabilities JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Print Sessions Table
CREATE TABLE IF NOT EXISTS print_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id VARCHAR(20) UNIQUE NOT NULL,
    kiosk_id UUID REFERENCES kiosks(id),
    status VARCHAR(20) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '15 minutes'),
    completed_at TIMESTAMP,
    client_ip INET,
    user_agent TEXT,
    CONSTRAINT session_timeout CHECK (expires_at > created_at)
);

-- Documents Table
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID REFERENCES print_sessions(id) ON DELETE CASCADE,
    original_filename VARCHAR(255) NOT NULL,
    file_type VARCHAR(100) NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    s3_key TEXT NOT NULL,
    page_count INTEGER,
    processed BOOLEAN DEFAULT false,
    processed_path TEXT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);

-- Print Jobs Table
CREATE TABLE IF NOT EXISTS print_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID REFERENCES print_sessions(id),
    document_id UUID REFERENCES documents(id),
    kiosk_id UUID REFERENCES kiosks(id),
    color_mode VARCHAR(10) NOT NULL,
    page_range VARCHAR(50) DEFAULT 'all',
    custom_range TEXT,
    copies INTEGER DEFAULT 1 CHECK (copies > 0 AND copies <= 100),
    orientation VARCHAR(10) DEFAULT 'portrait',
    paper_size VARCHAR(10) DEFAULT 'a4',
    print_sides VARCHAR(10) DEFAULT 'single',
    base_price_per_page DECIMAL(10,2) NOT NULL,
    total_pages INTEGER NOT NULL,
    total_amount DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    queued_at TIMESTAMP,
    started_printing_at TIMESTAMP,
    completed_at TIMESTAMP,
    printed_pages INTEGER DEFAULT 0,
    print_duration_seconds INTEGER,
    payment_status VARCHAR(20) DEFAULT 'unpaid',
    paid_at TIMESTAMP
);

-- Payments Table
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    print_job_id UUID REFERENCES print_jobs(id),
    session_id UUID REFERENCES print_sessions(id),
    amount DECIMAL(10,2) NOT NULL,
    payment_method VARCHAR(20) NOT NULL,
    transaction_id VARCHAR(100) UNIQUE NOT NULL,
    gateway_response JSONB,
    payment_gateway VARCHAR(50),
    status VARCHAR(20) DEFAULT 'pending',
    initiated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    reconciled BOOLEAN DEFAULT false,
    reconciled_at TIMESTAMP
);

-- Payment Orders Table
CREATE TABLE IF NOT EXISTS payment_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES print_jobs(id) ON DELETE CASCADE,
    order_id VARCHAR(100) UNIQUE NOT NULL,
    amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) DEFAULT 'INR',
    status VARCHAR(20) DEFAULT 'created',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payment Transactions Table
CREATE TABLE IF NOT EXISTS payment_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id VARCHAR(100) NOT NULL REFERENCES payment_orders(order_id) ON DELETE CASCADE,
    payment_id VARCHAR(100) UNIQUE NOT NULL,
    amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) DEFAULT 'INR',
    method VARCHAR(20),
    status VARCHAR(20) DEFAULT 'pending',
    error_code VARCHAR(50),
    error_description TEXT,
    signature VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Analytics Events Table
CREATE TABLE IF NOT EXISTS analytics_events (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    kiosk_id UUID REFERENCES kiosks(id),
    session_id UUID REFERENCES print_sessions(id),
    event_data JSONB,
    occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Daily Stats Table
CREATE TABLE IF NOT EXISTS daily_stats (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    kiosk_id UUID REFERENCES kiosks(id),
    total_sessions INTEGER DEFAULT 0,
    completed_sessions INTEGER DEFAULT 0,
    total_prints INTEGER DEFAULT 0,
    total_pages INTEGER DEFAULT 0,
    total_revenue DECIMAL(10,2) DEFAULT 0,
    bw_pages INTEGER DEFAULT 0,
    color_pages INTEGER DEFAULT 0,
    avg_session_duration_seconds INTEGER,
    failed_prints INTEGER DEFAULT 0,
    last_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, kiosk_id)
);

-- Admin Users Table
CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(255),
    role VARCHAR(20) DEFAULT 'viewer',
    last_login_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP
);

-- Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    admin_user_id UUID REFERENCES admin_users(id),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id UUID,
    ip_address INET,
    user_agent TEXT,
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_print_jobs_session ON print_jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_kiosk_status ON print_jobs(kiosk_id, status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_created ON print_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status) WHERE status IN ('pending', 'queued', 'printing');

CREATE INDEX IF NOT EXISTS idx_payments_transaction ON payments(transaction_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at);

CREATE INDEX IF NOT EXISTS idx_sessions_kiosk ON print_sessions(kiosk_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON print_sessions(status);

CREATE INDEX IF NOT EXISTS idx_analytics_kiosk_time ON analytics_events(kiosk_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_event_type ON analytics_events(event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_time_series ON analytics_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date DESC);

-- Insert sample kiosk for development
INSERT INTO kiosks (kiosk_id, location, status, capabilities)
VALUES (
    'M001',
    'Development Test Location',
    'active',
    '{"color": true, "duplex": true, "paper_sizes": ["a4", "letter"]}'::jsonb
) ON CONFLICT (kiosk_id) DO NOTHING;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Database schema initialized successfully!';
END $$;
