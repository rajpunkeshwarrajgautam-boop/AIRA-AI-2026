import assert from 'node:assert/strict';
import { ComputerLeaseManager } from '../packages/computer-runtime/src/lease.js';
import { DockerComputerProvider } from '../packages/computer-runtime/src/docker.js';
import { ManagedComputerRuntime } from '../packages/computer-runtime/src/managed.js';
import type { ComputerProvider } from '../packages/computer-runtime/src/provider.js';
import type { Run, ToolCall } from '../packages/contracts/src/index.js';
import { withComputerAction } from '../packages/computer-runtime/src/action-context.js';

const leases = new ComputerLeaseManager(60_000);
const first = leases.acquireBot('owner-a', 'bot-a', 'run-a');
assert.equal(first.mode, 'BOT');
assert.throws(() => leases.acquireBot('owner-a', 'bot-b', 'run-b'), /COMPUTER_BUSY/);
const takeover = leases.takeover('owner-a', 'bot-a', 'session-a');
assert.equal(takeover.preempted?.holderId, 'run:run-a');
assert.equal(takeover.lease.mode, 'HUMAN');
assert.throws(() => leases.acquireBot('owner-a', 'bot-a', 'run-a'), /COMPUTER_TAKEN_OVER/);
assert.equal(leases.assertHuman('owner-a', takeover.lease.token).holderId, 'human:session-a');
assert(leases.release('owner-a', takeover.lease.token));
assert.equal(leases.acquireBot('owner-a', 'bot-b', 'run-b').holderId, 'run:run-b');
assert.equal(leases.releaseRun('owner-a', 'run-b'), true);

let opened = 0;
const fakeProvider: ComputerProvider = {
  kind: 'docker', enabled: true, terminalEnabled: true, allowedPrograms: ['node'],
  async status() { return { enabled: true, state: 'RUNNING', workspaceReady: true, browser: { state: 'RUNNING' }, terminal: { enabled: true, allowedPrograms: ['node'] } }; },
  async start(ownerId, botId) { return this.status(ownerId, botId); },
  async stop(ownerId, botId) { return this.status(ownerId, botId); },
  async open(_ownerId, _botId, url) { opened++; return { url, title: 'fixture', text: 'ok', links: [], screenshotPath: 'screenshots/latest.png' }; },
  async click(_ownerId, _botId, selector) { return { action: 'click', url: 'https://example.com', title: selector, text: '', links: [], screenshotPath: 'screenshots/latest.png' }; },
  async type(_ownerId, _botId, selector) { return { action: 'type', url: 'https://example.com', title: selector, text: '', links: [], screenshotPath: 'screenshots/latest.png' }; },
  async scroll() { return { action: 'scroll', url: 'https://example.com', title: '', text: '', links: [], screenshotPath: 'screenshots/latest.png' }; },
  async waitFor(_ownerId, _botId, selector) { return { action: 'wait', url: 'https://example.com', title: selector, text: '', links: [], screenshotPath: 'screenshots/latest.png' }; },
  async screenshot() { return { action: 'screenshot', url: 'https://example.com', title: '', text: '', links: [], screenshotPath: 'screenshots/latest.png' }; },
  async listFiles() { return []; },
  async readText(_ownerId, _botId, relativePath) { return { path: relativePath, content: 'ok', sizeBytes: 2 }; },
  async writeText(_ownerId, _botId, relativePath, content) { return { path: relativePath, sizeBytes: Buffer.byteLength(content) }; },
  async terminal(_ownerId, _botId, program, args = []) { return { program, args, exitCode: 0, stdout: '', stderr: '', truncated: false }; }
};
const managed = new ManagedComputerRuntime(fakeProvider, new ComputerLeaseManager());
const run = { id: 'run-1', principalId: 'owner-x', agentId: 'bot-x' } as Run;
const call: ToolCall = { id: 'call-1', toolId: 'tool_browser_open', name: 'browser_open', arguments: { url: 'https://example.com' }, timestamp: Date.now(), status: 'PENDING' };
const human = await managed.takeover('owner-x', 'bot-x', 'session-x');
const blocked = await managed.execute(run, call);
assert.equal(blocked.isError, true);
assert.equal(blocked.error, 'COMPUTER_TAKEN_OVER');
assert.equal(opened, 0);
await managed.releaseHuman('owner-x', 'bot-x', human.lease.token);
const executed = await managed.execute(run, call);
assert.equal(executed.isError, false);
assert.equal(opened, 1);
const otherRun = { ...run, id: 'run-2', agentId: 'bot-y' } as Run;
const busy = await managed.execute(otherRun, { ...call, id: 'call-2' });
assert.equal(busy.error, 'COMPUTER_BUSY');
await managed.releaseRun('owner-x', 'run-1');

