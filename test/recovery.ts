import { spawn } from 'child_process';
import assert from 'assert';
import { db } from '../packages/db/src/index.js'; // to seed/verify DB states directly

const API_PORT = 3003;
const BASE_URL = `http://127.0.0.1:${API_PORT}`;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let apiServer: any;

async function startApiServer() {
  console.log('Starting API Server...');
  apiServer = spawn('npx', ['tsx', 'apps/api/src/index.ts'], {
    // Pin the worker identity for deterministic recovery-owner assertions.
    // Production remains on unique generated IDs unless AIRA_WORKER_ID is explicitly configured.
    env: { ...process.env, PORT: API_PORT.toString(), NODE_ENV: 'test', AIRA_ALLOW_MOCK: 'true', AIRA_WORKER_ID: 'api-worker-1' },
    stdio: 'inherit',
    shell: true
  });
  
  // Wait until it responds to health check
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/ready`);
      if (res.ok) return;
    } catch (e) {}
    await sleep(500);
  }
  throw new Error('API server failed to start');
}

function killApiServer() {
  if (apiServer) {
    console.log('Killing API Server (SIGKILL)...');
    apiServer.kill('SIGKILL');
    apiServer = null;
  }
}

async function createRun(prompt: string) {
  const createRes = await fetch(`${BASE_URL}/api/runs`, {
    method: 'POST',
    headers: {
      'x-test-user-id': 'test-user',
      'x-test-session-id': 'test-session',
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
  return await createRes.json();
}

async function seedRun(id: string, state: string, checkpoint: string, extra: any = {}) {
  await db('runs').insert({
    id,
    agent_id: null,
    principal_id: 'test-user',
    session_id: 'test-session',
    state,
    status: state,
    execution_checkpoint: checkpoint,
    prompt: 'Seeded test run',
    modelPolicy: JSON.stringify({ model: 'mock-deterministic' }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra
  });
}

async function runRecoveryTests() {
  console.log('=== TASK 5 RECOVERY TEST SUITE ===');

  await db('runs').del();

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
  killApiServer();
  await sleep(1000);

  // Phase 6+ uses durable execution fencing. A replacement worker must not
  // steal an unexpired lease from another worker, even if that process appears
  // to have disappeared. This test is about post-TTL crash recovery, while the
  // dedicated worker-leasing suite separately certifies the no-steal window.
  // Simulate the crashed worker's lease TTL having elapsed before restart.
  const crashed = await db('runs')
    .whereIn('id', [runSafeId, runUnsafeId])
    .select('id', 'execution_owner', 'execution_lease_until');
  assert.strictEqual(crashed.length, 2);
  assert.ok(crashed.every((row: any) => row.execution_owner && row.execution_lease_until),
    'Interrupted tool runs should hold durable execution leases before simulated expiry');
  await db('runs')
    .whereIn('id', [runSafeId, runUnsafeId])
    .update({ execution_lease_until: Date.now() - 1 });

  console.log('\n--- 2. Prepare Static Runs for Startup Verification ---');
  
  // Test A: WAITING_FOR_APPROVAL
  const runApprovalId = 'run_approval_123';
  await seedRun(runApprovalId, 'WAITING_FOR_APPROVAL', 'WAITING_FOR_APPROVAL');
  
  // Test E: TOOL_COMPLETED
  const runCompletedToolId = 'run_tc_123';
  await seedRun(runCompletedToolId, 'RUNNING', 'TOOL_COMPLETED', {
    toolCalls: JSON.stringify([{ id: 'call_1', toolId: 'tool_1', name: 'dummy', arguments: {}, timestamp: Date.now(), status: 'COMPLETED' }])
  });
  
  // Test F: SYNTHESIZING
  const runSynthId = 'run_synth_123';
  await seedRun(runSynthId, 'RUNNING', 'SYNTHESIZING');

  // Test G: FINALIZING
  const runFinalizeId = 'run_final_123';
  await seedRun(runFinalizeId, 'RUNNING', 'FINALIZING');

  // Test H: Terminal runs
  const runCompletedId = 'run_done_123';
  await seedRun(runCompletedId, 'COMPLETED', 'COMPLETED');
  const runFailedId = 'run_fail_123';
  await seedRun(runFailedId, 'FAILED', 'TOOL_EXECUTING');

  // Test I: Lease takeover / contention
  const runLeasedId = 'run_leased_123';
  await seedRun(runLeasedId, 'RUNNING', 'TOOL_APPROVED', {
    recovery_owner: 'other-worker',
    recovery_claimed_at: Date.now(),
    recovery_lease_until: Date.now() + 60000,
    toolCalls: JSON.stringify([{ id: 'call_1', toolId: 'tool_1', name: 'dummy', arguments: {}, timestamp: Date.now(), status: 'APPROVED' }])
  });
  
  const runExpiredLeaseId = 'run_expired_123';
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

  // Test E / 11: TOOL_COMPLETED does not re-execute tool, moves to SYNTHESIZING or finishes
  const checkTc = await db('runs').where({ id: runCompletedToolId }).first();
  assert.ok(['SYNTHESIZING', 'FINALIZING', 'COMPLETED'].includes(checkTc.execution_checkpoint), `Expected post-TC state, got ${checkTc.execution_checkpoint}`);
  console.log('✅ Test 11 (TOOL_COMPLETED moves forward): Passed');

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
  // Expired lease SHOULD be taken over by this worker ('api-worker-1')
  assert.strictEqual(checkExpired.recovery_owner, 'api-worker-1');
  console.log('✅ Test 6 & I (Lease expiry/takeover works): Passed');

  console.log('\nAll A-I Tests Passed Successfully!');
  killApiServer();
  process.exit(0);
}

runRecoveryTests().catch(err => {
  console.error(err);
  killApiServer();
  process.exit(1);
});
