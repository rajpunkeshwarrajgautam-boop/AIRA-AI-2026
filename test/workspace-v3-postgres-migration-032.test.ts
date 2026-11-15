import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { db } from '../packages/db/src/index.js';
import { up as migrateWorkspace } from '../packages/db/src/migrations/032_workspace_experience.js';

if (process.env.AIRA_POSTGRES_CERTIFICATION !== '1' ||
    process.env.CI_DISPOSABLE_DATABASE !== 'true') {
  throw new Error('Migration 032 PostgreSQL rehearsal requires an isolated CI database');
}

// Inspect the actual PostgreSQL connection before any write, never trust only
// environment labels. The guard rejects Neon/production/staging endpoints.
execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });

test('Migration 032 restores missing workflow artifacts without changing persistent data', async () => {
  const migrationRecord = await db('knex_migrations')
    .where({ name: '010_workflow_runs_artifacts.ts' }).first();
  assert.ok(migrationRecord, 'Prior migration 010 must be recorded');
  assert.equal(await db.schema.hasColumn('workflow_runs', 'artifacts'), true);

  const originalRunCount = await db('workflow_runs').count<{ count: string }>('* as count').first();
  const rollbackMarker = new Error('ROLL_BACK_ISOLATED_REHEARSAL');

  // All DDL and any migration side effects are rolled back, even if assertions
  // fail. A fresh database migration was performed by CI before this check.
  await assert.rejects(
    db.transaction(async trx => {
      await trx.schema.alterTable('workflow_runs', table => table.dropColumn('artifacts'));
      assert.equal(await trx.schema.hasColumn('workflow_runs', 'artifacts'), false);

      // Reproduce production drift: migration 010 is recorded, column absent.
      await migrateWorkspace(trx);
      assert.equal(await trx.schema.hasColumn('workflow_runs', 'artifacts'), true);

      const [{ column_default: columnDefault, data_type: dataType }] = await trx
        .select('column_default', 'data_type')
        .from('information_schema.columns')
        .where({ table_schema: 'public', table_name: 'workflow_runs', column_name: 'artifacts' });
      assert.equal(dataType, 'jsonb');
      assert.match(String(columnDefault), /'\[\]'::jsonb/);

      // Reapplying the expansion must not erase or duplicate existing schema.
      await migrateWorkspace(trx);
      const rows = await trx('information_schema.columns')
        .where({ table_schema: 'public', table_name: 'workflow_runs', column_name: 'artifacts' });
      assert.equal(rows.length, 1);
      const runCount = await trx('workflow_runs').count<{ count: string }>('* as count').first();
      assert.equal(String(runCount?.count), String(originalRunCount?.count));
      throw rollbackMarker;
    }),
    err => err === rollbackMarker,
  );

  // Verify original schema and migration bookkeeping survived the rehearsal.
  assert.equal(await db.schema.hasColumn('workflow_runs', 'artifacts'), true);
  const sameRecord = await db('knex_migrations').where({ name: '010_workflow_runs_artifacts.ts' }).first();
  assert.equal(sameRecord?.id, migrationRecord.id);
});

test.after(async () => { await db.destroy(); });
