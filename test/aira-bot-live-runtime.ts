import assert from 'node:assert/strict';
import { fork, spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, connect, type Socket } from 'node:net';
import { createHash, createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestDatabase } from './postgres-fixture.js';

process.env.NODE_ENV = 'test';
const cleanup = await createTestDatabase();
const { db, runMigrations, closeDb } = await import('../packages/db/src/index.js');
await runMigrations();
const children: ChildProcess[] = [];
const dockerNames = new Map<ChildProcess, string>();
const dockerMode = process.env.AIRA_TEST_USE_DOCKER_RUNNER === 'true';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aira-phase7-runner-'));
const owner = 'phase7-owner';
const runnerToken = createHmac('sha256', 'phase7-test-secret').update(owner).digest('hex');
const sockets = new Set<Socket>();
const databaseUrl = new URL(process.env.DATABASE_URL!);
let proxy!: ReturnType<typeof createServer>;
let proxyPort = 0;
async function startProxy() {
  proxy = createServer(client => {
    const upstream = connect(Number(databaseUrl.port || 5432), databaseUrl.hostname);
    sockets.add(client); sockets.add(upstream);
    client.pipe(upstream); upstream.pipe(client);
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
  });
  proxy.listen(proxyPort, '127.0.0.1');
  await once(proxy, 'listening');
  proxyPort = (proxy.address() as any).port;
}
async function stopProxy() {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => proxy.close(() => resolve()));
}
const logs = new Map<ChildProcess, string>();
function capture(child: ChildProcess) {
  children.push(child); logs.set(child, '');
  child.stdout?.on('data', value => logs.set(child, logs.get(child) + value));
  child.stderr?.on('data', value => logs.set(child, logs.get(child) + value));
  return child;
}
async function until(check: () => Promise<boolean>, message: string, timeout = 20000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message + '\n' + [...logs.values()].join('\n').slice(-8000));
}
async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as any).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}
const runnerPort = await freePort();
const runnerUrl = 'http://127.0.0.1:' + runnerPort;
async function startRunner() {
  const name = 'aira-phase7-test-' + path.basename(root).toLowerCase();
  const program = dockerMode ? 'docker' : process.execPath;
  const args = dockerMode ? [
    'run', '--rm', '--name', name, '--user', String(process.getuid!()) + ':' + String(process.getgid!()),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=268435456',
    '--mount', 'type=bind,source=' + root + ',target=/data', '--publish', '127.0.0.1:' + runnerPort + ':7777',
    '--env', 'AIRA_RUNNER_TOKEN=' + runnerToken, '--env', 'AIRA_COMPUTER_PROGRAMS=node', 'aira-computer:certified'
  ] : ['docker/aira-computer/runner.mjs'];
  const child = capture(spawn(program, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AIRA_RUNNER_TOKEN: runnerToken, AIRA_RUNNER_PORT: String(runnerPort), AIRA_RUNNER_DATA_ROOT: root, AIRA_COMPUTER_PROGRAMS: 'node' },
    windowsHide: true
  }));
  if (dockerMode) dockerNames.set(child, name);
  await until(async () => {
    try { return (await fetch(runnerUrl + '/health', { headers: { Authorization: 'Bearer ' + runnerToken }, signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, 'native runner starts');
  return child;
}
async function startApi(name: string) {
  const url = new URL(databaseUrl); url.hostname = '127.0.0.1'; url.port = String(proxyPort);
  const child = capture(fork(fileURLToPath(new URL('./aira-bot-live-api-worker.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: url.toString(), AIRA_TEST_RUNNER_URL: runnerUrl,
      AIRA_INSTANCE_ID: name, AIRA_WORKER_ID: name, AIRA_RUN_LEASE_TTL_MS: '15000',
      AIRA_RUNTIME_HEARTBEAT_MS: '5000', AIRA_SCHEDULER_LEASE_MS: '7000' }
  }));
  const state: any = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('API startup timed out: ' + logs.get(child))), 20000);
    child.on('message', message => { if ((message as any).ready) { clearTimeout(timer); resolve(message); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('API startup exited ' + code + ': ' + logs.get(child))); });
  });
  return { child, ...state, url: 'http://127.0.0.1:' + state.port };
}
let commandId = 0;
async function command(api: any, action: string, values: any = {}) {
  const id = ++commandId;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { api.child.off('message', receive); reject(new Error('IPC timeout: ' + action)); }, 20000);
    const receive = (message: any) => { if (message.id === id) { clearTimeout(timer); api.child.off('message', receive); if (message.error) reject(new Error(message.error)); else resolve(message); } };
    api.child.on('message', receive); api.child.send({ id, action, ...values });
  });
}
function signal(api: any, key: string) {
  return new Promise<void>(resolve => {
    const receive = (message: any) => { if (message[key]) { api.child.off('message', receive); resolve(); } };
    api.child.on('message', receive);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const container = dockerNames.get(child);
  if (container) await new Promise<void>((resolve, reject) => execFile('docker', ['rm', '-f', container], { timeout: 15000, windowsHide: true }, error => error ? reject(error) : resolve()));
  child.kill('SIGKILL'); await exited;
}
async function api(instance: any, route: string, method = 'GET', body?: unknown, lease?: string, key?: string, user = owner) {
  const response = await fetch(instance.url + '/api/aira-bot' + route, {
    method, headers: { 'Content-Type': 'application/json', 'x-test-user-id': user, 'x-test-session-id': 'phase7-human',
      ...(lease ? { 'x-aira-computer-lease': lease } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000)
  });
  return { status: response.status, data: await response.json() };
}
try {
  await startProxy();
  let runner = await startRunner();
  const a = await startApi('phase7-api-A');
  const b = await startApi('phase7-api-B');
  assert.equal((await fetch(a.url + '/api/ready')).status, 200);
  assert.equal((await fetch(b.url + '/api/ready')).status, 200);
  const created = await api(a, '/bots', 'POST', {
    name: 'Distributed fixture', description: '', instructions: 'Use bounded tools.', model: 'gpt-4o',
    tools: ['terminal_exec', 'file_read', 'file_write'], approvalPolicy: 'risky_only', memory: '', skills: [], maxSteps: 4
  });
  assert.equal(created.status, 201);
  const bot = created.data;
  const computer = '/bots/' + bot.id + '/computer';
  assert.equal((await api(b, computer, 'GET', undefined, undefined, undefined, 'other-owner')).status, 404);
  const takeover = await api(a, computer + '/takeover', 'POST', {});
  assert.equal(takeover.status, 200);
  const lease = takeover.data.leaseToken;
  assert.equal((await api(b, computer)).data.humanControl, true);
  if (dockerMode) {
    assert.equal((await api(a, computer + '/start', 'POST', {}, lease, 'browser-start')).status, 200);
    assert.equal((await api(b, computer)).data.state, 'RUNNING');
    assert.equal((await api(b, computer + '/stop', 'POST', {}, lease, 'browser-stop')).status, 200);
    console.log('PASS Docker runner starts/stops Chromium and persists lifecycle intent/observation');
  }
  const written = await api(a, computer + '/file', 'PUT', { path: 'shared.txt', content: 'Shared across API instances.' }, lease, 'shared-file');
  assert.equal(written.status, 200);
  const rejectedBody = JSON.stringify({ botKey: createHash('sha256').update(owner + '\0' + bot.id).digest('hex').slice(0, 32), path: 'rejected.txt', content: 'must not execute' });
  assert.equal((await fetch(runnerUrl + '/file', { method: 'PUT', body: rejectedBody,
    headers: { Authorization: 'Bearer ' + runnerToken, 'Content-Type': 'application/json' } })).status, 403);
  const authority = await db('aira_computer_leases').where({ owner_id: owner }).first();
  for (const invalid of [{ fence: Number(authority.fence), token: authority.token, expiresAt: Date.now() - 1 },
    { fence: Number(authority.fence) - 1, token: authority.token, expiresAt: Date.now() + 60000 },
    { fence: Number(authority.fence), token: 'wrong-token', expiresAt: Date.now() + 60000 }]) {
    const identity = JSON.stringify({ id: createHash('sha256').update(JSON.stringify(invalid)).digest('hex'), method: 'PUT', route: '/file',
      digest: createHash('sha256').update(rejectedBody).digest('hex'), ...invalid });
    const rejection = await fetch(runnerUrl + '/file', { method: 'PUT', body: rejectedBody, headers: {
      Authorization: 'Bearer ' + runnerToken, 'Content-Type': 'application/json', 'x-aira-action': identity,
      'x-aira-action-signature': createHmac('sha256', runnerToken).update(identity).digest('hex')
    } });
    assert.equal(rejection.status, invalid.fence < 1 ? 403 : 409);
  }
  console.log('PASS runner rejects unsigned, expired, stale-fence and mismatched-token action authority');
  assert.equal((await api(b, computer + '/file?path=shared.txt')).data.content, 'Shared across API instances.');
  const replay = await api(b, computer + '/file', 'PUT', { path: 'shared.txt', content: 'Shared across API instances.' }, lease, 'shared-file');
  assert.equal(replay.status, 200);
  assert.equal((await api(b, computer + '/file', 'PUT', { path: 'shared.txt', content: 'different' }, lease, 'shared-file')).status, 409);
  const originalEvents = (await api(a, computer + '/events')).data;
  const cursor = originalEvents[0].sequence;
  assert.deepEqual((await api(b, computer + '/events?after=' + cursor)).data.map((event: any) => event.sequence),
    originalEvents.filter((event: any) => event.sequence > cursor).map((event: any) => event.sequence));
  const routineCreated = await api(a, '/bots/' + bot.id + '/routines', 'POST', {
    name: 'Crash-safe dispatch', objective: 'Original routine objective', cronExpression: '* * * * *', timezone: 'UTC', enabled: true
  });
  assert.equal(routineCreated.status, 201);
  const orphanSlot = Math.floor(Date.now() / 60000) * 60000 - 300000;
  const abandonedClaim = (await command(a, 'claim-routine', { owner, routineId: routineCreated.data.id, scheduledFor: orphanSlot })).claim;
  assert.ok(abandonedClaim);
  await api(b, '/bots/' + bot.id + '/routines/' + routineCreated.data.id, 'PATCH', { objective: 'Modified later objective' });
  console.log('PASS two live APIs share lease, files, cursor replay and idempotency protection');

  const script = 'const fs=require("node:fs");fs.appendFileSync("effects.log","effect\\n");console.log("done")';
  await command(a, 'lose-response');
  const observed = signal(a, 'effectObserved');
  const lost = api(a, computer + '/terminal', 'POST', { program: 'node', args: ['-e', script] }, lease, 'lost-response').catch(() => undefined);
  await observed; await kill(a.child); await lost;
  await command(b, 'recover'); await command(b, 'publish');
  const retried = await api(b, computer + '/terminal', 'POST', { program: 'node', args: ['-e', script] }, lease, 'lost-response');
  assert.equal(retried.status, 200);
  assert.equal((await api(b, computer + '/file?path=effects.log')).data.content, 'effect\n', 'API death after the effect cannot replay the terminal command');
  const actionId = createHash('sha256').update(owner + '\0' + bot.id + '\0lost-response').digest('hex');
  assert.equal((await db('aira_computer_actions').where({ id: actionId }).first()).status, 'COMPLETED');
  const delivered = await db('aira_computer_events').where({ source_key: 'action:' + actionId });
  assert.equal(delivered.length, 1);
  // Lost acknowledgement: reclaim the already delivered outbox record.
  await db('aira_runtime_outbox').where({ dedupe_key: 'action:' + actionId }).update({ status: 'PENDING', available_at: 0 });
  await command(b, 'publish');
  assert.equal((await db('aira_computer_events').where({ source_key: 'action:' + actionId })).length, 1);
  console.log('PASS killed API recovers runner receipt; effect executes once; outbox redelivery does not duplicate events');

  const interruptedScript = 'const fs=require("node:fs");fs.appendFileSync("uncertain.log","effect\\n");setTimeout(()=>console.log("done"),3000)';
  const pending = api(b, computer + '/terminal', 'POST', { program: 'node', args: ['-e', interruptedScript] }, lease, 'runner-crash').catch(() => undefined);
  const botKey = createHash('sha256').update(owner + '\0' + bot.id).digest('hex').slice(0, 32);
  await until(async () => {
    try {
      const response = await fetch(runnerUrl + '/file?botKey=' + botKey + '&path=uncertain.log', { headers: { Authorization: 'Bearer ' + runnerToken } });
      return (await response.json()).content === 'effect\n';
    }
    catch { return false; }
  }, 'terminal side effect is observed before runner death');
  await kill(runner); await pending;
  runner = await startRunner();
  await command(b, 'recover');
  assert.equal((await api(b, computer + '/terminal', 'POST', { program: 'node', args: ['-e', interruptedScript] }, lease, 'runner-crash')).status, 409);
  assert.equal((await api(b, computer + '/takeover', 'POST', {})).status, 409);
  const uncertainId = createHash('sha256').update(owner + '\0' + bot.id + '\0runner-crash').digest('hex');
  assert.equal((await db('aira_computer_actions').where({ id: uncertainId }).first()).status, 'AMBIGUOUS');
  assert.equal((await api(b, computer + '/actions/' + uncertainId + '/acknowledge', 'POST', {})).status, 400);
  await delay(3200); // native child is bounded; Docker restart would kill its process group
  assert.equal((await api(b, computer + '/actions/' + uncertainId + '/acknowledge', 'POST', { acknowledgeMayHaveExecuted: true })).status, 200);
  assert.equal((await api(b, computer + '/terminal', 'POST', { program: 'node', args: ['-e', interruptedScript] }, lease, 'runner-crash')).status, 409, 'abandoned action ID cannot be replayed');
  assert.equal((await api(b, computer + '/file?path=uncertain.log')).data.content, 'effect\n');
  assert.equal((await api(b, computer + '/release', 'POST', { leaseToken: lease })).status, 200);
  console.log('PASS runner restart retains STARTED receipt, blocks ambiguity and requires explicit acknowledgement/revocation');

  const c = await startApi('phase7-api-C');
  const held = signal(c, 'modelHeld');
  const run = await api(c, '/bots/' + bot.id + '/tasks', 'POST', { prompt: 'hold-model' });
  assert.equal(run.status, 201); await held; await kill(c.child);
  await until(async () => {
    const row = await db('runs').where({ id: run.data.run.id }).first();
    return row.state === 'COMPLETED';
  }, 'surviving API recovers killed model worker after lease expiry', 75000);
  assert.equal((await db('runs').where({ id: run.data.run.id }).first()).execution_owner, null);
  console.log('PASS periodic live recovery completes an interrupted run without stale-worker writes');

  await until(async () => {
    const row = await db('aira_bot_routine_runs').where({ id: abandonedClaim.id }).first();
    const now = Number((await db.raw('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000) AS now')).rows[0].now);
    return Number(row.dispatch_until) <= now;
  }, 'dead routine dispatcher claim expires', 35000);
  await command(b, 'heartbeat');
  await Promise.all([command(b, 'routine-tick', { now: Date.now() }), command(b, 'routine-tick', { now: Date.now() })]);
  const routineRun = await db('aira_bot_routine_runs').where({ id: abandonedClaim.id }).first();
  assert.equal(routineRun.status, 'RUNNING');
  assert.equal(Number(routineRun.dispatch_fence), Number(abandonedClaim.dispatchFence) + 1);
  assert.equal((await db('runs').where({ id: routineRun.run_id }).first()).prompt, 'Original routine objective');
  assert.equal((await db('aira_bot_tasks').where({ run_id: routineRun.run_id })).length, 1);
  const { BotOrchestrationRepository } = await import('../packages/aira-bot/src/orchestration.js');
  assert.equal(await new BotOrchestrationRepository().failRoutineRun(abandonedClaim.id, 'stale dispatcher', abandonedClaim), false);
  console.log('PASS dead routine dispatcher is reclaimed once with its original snapshot and stale dispatch writes are rejected');

  await stopProxy();
  const offline = await fetch(b.url + '/api/ready', { signal: AbortSignal.timeout(20000) });
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).database, false);
  assert.equal((await fetch(b.url + '/api/health')).status, 200);
  await startProxy();
  await command(b, 'heartbeat');
  await until(async () => (await fetch(b.url + '/api/ready')).status === 200, 'readiness recovers after genuine database connectivity loss');
  console.log('PASS genuine database disconnection makes readiness 503 while liveness remains available; reconnect restores readiness');
  console.log('Aira Bot live distributed runtime: PASS — real PostgreSQL, two API processes, ' + (dockerMode ? 'Docker runner container' : 'native runner process') + ', durable actions, receipt recovery, ambiguity/revocation, outbox delivery, worker recovery, database network interruption');
} finally {
  await Promise.all(children.map(kill));
  if (proxy?.listening) await stopProxy();
  await closeDb(); await cleanup();
  await fs.rm(root, { recursive: true, force: true });
}
