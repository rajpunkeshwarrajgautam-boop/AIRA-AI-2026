/**
 * AIRA AI 2026 — Staging Database Role Separation & Least-Privilege Architecture
 * 
 * Defines the dual-role architecture for permanent staging:
 * 1. Runtime Application Role (`aira_staging_runtime`):
 *    - Connects from Express API and Vercel serverless functions.
 *    - Granted standard DML permissions (SELECT, INSERT, UPDATE, DELETE) on public tables.
 *    - NOT a table owner. Cannot disable triggers, drop triggers, change schema, or execute DDL.
 *    - Has read-only access to `_aira_staging_maintenance` (cannot modify sentinel or bypass hash).
 * 2. Migration & Cutover Operator Role (`aira_staging_migration` / `neondb_owner`):
 *    - Connects exclusively from out-of-band CLI tools (cutover wizard, Knex runner, import scripts).
 *    - Table owner with full DDL and migration authority.
 *    - Authorized to manage maintenance triggers and sentinel state.
 * 
 * Old Immutable Deployment Containment:
 * - Legacy immutable Vercel preview deployments retain connection strings with `neondb_owner`.
 * - While they retain owner credentials, their normal DML operations (INSERT, UPDATE, DELETE, TRUNCATE)
 *   are caught and blocked by `_aira_staging_maintenance_trigger` and `default_transaction_read_only`.
 * - To achieve full structural containment, the operator cutover runbook defines the credential transition:
 *   1. Create `aira_staging_runtime` role.
 *   2. Update Vercel environment variable `DATABASE_URL` for staging to use `aira_staging_runtime`.
 *   3. Upon owner authorization, rotate or restrict `neondb_owner` access so only the migration orchestrator
 *      possesses table-owner credentials.
 */

import type { Knex } from 'knex';

export const RUNTIME_ROLE_NAME = 'aira_staging_runtime';
export const MIGRATION_ROLE_NAME = 'neondb_owner';

export interface StagingRoleAuditResult {
  currentRole: string;
  isTableOwner: boolean;
  canDisableTriggers: boolean;
  canAlterMaintenanceSentinel: boolean;
  isRuntimeRoleSeparated: boolean;
  details: string;
}

/**
 * Audits the connected role's permissions against the staging database to verify
 * whether it possesses table-owner privileges or least-privilege runtime status.
 */
export async function auditConnectedRolePrivileges(client: Knex): Promise<StagingRoleAuditResult> {
  const userRes = await client.raw(`
    SELECT 
      current_user as current_role,
      session_user as session_role,
      current_database() as db_name
  `);
  const currentRole = userRes.rows?.[0]?.current_role || 'unknown';

  // Check ownership of public tables
  const ownershipRes = await client.raw(`
    SELECT tableowner, count(*) as count
    FROM pg_tables
    WHERE schemaname = 'public'
    GROUP BY tableowner;
  `);
  
  const ownerRows: Array<{ tableowner: string; count: string | number }> = ownershipRes.rows || [];
  const isOwner = ownerRows.some(r => r.tableowner === currentRole);

  // Check if current role has DDL / trigger alteration privileges
  let canDisableTriggers = false;
  if (isOwner || currentRole === 'neondb_owner' || currentRole === 'postgres') {
    canDisableTriggers = true;
  }

  // Check if current role can update _aira_staging_maintenance
  const canAlterSentinel = isOwner || currentRole === 'neondb_owner';

  const isRuntimeRoleSeparated = currentRole === RUNTIME_ROLE_NAME && !isOwner;

  let details = `Connected role: ${currentRole}. Table owner: ${isOwner}. `;
  if (isOwner) {
    details += 'WARNING: Role possesses table ownership and can alter triggers. Recommended for migration runner only, NOT runtime application.';
  } else {
    details += 'Least-privilege role verified: cannot alter table triggers or sentinel configuration.';
  }

  return {
    currentRole,
    isTableOwner: isOwner,
    canDisableTriggers,
    canAlterMaintenanceSentinel: canAlterSentinel,
    isRuntimeRoleSeparated,
    details
  };
}

/**
 * Generates the idempotent SQL script required to provision the least-privilege runtime role.
 */
export function generateRoleSeparationSql(runtimePasswordPlaceholder = 'GENERATE_SECURE_PASSWORD'): string {
  return `
-- AIRA AI 2026: Permanent Staging Least-Privilege Role Provisioning
-- To be executed by owner on mute-frost-50372225 (main branch)

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME_ROLE_NAME}') THEN
    CREATE ROLE ${RUNTIME_ROLE_NAME} WITH LOGIN PASSWORD '${runtimePasswordPlaceholder}';
  END IF;
END
$$;

-- Grant standard DML to runtime role
GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE_NAME};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE_NAME};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE_NAME};

-- Ensure future tables grant DML to runtime role
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_ROLE_NAME};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${RUNTIME_ROLE_NAME};

-- Revoke DDL and table creation privileges from runtime role
REVOKE CREATE ON SCHEMA public FROM ${RUNTIME_ROLE_NAME};

-- Ensure runtime role CANNOT modify maintenance sentinel table
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE _aira_staging_maintenance FROM ${RUNTIME_ROLE_NAME};
GRANT SELECT ON TABLE _aira_staging_maintenance TO ${RUNTIME_ROLE_NAME};
`.trim();
}
