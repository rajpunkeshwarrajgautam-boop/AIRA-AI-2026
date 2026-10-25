import assert from 'node:assert/strict';
import knex, { Knex } from 'knex';
import { reconcileRunPromptColumn } from '../packages/db/src/migrations/024_reconcile_runs_prompt_text.js';

const connectionString = process.env.ISOLATED_TEST_DATABASE_URL;

if (!connectionString) {
  console.error('FAIL: ISOLATED_TEST_DATABASE_URL is required.');
  process.exit(1);
}

// Security guard: ensure we are NOT touching production Neon (old-sky-50952395)
const parsedUrl = new URL(connectionString);
if (parsedUrl.hostname.includes('old-sky-50952395')) {
  console.error('[SECURITY FATAL] Attempted to connect to production Neon old-sky-50952395. Aborting.');
  process.exit(1);
}

const db = knex({
  client: 'pg',
  connection: {
    connectionString,
    ssl: { rejectUnauthorized: false }
  },
  pool: { min: 1, max: 2 }
});

async function main() {
  console.log('[STAGE 1] Verifying isolated database identity...');
  const identity = await db.raw(`
    SELECT current_database() AS db_name,
           current_user AS db_user,
           current_setting('server_version') AS server_version,
           inet_server_addr() AS server_addr
  `);
  const row = identity.rows[0];
  console.log(`Identity: database=${row.db_name}, user=${row.db_user}, host=${parsedUrl.hostname}`);

  // Confirm runs table presence
  const hasRuns = await db.schema.hasTable('runs');
  console.log(`Table public.runs exists: ${hasRuns}`);

  console.log('\n[STAGE 2] Reproducing 255-character limitation (SQLSTATE 22001)...');
  const testTableName = 'runs_schema_drift_repro';
  await db.schema.dropTableIfExists(testTableName);
  await db.schema.createTable(testTableName, (table) => {
    table.increments('id').primary();
    table.string('prompt', 255).notNullable();
  });

  const shortPrompt = 'A'.repeat(255);
  await db(testTableName).insert({ prompt: shortPrompt });
  console.log('PASS: 255-character prompt inserted successfully');

  let failedWith22001 = false;
  try {
    const longPrompt256 = 'B'.repeat(256);
    await db(testTableName).insert({ prompt: longPrompt256 });
  } catch (err: any) {
    if (err.code === '22001') {
      failedWith22001 = true;
      console.log(`PASS: 256-character prompt failed with expected SQLSTATE 22001 (${err.message})`);
    } else {
      console.error('Unexpected error code:', err);
    }
  }
  assert.equal(failedWith22001, true, 'Must fail with SQLSTATE 22001 on varchar(255)');

  console.log('\n[STAGE 3] Applying migration 024 reconcileRunPromptColumn...');
  await reconcileRunPromptColumn(db as any, testTableName);

  const colInfo = await db('information_schema.columns')
    .where({ table_schema: 'public', table_name: testTableName, column_name: 'prompt' })
    .first('data_type');
  console.log(`Column public.${testTableName}.prompt data_type after repair: ${colInfo?.data_type}`);
  assert.equal(colInfo?.data_type, 'text', 'Column must be TEXT');

  // Verify initial 255-char prompt was preserved without truncation
  const preserved = await db(testTableName).where({ id: 1 }).first('prompt');
  assert.equal(preserved?.prompt, shortPrompt, 'Original 255-char prompt preserved intact');
  console.log('PASS: Pre-existing data preserved intact');

  console.log('\n[STAGE 4] Testing long prompt persistence (256, 1024, 10240, 32768 chars)...');
  const testSizes = [256, 1024, 10_240, 32_768];
  for (const size of testSizes) {
    const payload = `${size}-` + 'X'.repeat(size - String(size).length - 1);
    assert.equal(payload.length, size);

    const startTime = Date.now();
    const [inserted] = await db(testTableName).insert({ prompt: payload }).returning('id');
    const writeLatency = Date.now() - startTime;

    const readStart = Date.now();
    const retrieved = await db(testTableName).where({ id: inserted.id }).first('prompt');
    const readLatency = Date.now() - readStart;

    assert.equal(retrieved?.prompt, payload, `Payload of size ${size} must round-trip exactly`);
    assert.equal(retrieved?.prompt.length, size, `Length must be exactly ${size}`);
    console.log(`PASS: ${size}-char prompt persisted and retrieved accurately (write: ${writeLatency}ms, read: ${readLatency}ms)`);
  }

  console.log('\n[STAGE 5] Testing idempotency of migration 024...');
  await reconcileRunPromptColumn(db as any, testTableName);
  const colInfo2 = await db('information_schema.columns')
    .where({ table_schema: 'public', table_name: testTableName, column_name: 'prompt' })
    .first('data_type');
  assert.equal(colInfo2?.data_type, 'text', 'Column remains TEXT');
  console.log('PASS: Re-applying reconcileRunPromptColumn is a safe no-op');

  console.log('\n[STAGE 6] Testing against actual runs table in isolated test branch...');
  if (hasRuns) {
    const runsCol = await db('information_schema.columns')
      .where({ table_schema: 'public', table_name: 'runs', column_name: 'prompt' })
      .first('data_type');
    console.log(`Current public.runs.prompt in isolated branch: ${runsCol?.data_type}`);

    await reconcileRunPromptColumn(db as any, 'runs');

    const runsColAfter = await db('information_schema.columns')
      .where({ table_schema: 'public', table_name: 'runs', column_name: 'prompt' })
      .first('data_type');
    console.log(`public.runs.prompt after reconcile: ${runsColAfter?.data_type}`);
    assert.equal(runsColAfter?.data_type, 'text');
  }

  // Cleanup test table
  await db.schema.dropTableIfExists(testTableName);
  console.log(`PASS: Dropped temporary table ${testTableName}`);

  console.log('\n========================================');
  console.log('ISOLATED NEON CERTIFICATION: ALL CHECKS PASS');
  console.log('========================================');
}

main()
  .catch((err) => {
    console.error('ISOLATED NEON CERTIFICATION FAILED:', err);
    process.exit(1);
  })
  .finally(async () => {
    await db.destroy();
  });
