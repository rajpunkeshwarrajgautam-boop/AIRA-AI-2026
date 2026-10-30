import { spawn } from 'child_process';
import { execFileSync } from 'node:child_process';
import assert from 'assert';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/src/index.js'; // to seed/verify DB states directly
import { createPostgresExecutionFixture } from './helpers/postgres-execution-fixture.js';

function assertAuthorizedDisposableDatabase(): void {
  if (process.env.AIRA_POSTGRES_CERTIFICATION !== '1') {
    throw new Error('Recovery certification requires AIRA_POSTGRES_CERTIFICATION=1.');
  }
  if (process.env.CI_DISPOSABLE_DATABASE !== 'true'
      || !process.env.DATABASE_URL
      || process.env.DATABASE_URL !== process.env.ISOLATED_TEST_DATABASE_URL) {
    throw new Error('Recovery certification requires the matching disposable PostgreSQL URL contract.');
  }
  execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });
}

const API_PORT = 3003;
const BASE_URL = `http://127.0.0.1:${API_PORT}`;
const FIXTURE_TAG = randomUUID();
const RECOVERY_PRINCIPAL_ID = `cert_recovery_${FIXTURE_TAG}`;
const RECOVERY_SESSION_ID = `cert_recovery_session_${FIXTURE_TAG}`;
let executionFixture: Awaited<ReturnType<typeof createPostgresExecutionFixture>> | undefined;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let apiServer: any;

