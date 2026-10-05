-- Migration: refunds for paid-but-unprinted jobs
-- Created: 2026-10-05
--
-- One refund per job (full amount). The UNIQUE constraint is what makes
-- POST /admin/print-jobs/:jobId/refund idempotent at the database level.
-- No cascade: refunds are financial records and must outlive the job's file.

CREATE TABLE IF NOT EXISTS payment_refunds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL UNIQUE REFERENCES print_jobs(id),
    order_id VARCHAR(100) NOT NULL,
    payment_id VARCHAR(100) NOT NULL,
    refund_id VARCHAR(100) NOT NULL UNIQUE,
    amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    status VARCHAR(20) NOT NULL,
    reason TEXT NOT NULL,
    requested_by UUID,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_created_at ON payment_refunds(created_at DESC);
