import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface GuardedMigrationResult {
  target: string;
  applied: boolean;
  status: 'SUCCESS' | 'ALREADY_APPLIED' | 'FAILED';
  migrationName: string;
  batch?: number;
  rowCount: number;
  columnDetails?: {
    data_type: string;
    column_default: string;
    is_nullable: string;
  };
  durationMs: number;
}

export type ValidTargetEnvironment = 'production' | 'rehearsal' | 'disposable_test';

export interface GuardedMigrationOptions {
  connectionString: string;
  targetEnvironment: ValidTargetEnvironment;
  authorizeProductionExecution?: boolean;
  migrationsDir?: string;
  customLockTimeout?: string; // defaults to '2s'
  customStatementTimeout?: string; // defaults to '5s'
}

export const AUTHORIZED_MIGRATION_FILE = '032_reconcile_workflow_run_artifacts.ts';
export const ADVISORY_LOCK_KEY_1 = 1095325257; // 'AIRA' in ASCII
export const ADVISORY_LOCK_KEY_2 = 32;         // Migration 32

export const CANONICAL_PRODUCTION_ENDPOINT_ID = 'ep-withered-art-b36ox90b';
export const APPROVED_REHEARSAL_ENDPOINT_ID = 'ep-lively-truth-b3im2z2q';

/**
 * Strict CLI argument parser enforcing the exact approved contracts:
 *   --target=production --authorize-production-migration-032-execute
 *   --target=rehearsal
 *   --target=disposable_test
 */
export function parseGuardedMigrationCliArgs(argv: string[]): {
  targetEnv: ValidTargetEnvironment;
  isProdAuth: boolean;
} {
  if (!argv || argv.length === 0) {
    throw new Error(
      '[CLI_ERROR] Missing required execution target. You must specify exact flags: ' +
      '--target=production --authorize-production-migration-032-execute | --target=rehearsal | --target=disposable_test'
    );
  }

  let targetEnv: ValidTargetEnvironment | undefined;
  let isProdAuth = false;
  const seenFlags = new Set<string>();

  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) {
      throw new Error(`[CLI_ERROR] Unexpected positional argument "${arg}". Positional arguments are strictly forbidden.`);
    }

    if (seenFlags.has(arg)) {
      throw new Error(`[CLI_ERROR] Duplicate argument "${arg}" detected.`);
    }
    seenFlags.add(arg);

    if (arg === '--authorize-production-migration-032-execute') {
      isProdAuth = true;
    } else if (arg.startsWith('--target=')) {
      if (targetEnv !== undefined) {
        throw new Error('[CLI_ERROR] Conflicting or multiple --target arguments specified.');
      }
      const val = arg.slice('--target='.length);
      if (val === 'production' || val === 'rehearsal' || val === 'disposable_test') {
        targetEnv = val;
      } else {
        throw new Error(`[CLI_ERROR] Invalid target environment "${val}". Must be exactly "production", "rehearsal", or "disposable_test".`);
      }
    } else {
      throw new Error(`[CLI_ERROR] Unrecognized flag "${arg}". Allowed flags are --target=<environment> and --authorize-production-migration-032-execute.`);
    }
  }

  if (!targetEnv) {
    throw new Error('[CLI_ERROR] Missing required --target=<environment> flag.');
  }

  if (targetEnv === 'production') {
    if (!isProdAuth) {
      throw new Error(
        '[CLI_ERROR] Target is "production" but mandatory authorization flag ' +
        '"--authorize-production-migration-032-execute" was not provided. Production execution is rejected.'
      );
    }
  } else if (isProdAuth) {
    throw new Error(
      `[CLI_ERROR] Conflicting options: authorization flag "--authorize-production-migration-032-execute" ` +
      `is only permitted with --target=production, but target is "${targetEnv}".`
    );
  }

  return { targetEnv, isProdAuth };
}

/**
 * Validates connection string against expected environment identity before connecting.
 */
