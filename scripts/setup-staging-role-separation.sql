-- ============================================================================
-- AIRA AI 2026 — Permanent Staging Role Separation & Least-Privilege DDL
-- Target: Neon Project mute-frost-50372225 (Branch: br-autumn-star-b36dfu5w)
-- Requires: Execution by neondb_owner with Owner Authorization
-- ============================================================================

-- 1. Create runtime role if not present (password provisioned out-of-band via env/console)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aira_staging_runtime') THEN
    CREATE ROLE aira_staging_runtime WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- 2. Grant connect dynamically on current target database (valid PostgreSQL syntax)
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO aira_staging_runtime', current_database());
END
$$;

-- 3. Grant schema usage and DML on existing public application tables
GRANT USAGE ON SCHEMA public TO aira_staging_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aira_staging_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aira_staging_runtime;

-- 4. Configure default privileges for future tables and sequences created by migrations
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aira_staging_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO aira_staging_runtime;

-- 5. Strip DDL / schema creation privileges from runtime role
REVOKE CREATE ON SCHEMA public FROM aira_staging_runtime;

-- 6. Strict Maintenance Sentinel Protection (compatible if table does not yet exist)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = '_aira_staging_maintenance') THEN
    EXECUTE 'GRANT SELECT ON TABLE _aira_staging_maintenance TO aira_staging_runtime';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE _aira_staging_maintenance FROM aira_staging_runtime';
  END IF;
END
$$;

-- ============================================================================
-- Verification Queries (Run as neondb_owner to verify configuration):
-- ============================================================================
-- 1. Verify role exists and lacks superuser/create privileges:
--    SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin 
--    FROM pg_roles WHERE rolname = 'aira_staging_runtime';
--
-- 2. Verify schema CREATE permission is revoked:
--    SELECT has_schema_privilege('aira_staging_runtime', 'public', 'CREATE'); -- MUST BE FALSE
--
-- 3. Verify public table DML is permitted:
--    SELECT has_table_privilege('aira_staging_runtime', 'conversations', 'INSERT'); -- MUST BE TRUE
--
-- 4. Verify sentinel modification is denied:
--    SELECT has_table_privilege('aira_staging_runtime', '_aira_staging_maintenance', 'UPDATE'); -- MUST BE FALSE
-- ============================================================================
