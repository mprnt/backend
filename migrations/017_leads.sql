-- Migration: contact-form leads from MPrint Web
-- Created: 2026-10-05
--
-- POST /api/v1/public/leads stores here; GET /api/v1/admin/leads reads it.

CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    email VARCHAR(254) NOT NULL,
    phone VARCHAR(20),
    company VARCHAR(150),
    message TEXT NOT NULL,
    source VARCHAR(50) NOT NULL DEFAULT 'web',
    client_ip INET,
    user_agent TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