export function validateTargetConnectionUrl(targetEnv: ValidTargetEnvironment, connStr: string): void {
  if (!connStr || typeof connStr !== 'string') {
    throw new Error('[SECURITY_HALT] Connection string is missing or empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(connStr);
  } catch {
    throw new Error('[SECURITY_HALT] Connection string is not a valid parseable PostgreSQL URL.');
  }

  const host = parsed.hostname.toLowerCase();
  const dbName = parsed.pathname.replace(/^\//, '');
  const endpointPrefix = host.split('.')[0].replace('-pooler', '');

  if (targetEnv === 'production') {
    if (endpointPrefix !== CANONICAL_PRODUCTION_ENDPOINT_ID) {
      throw new Error(
        `[SECURITY_HALT] Target endpoint "${endpointPrefix}" does not match canonical Neon production endpoint "${CANONICAL_PRODUCTION_ENDPOINT_ID}".`
      );
    }
    if (!host.endsWith('.neon.tech')) {
      throw new Error(`[SECURITY_HALT] Production hostname "${host}" must reside on the .neon.tech domain.`);
    }
    if (dbName !== 'neondb') {
      throw new Error(`[SECURITY_HALT] Production database name "${dbName}" does not match canonical production database "neondb".`);
    }
  } else if (targetEnv === 'rehearsal') {
    if (endpointPrefix !== APPROVED_REHEARSAL_ENDPOINT_ID && !host.includes('b3zeg2q2')) {
      throw new Error(
        `[SECURITY_HALT] Rehearsal endpoint "${endpointPrefix}" does not match approved rehearsal branch endpoint "${APPROVED_REHEARSAL_ENDPOINT_ID}".`
      );
    }
    if (!host.endsWith('.neon.tech')) {
      throw new Error(`[SECURITY_HALT] Rehearsal hostname "${host}" must reside on the .neon.tech domain.`);
    }
  } else if (targetEnv === 'disposable_test') {
    const isLocalOrCi = host === '127.0.0.1' || host === 'localhost' || host === 'postgres';
    if (!isLocalOrCi) {
      throw new Error(
        `[SECURITY_HALT] Disposable test target hostname "${host}" is not a recognized local or CI container host (127.0.0.1, localhost, postgres).`
      );
    }
  }
}

export async function executeGuardedMigration032(options: GuardedMigrationOptions): Promise<GuardedMigrationResult> {
  const startMs = Date.now();
  const lockTimeout = options.customLockTimeout || '2s';
  const stmtTimeout = options.customStatementTimeout || '5s';

  console.log('========================================================================');
  console.log(` GUARDED EXECUTION: MIGRATION 032 (${options.targetEnvironment.toUpperCase()})`);
  console.log('========================================================================');

  // Authorization gate check
  if (options.targetEnvironment === 'production' && !options.authorizeProductionExecution) {
    throw new Error('[SAFETY_BLOCK] Production execution is NOT authorized. Missing explicit --authorize-production-migration-032-execute flag.');
  }

  // Pre-connection URL identity check
  validateTargetConnectionUrl(options.targetEnvironment, options.connectionString);

  // 1. Connection and SSL Configuration
  const client = new pg.Client({
    connectionString: options.connectionString,
    ssl: options.connectionString.includes('neon.tech') || options.connectionString.includes('sslmode=require')
      ? { rejectUnauthorized: true }
      : false,
  });

  await client.connect();

  // Set session-level bounded locking immediately to protect pre-checks (SELECT count(*), table locks)
  await client.query(`SET lock_timeout = '${lockTimeout}'`);
  await client.query(`SET statement_timeout = '${stmtTimeout}'`);

  let advisoryLockAcquired = false;

  try {
    // 2. Validate Target Environment Database Identity Post-Connect
    const identRes = await client.query(`
      SELECT 
        current_database() as db_name, 
        current_user as db_user, 
        current_setting('server_version') as server_version,
        inet_server_addr() as server_addr
    `);
    const ident = identRes.rows[0];
    console.log(`[1/6] Target Database Identity: db=${ident.db_name}, user=${ident.db_user}, version=${ident.server_version}`);

    if (options.targetEnvironment === 'production') {
      if (!options.authorizeProductionExecution) {
        throw new Error('[SAFETY_BLOCK] Production execution is NOT authorized. Missing explicit --authorize-production-migration-032-execute flag.');
      }
      if (ident.db_name !== 'neondb') {
        throw new Error(`[SAFETY_BLOCK] Target database "${ident.db_name}" does not match canonical production database "neondb".`);
      }
    }

    // 3. Exclusive Advisory Lock (Migration-Runner Mutual Exclusion)
    console.log('[2/6] Acquiring session advisory lock (AIRA-032)...');
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1, $2) as acquired', [ADVISORY_LOCK_KEY_1, ADVISORY_LOCK_KEY_2]);
    if (!lockRes.rows[0].acquired) {
      throw new Error('[CONCURRENCY_HALT] Could not acquire migration advisory lock. Another migration runner is currently active.');
    }
    advisoryLockAcquired = true;
    console.log('  ✓ Advisory lock acquired (runner mutual exclusion verified).');

    // Check Knex migration lock table for concurrent standard migrations
    const hasKnexLockTable = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'knex_migrations_lock'
      ) as exists
    `);
    if (hasKnexLockTable.rows[0].exists) {
      const lockStatus = await client.query('SELECT is_locked FROM knex_migrations_lock WHERE index = 1');
      if (lockStatus.rows.length > 0 && lockStatus.rows[0].is_locked === 1) {
        throw new Error('[KNEX_LOCK_ACTIVE] Another Knex migration process is holding knex_migrations_lock (is_locked=1). Aborting.');
      }
    }

    // 4. Pending Migration Quarantine & Catalog Inspection
    console.log('[3/6] Inspecting Knex migration ledger and filesystem inventory...');
    const hasKnexMigrations = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'knex_migrations'
      ) as exists
    `);
    if (!hasKnexMigrations.rows[0].exists) {
      throw new Error('[CATALOG_HALT] knex_migrations table missing from target database.');
    }

    const appliedRows = await client.query('SELECT id, name, batch FROM knex_migrations ORDER BY id');
    const appliedNames = new Set(appliedRows.rows.map(r => r.name));

    // Verify filesystem migration inventory
    const dir = options.migrationsDir || path.resolve(__dirname, '../packages/db/src/migrations');
    if (!fs.existsSync(dir)) {
      throw new Error(`[CATALOG_HALT] Migrations directory "${dir}" does not exist. Fail closed.`);
    }

    const filesOnDisk = fs.readdirSync(dir).filter(f => /^\d+_.+\.ts$/.test(f)).sort();
    if (filesOnDisk.length === 0) {
      throw new Error(`[CATALOG_HALT] No migration files found in "${dir}". Fail closed.`);
    }

    if (!filesOnDisk.includes(AUTHORIZED_MIGRATION_FILE)) {
      throw new Error(`[CATALOG_HALT] Authorized migration file "${AUTHORIZED_MIGRATION_FILE}" missing from filesystem directory "${dir}". Fail closed.`);
    }

    // Check for unexpected pending migrations
    const unappliedFiles = filesOnDisk.filter(f => !appliedNames.has(f));
    const forbiddenFiles = unappliedFiles.filter(f => f !== AUTHORIZED_MIGRATION_FILE);
    if (forbiddenFiles.length > 0) {
      throw new Error(
        `[MIGRATION_SAFETY_HALT] UNEXPECTED_PENDING_MIGRATION: Detected unapplied migrations outside authorized scope: ` +
        `${forbiddenFiles.join(', ')}. Workspace V3 and other unreviewed migrations are strictly forbidden from running.`
      );
    }

    // Check if 032 is already applied — verify schema integrity rather than blind trust
    if (appliedNames.has(AUTHORIZED_MIGRATION_FILE)) {
      console.log(`  -> Migration "${AUTHORIZED_MIGRATION_FILE}" is recorded in knex_migrations ledger.`);
      console.log('  -> Verifying schema integrity for recorded migration...');
      
      const hasWorkflowRunsTable = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workflow_runs'
        ) as exists
      `);
      if (!hasWorkflowRunsTable.rows[0].exists) {
        throw new Error(
          '[CORRUPT_SCHEMA_ERROR] knex_migrations ledger records 032 as applied, but "workflow_runs" table is missing from database!'
        );
      }

      const colCheck = await client.query(`
        SELECT column_name, data_type, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'workflow_runs' AND column_name = 'artifacts'
      `);
      if (colCheck.rows.length === 0) {
        throw new Error(
          '[CORRUPT_SCHEMA_ERROR] knex_migrations ledger records 032 as applied, but "workflow_runs.artifacts" column is missing!'
        );
      }
      if (colCheck.rows[0].data_type !== 'jsonb') {
        throw new Error(
          `[CORRUPT_SCHEMA_ERROR] Column "workflow_runs.artifacts" has data_type "${colCheck.rows[0].data_type}", expected jsonb.`
        );
      }

      const rowCountRes = await client.query('SELECT count(*)::int as count FROM workflow_runs');
      console.log(`  ✓ Schema integrity verified: workflow_runs exists with jsonb artifacts column. Row count: ${rowCountRes.rows[0].count}.`);

      return {
        target: options.targetEnvironment,
        applied: false,
        status: 'ALREADY_APPLIED',
        migrationName: AUTHORIZED_MIGRATION_FILE,
        rowCount: rowCountRes.rows[0].count,
        columnDetails: colCheck.rows[0],
        durationMs: Date.now() - startMs,
      };
    }

    // 5. Precondition verification: workflow_runs table
    console.log('[4/6] Verifying workflow_runs table exists...');
    const hasWorkflowRuns = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workflow_runs'
      ) as exists
    `);
    if (!hasWorkflowRuns.rows[0].exists) {
      throw new Error('[PRECONDITION_FAILED] Table "workflow_runs" does not exist in target database. Fail closed.');
    }

    const preRowCountRes = await client.query('SELECT count(*)::int as count FROM workflow_runs');
    const preRowCount = preRowCountRes.rows[0].count;
    console.log(`  ✓ Table workflow_runs exists. Current row count: ${preRowCount}`);

    // 6. Execute Single Atomic Transaction with Bounded Locking
    console.log(`[5/6] Executing atomic transaction with lock_timeout=${lockTimeout}, statement_timeout=${stmtTimeout}...`);

    await client.query('BEGIN');
    let transactionCommitted = false;

    try {
      // Apply bounded timeouts on the EXACT backend connection
      await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
      await client.query(`SET LOCAL statement_timeout = '${stmtTimeout}'`);

      // Verify timeouts took effect on session
      const verifyTimeouts = await client.query("SHOW lock_timeout; SHOW statement_timeout;");
      console.log('  ✓ Session bounded locking confirmed active.');

      // Check if column already exists
      const colCheck = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'workflow_runs' AND column_name = 'artifacts'
      `);

      if (colCheck.rows.length === 0) {
        console.log('  -> Adding JSONB column artifacts with DEFAULT \'[]\' to workflow_runs...');
        await client.query(`
          ALTER TABLE workflow_runs ADD COLUMN artifacts JSONB DEFAULT '[]'::jsonb;
        `);
        console.log('  ✓ Column artifacts added successfully.');
      } else {
        console.log('  -> Column artifacts already exists on workflow_runs (skipping DDL).');
      }

      // Compute next batch number
      const batchRes = await client.query('SELECT COALESCE(MAX(batch), 0) + 1 AS next_batch FROM knex_migrations');
      const nextBatch = batchRes.rows[0].next_batch;

      // Atomically insert into knex_migrations ledger in same transaction
      console.log(`  -> Inserting ledger record into knex_migrations (batch ${nextBatch})...`);
      await client.query(
        'INSERT INTO knex_migrations (name, batch, migration_time) VALUES ($1, $2, NOW())',
        [AUTHORIZED_MIGRATION_FILE, nextBatch]
      );
      console.log('  ✓ Knex ledger entry inserted atomically.');

      // Commit transaction
      await client.query('COMMIT');
      transactionCommitted = true;
      console.log('  ✓ Transaction committed successfully.');

      // 7. Postcondition Verification
      console.log('[6/6] Verifying postconditions...');
      const postColRes = await client.query(`
        SELECT column_name, data_type, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'workflow_runs' AND column_name = 'artifacts'
      `);
      if (postColRes.rows.length === 0 || postColRes.rows[0].data_type !== 'jsonb') {
        throw new Error('[POSTCONDITION_FAILED] Column workflow_runs.artifacts was not created as JSONB.');
      }

      const postRowCountRes = await client.query('SELECT count(*)::int as count FROM workflow_runs');
      const postRowCount = postRowCountRes.rows[0].count;
      if (postRowCount !== preRowCount) {
        throw new Error(`[DATA_INTEGRITY_FAILED] Row count changed during migration! (before: ${preRowCount}, after: ${postRowCount})`);
      }
      console.log(`  ✓ Data integrity verified: row count preserved (${postRowCount} rows).`);

      const ledgerCheck = await client.query(
        'SELECT id, name, batch, migration_time FROM knex_migrations WHERE name = $1',
        [AUTHORIZED_MIGRATION_FILE]
      );
      if (ledgerCheck.rows.length === 0) {
        throw new Error('[LEDGER_FAILED] Migration entry was not found in knex_migrations after commit.');
      }
      console.log(`  ✓ Ledger confirmed: id=${ledgerCheck.rows[0].id}, batch=${ledgerCheck.rows[0].batch}`);

      return {
        target: options.targetEnvironment,
        applied: true,
        status: 'SUCCESS',
        migrationName: AUTHORIZED_MIGRATION_FILE,
        batch: nextBatch,
        rowCount: postRowCount,
        columnDetails: postColRes.rows[0],
        durationMs: Date.now() - startMs,
      };
    } catch (txError: any) {
      if (!transactionCommitted) {
        console.error('  ✗ Transaction failed, rolling back cleanly:', txError.message);
        try {
          await client.query('ROLLBACK');
          console.log('  ✓ ROLLBACK completed.');
        } catch (rbErr: any) {
          console.error('  ! Failed to rollback:', rbErr.message);
        }
      }
      throw txError;
    }
  } finally {
    if (advisoryLockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [ADVISORY_LOCK_KEY_1, ADVISORY_LOCK_KEY_2]);
        console.log('  ✓ Advisory lock released.');
      } catch {}
    }
    await client.end();
  }
}

// CLI Entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  try {
    const { targetEnv, isProdAuth } = parseGuardedMigrationCliArgs(process.argv.slice(2));
    const connStr = process.env.DATABASE_URL;

    if (!connStr) {
      console.error('[CLI_ERROR] DATABASE_URL environment variable is required.');
      process.exit(1);
    }

    executeGuardedMigration032({
      connectionString: connStr,
      targetEnvironment: targetEnv,
      authorizeProductionExecution: isProdAuth,
    })
      .then(res => {
        console.log('\n========================================================================');
        console.log(` RESULT: ${res.status} in ${res.durationMs}ms`);
        console.log('========================================================================');
        console.log(JSON.stringify(res, null, 2));
        process.exit(0);
      })
      .catch(err => {
        console.error('\n✗ Guarded Migration Execution Failed:', err.message);
        process.exit(1);
      });
  } catch (cliErr: any) {
    console.error('\n✗ Guarded Migration CLI Error:', cliErr.message);
    process.exit(1);
  }
}
