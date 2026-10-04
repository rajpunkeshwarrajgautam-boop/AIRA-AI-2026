import { spawn, exec } from 'child_process';
import assert from 'assert';

const API_PORT = 3001;
const BASE_URL = `http://127.0.0.1:${API_PORT}`;
// Standard auth headers for integration test calls
const INT_HEADERS = {
  'Content-Type': 'application/json',
  'x-test-user-id': 'integration-test-user',
  'x-test-session-id': 'integration-test-session',
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// SSE helper — reads events until `limit` events collected or stream ends
// ---------------------------------------------------------------------------
async function collectSseEvents(
  runId: string,
  headers: Record<string, string> = {},
  limit: number,
  timeoutMs = 6000,
  query = ''
): Promise<{ id: string; event: string; data: any }[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/api/runs/${runId}/events${query}`, {
      headers: { ...headers },
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SSE endpoint returned ${res.status}: ${body}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No reader');

    const events: any[] = [];
    let buffer = '';
    let currentId = '';
    let currentEvent = '';

    while (events.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = new TextDecoder().decode(value);
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('id: ')) currentId = line.substring(4).trim();
        else if (line.startsWith('event: ')) currentEvent = line.substring(7).trim();
        else if (line.startsWith('data: ')) {
          events.push({ id: currentId, event: currentEvent, data: JSON.parse(line.substring(6).trim()) });
          currentId = '';
          currentEvent = '';
        }
      }
    }
    clearTimeout(timeout);
    reader.cancel();
    return events;
  } catch (e: any) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') return [];
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Main integration runner
// ---------------------------------------------------------------------------
async function runIntegration() {
  // -------------------------------------------------------------------------
  // ITEM 1 (Migration): Test BOTH paths
  // Path A: Clean DB — fresh schema, 006 is a no-op (column already exists)
  // Path B: Existing DB — simulate old 003 without artifacts, 006 adds it
  // -------------------------------------------------------------------------
  console.log('--- MIGRATION PATH A: Clean DB (006 should be no-op) ---');
  await new Promise((resolve, reject) => {
    const script = `import path from 'path'; import { pathToFileURL } from 'url'; async function clean() { const dbModule = await import(pathToFileURL(path.resolve('./packages/db/src/index.ts')).href); const db = dbModule.db; await db.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await db.migrate.latest(); const exists = await db.schema.hasColumn('runs', 'artifacts'); if (!exists) { console.error('FAIL: artifacts column missing after full migration'); process.exit(1); } console.log('PASS: artifacts column present after full migration (006 was no-op)'); process.exit(0); } clean().catch((err) => { console.error(err); process.exit(1); });`;
    exec(`npx tsx -e "${script}"`, (err, stdout, stderr) => {
      if (err) { console.error(stderr); return reject(new Error(`Migration Path A failed: ${err.message}`)); }
      console.log(stdout.trim());
      resolve(true);
    });
  });

  console.log('--- MIGRATION PATH B: Existing DB missing artifacts (006 should add it) ---');
  await new Promise<void>((resolve, reject) => {
    exec('npx tsx test/migration-path-b.ts', (err, stdout, stderr) => {
      if (err) { console.error(stderr); return reject(new Error(`Migration Path B failed: ${stdout || stderr}`)); }
      console.log(stdout.trim());
      resolve();
    });
  });

  console.log('--- MIGRATION: Fresh DB for integration tests ---');
  await new Promise((resolve, reject) => {
    const script = `import path from 'path'; import { pathToFileURL } from 'url'; async function clean() { const dbModule = await import(pathToFileURL(path.resolve('./packages/db/src/index.ts')).href); const db = dbModule.db; await db.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await db.migrate.latest(); console.log('Clean DB migration PASS'); process.exit(0); } clean().catch((err) => { console.error(err); process.exit(1); });`;
    exec(`npx tsx -e "${script}"`, (err, stdout, stderr) => {
      if (err) { console.error(stderr); return reject(err); }
      console.log('DB Migration complete.');
      resolve(true);
    });
  });

  console.log('Starting MCP server...');
  const mcpServer = spawn('npx', ['tsx', 'packages/mcp/src/test-server.ts'], { shell: true });

  console.log('Starting API server...');
  const apiServer = spawn('npx', ['tsx', '--no-cache', 'apps/api/src/index.ts'], { shell: true, env: { ...process.env, TSX_CACHE: 'false', NODE_ENV: 'test' } });
  apiServer.stdout?.on('data', d => process.stdout.write(`API: ${d}`));
  apiServer.stderr?.on('data', d => process.stderr.write(`API ERR: ${d}`));

  await sleep(5000);

  try {
    // -----------------------------------------------------------------------
    // TEST 1: MCP Integration placeholder
    // -----------------------------------------------------------------------
    console.log('--- TEST 1: MCP Integration ---');

    // -----------------------------------------------------------------------
    // TEST 2: Durability & Fail-over
    // -----------------------------------------------------------------------
    console.log('--- TEST 2: Durability & Fail-over ---');
    const createRunRes = await fetch(`${BASE_URL}/api/runs`, {
      method: 'POST',
      headers: INT_HEADERS,
      body: JSON.stringify({
        intent: 'AGENT_MISSION',
        prompt: 'Test prompt',
        systemPrompt: 'You are a test agent',
        modelPolicy: { model: 'mock-deterministic' }
      })
    });

    if (!createRunRes.ok) {
      const txt = await createRunRes.text();
      throw new Error(`Failed to create run: ${createRunRes.status} - ${txt}`);
    }

    const runData = await createRunRes.json();
    assert.ok(runData.id, 'Should create run and return ID');
    console.log('Run created:', runData.id);

    // -----------------------------------------------------------------------
    // TEST 3: Process Restart Recovery
    // -----------------------------------------------------------------------
    console.log('--- TEST 3: Process Restart Recovery ---');
    console.log('Killing API server...');
    apiServer.kill();
    await sleep(1000);

    console.log('Restarting API server...');
    const apiServer2 = spawn('npx', ['tsx', '--no-cache', 'apps/api/src/index.ts'], { shell: true, env: { ...process.env, TSX_CACHE: 'false', NODE_ENV: 'test' } });
    apiServer2.stdout?.on('data', d => process.stdout.write(`API2: ${d}`));
    apiServer2.stderr?.on('data', d => process.stderr.write(`API2 ERR: ${d}`));
    await sleep(3000);

    console.log('Fetching run after restart...');
    const getRunRes = await fetch(`${BASE_URL}/api/runs/${runData.id}`, { headers: INT_HEADERS });
    const getRunData = await getRunRes.json();

    assert.strictEqual(getRunData.id, runData.id, 'Run should persist across restarts');
    console.log('Run persistence verified.');

    // -----------------------------------------------------------------------
    // TEST 4: Scheduler Concurrency
    // -----------------------------------------------------------------------
    console.log('--- TEST 4: Scheduler Concurrency ---');
    console.log('Spawning two claim workers concurrently...');
    const claimScript = `import path from 'path'; import { pathToFileURL } from 'url'; async function run() { const repoModule = await import(pathToFileURL(path.resolve('./packages/automation/src/repositories.ts')).href); const repo = new repoModule.PostgresAutomationRunRepository(); const claim = await repo.claimRun('auto_default', 10000); console.log(claim ? 'CLAIMED' : 'CONFLICT'); process.exit(0); } run().catch((err) => { console.error(err); process.exit(1); });`;

    const [w1, w2] = await Promise.all([
      new Promise(r => exec(`npx tsx -e "${claimScript}"`, (err, stdout) => r(stdout.trim()))),
      new Promise(r => exec(`npx tsx -e "${claimScript}"`, (err, stdout) => r(stdout.trim())))
    ]);
    const claimedCount = [w1, w2].filter(out => String(out).includes('CLAIMED')).length;
    assert.strictEqual(claimedCount, 1, `Exactly one worker should claim the run. Got: w1=${w1}, w2=${w2}`);
    console.log('Scheduler concurrency verified.');

    // -----------------------------------------------------------------------
    // TEST 5a: Real Replay -> Live Continuation (Deterministic)
    // -----------------------------------------------------------------------
    console.log('--- TEST 5a: Real Replay -> Live Continuation ---');
    const liveRunRes = await fetch(`${BASE_URL}/api/runs`, {
      method: 'POST',
      headers: INT_HEADERS,
      body: JSON.stringify({
        intent: 'TOOL_ACTION',
        prompt: 'run command', // Triggers system_shell (DESTRUCTIVE), which pauses for approval
        systemPrompt: 'You are a test agent',
        modelPolicy: { model: 'mock-deterministic' }
      })
    });
    if (!liveRunRes.ok) throw new Error(`Failed to create live run: ${liveRunRes.status}`);
    const liveRun = await liveRunRes.json();
    
    // Wait for the run to pause at WAITING_FOR_APPROVAL
    await sleep(2000);
    
    // Subscribe to SSE. Should replay created, requested, approval.required events
    const controller = new AbortController();
    const liveStreamRes = await fetch(`${BASE_URL}/api/runs/${liveRun.id}/events`, {
      signal: controller.signal,
      headers: INT_HEADERS,
    });
    const reader = liveStreamRes.body?.getReader();
    if (!reader) throw new Error('No reader');

    const liveEvents: any[] = [];
    let buffer = '';
    let currentId = '';
    let currentEvent = '';

    const readLoop = async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = new TextDecoder().decode(value);
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('id: ')) currentId = line.substring(4).trim();
          else if (line.startsWith('event: ')) currentEvent = line.substring(7).trim();
          else if (line.startsWith('data: ')) {
            liveEvents.push({ id: currentId, event: currentEvent, data: JSON.parse(line.substring(6).trim()) });
            currentId = ''; currentEvent = '';
          }
        }
      }
    };
    const readPromise = readLoop();
    
    await sleep(1000);
    const failedEvent = liveEvents.find(e => e.event === 'run.failed');
    if (failedEvent) console.error('Run failed early:', failedEvent.data);
    console.log('Received events:', liveEvents.map(e => e.event));
    const approvalReqEvent = liveEvents.find(e => e.event === 'approval.required');
    assert.ok(approvalReqEvent, 'Should have received approval.required via replay');
    
    console.log('Sending approval to trigger live continuation...');
    const resApprove = await fetch(`${BASE_URL}/api/runs/${liveRun.id}/approve`, {
      method: 'POST',
      headers: INT_HEADERS,
      body: JSON.stringify({
        requestId: approvalReqEvent.data.id,
        decision: 'ALLOW_ONCE'
      })
    });
    if (!resApprove.ok) {
      throw new Error(`Approval fetch failed: ${await resApprove.text()}`);
    }
    
    // Wait for run to finish and emit live events
    await sleep(4000);
    controller.abort();
    try { await readPromise; } catch (e: any) { if (e.name !== 'AbortError') throw e; }
    
    const liveToolStarted = liveEvents.find(e => e.event === 'tool.started');
    const liveRunCompleted = liveEvents.find(e => e.event === 'run.completed' || e.event === 'run.failed');
    
    assert.ok(liveToolStarted, 'Should receive tool.started live after replay');
    assert.ok(liveRunCompleted, 'Should receive run.completed or run.failed live after replay');
    console.log('TEST 5a PASS: Replay -> Live continuation verified deterministically');

    // -----------------------------------------------------------------------
    // TEST 5b: Replay/Live Race Test (Barrier/Hook)
    // -----------------------------------------------------------------------
    console.log('--- TEST 5b: Replay/Live Race Test ---');
    const raceRunRes = await fetch(`${BASE_URL}/api/runs`, {
      method: 'POST',
      headers: INT_HEADERS,
      body: JSON.stringify({
        intent: 'TOOL_ACTION',
        prompt: 'run command',
        systemPrompt: 'You are a test agent',
        modelPolicy: { model: 'mock-deterministic' }
      })
    });
    const raceRun = await raceRunRes.json();
    
    // Connect with test hook to induce 500ms delay between subscription and DB fetch
    const raceEvents = await collectSseEvents(raceRun.id, INT_HEADERS, 5, 4000, `?__test_hook_replay_race=1`);
    assert.ok(raceEvents.length >= 2, `Should get events despite the race condition. Got: ${raceEvents.length}`);
    const raceIds = raceEvents.map(e => parseInt(e.id, 10));
    const uniqueIds = new Set(raceIds);
    assert.strictEqual(raceIds.length, uniqueIds.size, 'Should not have duplicate events from race condition');
    for (let i = 1; i < raceIds.length; i++) {
      assert.ok(raceIds[i] > raceIds[i - 1], `Sequences must be strictly increasing: ${raceIds[i]} must be > ${raceIds[i - 1]}`);
    }
    console.log('TEST 5b PASS: Replay/Live race condition handled correctly without duplicates.');

    // -----------------------------------------------------------------------
    // TEST 6: Cursor Validation — strict numeric input
    // -----------------------------------------------------------------------
    console.log('--- TEST 6: Cursor Validation ---');

    const invalidCursors = [
      { header: 'Last-Event-ID', value: 'abc' },
      { header: 'Last-Event-ID', value: '-1' },
      { header: 'Last-Event-ID', value: '12abc' },
      { header: 'Last-Event-ID', value: '1.5' },
      { header: 'Last-Event-ID', value: '0x10' },
      { header: 'Last-Event-ID', value: String(Number.MAX_SAFE_INTEGER + 1) }
    ];

    for (const { header, value } of invalidCursors) {
      const r = await fetch(`${BASE_URL}/api/runs/${runData.id}/events`, {
        headers: { ...INT_HEADERS, [header]: value }
      });
      assert.strictEqual(r.status, 400,
        `Expected HTTP 400 for ${header}: "${value}", got ${r.status}`);
      const body = await r.json();
      assert.ok(body.error, `Expected error message for ${header}: "${value}"`);
      console.log(`  ✓ ${header}: "${value}" → 400: ${body.error}`);
    }

    const invalidQueryCursors = ['banana', '-5', '9abc'];
    for (const value of invalidQueryCursors) {
      const r = await fetch(`${BASE_URL}/api/runs/${runData.id}/events?after=${value}`, {
        headers: INT_HEADERS
      });
      assert.strictEqual(r.status, 400,
        `Expected HTTP 400 for ?after="${value}", got ${r.status}`);
      const body = await r.json();
      assert.ok(body.error, `Expected error message for ?after="${value}"`);
      console.log(`  ✓ ?after="${value}" → 400: ${body.error}`);
    }

    // Valid cursor "0" must NOT return 400
    const validCursorRes = await fetch(`${BASE_URL}/api/runs/${runData.id}/events`, {
      headers: { ...INT_HEADERS, 'Last-Event-ID': '0' }
    });
    // Should be 200 (content-type: text/event-stream)
    assert.strictEqual(validCursorRes.status, 200, `Valid cursor "0" must not return 400`);
    await validCursorRes.body?.cancel();
    console.log('TEST 6 PASS: cursor validation verified.');

    // -----------------------------------------------------------------------
    // TEST 7: Terminal Replay + Stream Close
    // -----------------------------------------------------------------------
    console.log('--- TEST 7: Terminal Replay + Stream Close ---');

    // The run is already completed. Reconnect from beginning — should get all events and stream must close.
    const terminalEvents = await collectSseEvents(runData.id, INT_HEADERS, 30, 5000);
    const lastEvt = terminalEvents[terminalEvents.length - 1];
    assert.ok(
      ['run.completed', 'run.failed', 'run.cancelled'].includes(lastEvt?.event),
      `Last event should be terminal, got: ${lastEvt?.event}`
    );
    console.log(`Terminal event received: ${lastEvt.event} (id: ${lastEvt.id})`);

    // Reconnect at cursor JUST before terminal event — should replay remaining events + terminal + close
    const penultimateId = String(parseInt(lastEvt.id, 10) - 1);
    const nearTerminalEvents = await collectSseEvents(
      runData.id,
      { ...INT_HEADERS, 'Last-Event-ID': penultimateId },
      5,
      4000
    );
    assert.ok(nearTerminalEvents.length >= 1,
      `Should get at least the terminal event when cursor is just before it`);
    const nearLast = nearTerminalEvents[nearTerminalEvents.length - 1];
    assert.ok(
      ['run.completed', 'run.failed', 'run.cancelled'].includes(nearLast?.event),
      `Terminal event should be in replay result, got: ${nearLast?.event}`
    );
    console.log('TEST 7 PASS: terminal replay verified, stream closed after terminal event.');

    // -----------------------------------------------------------------------
    // TEST 8: Repository Roundtrip
    // -----------------------------------------------------------------------
    console.log('--- TEST 8: Repository Roundtrip ---');

    await new Promise<void>((resolve, reject) => {
      exec(`npx tsx test/repo-roundtrip.ts ${runData.id}`, (err, stdout, stderr) => {
        if (err) { console.error(stderr); return reject(new Error(`Repository roundtrip failed: ${stdout || stderr}`)); }
        console.log(stdout.trim());
        resolve();
      });
    });
    console.log('TEST 8 PASS: repository roundtrip verified.');

    // -----------------------------------------------------------------------
    // TEST 9: Multiple Subscribers
    // -----------------------------------------------------------------------
    console.log('--- TEST 9: Multiple Subscribers ---');

    // Create a fresh run for the multi-subscriber test
    const multiRunRes = await fetch(`${BASE_URL}/api/runs`, {
      method: 'POST',
      headers: INT_HEADERS,
      body: JSON.stringify({
        intent: 'AGENT_MISSION',
        prompt: 'Multi-subscriber test',
        systemPrompt: 'You are a test agent',
        modelPolicy: { model: 'mock-deterministic' }
      })
    });
    if (!multiRunRes.ok) throw new Error(`Failed to create multi-sub run: ${multiRunRes.status}`);
    const multiRun = await multiRunRes.json();

    // Two concurrent SSE connections to the same run
    const [subA, subB] = await Promise.all([
      collectSseEvents(multiRun.id, INT_HEADERS, 3, 8000),  // Disconnects early
      collectSseEvents(multiRun.id, INT_HEADERS, 10, 8000), // Continues receiving
    ]);

    assert.ok(subA.length === 3, `Subscriber A should receive exactly 3 events before disconnecting, got ${subA.length}`);
    assert.ok(subB.length > 3, `Subscriber B should receive more than 3 events, got ${subB.length}`);

    // Both should see the same sequence of events up to the point A disconnected
    const seqA = subA.map(e => e.id);
    const seqB = subB.map(e => e.id);
    
    for (let i = 0; i < seqA.length; i++) {
      assert.strictEqual(seqA[i], seqB[i],
        `Subscribers A and B should see same event at position ${i}: A=${seqA[i]}, B=${seqB[i]}`);
    }
    console.log(`Subscriber A got ${subA.length} events, B got ${subB.length} events. First ${seqA.length} match.`);
    console.log('TEST 9 PASS: multiple subscribers and disconnect isolation verified.');

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------
    console.log('Cleaning up...');
    apiServer2.kill();
    mcpServer.kill();
    console.log('Integration tests PASS.');
    apiServer.kill();
    mcpServer.kill();
    process.exit(0);
  } catch (err) {
    console.error('Integration tests FAILED:', err);
    apiServer.kill();
    mcpServer.kill();
    process.exit(1);
  }
}

runIntegration();
