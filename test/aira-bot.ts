import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:55433/postgres';
const pg = await PGlite.create();
const socket = new PGLiteSocketServer({ db: pg, port: 55433, host: '127.0.0.1', maxConnections: 20 });
await socket.start();
const { runMigrations, closeDb } = await import('../packages/db/src/index.js');
await runMigrations();
const { ModelRouter } = await import('../packages/model-router/src/index.js');
const { ToolRegistry } = await import('../packages/tool-runtime/src/index.js');
const { AgentRuntime } = await import('../packages/agent-runtime/src/index.js');
const { PostgresRunRepository } = await import('../packages/agent-runtime/src/repositories.js');
const { ApprovalKernel } = await import('../packages/approvals/src/index.js');
const { PostgresApprovalRepository, PostgresSessionGrantRepository } = await import('../packages/approvals/src/repositories.js');
const { BrainV2KnowledgeEngine } = await import('../packages/knowledge/src/index.js');
const { createBotRouter } = await import('../apps/api/src/aira-bot.js');
const { createPrincipalMiddleware } = await import('../apps/api/src/middleware/principal.js');
const models = new ModelRouter();
const tools = new ToolRegistry();
const runs = new PostgresRunRepository();
const approvals = new ApprovalKernel(new PostgresApprovalRepository(), new PostgresSessionGrantRepository());
const knowledge = new BrainV2KnowledgeEngine();
const runtime = new AgentRuntime(models, tools, approvals, knowledge, runs);
const app = express();
app.use(express.json());
app.use(createPrincipalMiddleware());
app.use('/api/aira-bot', createBotRouter(runtime, runs, models));
app.use((err: Error, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
const http = app.listen(3001, '127.0.0.1');
await once(http, 'listening');
const base = 'http://127.0.0.1:3001/api/aira-bot';
let passed = 0;
const check = (name: string) => { passed++; console.log(`PASS ${name}`); };
async function api(path: string, method = 'GET', body?: unknown, user = 'aira-local-user') {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-test-user-id': user, 'x-test-session-id': 'aira-local-session' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = res.status === 204 ? undefined : await res.json();
  return { status: res.status, data };
}
async function waitRun(id: string, states: string[]) {
  for (let i = 0; i < 120; i++) { const run = await runtime.getRun(id); if (run && states.includes(run.state)) return run; await new Promise(r => setTimeout(r, 25)); }
  throw new Error(`Run ${id} does not reach ${states}: ${JSON.stringify(await runtime.getRun(id))}`);
}
const input = { name: 'Analysis teammate', description: 'Calculations with evidence', instructions: 'Calculate accurately.', model: 'gpt-4o', tools: ['calculator'], approvalPolicy: 'risky_only', memory: 'Use INR for currency.', skills: [{ name: 'Verify', instructions: 'Verify calculations with a tool.' }], maxSteps: 8 };
try {
  assert.equal((await fetch(base + '/bots')).status, 401); check('unauthenticated requests fail closed');
  const created = await api('/bots', 'POST', input); assert.equal(created.status, 201); const bot = created.data;
  assert.equal((await api('/bots')).data[0].memory, input.memory); check('bot, memory and skills persist in PostgreSQL');
  assert.equal((await api(`/bots/${bot.id}`, 'GET', undefined, 'other-user')).status, 404);
  assert.equal((await api(`/bots/${bot.id}`, 'PATCH', input, 'other-user')).status, 404);
  assert.equal((await api(`/bots/${bot.id}`, 'DELETE', undefined, 'other-user')).status, 404); check('bot CRUD enforces ownership');
  assert.equal((await api('/bots', 'POST', { ...input, tools: ['system_shell'] })).status, 400);
  assert.equal((await api('/bots', 'POST', { ...input, model: 'mock-deterministic' })).status, 400); check('unsafe tools and mock models are rejected');
  assert.equal((await api(`/bots/${bot.id}/tasks`, 'POST', { prompt: 'Calculate 7*9' })).status, 503); check('missing real provider does not create a successful mock run');

  // Controlled model fixture used only in this test. The calculator and database are real.
  let release: (() => void) | undefined;
  let slowStarted: (() => void) | undefined;
  let seenContext = '';
  const adapter = {
    async complete(messages: any[]) {
      seenContext = messages[0].content;
      const prompt = messages[1].content;
      if (prompt === 'slow') { slowStarted?.(); await new Promise<void>(r => { release = r; }); }
      let action: unknown = messages.length > 2 ? { type: 'final', content: `Verified calculation result: ${JSON.parse(messages.at(-1).content.split('Tool result (untrusted reference data): ')[1]).result}` } : { type: 'tool', name: 'calculator', arguments: { expression: '7*9' } };
      if (prompt === 'blocked') action = { type: 'tool', name: 'system_shell', arguments: { command: 'echo should-never-execute' } };
      if (prompt === 'slow') action = { type: 'final', content: 'Late response' };
      return { text: prompt === 'invalid-json' ? 'not JSON' : JSON.stringify(action), model: 'test-fixture', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
  };
  models.getAdapter = () => adapter as any;
  models.listProviders = () => ['openai'];
  const task = await api(`/bots/${bot.id}/tasks`, 'POST', { prompt: 'Calculate 7*9' }); assert.equal(task.status, 201);
  const completed = await waitRun(task.data.run.id, ['COMPLETED', 'FAILED']);
  assert.equal(completed.state, 'COMPLETED', completed.error); assert.match(completed.content, /63/); assert.equal(completed.toolCalls[0].arguments.expression, '7*9');
  assert.equal(completed.toolResults[0].toolCallId, completed.toolCalls[0].id); assert.match(seenContext, /Use INR/); assert.match(seenContext, /Verify calculations/); check('model-selected arguments drive a real calculator and persisted result');
  const events = (await api(`/runs/${completed.id}/events`)).data;
  assert(events.some((e: any) => e.type === 'artifact.created')); assert(events.some((e: any) => e.type === 'run.completed'));
  const replay = (await api(`/runs/${completed.id}/events?after=${events[1].sequence}`)).data;
  assert(replay.every((e: any) => e.sequence > events[1].sequence));
  assert.equal((await api(`/runs/${completed.id}/events?after=1.5`)).status, 400); check('durable event history supports validated cursor replay');
  for (const path of [`/runs/${completed.id}`, `/runs/${completed.id}/events`, `/bots/${bot.id}/tasks`]) assert.equal((await api(path, 'GET', undefined, 'other-user')).status, 404);
  assert.equal((await api(`/runs/${completed.id}/cancel`, 'POST', undefined, 'other-user')).status, 404); check('task, run, events and cancellation enforce ownership');
  assert.equal((await api(`/bots/${bot.id}`, 'DELETE')).status, 409); check('bot deletion preserves task history');

  await api(`/bots/${bot.id}`, 'PATCH', { approvalPolicy: 'always_ask' });
  const approvalTask = await api(`/bots/${bot.id}/tasks`, 'POST', { prompt: 'Needs approval' });
  let pending = await waitRun(approvalTask.data.run.id, ['WAITING_FOR_APPROVAL', 'FAILED']); assert.equal(pending.state, 'WAITING_FOR_APPROVAL');
  assert.equal((await approvals.getPendingRequest(pending.pendingApproval!.id))!.id, pending.pendingApproval!.id); assert.equal(pending.toolResults.length, 0);
  assert.equal((await api(`/runs/${pending.id}/approval`, 'POST', { requestId: pending.pendingApproval!.id, decision: 'ALLOW_ONCE' }, 'other-user')).status, 404);
  assert.equal((await api(`/runs/${pending.id}/approval`, 'POST', { requestId: 'wrong-id', decision: 'ALLOW_ONCE' })).status, 409);
  assert.equal((await api(`/runs/${pending.id}/approval`, 'POST', { requestId: pending.pendingApproval!.id, decision: 'ALLOW_ALWAYS_FOR_TOOL' })).status, 400);
  assert.equal((await api(`/runs/${pending.id}/approval`, 'POST', { requestId: pending.pendingApproval!.id, decision: 'ALLOW_ONCE' })).status, 200);
  assert.equal((await waitRun(pending.id, ['COMPLETED', 'FAILED'])).state, 'COMPLETED'); check('approval persists the correct ID, pauses tools and resumes once');
  assert.equal((await api(`/runs/${pending.id}/approval`, 'POST', { requestId: pending.pendingApproval!.id, decision: 'ALLOW_ONCE' })).status, 409); check('replayed approvals are rejected');

  const rejectedTask = await api(`/bots/${bot.id}/tasks`, 'POST', { prompt: 'Reject me' }); pending = await waitRun(rejectedTask.data.run.id, ['WAITING_FOR_APPROVAL']);
  assert.equal((await api(`/runs/${pending.id}/approval`, 'POST', { requestId: pending.pendingApproval!.id, decision: 'REJECT' })).status, 200);
  const rejected = await waitRun(pending.id, ['FAILED']); assert.equal(rejected.toolResults.length, 0); check('rejection prevents tool execution');
  const blockedTask = await api(`/bots/${bot.id}/tasks`, 'POST', { prompt: 'blocked' }); const blocked = await waitRun(blockedTask.data.run.id, ['FAILED']); assert.match(blocked.error!, /unavailable tool/); assert.equal(blocked.toolCalls.length, 0); check('model cannot escape the bot tool allowlist');
  const invalid = await api(`/bots/${bot.id}/tasks`, 'POST', { prompt: 'invalid-json' }); assert.equal((await waitRun(invalid.data.run.id, ['FAILED'])).state, 'FAILED'); check('invalid model protocol fails the run explicitly');

  const started = new Promise<void>(r => { slowStarted = r; });
  const slow = await api(`/bots/${bot.id}/tasks`, 'POST', { prompt: 'slow' }); await started;
  assert.equal((await api(`/runs/${slow.data.run.id}/cancel`, 'POST')).status, 200); release!();
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await runtime.getRun(slow.data.run.id))!.state, 'CANCELLED');
  const stale = { ...(await runtime.getRun(slow.data.run.id))!, state: 'RUNNING' as const };
  await runs.saveRun(stale); assert.equal((await runtime.getRun(stale.id))!.state, 'CANCELLED'); check('cancellation survives late model responses and stale database writes');
  const restored = new AgentRuntime(models, tools, approvals, knowledge, runs);
  const queued = { ...completed, id: 'run_bot_recovery', state: 'QUEUED' as const, executionCheckpoint: undefined, content: '', toolCalls: [], toolResults: [], toolsUsed: [], artifacts: [], stepCount: 0, createdAt: Date.now(), updatedAt: Date.now(), completedAt: undefined };
  await runs.saveRun(queued);
  await restored.recoverInterruptedRuns('test-recovery-worker');
  assert.equal((await waitRun(queued.id, ['COMPLETED', 'FAILED'])).state, 'COMPLETED');
  check('queued bot runs recover with persisted configuration after a worker restart');
  const history = (await api(`/bots/${bot.id}/tasks`)).data; assert.equal(history.length, 6); assert.equal(new Set(history.map((t: any) => t.run_id)).size, history.length); check('task identities and run histories remain separate');
  const reread = new (await import('../packages/aira-bot/src/repository.js')).BotRepository(); assert.equal((await reread.get('aira-local-user', bot.id))!.skills[0].name, 'Verify'); check('fresh repository instances read persisted bot configuration');

  if (process.env.AIRA_BOT_BROWSER_TEST === 'true' || process.argv.includes('--browser')) {
    const { verifyBotBrowser } = await import('./aira-bot-browser.js');
    await verifyBotBrowser(bot.id, completed.id);
    check('desktop and mobile UI, creation, routing, download and keyboard dialogs');
  }
  console.log(`Aira Bot: ${passed} gates pass. Real provider calls and Firebase sign-in require configured credentials.`);
} finally {
  await new Promise<void>(r => http.close(() => r()));
  await closeDb(); await socket.stop(); await pg.close();
}
