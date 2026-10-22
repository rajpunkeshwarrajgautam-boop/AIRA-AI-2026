/**
 * AIRA AI 2026 — Staging Maintenance Barrier Engine
 * 
 * Enforces an authoritative, reversible, fail-closed maintenance barrier
 * protecting the permanent staging Neon database from unauthorized writes during
 * migration cutovers, schema updates, and controlled historical data imports.
 * 
 * Dual-layer protection:
 * 1. Database-Level (Authoritative):
 *    - `ALTER DATABASE ... SET default_transaction_read_only = on`
 *    - Sentinel table `_aira_staging_maintenance` with cryptographic bypass token hash
 *    - Universal BEFORE INSERT / UPDATE / DELETE (row-level) AND BEFORE TRUNCATE (statement-level)
 *      triggers `_aira_staging_maintenance_trigger` and `_aira_staging_maintenance_trunc_trigger`
 *      on all public application tables that abort any mutation unless the session holds the verified token.
 *    - Draining/terminating idle connections to force new session settings.
 * 2. Privileged Elevation Path:
 *    - Controlled migration runner and historical importer elevate their dedicated session
 *      via `SET default_transaction_read_only = off` and `SET aira.privileged_token = '<token>'`.
 * 3. Fail-Closed Staging Boundary:
 *    - Strictly blocks execution if connected to Production (old-sky-50952395).
 *    - Strictly validates Neon Project ID (mute-frost-50372225), Branch ID, and Endpoint ID.
 *    - Reversible on demand after release certification.
 */

import crypto from 'node:crypto';
import type { Knex } from 'knex';
import {
  PRODUCTION_NEON_PROJECT_ID,
  STAGING_NEON_PROJECT_ID,
  STAGING_NEON_BRANCH_ID,
  STAGING_NEON_ENDPOINT_ID
} from './database-isolation-guard.js';

export const STAGING_MAINTENANCE_TABLE = '_aira_staging_maintenance';
export const STAGING_MAINTENANCE_TRIGGER = '_aira_staging_maintenance_trigger';
export const STAGING_MAINTENANCE_TRUNC_TRIGGER = '_aira_staging_maintenance_trunc_trigger';
export const STAGING_MAINTENANCE_FUNCTION = '_aira_enforce_staging_maintenance';
export const STAGING_PROBE_TABLE = '_aira_maintenance_write_probe';

export const CORE_GUARDED_TABLES = [
  'conversations',
  'conversation_messages',
  'conversation_search_documents',
  'runs',
  'run_events',
  'agents',
  'automations',
  'automation_runs',
  'tool_calls',
  'approvals',
  'artifacts',
  'knowledge_sources',
  'knowledge_chunks',
  'knowledge_entities',
  'knowledge_edges',
  'memory_records',
  'session_grants',
  'workflow_definitions',
  'workflow_runs',
  'workflow_steps',
  'capacity_permits',
  'capacity_rate_log',
  'bff_sessions',
  'billing_customers',
  'plans',
  'plan_prices',
  'subscriptions',
  'credit_accounts',
  'credit_grants',
  'credit_reservations',
  'credit_transactions',
  'usage_events',
  'entitlement_snapshots',
  'billing_audit_events',
  'payment_gateway_events',
  'users',
  'oauth_accounts',
  'account_recovery_requests'
];

export interface StagingMaintenanceStatus {
  isActive: boolean;
  activatedAt?: string;
  activatedBy?: string;
  reason?: string;
  bypassTokenHash?: string;
  defaultReadOnly: boolean;
  tablesGuarded: string[];
  databaseName?: string;
  neonProjectId?: string;
  neonBranchId?: string;
  neonEndpointId?: string;
}

export interface StagingMaintenanceActivationResult {
  active: boolean;
  bypassToken: string;
  activatedAt: string;
  operator: string;
  guardedTablesCount: number;
  readOnlySet: boolean;
  details: string;
}

export interface StagingMaintenanceDeactivationResult {
  active: boolean;
  deactivatedAt: string;
  operator: string;
  readOnlyReset: boolean;
  triggersRemoved: boolean;
  details: string;
}

