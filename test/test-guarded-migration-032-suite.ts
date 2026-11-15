import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { executeGuardedMigration032 } from '../scripts/run-guarded-migration-032.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface DbAdminConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  adminDb: string;
}

function getAdminConfig(): DbAdminConfig {
  if (process.env.DATABASE_URL) {
    try {
      const u = new URL(process.env.DATABASE_URL);
      return {
        host: u.hostname,
        port: Number(u.port) || 5432,
        user: decodeURIComponent(u.username) || 'postgres',
        password: decodeURIComponent(u.password) || undefined,
        adminDb: 'postgres',
      };
    } catch {}
  }

  return {
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: process.env.PGPASSWORD || 'rehearsal_test_pass',
    adminDb: 'postgres',
  };
}

async function createIsolatedTestDb(dbName: string): Promise<string> {
  const cfg = getAdminConfig();
  
  try {
    let client = new pg.Client({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.adminDb,
    });

    try {
      await client.connect();
    } catch {
      client = new pg.Client({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: 'template1',
      });
      await client.connect();
    }

    try {
      await client.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await client.end();
    }
  } catch (err: any) {
    if (process.platform === 'win32' && (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED'))) {
      const { execSync } = await import('node:child_process');
      execSync(`wsl -d Ubuntu-24.04 sudo -u postgres createdb "${dbName}"`, { stdio: 'pipe' });
    } else {
      throw err;
    }
  }

  const pwPart = cfg.password ? `:${cfg.password}` : '';
  return `postgresql://${cfg.user}${pwPart}@${cfg.host}:${cfg.port}/${dbName}`;
}

async function dropIsolatedTestDb(dbName: string): Promise<void> {
  const cfg = getAdminConfig();

  try {
    let client = new pg.Client({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.adminDb,
    });

    try {
      await client.connect();
    } catch {
      client = new pg.Client({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: 'template1',
      });
      await client.connect();
    }

    try {
      await client.query(`
        SELECT pg_terminate_backend(pid) 
        FROM pg_stat_activity 
        WHERE datname = $1 AND pid <> pg_backend_pid()
      `, [dbName]);
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await client.end();
    }
  } catch (err: any) {
    if (process.platform === 'win32' && (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED'))) {
      const { execSync } = await import('node:child_process');
      execSync(`wsl -d Ubuntu-24.04 sudo -u postgres dropdb "${dbName}"`, { stdio: 'pipe' });
    } else {
      // ignore drop errors on cleanup
    }
  }
}

async function run() {
  console.log('========================================================================');
  console.log(' AIRA AI 2026 — GUARDED MIGRATION 032 COMPREHENSIVE SAFETY TEST SUITE');
  console.log('========================================================================\n');

  const testDbName = `aira_guard_m032_${Date.now()}`;
  console.log(`Creating isolated test database "${testDbName}"...`);
  const connStr = await createIsolatedTestDb(testDbName);

  const client = new pg.Client({ connectionString: connStr });
  await client.connect();

  try {
    // Setup baseline knex_migrations & workflow_runs
    console.log('[Setup] Setting up baseline schema...');
    await client.query(`
      CREATE TABLE knex_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        batch INTEGER NOT NULL,
        migration_time TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Insert all prior migrations 001 through 031 matching production baseline
    const dir = path.resolve(__dirname, '../packages/db/src/migrations');
    const priorFiles = fs.readdirSync(dir)
      .filter((f: string) => /^\d+_.+\.ts$/.test(f) && f !== '032_reconcile_workflow_run_artifacts.ts')
      .sort();

    for (let i = 0; i < priorFiles.length; i++) {
      await client.query('INSERT INTO knex_migrations (name, batch) VALUES ($1, $2)', [priorFiles[i], Math.min(7, Math.floor(i / 5) + 1)]);
    }

    await client.query(`
      CREATE TABLE workflow_runs (
        id VARCHAR(255) PRIMARY KEY,
        workflow_id VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO workflow_runs (id, workflow_id, status) VALUES ('run-baseline-1', 'wf-1', 'completed');
    `);
    console.log(`  ✓ Baseline established (knex_migrations seeded with ${priorFiles.length} prior migrations, workflow_runs with 1 record, no artifacts column).\n`);

    // TEST 1: Successful Guarded Execution
    console.log('--- TEST 1: Successful Guarded Execution with Bounded Locking ---');
    const res1 = await executeGuardedMigration032({
      connectionString: connStr,
      targetEnvironment: 'disposable_test',
    });
    assert.equal(res1.status, 'SUCCESS', 'Migration status must be SUCCESS');
    assert.equal(res1.applied, true, 'Migration must be applied');
    assert.equal(res1.batch, 8, 'Batch must be incremented to 8');
    assert.equal(res1.rowCount, 1, 'Pre-existing rows must be preserved');
    assert.equal(res1.columnDetails?.data_type, 'jsonb', 'Column must be jsonb');
    console.log('  ✓ TEST 1 PASSED: Migration applied cleanly, column is JSONB, row count preserved.\n');

    // TEST 2: Idempotency / Repeat Execution
    console.log('--- TEST 2: Idempotency & Repeat Execution ---');
    const res2 = await executeGuardedMigration032({
      connectionString: connStr,
      targetEnvironment: 'disposable_test',
    });
    assert.equal(res2.status, 'ALREADY_APPLIED', 'Status must be ALREADY_APPLIED');
    assert.equal(res2.applied, false, 'Should not re-apply');
    assert.equal(res2.rowCount, 1, 'Rows still preserved');
    console.log('  ✓ TEST 2 PASSED: Re-execution is clean idempotent no-op.\n');

    // TEST 3: Quarantine of Unrelated Pending Migrations (Workspace V3 Protection)
    console.log('--- TEST 3: Quarantine of Unrelated Pending Migrations ---');
    const testDbQuarantine = `aira_quarantine_test_${Date.now()}`;
    const connStrQuarantine = await createIsolatedTestDb(testDbQuarantine);
    const clientQ = new pg.Client({ connectionString: connStrQuarantine });
    await clientQ.connect();

    try {
      await clientQ.query(`
        CREATE TABLE knex_migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, batch INTEGER NOT NULL);
        INSERT INTO knex_migrations (name, batch) VALUES ('030_some_prior.ts', 6);
        CREATE TABLE workflow_runs (id VARCHAR(255) PRIMARY KEY);
      `);

      // Mock migration directory with 032_workspace_experience.ts
      const tmpDir = path.join(os.tmpdir(), `mock_migs_${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '032_reconcile_workflow_run_artifacts.ts'), '// authorized');
      fs.writeFileSync(path.join(tmpDir, '032_workspace_experience.ts'), '// unauthorized');

      try {
        await assert.rejects(
          async () => {
            await executeGuardedMigration032({
              connectionString: connStrQuarantine,
              targetEnvironment: 'disposable_test',
              migrationsDir: tmpDir,
            });
          },
          /UNEXPECTED_PENDING_MIGRATION.*032_workspace_experience\.ts/,
          'Must abort if unauthorized migrations are found pending'
        );
        console.log('  ✓ TEST 3 PASSED: Fails closed when Workspace V3 migration is pending.\n');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } finally {
      await clientQ.end();
      await dropIsolatedTestDb(testDbQuarantine);
    }

    // TEST 4: Precondition Failure (Missing Table)
    console.log('--- TEST 4: Precondition Failure when workflow_runs is missing ---');
    const testDbMissing = `aira_missing_test_${Date.now()}`;
    const connStrMissing = await createIsolatedTestDb(testDbMissing);
    const clientM = new pg.Client({ connectionString: connStrMissing });
    await clientM.connect();

    try {
      await clientM.query(`
        CREATE TABLE knex_migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, batch INTEGER NOT NULL);
      `);
      for (let i = 0; i < priorFiles.length; i++) {
        await clientM.query('INSERT INTO knex_migrations (name, batch) VALUES ($1, $2)', [priorFiles[i], Math.min(7, Math.floor(i / 5) + 1)]);
      }

      await assert.rejects(
        async () => {
          await executeGuardedMigration032({
            connectionString: connStrMissing,
            targetEnvironment: 'disposable_test',
          });
        },
        /Table "workflow_runs" does not exist in target database/,
        'Must fail closed if workflow_runs is missing'
      );
      console.log('  ✓ TEST 4 PASSED: Fails closed when workflow_runs is absent.\n');
    } finally {
      await clientM.end();
      await dropIsolatedTestDb(testDbMissing);
    }

    // TEST 5: Exclusive Advisory Lock / Runner Mutual Exclusion
    console.log('--- TEST 5: Advisory Lock Mutual Exclusion ---');
    const testDbLock = `aira_advisory_test_${Date.now()}`;
    const connStrLock = await createIsolatedTestDb(testDbLock);
    const clientL = new pg.Client({ connectionString: connStrLock });
    await clientL.connect();

    try {
      await clientL.query(`
        CREATE TABLE knex_migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, batch INTEGER NOT NULL);
      `);
      for (let i = 0; i < priorFiles.length; i++) {
        await clientL.query('INSERT INTO knex_migrations (name, batch) VALUES ($1, $2)', [priorFiles[i], Math.min(7, Math.floor(i / 5) + 1)]);
      }
      await clientL.query(`
        CREATE TABLE workflow_runs (id VARCHAR(255) PRIMARY KEY);
      `);

      // Hold lock on this db
      await clientL.query('SELECT pg_try_advisory_lock(1095325257, 32)');

      await assert.rejects(
        async () => {
          await executeGuardedMigration032({
            connectionString: connStrLock,
            targetEnvironment: 'disposable_test',
          });
        },
        /Could not acquire migration advisory lock. Another migration runner is currently active./,
        'Must fail closed if advisory lock is already held'
      );
      console.log('  ✓ TEST 5 PASSED: Concurrent runner blocked by advisory lock.\n');

      await clientL.query('SELECT pg_advisory_unlock_all()');
    } finally {
      await clientL.end();
      await dropIsolatedTestDb(testDbLock);
    }

    // TEST 6: Lock Contention & Forced Rollback with Bounded Timeout
    console.log('--- TEST 6: Lock Contention Timeout & Atomic Rollback ---');
    const testDbContention = `aira_contention_test_${Date.now()}`;
    const connStrContention = await createIsolatedTestDb(testDbContention);
    const clientC = new pg.Client({ connectionString: connStrContention });
    clientC.on('error', () => {});
    await clientC.connect();

    const clientBlocker = new pg.Client({ connectionString: connStrContention });
    clientBlocker.on('error', () => {});
    await clientBlocker.connect();

    try {
      await clientC.query(`
        CREATE TABLE knex_migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, batch INTEGER NOT NULL);
      `);
      for (let i = 0; i < priorFiles.length; i++) {
        await clientC.query('INSERT INTO knex_migrations (name, batch) VALUES ($1, $2)', [priorFiles[i], Math.min(7, Math.floor(i / 5) + 1)]);
      }
      await clientC.query(`
        CREATE TABLE workflow_runs (id VARCHAR(255) PRIMARY KEY, status TEXT);
        INSERT INTO workflow_runs (id, status) VALUES ('run-contention-1', 'active');
      `);

      // Hold ACCESS EXCLUSIVE lock in blocker transaction
      await clientBlocker.query('BEGIN');
      await clientBlocker.query('LOCK TABLE workflow_runs IN ACCESS EXCLUSIVE MODE');
      console.log('  -> Held ACCESS EXCLUSIVE lock on workflow_runs in background transaction.');

      // Run guarded migration with 1s timeout
      const startMs = Date.now();
      let threw = false;
      try {
        await executeGuardedMigration032({
          connectionString: connStrContention,
          targetEnvironment: 'disposable_test',
          customLockTimeout: '1s',
          customStatementTimeout: '2s',
        });
      } catch (err: any) {
        threw = true;
        const elapsed = Date.now() - startMs;
        console.log(`  -> Migration aborted in ${elapsed}ms: ${err.message}`);
        assert.ok(err.message.includes('lock timeout'), `Must fail due to lock timeout, got: ${err.message}`);
        assert.ok(elapsed >= 900 && elapsed < 3500, `Lock timeout must abort in ~1s, took ${elapsed}ms`);
      }
      assert.ok(threw, 'Must throw error on lock timeout');

      // Release blocker
      await clientBlocker.query('ROLLBACK');

      // Verify that NO partial DDL or ledger write leaked
      const postCol = await clientC.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'workflow_runs' AND column_name = 'artifacts'
      `);
      assert.equal(postCol.rows.length, 0, 'Rolled back transaction must leave ZERO columns');

      const postLedger = await clientC.query(`
        SELECT name FROM knex_migrations WHERE name = '032_reconcile_workflow_run_artifacts.ts'
      `);
      assert.equal(postLedger.rows.length, 0, 'Rolled back transaction must leave ZERO ledger entries');

      const postRows = await clientC.query('SELECT count(*)::int as count FROM workflow_runs');
      assert.equal(postRows.rows[0].count, 1, 'Data must be completely intact');

      console.log('  ✓ TEST 6 PASSED: Lock contention timeout cleanly triggers ROLLBACK with zero corrupt state.\n');
    } finally {
      await clientBlocker.end();
      await clientC.end();
      await dropIsolatedTestDb(testDbContention);
    }

    // TEST 7: Unauthorized Production Targeting Fail-Closed
    console.log('--- TEST 7: Unauthorized Production Targeting Fail-Closed ---');
    await assert.rejects(
      async () => {
        await executeGuardedMigration032({
          connectionString: connStr,
          targetEnvironment: 'production',
          authorizeProductionExecution: false,
        });
      },
      /Production execution is NOT authorized/,
      'Must fail closed when target is production but authorize flag is missing'
    );
    console.log('  ✓ TEST 7 PASSED: Fails closed when production is targeted without explicit flag.\n');

    // TEST 8: Schema Corruption Detection when 032 is Recorded but Artifacts Missing
    console.log('--- TEST 8: Schema Corruption Detection (Recorded in Ledger but Column Absent) ---');
    const testDbCorrupt = `aira_corrupt_test_${Date.now()}`;
    const connStrCorrupt = await createIsolatedTestDb(testDbCorrupt);
    const clientCorrupt = new pg.Client({ connectionString: connStrCorrupt });
    await clientCorrupt.connect();

    try {
      await clientCorrupt.query(`
        CREATE TABLE knex_migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, batch INTEGER NOT NULL);
      `);
      for (let i = 0; i < priorFiles.length; i++) {
        await clientCorrupt.query('INSERT INTO knex_migrations (name, batch) VALUES ($1, $2)', [priorFiles[i], Math.min(7, Math.floor(i / 5) + 1)]);
      }
      await clientCorrupt.query(`
        INSERT INTO knex_migrations (name, batch) VALUES ('032_reconcile_workflow_run_artifacts.ts', 8);
        CREATE TABLE workflow_runs (id VARCHAR(255) PRIMARY KEY);
      `);

      await assert.rejects(
        async () => {
          await executeGuardedMigration032({
            connectionString: connStrCorrupt,
            targetEnvironment: 'disposable_test',
          });
        },
        /CORRUPT_SCHEMA_ERROR.*workflow_runs\.artifacts.*column is missing/,
        'Must fail closed when ledger says 032 applied but column is missing'
      );
      console.log('  ✓ TEST 8 PASSED: Fails closed when ledger records 032 but column is absent.\n');
    } finally {
      await clientCorrupt.end();
      await dropIsolatedTestDb(testDbCorrupt);
    }

    // TEST 9: Missing Migration Directory / File Fail-Closed
    console.log('--- TEST 9: Missing Migration Directory / File Fail-Closed ---');
    const nonExistentDir = path.join(os.tmpdir(), `non_existent_migs_${Date.now()}`);
    await assert.rejects(
      async () => {
        await executeGuardedMigration032({
          connectionString: connStr,
          targetEnvironment: 'disposable_test',
          migrationsDir: nonExistentDir,
        });
      },
      /CATALOG_HALT.*does not exist/,
      'Must fail closed when migrations directory is missing'
    );
    console.log('  ✓ TEST 9 PASSED: Fails closed when migrations directory is absent.\n');

    // TEST 10: Concurrent Knex Migration Lock Detection
    console.log('--- TEST 10: Concurrent Knex Migration Lock Active Fail-Closed ---');
    const testDbKnexLock = `aira_knex_lock_test_${Date.now()}`;
    const connStrKnexLock = await createIsolatedTestDb(testDbKnexLock);
    const clientK = new pg.Client({ connectionString: connStrKnexLock });
    await clientK.connect();

    try {
      await clientK.query(`
        CREATE TABLE knex_migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, batch INTEGER NOT NULL);
      `);
      for (let i = 0; i < priorFiles.length; i++) {
        await clientK.query('INSERT INTO knex_migrations (name, batch) VALUES ($1, $2)', [priorFiles[i], Math.min(7, Math.floor(i / 5) + 1)]);
      }
      await clientK.query(`
        CREATE TABLE knex_migrations_lock (index INTEGER PRIMARY KEY, is_locked INTEGER);
        INSERT INTO knex_migrations_lock (index, is_locked) VALUES (1, 1);
        CREATE TABLE workflow_runs (id VARCHAR(255) PRIMARY KEY);
      `);

      await assert.rejects(
        async () => {
          await executeGuardedMigration032({
            connectionString: connStrKnexLock,
            targetEnvironment: 'disposable_test',
          });
        },
        /KNEX_LOCK_ACTIVE.*Another Knex migration process is holding knex_migrations_lock/,
        'Must fail closed if knex_migrations_lock is_locked=1'
      );
      console.log('  ✓ TEST 10 PASSED: Fails closed when Knex migration lock is active.\n');
    } finally {
      await clientK.end();
      await dropIsolatedTestDb(testDbKnexLock);
    }

    console.log('========================================================================');
    console.log(' ALL 10 GUARDED MIGRATION 032 TESTS PASSED: 100% CERTIFIED');
    console.log('========================================================================\n');
  } finally {
    await client.end();
    console.log(`Cleaning up test database "${testDbName}"...`);
    await dropIsolatedTestDb(testDbName);
    console.log('Cleanup complete.');
  }
}

run().catch(err => {
  console.error('\n✗ Suite Failure:', err);
  process.exit(1);
});
