import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:55438/postgres';
process.env.AIRA_RUN_LEASE_TTL_MS = '15000';
const pg = await PGlite.create();
const socket = new PGLiteSocketServer({ db: pg, port: 55438, host: '127.0.0.1', maxConnections: 30 });
await socket.start();
const { db, runMigrations, closeDb } = await import('../packages/db/src/index.js');
await runMigrations();
const { BotRepository } = await import('../packages/aira-bot/src/repository.js');
const { ModelRouter } = await import('../packages/model-router/src/index.js');
const { ToolRegistry } = await import('../packages/tool-runtime/src/index.js');
const { AgentRuntime } = await import('../packages/agent-runtime/src/index.js');
const { PostgresRunRepository } = await import('../packages/agent-runtime/src/repositories.js');
const { ApprovalKernel } = await import('../packages/approvals/src/index.js');
const { PostgresApprovalRepository, PostgresSessionGrantRepository } = await import('../packages/approvals/src/repositories.js');
const { BrainV2KnowledgeEngine } = await import('../packages/knowledge/src/index.js');

const runs = new PostgresRunRepository();
const now = Date.now();
const seedRun: any = {
  id: 'run_lease_seed', principalId: 'lease-owner', agentId: null, sessionId: 'lease-session', workspaceId: null,
  projectId: null, conversationId: null, intent: 'ANSWER', state: 'QUEUED', modelPolicy: { model: 'gpt-4o' },
  prompt: 'lease seed', systemPrompt: '', context: {}, content: '', thinking: '', toolsUsed: [], toolCalls: [], toolResults: [],
  artifacts: [], citations: [], stepCount: 0, maxSteps: 8, createdAt: now, updatedAt: now
};

async function waitTerminal(runtime: InstanceType<typeof AgentRuntime>, id: string) {
  for (let i = 0; i < 160; i++) {
    const run = await runtime.getRun(id);
    if (run && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${id} did not become terminal.`);
}

try {
  await runs.saveRun(seedRun);
  const a = await runs.claimExecution(seedRun.id, 'worker-A', 15_000);
  assert.ok(a);
  assert.equal(a!.fence, 1);
  assert.equal(await runs.assertExecution(seedRun.id, 'worker-A', a!.fence), true);
  assert.equal(await runs.claimExecution(seedRun.id, 'worker-B', 15_000), undefined, 'a live lease must reject another worker');

  const renewed = await runs.renewExecution(seedRun.id, 'worker-A', a!.fence, 15_000);
  assert.ok(renewed);
  assert.equal(renewed!.fence, a!.fence);
  assert.equal(await runs.releaseExecution(seedRun.id, 'worker-A', a!.fence + 1), false, 'wrong fence cannot release an active lease');
  assert.equal(await runs.releaseExecution(seedRun.id, 'worker-A', a!.fence), true);

  const b = await runs.claimExecution(seedRun.id, 'worker-B', 15_000);
  assert.ok(b);
  assert(b!.fence > a!.fence, 'new ownership must increment the fence token');
  assert.equal(await runs.assertExecution(seedRun.id, 'worker-A', a!.fence), false, 'stale worker must lose authority');
  assert.equal(await runs.renewExecution(seedRun.id, 'worker-A', a!.fence, 15_000), undefined);

  // Expiration allows a new claimant, but the stale fence can no longer renew or release it.
  await db('runs').where({ id: seedRun.id }).update({ execution_lease_until: Date.now() - 1 });
  const c = await runs.claimExecution(seedRun.id, 'worker-C', 15_000);
  assert.ok(c);
  assert(c!.fence > b!.fence);
  assert.equal(await runs.renewExecution(seedRun.id, 'worker-B', b!.fence, 15_000), undefined);
  assert.equal(await runs.releaseExecution(seedRun.id, 'worker-B', b!.fence), false);
  assert.equal((await runs.getExecutionLease(seedRun.id))?.owner, 'worker-C');
  assert.equal(await runs.releaseExecution(seedRun.id, 'worker-C', c!.fence), true);

  // Two AgentRuntime instances race the same Bot run. Only one may reach the model boundary.
  const bots = new BotRepository();
  const bot = await bots.create('lease-owner', {
    name: 'Lease Bot', description: '', instructions: 'Finish the task.', model: 'gpt-4o', tools: [], connectorIds: [],
    approvalPolicy: 'risky_only', memory: '', skills: [], skillIds: [], maxSteps: 8
  });
  let modelCalls = 0;
  const adapter = {
    async complete() {
      modelCalls++;
      await new Promise(resolve => setTimeout(resolve, 150));
      return { text: JSON.stringify({ type: 'final', content: 'single owner result' }), model: 'fixture', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
    async stream() { /* Bot loop uses complete */ }
  };
  const makeRuntime = (workerId: string) => {
    process.env.AIRA_WORKER_ID = workerId;
    const models = new ModelRouter();
    models.getAdapter = () => adapter as any;
    models.listProviders = () => ['openai'];
    return new AgentRuntime(
      models,
      new ToolRegistry(),
      new ApprovalKernel(new PostgresApprovalRepository(), new PostgresSessionGrantRepository()),
      new BrainV2KnowledgeEngine(),
      runs
    );
  };
  const runtimeA = makeRuntime('runtime-A');
  const runtimeB = makeRuntime('runtime-B');
  // Keep the lease-race assertion focused on execution ownership. Persist the task
  // before execution so the PGlite socket shim is not asked to multiplex an unrelated
  // INSERT while the run is concurrently entering its lease-controlled loop.
  const started = await runtimeA.createRun(
    { prompt: 'Return one result.', intent: 'AGENT_MISSION', modelPolicy: { model: 'gpt-4o' } },
    { userId: 'lease-owner', sessionId: 'lease-session' },
    bot
  );
  await bots.recordTask('lease-owner', bot.id, started.id, started.prompt);
  const executionA = (runtimeA as any).executeRunLoop(started.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  await (runtimeB as any).executeRunLoop(started.id);
  await executionA;
  const completed = await waitTerminal(runtimeA, started.id);
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.content, 'single owner result');
  assert.equal(modelCalls, 1, 'execution fence must prevent duplicate model execution');
  assert.equal(await runs.getExecutionLease(started.id), undefined, 'terminal execution releases the lease');

  console.log('Aira Bot worker leases: PASS — atomic claim, renewal, monotonic fencing, stale-worker rejection, expiry takeover, single model execution');
} finally {
  delete process.env.AIRA_WORKER_ID;
  await closeDb();
  await socket.stop();
  await pg.close();
}