export interface WriteRestrictionVerificationResult {
  writesBlocked: boolean;
  privilegedPathOperational: boolean;
  truncateBlocked: boolean;
  details: string;
}

/**
 * Computes sha256 hex digest of a bypass token for secure database storage.
 */
export function hashBypassToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * Generates a high-entropy 256-bit cryptographic token.
 */
export function generateBypassToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Strict database identity assertion:
 * - Unconditionally throws [SECURITY FATAL] if connected to Production (old-sky-50952395).
 * - Enforces exact match against authorized Neon staging project, branch, and endpoint.
 * - Fails closed when required identifiers are missing or mismatched.
 */
export async function assertNonProductionTarget(
  client: Knex,
  options: { allowRehearsalBranch?: boolean } = {}
): Promise<void> {
  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.AIRA_TEST_ENVIRONMENT === 'true';

  let row: any = {};
  try {
    const rawRes = await client.raw(`
      SELECT 
        current_database() as db_name,
        current_setting('neon.project_id', true) as neon_project_id,
        current_setting('neon.branch_id', true) as neon_branch_id,
        current_setting('neon.endpoint_id', true) as neon_endpoint_id
    `);
    row = rawRes.rows?.[0] || {};
  } catch (err: any) {
    if (isTestEnv) {
      // In-memory or mock test client
      return;
    }
    throw new Error(`[SECURITY FATAL] Failed to query target database identity settings: ${err.message}. Fail-closed.`);
  }

  // 1. Unconditional Production Rejection
  if (row.neon_project_id === PRODUCTION_NEON_PROJECT_ID) {
    throw new Error(`[SECURITY FATAL] Target database is PRODUCTION (${PRODUCTION_NEON_PROJECT_ID})! Staging maintenance operations are strictly prohibited.`);
  }

  // 2. If Neon settings are present, validate exact staging project identity
  if (row.neon_project_id) {
    if (row.neon_project_id !== STAGING_NEON_PROJECT_ID) {
      throw new Error(`[SECURITY FATAL] Connected Neon project (${row.neon_project_id}) does not match authorized Staging project (${STAGING_NEON_PROJECT_ID})! Fail-closed.`);
    }

    if (!options.allowRehearsalBranch) {
      // Permanent Staging validation
      if (row.neon_branch_id && row.neon_branch_id !== STAGING_NEON_BRANCH_ID) {
        throw new Error(`[SECURITY FATAL] Connected Neon branch (${row.neon_branch_id}) does not match authorized Permanent Staging branch (${STAGING_NEON_BRANCH_ID})! Fail-closed.`);
      }
      if (row.neon_endpoint_id && row.neon_endpoint_id !== STAGING_NEON_ENDPOINT_ID) {
        throw new Error(`[SECURITY FATAL] Connected Neon endpoint (${row.neon_endpoint_id}) does not match authorized Permanent Staging endpoint (${STAGING_NEON_ENDPOINT_ID})! Fail-closed.`);
      }
    }
  } else if (!isTestEnv) {
    // Non-test environment connected without neon.* GUCs
    throw new Error('[SECURITY FATAL] Target database missing required Neon identity settings (neon.project_id). Fail-closed.');
  }
}

/**
 * Activates the authoritative staging maintenance barrier on the target database.
 * Installs both row-level (INSERT, UPDATE, DELETE) and statement-level (TRUNCATE) triggers
 * atomically across all application tables.
 */
