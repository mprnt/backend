-- Migration: Update documents table schema
-- Run this to fix the column name mismatch

\c mprnt;

-- Rename columns to match the application code
ALTER TABLE documents
  RENAME COLUMN mime_type TO file_type;

ALTER TABLE documents
  RENAME COLUMN file_size TO file_size_bytes;

ALTER TABLE documents
  RENAME COLUMN storage_path TO s3_key;

-- Make page_count nullable (it's null for PDFs until processed)
ALTER TABLE documents
  ALTER COLUMN page_count DROP NOT NULL;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Documents table migrated successfully!';
END $$;
