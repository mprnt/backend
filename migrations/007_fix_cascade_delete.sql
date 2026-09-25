-- Migration: Fix foreign key constraints for cascade deletion
-- Created: 2026-09-25

-- Drop existing foreign key constraint on print_jobs
ALTER TABLE print_jobs
DROP CONSTRAINT IF EXISTS print_jobs_document_id_fkey;

-- Re-add with CASCADE delete
-- When a document is deleted, also delete associated print jobs
ALTER TABLE print_jobs
ADD CONSTRAINT print_jobs_document_id_fkey
FOREIGN KEY (document_id)
REFERENCES documents(id)
ON DELETE CASCADE;

-- Similarly, ensure session deletion cascades properly
ALTER TABLE documents
DROP CONSTRAINT IF EXISTS documents_session_id_fkey;

ALTER TABLE documents
ADD CONSTRAINT documents_session_id_fkey
FOREIGN KEY (session_id)
REFERENCES print_sessions(id)
ON DELETE CASCADE;

-- Ensure payment orders cascade when print job is deleted
ALTER TABLE payment_orders
DROP CONSTRAINT IF EXISTS payment_orders_job_id_fkey;

ALTER TABLE payment_orders
ADD CONSTRAINT payment_orders_job_id_fkey
FOREIGN KEY (job_id)
REFERENCES print_jobs(id)
ON DELETE CASCADE;

-- Comments for documentation
COMMENT ON CONSTRAINT print_jobs_document_id_fkey ON print_jobs IS
'CASCADE: When document is deleted, delete associated print jobs';

COMMENT ON CONSTRAINT documents_session_id_fkey ON documents IS
'CASCADE: When session is deleted, delete associated documents';

COMMENT ON CONSTRAINT payment_orders_job_id_fkey ON payment_orders IS
'CASCADE: When print job is deleted, delete associated payment orders';