let exists = false;
let running = false;
let dockerRunArgs: string[] = [];
const dockerCalls: string[][] = [];
const fakeDocker = async (args: string[]) => {
  dockerCalls.push(args);
  if (args[0] === 'inspect') {
    if (!exists) throw new Error('No such object: fixture');
    return { stdout: running ? 'true\n' : 'false\n', stderr: '' };
  }
  if (args[0] === 'run') { exists = true; running = true; dockerRunArgs = args; return { stdout: 'container-id\n', stderr: '' }; }
  if (args[0] === 'start') { running = true; return { stdout: 'started\n', stderr: '' }; }
  if (args[0] === 'port') return { stdout: '127.0.0.1:49152\n', stderr: '' };
  if (args[0] === 'stop') { running = false; return { stdout: '', stderr: '' }; }
  if (args[0] === 'rm') { exists = false; running = false; return { stdout: '', stderr: '' }; }
  throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
};
const runnerUrls: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input); runnerUrls.push(url);
  const headers = new Headers(init?.headers);
  assert.match(headers.get('Authorization') || '', /^Bearer [a-f0-9]{64}$/);
  const pathname = new URL(url).pathname;
  if (pathname === '/status') return new Response(JSON.stringify({ browser: { state: 'RUNNING' }, terminal: { enabled: true, allowedPrograms: ['node'] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const docker = new DockerComputerProvider({ image: 'aira-computer:test', runnerSecret: 'test-runner-secret', allowedPrograms: ['node'], execute: fakeDocker, fetcher: fakeFetch });
const owner = 'sensitive-user@example.test';
assert.equal(docker.containerName(owner), docker.containerName(owner));
assert.equal(docker.volumeName(owner), docker.volumeName(owner));
assert.notEqual(docker.botKey(owner, 'bot-a'), docker.botKey(owner, 'bot-b'));
assert(!docker.containerName(owner).includes('sensitive'));
assert(!docker.volumeName(owner).includes('sensitive'));
await withComputerAction({
  actionId: 'a'.repeat(64),
  lease: { ownerId: owner, botId: 'bot-a', holderId: 'test', mode: 'BOT', token: 'test-token', fence: 1, acquiredAt: Date.now(), expiresAt: Date.now() + 60000 }
}, () => docker.start(owner, 'bot-a'));
assert(dockerRunArgs.includes('--read-only'));
assert.deepEqual(dockerRunArgs.slice(dockerRunArgs.indexOf('--cap-drop'), dockerRunArgs.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
assert(dockerRunArgs.includes('no-new-privileges:true'));
assert(dockerRunArgs.includes('127.0.0.1::7777'));
assert(dockerRunArgs.some(value => value.startsWith('type=volume,source=aira-computer-data-') && value.endsWith(',target=/data')));
assert(dockerRunArgs.includes('--memory'));
assert(dockerRunArgs.includes('--cpus'));
assert(runnerUrls.length >= 3 && runnerUrls.every(url => url.startsWith('http://127.0.0.1:49152/')));
assert(dockerCalls.some(args => args[0] === 'run'));

process.stdout.write('Aira Bot isolated computer: PASS\n');
