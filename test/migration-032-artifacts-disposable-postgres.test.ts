import assert from 'node:assert/strict';
import test from 'node:test';
import knexFactory from 'knex';
import { up, down } from '../packages/db/src/migrations/032_reconcile_workflow_run_artifacts.js';

// Never connect to a shared Neon, staging, or production database.
// This test executes ALTER TABLE/DROP COLUMN only inside a rolled-back
// transaction in the GitHub Actions internal-network disposable PostgreSQL.
test('migration 032 repairs observed production drift and preserves all rows', async () => {
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.CI_DISPOSABLE_DATABASE, 'true');
  assert.equal(process.env.AIRA_POSTGRES_CERTIFICATION, '1');
  const url = new URL(process.env.DATABASE_URL || '');
  assert.equal(url.hostname, 'postgres', 'Must use the Docker internal network alias');
  assert.match(url.pathname, /^\/aira_ci_[0-9]+-[0-9]+$/, 'Unexpected database name');
  assert.equal(url.pathname.slice(1), process.env.CI_EXPECTED_DATABASE_NAME);
  assert.equal(decodeURIComponent(url.username), process.env.CI_EXPECTED_DATABASE_USER);
  const db = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  try {
    const identity = await db.raw('select current_database() as database_name, current_user as role_name');
    assert.equal(identity.rows[0].database_name, process.env.CI_EXPECTED_DATABASE_NAME);
    assert.equal(identity.rows[0].role_name, process.env.CI_EXPECTED_DATABASE_USER);
    assert.equal(await db.schema.hasColumn('workflow_runs', 'artifacts'), true,
      'Baseline full migrations must create artifacts');
    const countBefore = await db('workflow_runs').count('* as count').first();
    const abort = new Error('ROLLBACK_TEST_ONLY');
    await assert.rejects(
      db.transaction(async trx => {
        // Deliberately simulate the observed missing column ONLY inside a
        // disposable transaction; rollback restores the original test schema.
        await trx.schema.alterTable('workflow_runs', table => { table.dropColumn('artifacts'); });
        assert.equal(await trx.schema.hasColumn('workflow_runs', 'artifacts'), false);
        await up(trx);
        await up(trx); // idempotency
        const result = await trx('information_schema.columns')
          .select('data_type', 'column_default', 'is_nullable')
          .where({ table_schema: 'public', table_name: 'workflow_runs', column_name: 'artifacts' })
          .first();
        assert.equal(result?.data_type, 'jsonb');
        assert.match(result?.column_default || '', /'\[\]'::jsonb/);
        assert.equal(result?.is_nullable, 'YES', 'Match migration 010 nullable semantics');
        const countDuring = await trx('workflow_runs').count('* as count').first();
        assert.equal(String(countDuring?.count), String(countBefore?.count));
        await assert.rejects(down(trx), /expand-only/);
        throw abort;
      }),
      error => error === abort
    );
    assert.equal(await db.schema.hasColumn('workflow_runs', 'artifacts'), true,
      'Transaction rollback must restore original test schema');
    const countAfter = await db('workflow_runs').count('* as count').first();
    assert.equal(String(countAfter?.count), String(countBefore?.count));
  } finally {
    await db.destroy();
  }
});
