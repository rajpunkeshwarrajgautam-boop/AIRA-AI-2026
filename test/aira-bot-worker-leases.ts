import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.AIRA_WORKER_LEASE_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://aira:aira@127.0.0.1:5432/aira_db';
process.env.AIRA_RUN_LEASE_TTL_MS = '15000';

// Worker leasing is intentionally certified against a real PostgreSQL server.
// The lease contract depends on independent database sessions under contention;
// an in-process socket multiplexer cannot faithfully model that boundary.
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
  id: `run_lease_seed_${randomUUID()}`, principalId: 'lease-owner', agentId: null, sessionId: 'lease-session', workspaceId: null,
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

  // Repeatedly contend from independent pool clients. Exactly one claimant may own each lease,
  // and every ownership transfer must advance the fencing token.
  let lastFence = c!.fence;
  for (let round = 0; round < 20; round++) {
    const owners = [`stress-A-${round}`, `stress-B-${round}`];
    const claims = await Promise.all(owners.map(owner => runs.claimExecution(seedRun.id, owner, 15_000)));
    const winners = claims
      .map((lease, index) => lease ? { lease, owner: owners[index] } : undefined)
      .filter((winner): winner is { lease: NonNullable<typeof claims[number]>; owner: string } => Boolean(winner));
    assert.equal(winners.length, 1, `contention round ${round} must have exactly one lease owner`);
    const winner = winners[0];
    assert(winner.lease.fence > lastFence, `contention round ${round} must advance the fence`);
    lastFence = winner.lease.fence;
    assert.equal(await runs.releaseExecution(seedRun.id, winner.owner, winner.lease.fence), true);
  }

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
  const started = await runtimeA.createAndExecuteRun(
    { prompt: 'Return one result.', intent: 'AGENT_MISSION', modelPolicy: { model: 'gpt-4o' } },
    { userId: 'lease-owner', sessionId: 'lease-session' }, bot,
    async created => { await bots.recordTask('lease-owner', bot.id, created.id, created.prompt); }
  );
  await (runtimeB as any).executeRunLoop(started.id);
  const completed = await waitTerminal(runtimeA, started.id);
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.content, 'single owner result');
  assert.equal(modelCalls, 1, 'execution fence must prevent duplicate model execution');
  assert.equal(await runs.getExecutionLease(started.id), undefined, 'terminal execution releases the lease');

  console.log('Aira Bot worker leases: PASS — atomic claim, renewal, monotonic fencing, stale-worker rejection, expiry takeover, 20 contention rounds, single model execution');
} finally {
  delete process.env.AIRA_WORKER_ID;
  await closeDb();
}