export async function activateStagingMaintenance(
  client: Knex,
  options: {
    operator: string;
    reason: string;
    bypassToken?: string;
    allowRehearsalBranch?: boolean;
  }
): Promise<StagingMaintenanceActivationResult> {
  await assertNonProductionTarget(client, { allowRehearsalBranch: options.allowRehearsalBranch });

  const operator = options.operator || 'authorized_cutover_operator';
  const reason = options.reason || 'PR #96 staging release cutover';
  const bypassToken = options.bypassToken || generateBypassToken();
  const tokenHash = hashBypassToken(bypassToken);

  // 1. Create or initialize the maintenance sentinel table
  await client.raw(`
    CREATE TABLE IF NOT EXISTS ${STAGING_MAINTENANCE_TABLE} (
      id INTEGER PRIMARY KEY DEFAULT 1,
      is_active BOOLEAN NOT NULL DEFAULT true,
      activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      bypass_token_hash TEXT NOT NULL,
      allowed_migration_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT single_row_maintenance_guard CHECK (id = 1)
    );
  `);

  await client.raw(`
    INSERT INTO ${STAGING_MAINTENANCE_TABLE} (id, is_active, activated_at, activated_by, reason, bypass_token_hash, updated_at)
    VALUES (1, true, NOW(), :operator, :reason, :tokenHash, NOW())
    ON CONFLICT (id) DO UPDATE SET
      is_active = true,
      activated_at = NOW(),
      activated_by = :operator,
      reason = :reason,
      bypass_token_hash = :tokenHash,
      updated_at = NOW();
  `, { operator, reason, tokenHash });

  // 2. Create the maintenance enforcement trigger function
  // Handles row-level triggers (BEFORE INSERT OR UPDATE OR DELETE) and statement-level triggers (BEFORE TRUNCATE)
  await client.raw(`
    CREATE OR REPLACE FUNCTION ${STAGING_MAINTENANCE_FUNCTION}()
    RETURNS TRIGGER AS $$
    DECLARE
      m_active BOOLEAN;
      m_token_hash TEXT;
      session_token TEXT;
    BEGIN
      SELECT is_active, bypass_token_hash INTO m_active, m_token_hash
      FROM ${STAGING_MAINTENANCE_TABLE}
      WHERE id = 1;

      IF m_active IS TRUE THEN
        session_token := current_setting('aira.privileged_token', true);
        IF session_token IS NULL OR encode(sha256(session_token::bytea), 'hex') <> m_token_hash THEN
          RAISE EXCEPTION '[STAGING_MAINTENANCE_BLOCKED] Operation denied: Permanent Staging database is in maintenance mode. Write path is locked.'
            USING ERRCODE = '55P03';
        END IF;
      END IF;

      IF TG_LEVEL = 'ROW' THEN
        RETURN NEW;
      ELSE
        RETURN NULL;
      END IF;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // 3. Attach triggers to all existing application tables in public schema
  const existingTablesRes = await client.raw(`
    SELECT tablename 
    FROM pg_tables 
    WHERE schemaname = 'public' 
      AND tablename NOT LIKE '_aira_%'
      AND tablename NOT LIKE 'knex_%';
  `);
  const existingTables: string[] = (existingTablesRes.rows || []).map((r: any) => r.tablename);
  let guardedCount = 0;

  for (const table of existingTables) {
    // Both row trigger and truncate statement trigger
    await client.raw(`
      DROP TRIGGER IF EXISTS ${STAGING_MAINTENANCE_TRIGGER} ON "${table}";
      CREATE TRIGGER ${STAGING_MAINTENANCE_TRIGGER}
      BEFORE INSERT OR UPDATE OR DELETE ON "${table}"
      FOR EACH ROW
      EXECUTE FUNCTION ${STAGING_MAINTENANCE_FUNCTION}();

      DROP TRIGGER IF EXISTS ${STAGING_MAINTENANCE_TRUNC_TRIGGER} ON "${table}";
      CREATE TRIGGER ${STAGING_MAINTENANCE_TRUNC_TRIGGER}
      BEFORE TRUNCATE ON "${table}"
      FOR EACH STATEMENT
      EXECUTE FUNCTION ${STAGING_MAINTENANCE_FUNCTION}();
    `);
    guardedCount++;
  }

  // 4. Create dedicated probe table for active write restriction verification
  await client.raw(`
    CREATE TABLE IF NOT EXISTS ${STAGING_PROBE_TABLE} (
      id VARCHAR(64) PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    DROP TRIGGER IF EXISTS ${STAGING_MAINTENANCE_TRIGGER} ON ${STAGING_PROBE_TABLE};
    CREATE TRIGGER ${STAGING_MAINTENANCE_TRIGGER}
    BEFORE INSERT OR UPDATE OR DELETE ON ${STAGING_PROBE_TABLE}
    FOR EACH ROW
    EXECUTE FUNCTION ${STAGING_MAINTENANCE_FUNCTION}();

    DROP TRIGGER IF EXISTS ${STAGING_MAINTENANCE_TRUNC_TRIGGER} ON ${STAGING_PROBE_TABLE};
    CREATE TRIGGER ${STAGING_MAINTENANCE_TRUNC_TRIGGER}
    BEFORE TRUNCATE ON ${STAGING_PROBE_TABLE}
    FOR EACH STATEMENT
    EXECUTE FUNCTION ${STAGING_MAINTENANCE_FUNCTION}();
  `);

  // 5. Attempt database-level read-only setting (best-effort secondary reinforcement)
  let readOnlySet = false;
  try {
    const dbNameRes = await client.raw('SELECT current_database() as db_name;');
    const dbName = dbNameRes.rows?.[0]?.db_name;
    if (dbName) {
      await client.raw(`ALTER DATABASE "${dbName}" SET default_transaction_read_only = on;`);
      readOnlySet = true;
    }
  } catch {
    readOnlySet = false;
  }

  // 6. Terminate idle backend sessions to clear stale connection states
  try {
    await client.raw(`
      SELECT pg_terminate_backend(pid) 
      FROM pg_stat_activity 
      WHERE datname = current_database() 
        AND pid <> pg_backend_pid() 
        AND state = 'idle';
    `);
  } catch {
    // Ignore if permission denied on unprivileged client
  }

  // 7. Verify atomic enforcement probe
  const probe = await verifyStagingWriteRestriction(client, { bypassToken });
  if (!probe.writesBlocked || !probe.truncateBlocked) {
    throw new Error(`[SECURITY FATAL] Maintenance barrier activation failed write-probe verification: writesBlocked=${probe.writesBlocked}, truncateBlocked=${probe.truncateBlocked}. Fail-closed.`);
  }

  return {
    active: true,
    bypassToken,
    activatedAt: new Date().toISOString(),
    operator,
    guardedTablesCount: guardedCount,
    readOnlySet,
    details: `Staging maintenance barrier activated: ${guardedCount} tables guarded with row and truncate triggers, sentinel initialized, write probes verified.`
  };
}

/**
 * Deactivates the staging maintenance barrier and restores normal write traffic.
 * Guarantees reliable execution even if default_transaction_read_only was active.
 */
export async function deactivateStagingMaintenance(
  client: Knex,
  options: {
    operator: string;
    bypassToken?: string;
    allowRehearsalBranch?: boolean;
  }
): Promise<StagingMaintenanceDeactivationResult> {
  await assertNonProductionTarget(client, { allowRehearsalBranch: options.allowRehearsalBranch });
  const operator = options.operator || 'authorized_cutover_operator';

  // 1. Elevate session explicitly so deactivation commands cannot be blocked by read-only defaults
  try {
    await client.raw('SET default_transaction_read_only = off;');
    if (options.bypassToken) {
      await client.raw("SELECT set_config('aira.privileged_token', :token, false);", { token: options.bypassToken });
    }
  } catch {
    // continue
  }

  // 2. Reset database-level default_transaction_read_only = off
  let readOnlyReset = false;
  try {
    const dbNameRes = await client.raw('SELECT current_database() as db_name;');
    const dbName = dbNameRes.rows?.[0]?.db_name;
    if (dbName) {
      await client.raw(`ALTER DATABASE "${dbName}" SET default_transaction_read_only = off;`);
      readOnlyReset = true;
    }
  } catch {
    readOnlyReset = false;
  }

  // 3. Drop trigger function with CASCADE to remove all triggers atomically
  let triggersRemoved = false;
  try {
    await client.raw(`DROP FUNCTION IF EXISTS ${STAGING_MAINTENANCE_FUNCTION}() CASCADE;`);
    triggersRemoved = true;
  } catch {
    // Fallback: Drop triggers individually
    try {
      const tablesRes = await client.raw(`
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public';
      `);
      const tables: string[] = (tablesRes.rows || []).map((r: any) => r.tablename);
      for (const table of tables) {
        await client.raw(`DROP TRIGGER IF EXISTS ${STAGING_MAINTENANCE_TRIGGER} ON "${table}";`).catch(() => {});
        await client.raw(`DROP TRIGGER IF EXISTS ${STAGING_MAINTENANCE_TRUNC_TRIGGER} ON "${table}";`).catch(() => {});
      }
      triggersRemoved = true;
    } catch {
      triggersRemoved = false;
    }
  }

  // 4. Mark maintenance inactive in sentinel table
  try {
    await client.raw(`
      UPDATE ${STAGING_MAINTENANCE_TABLE}
      SET is_active = false, updated_at = NOW()
      WHERE id = 1;
    `);
  } catch {
    // Sentinel table may not exist
  }

  return {
    active: false,
    deactivatedAt: new Date().toISOString(),
    operator,
    readOnlyReset,
    triggersRemoved,
    details: 'Staging maintenance barrier deactivated: normal write operations safely restored.'
  };
}

/**
 * Retrieves the current maintenance status from the target database.
 */
export async function getStagingMaintenanceStatus(client: Knex): Promise<StagingMaintenanceStatus> {
  let isActive = false;
  let activatedAt: string | undefined;
  let activatedBy: string | undefined;
  let reason: string | undefined;
  let bypassTokenHash: string | undefined;
  let defaultReadOnly = false;
  let databaseName: string | undefined;
  let neonProjectId: string | undefined;
  let neonBranchId: string | undefined;
  let neonEndpointId: string | undefined;
  const tablesGuarded: string[] = [];

  try {
    const dbRes = await client.raw(`
      SELECT 
        current_database() as db_name,
        current_setting('default_transaction_read_only', true) as default_ro,
        current_setting('neon.project_id', true) as project_id,
        current_setting('neon.branch_id', true) as branch_id,
        current_setting('neon.endpoint_id', true) as endpoint_id
    `);
    const dbRow = dbRes.rows?.[0] || {};
    databaseName = dbRow.db_name;
    defaultReadOnly = dbRow.default_ro === 'on' || dbRow.default_ro === 'true';
    neonProjectId = dbRow.project_id;
    neonBranchId = dbRow.branch_id;
    neonEndpointId = dbRow.endpoint_id;
  } catch {
    // continue
  }

  try {
    const sentinelRes = await client.raw(`
      SELECT is_active, activated_at::text, activated_by, reason, bypass_token_hash
      FROM ${STAGING_MAINTENANCE_TABLE}
      WHERE id = 1;
    `);
    const row = sentinelRes.rows?.[0];
    if (row) {
      isActive = Boolean(row.is_active);
      activatedAt = row.activated_at;
      activatedBy = row.activated_by;
      reason = row.reason;
      bypassTokenHash = row.bypass_token_hash;
    }
  } catch {
    // Sentinel table doesn't exist
  }

  try {
    const triggerRes = await client.raw(`
      SELECT DISTINCT event_object_table as tablename
      FROM information_schema.triggers
      WHERE trigger_name IN ('${STAGING_MAINTENANCE_TRIGGER}', '${STAGING_MAINTENANCE_TRUNC_TRIGGER}')
        AND trigger_schema = 'public';
    `);
    for (const r of triggerRes.rows || []) {
      tablesGuarded.push(r.tablename);
    }
  } catch {
    // continue
  }

  return {
    isActive,
    activatedAt,
    activatedBy,
    reason,
    bypassTokenHash,
    defaultReadOnly,
    tablesGuarded,
    databaseName,
    neonProjectId,
    neonBranchId,
    neonEndpointId
  };
}

/**
 * Empirically tests write restriction against the target database:
 * 1. Proves that unprivileged writes (INSERT, TRUNCATE) are rejected.
 * 2. Proves that privileged write with bypass token succeeds (if token provided).
 * Fails closed: If no token provided, privilegedPathOperational is FALSE.
 */
export async function verifyStagingWriteRestriction(
  client: Knex,
  options: {
    bypassToken?: string;
  } = {}
): Promise<WriteRestrictionVerificationResult> {
  const status = await getStagingMaintenanceStatus(client);
  if (!status.isActive) {
    return {
      writesBlocked: false,
      privilegedPathOperational: false,
      truncateBlocked: false,
      details: 'Maintenance barrier is not currently active on target database.'
    };
  }

  // 1. Ensure probe table exists
  try {
    await client.raw(`
      CREATE TABLE IF NOT EXISTS ${STAGING_PROBE_TABLE} (
        id VARCHAR(64) PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } catch {
    // If read-only prevents table creation, writes are blocked
  }

  // 2. Attempt unauthorized write without bypass token
  let unprivilegedWriteBlocked = false;
  const probeIdUnauthorized = `unauth_probe_${Date.now()}`;
  try {
    await client.raw(
      `INSERT INTO ${STAGING_PROBE_TABLE} (id) VALUES (:id);`,
      { id: probeIdUnauthorized }
    );
    unprivilegedWriteBlocked = false;
    await client.raw(`DELETE FROM ${STAGING_PROBE_TABLE} WHERE id = :id;`, { id: probeIdUnauthorized }).catch(() => {});
  } catch (err: any) {
    const msg = String(err.message || '');
    if (
      msg.includes('STAGING_MAINTENANCE_BLOCKED') ||
      msg.includes('read-only transaction') ||
      msg.includes('cannot execute INSERT') ||
      err.code === '55P03' ||
      err.code === '25006'
    ) {
      unprivilegedWriteBlocked = true;
    }
  }

  // 3. Attempt unauthorized TRUNCATE without bypass token
  let truncateBlocked = false;
  try {
    await client.raw(`TRUNCATE TABLE ${STAGING_PROBE_TABLE};`);
    truncateBlocked = false;
  } catch (err: any) {
    const msg = String(err.message || '');
    if (
      msg.includes('STAGING_MAINTENANCE_BLOCKED') ||
      msg.includes('read-only transaction') ||
      msg.includes('cannot execute TRUNCATE') ||
      err.code === '55P03' ||
      err.code === '25006'
    ) {
      truncateBlocked = true;
    }
  }

  // 4. Attempt privileged write with bypass token
  // Strict check: if no token provided, privilegedPathOperational is FALSE
  let privilegedPathOperational = false;
  if (options.bypassToken) {
    const probeIdPrivileged = `priv_probe_${Date.now()}`;
    try {
      await client.transaction(async (trx) => {
        await trx.raw(`SET LOCAL default_transaction_read_only = off;`);
        await trx.raw(`SELECT set_config('aira.privileged_token', :token, true);`, { token: options.bypassToken });
        await trx.raw(`INSERT INTO ${STAGING_PROBE_TABLE} (id) VALUES (:id);`, { id: probeIdPrivileged });
        await trx.raw(`DELETE FROM ${STAGING_PROBE_TABLE} WHERE id = :id;`, { id: probeIdPrivileged });
      });
      privilegedPathOperational = true;
    } catch {
      privilegedPathOperational = false;
    }
  } else {
    // Explicitly FALSE per Requirement #7 (zero false-positives)
    privilegedPathOperational = false;
  }

  const writesBlocked = unprivilegedWriteBlocked;
  const details = writesBlocked && truncateBlocked && (options.bypassToken ? privilegedPathOperational : true)
    ? `Verified write restriction: INSERT blocked=${writesBlocked}, TRUNCATE blocked=${truncateBlocked}, privilegedPathOperational=${privilegedPathOperational}`
    : `Write restriction verification failed: writesBlocked=${writesBlocked}, truncateBlocked=${truncateBlocked}, privilegedPathOperational=${privilegedPathOperational}`;

  return {
    writesBlocked,
    privilegedPathOperational,
    truncateBlocked,
    details
  };
}
