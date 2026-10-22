-- ============================================================================
-- AIRA AI 2026 — Permanent Staging Role Separation & Least-Privilege DDL
-- Target: Neon Project mute-frost-50372225 (Branch: br-autumn-star-b36dfu5w)
-- Requires: Execution by neondb_owner with Owner Authorization
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aira_staging_runtime') THEN
    -- Password should be injected via environment variable or Neon console
    CREATE ROLE aira_staging_runtime WITH LOGIN;
  END IF;
END
$$;

-- 1. Grant connection and usage on public schema
GRANT CONNECT ON DATABASE current_database() TO aira_staging_runtime;
GRANT USAGE ON SCHEMA public TO aira_staging_runtime;

-- 2. Grant standard application DML on existing public tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aira_staging_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aira_staging_runtime;

-- 3. Configure default privileges for future tables created by migrations
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aira_staging_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO aira_staging_runtime;

-- 4. Strip DDL / schema modification permissions
REVOKE CREATE ON SCHEMA public FROM aira_staging_runtime;

-- 5. Strict Maintenance Sentinel Protection
-- aira_staging_runtime can check if maintenance is active, but CANNOT alter or clear it
GRANT SELECT ON TABLE _aira_staging_maintenance TO aira_staging_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE _aira_staging_maintenance FROM aira_staging_runtime;

-- ============================================================================
-- Verification:
-- SELECT has_table_privilege('aira_staging_runtime', 'conversations', 'INSERT'); -- true
-- SELECT has_table_privilege('aira_staging_runtime', '_aira_staging_maintenance', 'UPDATE'); -- false
-- ============================================================================
