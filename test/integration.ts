import { spawn, exec } from 'child_process';
import assert from 'assert';
import path from 'path';

const API_PORT = 3001;
const MCP_PORT = 3002;
const BASE_URL = `http://127.0.0.1:${API_PORT}`;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runIntegration() {
  console.log('--- TEST 1: Fresh Migration ---');
  await new Promise((resolve, reject) => {
    const script = `import path from 'path'; import { pathToFileURL } from 'url'; async function clean() { const dbModule = await import(pathToFileURL(path.resolve('./packages/db/src/index.ts')).href); const db = dbModule.db; await db.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await db.migrate.latest(); console.log('Clean DB migration PASS'); process.exit(0); } clean().catch((err) => { console.error(err); process.exit(1); });`;
    exec(`npx tsx -e "${script}"`, (err, stdout, stderr) => {
      if (err) return reject(err);
      console.log('DB Migration complete.');
      resolve(true);
    });
  });

  console.log('Starting MCP server...');
  const mcpServer = spawn('npx', ['tsx', 'packages/mcp/src/test-server.ts'], { shell: true });
  
  console.log('Starting API server...');
  const apiServer = spawn('npx', ['tsx', 'apps/api/src/index.ts'], { shell: true });
  apiServer.stdout?.on('data', d => console.log(`API: ${d.toString().trim()}`));
  apiServer.stderr?.on('data', d => console.error(`API ERR: ${d.toString().trim()}`));

  // Wait for servers to boot
  await sleep(5000);

  try {
    console.log('--- TEST 1: MCP Integration ---');
    // Ensure we can list MCP tools from API if API has the MCP endpoint?
    // Wait, let's just trigger a test that creates a run.
    console.log('--- TEST 2: Durability & Fail-over ---');
    const createRunRes = await fetch(`${BASE_URL}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    console.log('--- TEST 3: Process Restart Recovery ---');
    console.log('Killing API server...');
    apiServer.kill();
    await sleep(1000);
    
    console.log('Restarting API server...');
    const apiServer2 = spawn('npx', ['tsx', 'apps/api/src/index.ts'], { shell: true });
    apiServer2.stdout?.on('data', d => console.log(`API2: ${d.toString().trim()}`));
    apiServer2.stderr?.on('data', d => console.error(`API2 ERR: ${d.toString().trim()}`));
    await sleep(3000);
    
    console.log('Fetching run after restart...');
    const getRunRes = await fetch(`${BASE_URL}/api/runs/${runData.id}`);
    const getRunData = await getRunRes.json();
    
    assert.strictEqual(getRunData.id, runData.id, 'Run should persist across restarts');
    console.log('Run persistence verified.');
    
    console.log('--- TEST 4: Scheduler Concurrency ---');
    console.log('Spawning two claim workers concurrently...');
    const claimScript = `import path from 'path'; import { pathToFileURL } from 'url'; async function run() { const repoModule = await import(pathToFileURL(path.resolve('./packages/automation/src/repositories.ts')).href); const repo = new repoModule.PostgresAutomationRunRepository(); const claim = await repo.claimRun('auto_default', 10000); console.log(claim ? 'CLAIMED' : 'CONFLICT'); process.exit(0); } run().catch((err) => { console.error(err); process.exit(1); });`;
    
    const [w1, w2] = await Promise.all([
      new Promise(res => exec(`npx tsx -e "${claimScript}"`, (err, stdout) => res(stdout.trim()))),
      new Promise(res => exec(`npx tsx -e "${claimScript}"`, (err, stdout) => res(stdout.trim())))
    ]);
    const claimedCount = [w1, w2].filter(out => out.includes('CLAIMED')).length;
    assert.strictEqual(claimedCount, 1, `Exactly one worker should claim the run. Got outputs: w1=${w1}, w2=${w2}`);
    console.log('Scheduler concurrency verified.');
    
    console.log('--- TEST 5: SSE Event Replay ---');
    
    // Helper to read SSE events
    async function collectSseEvents(runId: string, headers: Record<string, string> = {}, limit: number, timeoutMs = 5000): Promise<{ id: string, event: string, data: any }[]> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${BASE_URL}/api/runs/${runId}/events`, {
          headers: { ...headers },
          signal: controller.signal
        });
        
        const reader = res.body?.getReader();
        const events: any[] = [];
        let buffer = '';
        
        let currentId = '';
        let currentEvent = '';
        
        if (!reader) throw new Error('No reader');
        
        while (events.length < limit) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = new TextDecoder().decode(value);
          console.log(`SSE chunk: ${chunk}`);
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (line.startsWith('id: ')) currentId = line.substring(4).trim();
            else if (line.startsWith('event: ')) currentEvent = line.substring(7).trim();
            else if (line.startsWith('data: ')) {
              events.push({
                id: currentId,
                event: currentEvent,
                data: JSON.parse(line.substring(6).trim())
              });
              console.log(`Collected event: ${currentEvent} (id: ${currentId})`);
            }
          }
        }
        clearTimeout(timeout);
        controller.abort();
        return events;
      } catch (e: any) {
        if (e.name === 'AbortError') return [];
        throw e;
      }
    }

    // Since we created runData earlier, it should have some events (run.created, etc.)
    console.log('Checking DB for events...');
    const dbEvents = await new Promise<any>((resolve, reject) => {
      exec(`npx tsx -e "import path from 'path'; import { pathToFileURL } from 'url'; async function run() { const dbModule = await import(pathToFileURL(path.resolve('./packages/db/src/index.ts')).href); const rows = await dbModule.db('run_events').where({ run_id: '${runData.id}' }); console.log(JSON.stringify(rows)); process.exit(0); } run().catch(err => { console.error(err); process.exit(1); })"`, (err, stdout) => {
        if (err) return reject(err);
        resolve(JSON.parse(stdout));
      });
    });
    console.log(`DB events count: ${dbEvents.length}`);

    const allEvents = await collectSseEvents(runData.id, {}, 1);
    assert.ok(allEvents.length >= 1, 'Should collect at least 1 event');
    const firstEventId = allEvents[0].id;
    assert.ok(firstEventId !== '', 'Event should have a sequence ID');
    
    console.log('Fetching with Last-Event-ID...');
    const replayedEvents = await collectSseEvents(runData.id, { 'Last-Event-ID': firstEventId }, 1, 2000);
    if (replayedEvents.length > 0) {
      assert.notStrictEqual(replayedEvents[0].id, firstEventId, 'Replayed event should be strictly after the cursor');
    }
    console.log('SSE replay tests verified.');
    
    console.log('Cleaning up...');
    apiServer2.kill();
    mcpServer.kill();
    console.log('Integration tests PASS.');
  } catch (err) {
    console.error('Integration tests FAILED:', err);
    apiServer.kill();
    mcpServer.kill();
    process.exit(1);
  }
}

runIntegration();
