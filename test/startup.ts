import { spawn } from 'child_process';
import assert from 'assert';
import path from 'path';
import { pathToFileURL } from 'url';

const API_PORT = 3006;
const BASE_URL = `http://127.0.0.1:${API_PORT}`;

async function runStartupTests() {
  console.log('=== TASK 6 STARTUP RECOVERY CERTIFICATION ===\n');

  const dbModule = await import(pathToFileURL(path.resolve('./packages/db/src/index.ts')).href);
  const db = dbModule.db;

  const testRunId = `run_startup_${Date.now()}`;
  const USER = { userId: 'startup-user', sessionId: 'startup-sess' };

  console.log('--- 1. Seed interrupted run ---');
  await db('runs').insert({
    id: testRunId,
    principal_id: USER.userId,
    session_id: USER.sessionId,
    agent_id: null,
    prompt: 'Startup test',
    systemPrompt: null,
    intent: 'ANSWER',
    state: 'RUNNING',
    status: 'RUNNING',
    modelPolicy: JSON.stringify({ model: 'mock-deterministic' }),
    context_data: '{}',
    content: '',
    thinking: '',
    toolsUsed: '[]',
    toolCalls: '[]',
    toolResults: '[]',
    citations: '[]',
    artifacts: '[]',
    stepCount: 1,
    max_steps: 10,
    execution_checkpoint: 'SYNTHESIZING',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }).catch((e: any) => console.warn('DB insert skipped:', e.message));

  console.log('--- 2. Start API Server ---');
  let apiProcess: any;
  let isListening = false;
  let isRecovered = false;

  const startServer = () => {
    return new Promise<void>((resolve) => {
      apiProcess = spawn('npx', ['tsx', 'apps/api/src/index.ts'], {
        env: { ...process.env, PORT: String(API_PORT), TSX_CACHE: 'false' },
        shell: true
      });

      apiProcess.stdout.on('data', (data: any) => {
        const out = data.toString();
        if (out.includes(`listening on port ${API_PORT}`)) {
          isListening = true;
          resolve(); // Resolve when bound to port
        }
        if (out.includes('Startup recovery complete')) {
          isRecovered = true;
        }
      });

      apiProcess.stderr.on('data', (_data: any) => {
        // Keep stderr attached so child-process errors cannot block on a full pipe.
      });
    });
  };

  await startServer();

  console.log('--- 3. Verify readiness during/after startup recovery ---');
  assert.ok(isListening, 'Server should be listening');

  // Recovery can complete between the stdout "listening" event reaching this
  // process and the first HTTP request. Treat the HTTP readiness contract as
  // authoritative rather than racing it against stdout delivery.
  const readyBefore = await fetch(`${BASE_URL}/api/ready`).catch(() => null);
  assert.ok(readyBefore, 'Readiness endpoint should respond');

  if (readyBefore.status === 503) {
    const bBody = await readyBefore.json();
    assert.strictEqual(bBody.status, 'RECOVERING', '503 readiness must report RECOVERING');

    // Protected runtime traffic must stay closed while recovery is incomplete.
    // Recovery may complete between the readiness probe above and this request,
    // so both outcomes are valid only if they agree with the current readiness state.
    const runRes = await fetch(`${BASE_URL}/api/runs`, {
      headers: { 'x-test-user-id': 'u', 'x-test-session-id': 's' }
    });

    if (runRes.status === 503) {
      // Still recovering: the runtime gate is correctly closed.
      assert.strictEqual(runRes.status, 503, 'Protected routes must return 503 while recovery is incomplete');
    } else {
      // Recovery completed in the race window. Protected traffic may now be open,
      // but readiness must have transitioned to READY before we accept that result.
      assert.strictEqual(runRes.status, 200, 'Protected route may only return 503 or 200 across the recovery boundary');
      const readyAfterRace = await fetch(`${BASE_URL}/api/ready`);
      assert.strictEqual(readyAfterRace.status, 200, 'Runtime traffic may only open after readiness becomes 200');
      const readyAfterRaceBody = await readyAfterRace.json();
      assert.strictEqual(readyAfterRaceBody.status, 'READY', 'Runtime traffic may only open after READY state');
      isRecovered = true;
      console.warn('Recovery completed between readiness and protected-route probes; validated READY transition.');
    }
  } else {
    assert.strictEqual(readyBefore.status, 200, 'Readiness may only be 503/RECOVERING or 200/READY');
    const bBody = await readyBefore.json();
    assert.strictEqual(bBody.status, 'READY', '200 readiness must report READY');
    isRecovered = true;
    console.warn('Recovery completed before the first readiness request; validated READY state instead.');
  }

  console.log('--- 4. Wait for recovery to complete ---');
  while (!isRecovered) {
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('--- 5. Readiness becomes HEALTHY ---');
  const readyAfter = await fetch(`${BASE_URL}/api/ready`).catch(() => null);
  assert.ok(readyAfter);
  assert.strictEqual(readyAfter.status, 200, 'Ready should return 200 when HEALTHY');
  const aBody = await readyAfter.json();
  assert.strictEqual(aBody.status, 'READY');

  console.log('--- 6. Recovered run maintains original principal/session ---');
  const recoveredRow = await db('runs').where('id', testRunId).first();
  assert.strictEqual(recoveredRow.principal_id, USER.userId);
  assert.strictEqual(recoveredRow.session_id, USER.sessionId);
  assert.ok(!recoveredRow.agent_id || recoveredRow.agent_id !== recoveredRow.principal_id);
  console.log('PASS Run maintains identity');

  console.log('--- 7. Cleanup ---');
  apiProcess.kill('SIGKILL');

  console.log('\n=== ALL STARTUP TESTS PASSED ===\n');
  process.exit(0);
}

runStartupTests().catch(e => {
  console.error('\nSTARTUP TEST FAILURE:', e);
  process.exit(1);
});
