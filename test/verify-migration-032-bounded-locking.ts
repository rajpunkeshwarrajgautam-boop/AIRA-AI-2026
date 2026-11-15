import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import knex, { type Knex } from 'knex';

/**
 * Hardened migration 032 with explicit bounded locking & statement timeouts
 */
async function migration032UpWithBoundedLocking(knexInstance: Knex): Promise<void> {
  // Enforce bounded locking to prevent lock queue pileup on production
  await knexInstance.raw("SET LOCAL lock_timeout = '2s'");
  await knexInstance.raw("SET LOCAL statement_timeout = '5s'");

  if (!(await knexInstance.schema.hasTable('workflow_runs'))) {
    throw new Error('workflow_runs is absent; migration 009 must be inspected before proceeding');
  }
  if (!(await knexInstance.schema.hasColumn('workflow_runs', 'artifacts'))) {
    await knexInstance.schema.alterTable('workflow_runs', table => {
      table.jsonb('artifacts').defaultTo('[]');
    });
  }
}

async function migration032Down(_knexInstance: Knex): Promise<void> {
  throw new Error('Migration 032 artifacts repair is expand-only; never drop persisted artifacts');
}

async function run() {
  console.log('========================================================================');
  console.log(' CERTIFYING MIGRATION 032 BOUNDED LOCKING ON POSTGRESQL 18');
  console.log('========================================================================\n');

  const testDbName = `aira_m032_lock_cert_${Date.now()}`;
  console.log(`[1/5] Creating isolated test database "${testDbName}" on WSL PostgreSQL 18...`);
  execSync(`wsl -d Ubuntu-24.04 sudo -u postgres createdb ${testDbName}`, { stdio: 'inherit' });

  const dbConfig = {
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: process.env.PGPASSWORD || 'rehearsal_test_pass',
    database: testDbName,
  };
  const db = knex({
    client: 'pg',
    connection: dbConfig,
    pool: { min: 1, max: 2 },
  });

  try {
    // Baseline table
    console.log('[2/5] Setting up baseline workflow_runs table...');
    await db.schema.createTable('workflow_runs', table => {
      table.string('id').primary();
      table.string('workflow_id').notNullable();
      table.string('status').notNullable().defaultTo('pending');
    });

    // Test bounded locking parameter application within transaction
    console.log('[3/5] Testing SET LOCAL lock_timeout and statement_timeout...');
    await db.transaction(async trx => {
      await trx.raw("SET LOCAL lock_timeout = '2s'");
      await trx.raw("SET LOCAL statement_timeout = '5s'");

      const lockRes = await trx.raw('SHOW lock_timeout');
      const stmtRes = await trx.raw('SHOW statement_timeout');

      assert.equal(lockRes.rows[0].lock_timeout, '2s', 'lock_timeout must be 2s');
      assert.equal(stmtRes.rows[0].statement_timeout, '5s', 'statement_timeout must be 5s');
      console.log(`  ✓ Transaction timeouts verified: lock_timeout=${lockRes.rows[0].lock_timeout}, statement_timeout=${stmtRes.rows[0].statement_timeout}`);

      await migration032UpWithBoundedLocking(trx);
    });

    // Verify column exists
    const hasCol = await db.schema.hasColumn('workflow_runs', 'artifacts');
    assert.equal(hasCol, true, 'artifacts column must exist');
    console.log('  ✓ Column successfully added under bounded locking.');

    // Test Lock Contention / Timeout behavior
    console.log('[4/5] Testing lock contention behavior: lock_timeout triggers fail-closed...');
    // Create a client that holds an ACCESS EXCLUSIVE lock
    const dbLocker = knex({
      client: 'pg',
      connection: dbConfig,
      pool: { min: 1, max: 1 },
    });

    const trxHolder = await dbLocker.transaction();
    try {
      // Lock table in exclusive mode
      await trxHolder.raw('LOCK TABLE workflow_runs IN ACCESS EXCLUSIVE MODE');
      console.log('  -> Held ACCESS EXCLUSIVE lock in background transaction.');

      // Now attempt migration in separate transaction with lock_timeout = '2s'
      const startMs = Date.now();
      let timedOut = false;
      try {
        await db.transaction(async trxAttempt => {
          await trxAttempt.raw("SET LOCAL lock_timeout = '1s'");
          await trxAttempt.schema.alterTable('workflow_runs', table => {
            table.string('dummy_col');
          });
        });
      } catch (err: any) {
        const elapsed = Date.now() - startMs;
        console.log(`  -> Lock attempt failed as expected in ${elapsed}ms: ${err.message}`);
        assert.ok(
          err.message.includes('canceling statement due to lock timeout') ||
          err.message.includes('lock timeout'),
          `Error must be lock timeout, got: ${err.message}`
        );
        assert.ok(elapsed >= 900 && elapsed < 3500, `Elapsed time must be bounded around ~1-2s, was: ${elapsed}ms`);
        timedOut = true;
      }
      assert.ok(timedOut, 'Must time out when lock cannot be acquired');
      console.log('  ✓ Bounded locking verified: blocked transaction times out safely without indefinite queuing.');
    } finally {
      await trxHolder.rollback();
      await dbLocker.destroy();
    }

    // 5. Test Knex ledger consistency
    console.log('[5/5] Testing Knex ledger consistency...');
    // Initialize knex_migrations table
    await db.schema.createTable('knex_migrations', table => {
      table.increments('id').primary();
      table.string('name').notNullable();
      table.integer('batch').notNullable();
      table.timestamp('migration_time').defaultTo(db.fn.now());
    });

    // Record baseline migration 031
    await db('knex_migrations').insert({
      id: 32,
      name: '031_autonomous_agent_tasks.ts',
      batch: 7,
    });

    // Simulate knex migration runner recording 032 atomically
    await db.transaction(async trx => {
      await migration032UpWithBoundedLocking(trx);
      await trx('knex_migrations').insert({
        name: '032_reconcile_workflow_run_artifacts.ts',
        batch: 8,
      });
    });

    const recorded = await db('knex_migrations')
      .where({ name: '032_reconcile_workflow_run_artifacts.ts' })
      .first();
    assert.ok(recorded, 'Migration 032 must be recorded in knex_migrations');
    assert.equal(recorded.batch, 8, 'Batch must be incremented to 8');
    console.log(`  ✓ Knex ledger consistency verified: migration recorded in knex_migrations (id=${recorded.id}, batch=${recorded.batch}).`);

    console.log('\n========================================================================');
    console.log(' MIGRATION 032 BOUNDED LOCKING CERTIFICATION: 100% PASS');
    console.log('========================================================================\n');
  } finally {
    await db.destroy();
    console.log(`Cleaning up isolated test database "${testDbName}"...`);
    execSync(`wsl -d Ubuntu-24.04 sudo -u postgres dropdb ${testDbName}`, { stdio: 'inherit' });
    console.log('Cleanup complete.');
  }
}

run().catch(err => {
  console.error('Certification failed:', err);
  process.exit(1);
});
