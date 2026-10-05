-- Migration: per-session secret for customer routes
-- Created: 2026-10-05
--
-- Customer routes used the session/job/document ID as their only credential,
-- and GET /sessions listed every ID. A session now gets a random secret at
-- creation; the client sends it as X-Session-Token on every customer route.
-- Only its SHA-256 is stored, so a database read does not hand out tokens.
--
-- Sessions created before this migration have no hash and are refused; they
-- expire within minutes anyway.

ALTER TABLE print_sessions
    ADD COLUMN IF NOT EXISTS access_token_hash VARCHAR(64);

COMMENT ON COLUMN print_sessions.access_token_hash IS
    'SHA-256 (hex) of the secret returned once by POST /sessions; required as X-Session-Token.';
