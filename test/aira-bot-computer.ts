import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ComputerRuntime } from '../packages/computer-runtime/src/index.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'aira-computer-'));
const runtime = new ComputerRuntime({ enabled: true, terminalEnabled: true, root, allowedPrograms: ['node'] });
const owner = 'test-owner';
const bot = 'bot_test';

try {
  const definitions = runtime.toolDefinitions();
  assert.equal(definitions.find(tool => tool.name === 'browser_open')?.permissionLevel, 'READ');
  assert.equal(definitions.find(tool => tool.name === 'file_write')?.permissionLevel, 'WRITE');
  assert.equal(definitions.find(tool => tool.name === 'terminal_exec')?.permissionLevel, 'DESTRUCTIVE');

  const initial = await runtime.status(owner, bot);
  assert.equal(initial.state, 'STOPPED');
  assert.equal(initial.workspaceReady, false);

  await runtime.writeText(owner, bot, 'notes/result.md', '# computer runtime\n');
  const read = await runtime.readText(owner, bot, 'notes/result.md');
  assert.equal(read.content, '# computer runtime\n');
  const files = await runtime.listFiles(owner, bot);
  assert(files.some(file => file.path === 'notes/result.md' && file.type === 'file'));

  await assert.rejects(() => runtime.readText(owner, bot, '../package.json'), /invalid|escapes/i);
  await assert.rejects(() => runtime.writeText(owner, bot, '/tmp/outside.txt', 'no'), /invalid|escapes/i);

  if (process.platform !== 'win32') {
    const workspace = runtime.workspaceFor(owner, bot);
    await symlink(os.tmpdir(), path.join(workspace, 'escape'));
    await assert.rejects(() => runtime.readText(owner, bot, 'escape/anything.txt'), /symlink/i);
  }

  const terminal = await runtime.terminal(owner, bot, process.execPath, ['-e', 'process.stdout.write("computer-ok")']);
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.stdout, 'computer-ok');
  await assert.rejects(() => runtime.terminal(owner, bot, 'definitely-not-allowed', []), /allowlist/i);

  await assert.rejects(() => runtime.open(owner, bot, 'http://127.0.0.1:3000'), /private|loopback|blocked/i);
  await assert.rejects(() => runtime.open(owner, bot, 'http://localhost:3000'), /loopback/i);

  const running = await runtime.start(owner, bot);
  assert.equal(running.state, 'RUNNING');
  assert.equal(running.browser.state, 'RUNNING');
  const stopped = await runtime.stop(owner, bot);
  assert.equal(stopped.state, 'STOPPED');

  process.stdout.write('Aira Bot computer runtime: PASS\n');
} finally {
  await runtime.stop(owner, bot).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