async function startApiServer() {
  console.log('Starting API Server...');
  const apiEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: API_PORT.toString(),
    NODE_ENV: 'test',
    AIRA_ALLOW_MOCK: 'true',
    AIRA_PERSISTENT_WORKSPACE_AUTHORITY: 'true',
    DOTENV_CONFIG_PATH: '/dev/null'
  };
  for (const key of [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NVIDIA_API_KEY', 'GROQ_API_KEY',
    'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY',
    'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'FAL_KEY', 'FAL_API_KEY',
    'REPLICATE_API_TOKEN', 'FIRECRAWL_API_KEY', 'E2B_API_KEY', 'LIGHTNING_SANDBOX_API_KEY',
    'BROWSERBASE_API_KEY', 'BROWSERLESS_API_KEY', 'AIRA_LIVE_PROVIDER_ACCEPTANCE',
    'AIRA_LIVE_PROVIDER', 'AIRA_LIVE_MODEL', 'AIRA_LIVE_PROVIDER_CONFIRMATION',
    'AIRA_LIVE_PROVIDER_DATABASE_CONFIRMATION'
  ]) delete apiEnvironment[key];
  apiServer = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'apps/api/src/index.ts'], {
    env: apiEnvironment,
    stdio: 'inherit'
  });
  
  // Wait until it responds to health check
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/ready`);
      if (res.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('API server failed to start');
}

async function killApiServer(): Promise<void> {
  const child = apiServer;
  apiServer = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  console.log('Killing API Server (SIGKILL)...');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

async function createRun(prompt: string) {
  const createRes = await fetch(`${BASE_URL}/api/runs`, {
    method: 'POST',
    headers: {
      'x-test-user-id': RECOVERY_PRINCIPAL_ID,
      'x-test-session-id': RECOVERY_SESSION_ID,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      intent: 'TOOL_ACTION',
      prompt: prompt,
      modelPolicy: { model: 'mock-deterministic' }
    })
  });
  
  if (!createRes.ok) {
    throw new Error(`Failed to create run: ${createRes.status} ${await createRes.text()}`);
  }
  const run = await createRes.json();
  if (!executionFixture) throw new Error('Recovery execution fixture was not initialized.');
  await executionFixture.trackParentRun(run.id);
  return run;
}

async function seedRun(id: string, state: string, checkpoint: string, extra: any = {}) {
  if (!executionFixture) throw new Error('Recovery execution fixture was not initialized.');
  await executionFixture.createParentRun(id, {
    prompt: 'Seeded test run', state, status: state, executionCheckpoint: checkpoint
  });
  await db('runs').where({ id }).update({
    agent_id: null,
    execution_checkpoint: checkpoint,
    modelPolicy: JSON.stringify({ model: 'mock-deterministic' }),
    updatedAt: Date.now(),
    ...extra
  });
}

async function runRecoveryTests() {
  try {
    assertAuthorizedDisposableDatabase();
    executionFixture = await createPostgresExecutionFixture({
      principalPrefix: 'cert_recovery', sessionPrefix: 'cert_recovery_session', tag: FIXTURE_TAG,
      principalId: RECOVERY_PRINCIPAL_ID, sessionId: RECOVERY_SESSION_ID, roles: ['member'], scopes: []
    });
    console.log('=== TASK 5 RECOVERY TEST SUITE ===');

  // We start the API server to create some initial runs that we will kill mid-flight
  await startApiServer();

  console.log('\n--- 1. Prepare Active Runs for SIGKILL ---');
  // Trigger a hang_safe (SAFE_READ) which stalls in TOOL_EXECUTING
  const runSafeId = (await createRun('hang safe')).id;
  
  // Trigger a hang_unsafe (NON_IDEMPOTENT) which stalls in TOOL_EXECUTING
  const runUnsafeId = (await createRun('hang unsafe')).id;

  // Let them transition to TOOL_EXECUTING
  await sleep(3000);

  // Kill the server abruptly
  await killApiServer();
  await sleep(1000);

  console.log('\n--- 2. Prepare Static Runs for Startup Verification ---');
  
  // Test A: WAITING_FOR_APPROVAL
  const runApprovalId = `run_approval_${FIXTURE_TAG}`;
  await seedRun(runApprovalId, 'WAITING_FOR_APPROVAL', 'WAITING_FOR_APPROVAL');
  
  // Model a SIGKILL boundary after durable tool completion: the run is still RUNNING,
  // its checkpoint is TOOL_COMPLETED, and the call/result plus lifecycle receipts are persisted.
  const runCompletedToolId = `run_tc_${FIXTURE_TAG}`;
  const completedToolCall = {
    id: 'call_1', toolId: 'tool_calculator', name: 'calculator',
    arguments: { expression: '6 * 7' }, timestamp: Date.now(), status: 'COMPLETED'
  };
  const completedToolResult = {
    toolCallId: completedToolCall.id,
    output: { expression: '6 * 7', result: 42 },
    isError: false,
    durationMs: 3,
    timestamp: Date.now()
  };
  await seedRun(runCompletedToolId, 'RUNNING', 'TOOL_COMPLETED', {
    toolCalls: JSON.stringify([completedToolCall]),
    toolResults: JSON.stringify([completedToolResult])
  });
  await db('run_events').insert([
    {
      id: `evt_${randomUUID()}`, run_id: runCompletedToolId, type: 'tool.started',
      payload: JSON.stringify({ callId: completedToolCall.id, name: completedToolCall.name }), createdAt: completedToolCall.timestamp
    },
    {
      id: `evt_${randomUUID()}`, run_id: runCompletedToolId, type: 'tool.completed',
      payload: JSON.stringify(completedToolResult), createdAt: completedToolResult.timestamp
    }
  ]);

  // Test F: SYNTHESIZING
  const runSynthId = `run_synth_${FIXTURE_TAG}`;
  await seedRun(runSynthId, 'RUNNING', 'SYNTHESIZING');

  // Test G: FINALIZING
  const runFinalizeId = `run_final_${FIXTURE_TAG}`;
  await seedRun(runFinalizeId, 'RUNNING', 'FINALIZING');

  // Test H: Terminal runs
  const runCompletedId = `run_done_${FIXTURE_TAG}`;
  await seedRun(runCompletedId, 'COMPLETED', 'COMPLETED');
  const runFailedId = `run_fail_${FIXTURE_TAG}`;
  await seedRun(runFailedId, 'FAILED', 'TOOL_EXECUTING');

  // Test I: Lease takeover / contention
  const runLeasedId = `run_leased_${FIXTURE_TAG}`;
  await seedRun(runLeasedId, 'RUNNING', 'TOOL_APPROVED', {
    recovery_owner: 'other-worker',
    recovery_claimed_at: Date.now(),
    recovery_lease_until: Date.now() + 60000,
    toolCalls: JSON.stringify([{ id: 'call_1', toolId: 'tool_1', name: 'dummy', arguments: {}, timestamp: Date.now(), status: 'APPROVED' }])
  });
  
  const runExpiredLeaseId = `run_expired_${FIXTURE_TAG}`;
  await seedRun(runExpiredLeaseId, 'RUNNING', 'TOOL_APPROVED', {
    recovery_owner: 'other-worker',
    recovery_claimed_at: Date.now(),
    recovery_lease_until: Date.now() - 10000,
    toolCalls: JSON.stringify([{ id: 'call_1', toolId: 'tool_1', name: 'dummy', arguments: {}, timestamp: Date.now(), status: 'APPROVED' }])
  });

  console.log('\n--- 3. Restart API Server (Triggers Startup Recovery) ---');
  // Start server again. On boot, recoverInterruptedRuns is called.
  await startApiServer();
  await sleep(5000); // Give recovery time to execute RunLoop

  console.log('\n--- 4. Assert Outcomes ---');

  // Test C / 9: SAFE_READ should rollback to TOOL_APPROVED and re-execute
  // Because it hangs again, it should be back in RUNNING / TOOL_EXECUTING
  const checkSafe = await db('runs').where({ id: runSafeId }).first();
  assert.ok(['RUNNING', 'WAITING_FOR_TOOL'].includes(checkSafe.state));
  assert.ok(checkSafe.execution_checkpoint === 'TOOL_EXECUTING' || checkSafe.execution_checkpoint === 'TOOL_APPROVED');
  console.log('✅ Test 9 (SAFE_READ retried): Passed');

  // Test D / 10: NON_IDEMPOTENT should be FAILED explicitly
  const checkUnsafe = await db('runs').where({ id: runUnsafeId }).first();
  assert.strictEqual(checkUnsafe.state, 'FAILED');
  assert.ok(checkUnsafe.error.includes('Process crashed during non-idempotent tool execution'));
  console.log('✅ Test 10 (NON_IDEMPOTENT aborted): Passed');

  // Test A / 7: WAITING_FOR_APPROVAL survives restart
  const checkApproval = await db('runs').where({ id: runApprovalId }).first();
  assert.strictEqual(checkApproval.state, 'WAITING_FOR_APPROVAL');
  console.log('✅ Test 7 (WAITING_FOR_APPROVAL survives): Passed');

  // Test E / 11: a completed tool is retained and synthesis finishes without redispatch.
  const checkTc = await db('runs').where({ id: runCompletedToolId }).first();
  assert.strictEqual(checkTc.state, 'COMPLETED');
  assert.strictEqual(checkTc.execution_checkpoint, 'COMPLETED');
  const recoveredCalls = typeof checkTc.toolCalls === 'string' ? JSON.parse(checkTc.toolCalls) : checkTc.toolCalls;
  const recoveredResults = typeof checkTc.toolResults === 'string' ? JSON.parse(checkTc.toolResults) : checkTc.toolResults;
  assert.deepStrictEqual(recoveredCalls, [completedToolCall]);
  assert.deepStrictEqual(recoveredResults, [completedToolResult]);
  const recoveredToolEvents = await db('run_events').where({ run_id: runCompletedToolId }).whereIn('type', ['tool.started', 'tool.completed']);
  assert.strictEqual(recoveredToolEvents.filter((event: any) => event.type === 'tool.started').length, 1,
    'Recovery must not emit a second tool.started event for a completed call.');
  assert.strictEqual(recoveredToolEvents.filter((event: any) => event.type === 'tool.completed').length, 1,
    'Recovery must retain exactly the pre-crash tool completion receipt.');
  console.log('✅ Test 11 (TOOL_COMPLETED retained, run completed, and adapter not replayed): Passed');

  // Test F / 12: SYNTHESIZING finishes without duplication
  const checkSynth = await db('runs').where({ id: runSynthId }).first();
  assert.ok(['FINALIZING', 'COMPLETED'].includes(checkSynth.execution_checkpoint));
  console.log('✅ Test 12 (SYNTHESIZING moves forward): Passed');

  // Test G / 13: FINALIZING finishes properly
  const checkFinalize = await db('runs').where({ id: runFinalizeId }).first();
  assert.strictEqual(checkFinalize.state, 'COMPLETED');
  console.log('✅ Test 13 (FINALIZING finishes): Passed');

  // Test H / 14: Terminal runs are never resumed
  const checkDone = await db('runs').where({ id: runCompletedId }).first();
  assert.strictEqual(checkDone.state, 'COMPLETED');
  const checkFail = await db('runs').where({ id: runFailedId }).first();
  assert.strictEqual(checkFail.state, 'FAILED');
  assert.ok(checkFail.recovery_owner === null || checkFail.recovery_owner === undefined);
  console.log('✅ Test 14 (Terminal runs ignored): Passed');

  // Test I / 6: Recovery lease expiry/takeover
  const checkLeased = await db('runs').where({ id: runLeasedId }).first();
  // Valid lease should NOT be taken over
  assert.strictEqual(checkLeased.recovery_owner, 'other-worker');
  assert.ok(checkLeased.recovery_claimed_at !== null);
  
  const checkExpired = await db('runs').where({ id: runExpiredLeaseId }).first();
  // The generated recovery claim is released after processing; stale fixed-owner assertions
  // do not describe the current fenced claim lifecycle.
  assert.strictEqual(checkExpired.recovery_owner, null);
  assert.strictEqual(checkExpired.recovery_claimed_at, null);
  assert.strictEqual(checkExpired.recovery_lease_until, null);
  assert.strictEqual(checkExpired.state, 'FAILED');
  console.log('✅ Test 6 & I (Expired lease claimed, processed, and released): Passed');

  console.log('\nAll A-I Tests Passed Successfully!');
  } finally {
    await killApiServer();
    try {
      await executionFixture?.cleanup();
    } finally {
      await db.destroy();
    }
  }
}

runRecoveryTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});