import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, runMigrations, closeDb } from '../packages/db/src/index.js';
import { reconcileRunPromptColumn } from '../packages/db/src/migrations/024_reconcile_runs_prompt_text.js';

async function main(): Promise<void> {
  await runMigrations();
  const tableName = `runs_prompt_repair_ci_${randomUUID().replace(/-/g, '').slice(0, 14)}`;

  // Exercise the drift-repair path against a disposable table. No production
  // or shared existing run data is modified during certification.
  await db.transaction(async (trx) => {
    await trx.schema.createTable(tableName, table => {
      table.increments('id').primary();
      table.string('prompt', 255).notNullable();
    });

    await reconcileRunPromptColumn(trx as any, tableName);
    await reconcileRunPromptColumn(trx as any, tableName); // idempotence

    const column = await trx('information_schema.columns')
      .where({ table_schema: 'public', table_name: tableName, column_name: 'prompt' })
      .first('data_type');
    assert.equal(column?.data_type, 'text');

    const longPrompt = 'A'.repeat(10_240);
    await trx(tableName).insert({ prompt: longPrompt });
    const stored = await trx(tableName).first('prompt');
    assert.equal(stored?.prompt, longPrompt);

    await trx.schema.dropTable(tableName);
  });
  console.log('PASS: repair widens varchar(255) to text, is idempotent, and persists 10240-character prompts');
}

main().finally(() => closeDb()).catch(err => {
  console.error('Run prompt schema drift repair certification FAILED', err);
  process.exitCode = 1;
});
