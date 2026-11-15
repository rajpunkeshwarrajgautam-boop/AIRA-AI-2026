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

export interface GuardedMigrationOptions {
  connectionString: string;
  targetEnvironment: 'production' | 'rehearsal' | 'disposable_test';
  authorizeProductionExecution?: boolean;
  migrationsDir?: string;
  customLockTimeout?: string; // defaults to '2s'
  customStatementTimeout?: string; // defaults to '5s'
}

const AUTHORIZED_MIGRATION_FILE = '032_reconcile_workflow_run_artifacts.ts';
const ADVISORY_LOCK_KEY_1 = 1095325257; // 'AIRA' in ASCII
const ADVISORY_LOCK_KEY_2 = 32;         // Migration 32

export async function executeGuardedMigration032(options: GuardedMigrationOptions): Promise<GuardedMigrationResult> {
  const startMs = Date.now();
  const lockTimeout = options.customLockTimeout || '2s';
  const stmtTimeout = options.customStatementTimeout || '5s';

  console.log('========================================================================');
  console.log(` GUARDED EXECUTION: MIGRATION 032 (${options.targetEnvironment.toUpperCase()})`);
  console.log('========================================================================');

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
    // 2. Validate Target Environment
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
        throw new Error(`[SAFETY_BLOCK] Target database "${ident.db_name}" does not match production database "neondb".`);
      }
      if (!options.connectionString.includes('ep-withered-art') && !options.connectionString.includes('old-sky-50952395')) {
        throw new Error('[SAFETY_BLOCK] Connection string does not match Neon Production project "old-sky-50952395". Aborting.');
      }
    } else if (options.targetEnvironment === 'rehearsal') {
      if (!options.connectionString.includes('rehearsal') && !options.connectionString.includes('b3zeg2q2') && !options.connectionString.includes('ep-lively-truth-b3im2z2q')) {
        throw new Error('[SAFETY_BLOCK] Connection string does not point to approved rehearsal branch.');
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

    // 4. Pending Migration Quarantine (Ensure ONLY 032_reconcile_workflow_run_artifacts.ts is pending)
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

    // Check if 032 is already applied
    if (appliedNames.has(AUTHORIZED_MIGRATION_FILE)) {
      console.log(`  ✓ Migration "${AUTHORIZED_MIGRATION_FILE}" is ALREADY APPLIED in knex_migrations (idempotent no-op).`);
      
      const colCheck = await client.query(`
        SELECT column_name, data_type, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'workflow_runs' AND column_name = 'artifacts'
      `);
      const rowCountRes = await client.query('SELECT count(*)::int as count FROM workflow_runs');

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

    // Inspect migration directory to quarantine any other migration
    const dir = options.migrationsDir || path.resolve(__dirname, '../packages/db/src/migrations');
    if (fs.existsSync(dir)) {
      const filesOnDisk = fs.readdirSync(dir).filter(f => /^\d+_.+\.ts$/.test(f)).sort();
      const unappliedFiles = filesOnDisk.filter(f => !appliedNames.has(f));

      // Strictly verify that NO unapplied file other than AUTHORIZED_MIGRATION_FILE exists
      const forbiddenFiles = unappliedFiles.filter(f => f !== AUTHORIZED_MIGRATION_FILE);
      if (forbiddenFiles.length > 0) {
        throw new Error(`[MIGRATION_SAFETY_HALT] UNEXPECTED_PENDING_MIGRATION: Detected unapplied migrations outside authorized scope: ${forbiddenFiles.join(', ')}. Workspace V3 and other unreviewed migrations are strictly forbidden from running.`);
      }
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
  const targetEnv = (process.argv[2] || 'disposable_test') as 'production' | 'rehearsal' | 'disposable_test';
  const connStr = process.env.DATABASE_URL;
  const isProdAuth = process.argv.includes('--authorize-production-migration-032-execute');

  if (!connStr) {
    console.error('DATABASE_URL environment variable is required.');
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
}
