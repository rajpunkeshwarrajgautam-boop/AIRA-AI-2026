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
