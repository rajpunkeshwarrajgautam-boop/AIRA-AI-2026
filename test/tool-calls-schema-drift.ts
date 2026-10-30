import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import knex from 'knex';
import { reconcileToolCallsSchema } from '../packages/db/src/migrations/025_reconcile_tool_calls_schema.js';

if (process.env.AIRA_POSTGRES_CERTIFICATION !== '1') {
  throw new Error('Tool-calls schema drift certification requires AIRA_POSTGRES_CERTIFICATION=1.');
}
if (process.env.CI_DISPOSABLE_DATABASE !== 'true'
    || !process.env.DATABASE_URL
    || process.env.DATABASE_URL !== process.env.ISOLATED_TEST_DATABASE_URL) {
  throw new Error('Tool-calls schema drift certification requires the matching disposable PostgreSQL URL contract.');
}
execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });

// No local default or Neon credential/connection-string fallback is permitted.
const connectionString = process.env.DATABASE_URL;
const parsed = new URL(connectionString);
const db = knex({
  client: 'pg',
  connection: { connectionString, ssl: false },
  pool: { min: 1, max: 2 }
});

async function main(): Promise<void> {
  const tableSuffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const testTableName = `tool_calls_drift_test_${tableSuffix}`;
  const badTable = `tool_calls_bad_type_${tableSuffix}`;
  try {
  console.log(`[P0 CERTIFICATION] Testing tool_calls schema reconciliation on table: ${testTableName}`);
  console.log(`[P0 CERTIFICATION] Target host: ${parsed.hostname}`);

  // Stage 1: Create table matching drifted production schema (14 columns)
  await db.schema.createTable(testTableName, (table) => {
    table.string('id', 255).primary();
    table.string('run_id', 255).notNullable();
    table.string('tool', 255).notNullable();
    table.jsonb('arguments');
    table.string('permission', 255);
    table.string('status', 255).notNullable();
    table.bigInteger('started_at').notNullable();
    table.bigInteger('completed_at');
    table.jsonb('result');
    table.text('error');
    table.string('source', 255);
    table.string('runtime', 255);
    table.string('idempotency_key', 255);
    table.string('approval_id', 255);
  });

  console.log('PASS: Drifted table created with 14 baseline columns');

  // Stage 2: Insert pre-existing legacy record
  const legacyRecord = {
    id: `call_legacy_${tableSuffix}`,
    run_id: `run_legacy_${tableSuffix}`,
    tool: 'file_system_read',
    arguments: JSON.stringify({ path: '/app/config.json' }),
    permission: 'READ',
    status: 'COMPLETED',
    started_at: Date.now() - 5000,
    completed_at: Date.now() - 4000,
    result: JSON.stringify({ bytes: 128 }),
    error: null,
    source: 'agent',
    runtime: 'node',
    idempotency_key: `idemp_${tableSuffix}`,
    approval_id: null
  };

  await db(testTableName).insert(legacyRecord);
  console.log('PASS: Legacy pre-existing record inserted');

  // Stage 3: Reproduce failure when inserting full Agent tool call payload
  let insertFailedAsExpected = false;
  try {
    await db(testTableName).insert({
      id: `call_agent_fail_${tableSuffix}`,
      run_id: `run_agent_${tableSuffix}`,
      workflow_run_id: `wf_${tableSuffix}`,
      agent_mission_id: `mission_${tableSuffix}`,
      principal_id: `usr_${tableSuffix}`,
      tool_id: 'tool_calculator_01',
      tool: 'calculator',
      adapter: 'built_in',
      side_effect_level: 'READ_ONLY',
      permission_scopes: JSON.stringify(['compute.math']),
      status: 'RUNNING',
      arguments: JSON.stringify({ expression: '2+2' }),
      started_at: Date.now()
    });
  } catch (err: any) {
    insertFailedAsExpected = true;
    console.log(`PASS: Un-reconciled insert failed as expected: ${err.message}`);
  }
  assert.equal(insertFailedAsExpected, true, 'Insert with agent gateway fields must fail on drifted schema');

  // Stage 4: Apply reconciliation migration 025
  console.log('Applying reconcileToolCallsSchema...');
  await reconcileToolCallsSchema(db as any, testTableName);

  // Stage 5: Apply reconciliation again to verify idempotency
  console.log('Applying reconcileToolCallsSchema (idempotency check)...');
  await reconcileToolCallsSchema(db as any, testTableName);

  // Stage 6: Verify all columns now exist
  const columns = await db('information_schema.columns')
    .where({ table_schema: 'public', table_name: testTableName })
    .select('column_name', 'data_type');

  const colNames = new Set(columns.map(c => String(c.column_name)));
  const requiredNewColumns = [
    'principal_id',
    'tool_id',
    'workflow_run_id',
    'agent_mission_id',
    'adapter',
    'side_effect_level',
    'permission_scopes',
    'input_metadata',
    'attempt_count',
    'error_code',
    'duration_ms'
  ];

  for (const col of requiredNewColumns) {
    assert.equal(colNames.has(col), true, `Column ${col} must exist after reconciliation`);
  }
  console.log('PASS: All 11 missing agent tool gateway columns verified in schema');

  // Stage 7: Insert full Agent tool call payload
  const agentPayload = {
    id: `call_agent_success_${tableSuffix}`,
    run_id: `run_agent_${tableSuffix}`,
    workflow_run_id: `wf_${tableSuffix}`,
    agent_mission_id: `mission_${tableSuffix}`,
    principal_id: `usr_${tableSuffix}`,
    tool_id: 'tool_calculator_01',
    tool: 'calculator',
    adapter: 'built_in',
    side_effect_level: 'READ_ONLY',
    permission_scopes: JSON.stringify(['compute.math']),
    status: 'COMPLETED',
    arguments: JSON.stringify({ expression: '42*2' }),
    result: JSON.stringify({ answer: 84 }),
    error: null,
    error_code: null,
    attempt_count: 1,
    approval_id: null,
    idempotency_key: `idemp_agent_${tableSuffix}`,
    started_at: Date.now() - 1000,
    completed_at: Date.now(),
    duration_ms: 1000
  };

  await db(testTableName).insert(agentPayload);
  const retrievedAgent = await db(testTableName).where({ id: agentPayload.id }).first();
  assert.equal(retrievedAgent?.workflow_run_id, `wf_${tableSuffix}`);
  assert.equal(retrievedAgent?.agent_mission_id, `mission_${tableSuffix}`);
  assert.equal(retrievedAgent?.principal_id, `usr_${tableSuffix}`);
  assert.equal(retrievedAgent?.tool_id, 'tool_calculator_01');
  assert.equal(retrievedAgent?.adapter, 'built_in');
  assert.equal(retrievedAgent?.side_effect_level, 'READ_ONLY');
  assert.equal(retrievedAgent?.duration_ms, 1000);
  console.log('PASS: Full agent tool call payload persisted and verified');

  // Stage 8: Verify pre-existing legacy record remains intact
  const retrievedLegacy = await db(testTableName).where({ id: legacyRecord.id }).first();
  assert.equal(retrievedLegacy?.tool, 'file_system_read');
  assert.equal(retrievedLegacy?.status, 'COMPLETED');
  assert.equal(retrievedLegacy?.principal_id, null);
  console.log('PASS: Legacy pre-existing tool call record preserved intact');

  // Stage 8B: Verify failure on incompatible existing column type
  await db.schema.createTable(badTable, (t) => {
    t.string('id').primary();
    t.boolean('duration_ms'); // Incompatible type: boolean instead of integer
  });
  let incompatibleCaught = false;
  try {
    await reconcileToolCallsSchema(db as any, badTable);
  } catch (err: any) {
    if (err.message.includes('incompatible data type')) {
      incompatibleCaught = true;
      console.log(`PASS: Incompatible existing column type caught: ${err.message}`);
    }
  }
  await db.schema.dropTableIfExists(badTable);
  assert.equal(incompatibleCaught, true, 'reconcileToolCallsSchema must throw on incompatible existing column types');

  // Stage 9: Cleanup
  await db.schema.dropTableIfExists(testTableName);
  console.log(`PASS: Dropped disposable test table ${testTableName}`);

  console.log('\n================================================================');
  console.log('P0 CERTIFICATION SUCCESSFUL: Tool calls schema reconciliation verified');
  console.log('================================================================');
  } finally {
    await db.schema.dropTableIfExists(badTable).catch(() => {});
    await db.schema.dropTableIfExists(testTableName).catch(() => {});
  }
}

main()
  .catch(err => {
    console.error('P0 CERTIFICATION FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
