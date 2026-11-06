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
const { PostgresRunRepository, withExecutionLease } = await import('../packages/agent-runtime/src/repositories.js');
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
    // Terminal state is persisted before its event and the execution finally
    // block. Wait for both observable state and cleanup, with the same deadline.
    if (run && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)
        && await runs.getExecutionLease(id) === undefined) return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${id} did not become terminal and release its execution lease.`);
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

  // Pause after A's preflight check, then transfer ownership before its writes.
  const staleLease = await runs.claimExecution(seedRun.id, 'stale-worker', 15_000);
  assert(staleLease);
  const staleRun = await runs.getRun(seedRun.id);
  assert(staleRun);
  assert.equal(await runs.assertExecution(seedRun.id, staleLease.owner, staleLease.fence), true);
  await db('runs').where({ id: seedRun.id }).update({ execution_lease_until: Date.now() - 1 });
  await assert.rejects(withExecutionLease(seedRun.id, staleLease, () => runs.saveRun(staleRun)), /EXECUTION_LEASE_LOST/,
    'expiry alone must reject worker writes, before another owner claims');
  await assert.rejects(withExecutionLease(seedRun.id, staleLease, () => runs.appendRunEvent({
    eventId: `evt_${randomUUID()}`, runId: seedRun.id, type: 'run.failed', timestamp: Date.now(), data: {}
  })), /EXECUTION_LEASE_LOST/, 'expiry alone must reject worker events');
  const currentLease = await runs.claimExecution(seedRun.id, 'current-worker', 15_000);
  assert(currentLease && currentLease.fence > staleLease.fence);
  for (const invalidLease of [
    { ...currentLease, owner: 'wrong-owner' },
    { ...currentLease, fence: currentLease.fence - 1 }
  ]) {
    await assert.rejects(withExecutionLease(seedRun.id, invalidLease, () => runs.saveRun(staleRun)), /EXECUTION_LEASE_LOST/);
  }
  await withExecutionLease(seedRun.id, currentLease, async () => {
    await runs.saveRun({ ...staleRun, content: 'current owner result' });
    await runs.appendRunEvent({ eventId: `evt_${randomUUID()}`, runId: seedRun.id, type: 'content.delta', timestamp: Date.now(), data: { delta: 'current owner result' } });
  });
  await assert.rejects(withExecutionLease(seedRun.id, staleLease, () => runs.saveRun({ ...staleRun, state: 'FAILED', content: 'stale overwrite' })), /EXECUTION_LEASE_LOST/);
  await assert.rejects(withExecutionLease(seedRun.id, staleLease, () => runs.appendRunEvent({ eventId: `evt_${randomUUID()}`, runId: seedRun.id, type: 'run.failed', timestamp: Date.now(), data: { error: 'stale error' } })), /EXECUTION_LEASE_LOST/);
  assert.equal((await runs.getRun(seedRun.id))?.content, 'current owner result');
  assert.equal((await runs.getRun(seedRun.id))?.state, 'QUEUED');
  assert.equal((await runs.getRunEvents(seedRun.id)).length, 1, 'a stale worker must not append an event');
  assert.equal(await runs.releaseExecution(seedRun.id, staleLease.owner, staleLease.fence), false);
  assert.equal(await runs.releaseExecution(seedRun.id, currentLease.owner, currentLease.fence), true);

  // Expiration must be checked after a row-lock wait, using database time.
  const waitingLease = await runs.claimExecution(seedRun.id, 'waiting-worker', 15_000);
  assert(waitingLease);
  const until = Date.now() + 1000;
  await db('runs').where({ id: seedRun.id }).update({ execution_lease_until: until });
  const lock = await db.transaction();
  let blockedWrite: Promise<void> | undefined;
  try {
    await lock('runs').where({ id: seedRun.id }).forUpdate().first('id');
    blockedWrite = withExecutionLease(seedRun.id, waitingLease, () => runs.saveRun({ ...staleRun, content: 'expired while waiting' }));
    // Attach rejection handling before releasing the blocker.
    const rejected = assert.rejects(blockedWrite, /EXECUTION_LEASE_LOST/);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await db.raw('select count(*)::int as waiting from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0');
      if (result.rows[0].waiting > 0) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(waiting, 'the write must actually wait for the run row lock');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, until - Date.now() + 50)));
    await lock.commit();
    await rejected;
    assert.equal((await runs.getRun(seedRun.id))?.content, 'current owner result');
  } finally {
    if (!lock.isCompleted()) await lock.rollback();
    await blockedWrite?.catch(() => undefined);
  }
  assert.equal(await runs.releaseExecution(seedRun.id, waitingLease.owner, waitingLease.fence), true);

  // Repeatedly contend from independent pool clients. Exactly one claimant may own each lease,
  // and every ownership transfer must advance the fencing token.
  let lastFence = waitingLease.fence;
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

  // Exercise the actual runtime wiring, including the failure handler. Force a
  // takeover at the last await between assertLease and saveRun, not during the
  // model request (which would only test the existing preflight check).
  const saveRun = runs.saveRun.bind(runs);
  for (const scenario of ['bot-completion', 'bot-failure', 'streaming']) {
    const failure = scenario === 'bot-failure';
    const id = `run_takeover_${randomUUID()}`;
    await saveRun({ ...seedRun, id, agentId: scenario === 'streaming' ? null : bot.id,
      context: { airaBot: bot }, executionCheckpoint: scenario === 'streaming' ? 'SYNTHESIZING' : undefined, content: '', artifacts: [] });
    const takeoverRuntime = makeRuntime(`paused-worker-${scenario}`);
    const takeoverAdapter = {
      ...adapter,
      async complete() {
        if (failure) throw new Error('model failed before takeover');
        return { text: JSON.stringify({ type: 'final', content: 'stale final result' }), model: 'fixture' };
      },
      async stream(_messages: unknown, _policy: unknown, emit: (delta: { text: string }) => Promise<void>) {
        await emit({ text: 'stale final result' });
      }
    };
    (takeoverRuntime as any).modelRouter.getAdapter = () => takeoverAdapter;
    let transferred = false;
    runs.saveRun = async run => {
      if (run.id === id && !transferred && (failure ? run.state === 'FAILED' : run.content === 'stale final result')) {
        transferred = true;
        await db('runs').where({ id }).update({ execution_lease_until: Date.now() - 1 });
        const takeover = await runs.claimExecution(id, 'replacement-worker', 15_000);
        assert(takeover);
        const fresh = await runs.getRun(id);
        assert(fresh);
        await withExecutionLease(id, takeover, () => saveRun({ ...fresh, state: 'RUNNING', content: 'replacement owns this run' }));
      }
      await saveRun(run);
    };
    try { await (takeoverRuntime as any).executeRunLoop(id); }
    finally { runs.saveRun = saveRun; }
    assert(transferred, 'test must reach the write immediately after its preflight check');
    const fresh = await runs.getRun(id);
    assert.equal(fresh?.state, 'RUNNING', 'stale completion or error handling must not terminate the new owner');
    assert.equal(fresh?.content, 'replacement owns this run');
    assert.equal(fresh?.error, null);
    assert.equal(fresh?.artifacts.length, 0);
    assert.equal((await runs.getExecutionLease(id))?.owner, 'replacement-worker', 'stale cleanup cannot release the replacement lease');
    assert(!(await runs.getRunEvents(id)).some(event => ['run.failed', 'run.completed', 'artifact.created', 'content.delta'].includes(event.type)), 'stale execution must not publish completion or failure events');
  }

  // Recovery must acquire execution authority before altering a checkpoint or
  // failing an interrupted side effect owned by a still-live worker.
  const recoveryId = `run_recovery_${randomUUID()}`;
  await saveRun({ ...seedRun, id: recoveryId, state: 'WAITING_FOR_TOOL', executionCheckpoint: 'TOOL_EXECUTING',
    toolCalls: [{ id: 'review-call', name: 'unregistered-side-effect', arguments: {}, timestamp: Date.now(), status: 'PENDING' }] });
  const liveOwner = await runs.claimExecution(recoveryId, 'live-worker', 15_000);
  assert(liveOwner);
  const recovering = makeRuntime('recovery-worker');
  await (recovering as any).resumeRun(recoveryId);
  assert.equal((await runs.getRun(recoveryId))?.state, 'WAITING_FOR_TOOL');
  assert.equal((await runs.getExecutionLease(recoveryId))?.owner, 'live-worker');
  await db('runs').where({ id: recoveryId }).update({ execution_lease_until: Date.now() - 1 });
  await (recovering as any).resumeRun(recoveryId);
  assert.equal((await runs.getRun(recoveryId))?.state, 'FAILED', 'unsafe interrupted tools still fail after legitimate takeover');
  assert.equal(await runs.getExecutionLease(recoveryId), undefined);

  console.log('Aira Bot worker leases: PASS — atomic claim, renewal, monotonic fencing, expiry takeover, fenced writes/events, lock-wait expiry, stale completion/error/stream rejection, recovery fencing, 20 contention rounds, single model execution');
} finally {
  delete process.env.AIRA_WORKER_ID;
  await closeDb();
}
