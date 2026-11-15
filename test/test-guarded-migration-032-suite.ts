import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { executeGuardedMigration032 } from '../scripts/run-guarded-migration-032.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  console.log('========================================================================');
  console.log(' AIRA AI 2026 — GUARDED MIGRATION 032 COMPREHENSIVE SAFETY TEST SUITE');
  console.log('========================================================================\n');

  const testDbName = `aira_guard_m032_${Date.now()}`;
  console.log(`Creating isolated test database "${testDbName}" on WSL PostgreSQL 18...`);
  execSync(`wsl -d Ubuntu-24.04 sudo -u postgres createdb "${testDbName}"`, { stdio: 'inherit' });

  const connStr = `postgresql://postgres:rehearsal_test_pass@127.0.0.1:5432/${testDbName}`;

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
    // Simulate a fresh database where an unauthorized migration is present
    const testDbQuarantine = `aira_quarantine_test_${Date.now()}`;
    execSync(`wsl -d Ubuntu-24.04 sudo -u postgres createdb "${testDbQuarantine}"`, { stdio: 'inherit' });
    const connStrQuarantine = `postgresql://postgres:rehearsal_test_pass@127.0.0.1:5432/${testDbQuarantine}`;
    const clientQ = new pg.Client({ connectionString: connStrQuarantine });
    await clientQ.connect();

    try {
      await clientQ.query(`
        CREATE TABLE knex_migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, batch INTEGER NOT NULL);
        INSERT INTO knex_migrations (name, batch) VALUES ('030_some_prior.ts', 6);
        CREATE TABLE workflow_runs (id VARCHAR(255) PRIMARY KEY);
      `);

      // Mock migration directory with 032_workspace_experience.ts
      const tmpDir = `C:\\Users\\WORKSTATION\\AppData\\Local\\Temp\\mock_migs_${Date.now()}`;
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(`${tmpDir}\\032_reconcile_workflow_run_artifacts.ts`, '// authorized');
      fs.writeFileSync(`${tmpDir}\\032_workspace_experience.ts`, '// unauthorized');

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
      await clientQ.end();
      execSync(`wsl -d Ubuntu-24.04 sudo -u postgres dropdb "${testDbQuarantine}"`, { stdio: 'inherit' });
    }

    // TEST 4: Precondition Failure (Missing Table)
    console.log('--- TEST 4: Precondition Failure when workflow_runs is missing ---');
    const testDbMissing = `aira_missing_test_${Date.now()}`;
    execSync(`wsl -d Ubuntu-24.04 sudo -u postgres createdb "${testDbMissing}"`, { stdio: 'inherit' });
    const connStrMissing = `postgresql://postgres:rehearsal_test_pass@127.0.0.1:5432/${testDbMissing}`;
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
      execSync(`wsl -d Ubuntu-24.04 sudo -u postgres dropdb "${testDbMissing}"`, { stdio: 'inherit' });
    }

    // TEST 5: Exclusive Advisory Lock / Runner Mutual Exclusion
    console.log('--- TEST 5: Advisory Lock Mutual Exclusion ---');
    // Acquire the advisory lock in a background client
    const testDbLock = `aira_advisory_test_${Date.now()}`;
    execSync(`wsl -d Ubuntu-24.04 sudo -u postgres createdb "${testDbLock}"`, { stdio: 'inherit' });
    const connStrLock = `postgresql://postgres:rehearsal_test_pass@127.0.0.1:5432/${testDbLock}`;
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
      execSync(`wsl -d Ubuntu-24.04 sudo -u postgres dropdb "${testDbLock}"`, { stdio: 'inherit' });
    }

    // TEST 6: Lock Contention & Forced Rollback with Bounded Timeout
    console.log('--- TEST 6: Lock Contention Timeout & Atomic Rollback ---');
    const testDbContention = `aira_contention_test_${Date.now()}`;
    execSync(`wsl -d Ubuntu-24.04 sudo -u postgres createdb "${testDbContention}"`, { stdio: 'inherit' });
    const connStrContention = `postgresql://postgres:rehearsal_test_pass@127.0.0.1:5432/${testDbContention}`;
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

      // Verify transaction rollback: knex_migrations must NOT have 032, workflow_runs must NOT have artifacts
      const migCheck = await clientC.query("SELECT * FROM knex_migrations WHERE name LIKE '%032%'");
      assert.equal(migCheck.rows.length, 0, 'Ledger must not contain 032 after rollback');

      const colCheck = await clientC.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'workflow_runs' AND column_name = 'artifacts'
      `);
      assert.equal(colCheck.rows.length, 0, 'Column artifacts must not exist after rollback');

      const rowCheck = await clientC.query('SELECT count(*)::int as count FROM workflow_runs');
      assert.equal(rowCheck.rows[0].count, 1, 'Row count must be preserved');

      console.log('  ✓ TEST 6 PASSED: Lock contention timeout cleanly triggers ROLLBACK with zero corrupt state.\n');
    } finally {
      await clientBlocker.end();
      await clientC.end();
      execSync(`wsl -d Ubuntu-24.04 sudo -u postgres dropdb "${testDbContention}"`, { stdio: 'inherit' });
    }

    // TEST 7: Unauthorized Production Targeting Protection
    console.log('--- TEST 7: Unauthorized Production Targeting Fail-Closed ---');
    await assert.rejects(
      async () => {
        await executeGuardedMigration032({
          connectionString: connStr,
          targetEnvironment: 'production',
          authorizeProductionExecution: false, // NOT authorized
        });
      },
      /Production execution is NOT authorized. Missing explicit --authorize-production-migration-032-execute flag./,
      'Must refuse production targeting without authorization flag'
    );
    console.log('  ✓ TEST 7 PASSED: Fails closed when production is targeted without explicit flag.\n');

    console.log('========================================================================');
    console.log(' ALL 7 GUARDED MIGRATION 032 TESTS PASSED: 100% CERTIFIED');
    console.log('========================================================================\n');
  } finally {
    await client.end();
    console.log(`Cleaning up test database "${testDbName}"...`);
    execSync(`wsl -d Ubuntu-24.04 sudo -u postgres dropdb "${testDbName}"`, { stdio: 'inherit' });
    console.log('Cleanup complete.');
  }
}

run().catch(err => {
  console.error('Safety suite failed:', err);
  process.exit(1);
});
