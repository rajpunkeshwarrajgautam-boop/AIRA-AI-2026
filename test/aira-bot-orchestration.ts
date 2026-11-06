import assert from 'node:assert/strict';
import { createTestDatabase } from './postgres-fixture.js';

process.env.NODE_ENV = 'test';
const cleanupDatabase = await createTestDatabase();
const { runMigrations, closeDb } = await import('../packages/db/src/index.js');
await runMigrations();
const { BotRepository } = await import('../packages/aira-bot/src/repository.js');
const { BotOrchestrationRepository, BotRoutineEngine } = await import('../packages/aira-bot/src/orchestration.js');
const { ModelRouter } = await import('../packages/model-router/src/index.js');
const { ToolRegistry } = await import('../packages/tool-runtime/src/index.js');
const { AgentRuntime } = await import('../packages/agent-runtime/src/index.js');
const { PostgresRunRepository } = await import('../packages/agent-runtime/src/repositories.js');
const { ApprovalKernel } = await import('../packages/approvals/src/index.js');
const { PostgresApprovalRepository, PostgresSessionGrantRepository } = await import('../packages/approvals/src/repositories.js');
const { BrainV2KnowledgeEngine } = await import('../packages/knowledge/src/index.js');

const owner = 'orchestration-owner';
const otherOwner = 'other-owner';
const bots = new BotRepository();
const orchestration = new BotOrchestrationRepository();
const models = new ModelRouter();
const tools = new ToolRegistry();
const runs = new PostgresRunRepository();
const approvals = new ApprovalKernel(new PostgresApprovalRepository(), new PostgresSessionGrantRepository());
const knowledge = new BrainV2KnowledgeEngine();
const runtime = new AgentRuntime(models, tools, approvals, knowledge, runs);
const adapter = {
  async complete() { return { text: JSON.stringify({ type: 'final', content: 'delegated result' }), model: 'fixture', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; },
  async stream(_messages: unknown, _policy: unknown, onDelta: (delta: { text?: string }) => Promise<void>) { await onDelta({ text: 'done' }); }
};
models.getAdapter = () => adapter as any;
models.listProviders = () => ['openai'];

const baseInput = {
  description: '', instructions: 'Complete the assigned objective precisely.', model: 'gpt-4o' as const,
  tools: [] as any[], approvalPolicy: 'risky_only' as const, memory: '', skills: [], maxSteps: 8
};

async function waitTerminal(id: string) {
  for (let i = 0; i < 120; i++) {
    const run = await runtime.getRun(id);
    if (run && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${id} did not become terminal.`);
}

try {
  const parentBot = await bots.create(owner, { ...baseInput, name: 'Lead Bot', tools: ['delegate_bot', 'delegation_status'] as any });
  const specialist = await bots.create(owner, { ...baseInput, name: 'Specialist Bot' });
  const foreign = await bots.create(otherOwner, { ...baseInput, name: 'Foreign Bot' });

  const parent = await runtime.createAndExecuteRun(
    { prompt: 'Lead task', intent: 'AGENT_MISSION', modelPolicy: { model: 'gpt-4o' } },
    { userId: owner, sessionId: 'orchestration-test' }, parentBot,
    async created => { await bots.recordTask(owner, parentBot.id, created.id, created.prompt); }
  );
  await waitTerminal(parent.id);

  const delegated = await runtime.delegateBot(parent, specialist.id, 'Produce specialist analysis.') as any;
  assert.ok(delegated.delegationId);
  assert.equal(delegated.targetBotId, specialist.id);
  const child = await waitTerminal(delegated.childRunId);
  assert.equal(child.principalId, owner);
  assert.equal(child.agentId, specialist.id);
  assert.equal(child.context.parentRunId, parent.id);
  assert.equal(child.context.delegationDepth, 1);
  assert.deepEqual(child.context.delegationChain, [parentBot.id]);

  const status = await runtime.delegationStatus(parent, delegated.delegationId) as any;
  assert.equal(status.childRun.state, 'COMPLETED');
  assert.equal(status.childRun.content, 'delegated result');
  assert.equal(status.delegation.status, 'COMPLETED');

  await assert.rejects(() => runtime.delegateBot(parent, parentBot.id, 'self'), /cannot delegate.*itself/i);
  await assert.rejects(() => runtime.delegateBot(parent, foreign.id, 'foreign'), /not owned/i);
  const cycleParent = { ...parent, context: { ...parent.context, delegationDepth: 1, delegationChain: [specialist.id] } };
  await assert.rejects(() => runtime.delegateBot(cycleParent, specialist.id, 'cycle'), /cycle/i);
  const deepParent = { ...parent, context: { ...parent.context, delegationDepth: 3, delegationChain: [] } };
  await assert.rejects(() => runtime.delegateBot(deepParent, specialist.id, 'too deep'), /depth limit/i);

  const routine = await orchestration.createRoutine(owner, specialist.id, {
    name: 'Minute check', objective: 'Run scheduled specialist check.', cronExpression: '* * * * *', timezone: 'UTC', enabled: true
  });
  assert.equal((await orchestration.listRoutines(otherOwner, specialist.id)).length, 0);
  const scheduledFor = Date.now() - 60_000;
  const firstClaim = await orchestration.claimRoutineSlot(routine, scheduledFor);
  const duplicateClaim = await orchestration.claimRoutineSlot(routine, scheduledFor);
  assert.ok(firstClaim);
  assert.equal(duplicateClaim, undefined);

  // Use a fresh routine to certify scheduler execution rather than consuming the pre-claimed slot above.
  const scheduledRoutine = await orchestration.createRoutine(owner, specialist.id, {
    name: 'Scheduler execution', objective: 'Scheduled execution objective.', cronExpression: '* * * * *', timezone: 'UTC', enabled: true
  });
  const engine = new BotRoutineEngine(runtime, orchestration, bots);
  const firstTick = Date.now();
  await engine.tick(firstTick);
  const routineRuns = await orchestration.routineRuns(owner, scheduledRoutine.id);
  assert.equal(routineRuns.length, 1);
  assert.ok(routineRuns[0].runId);
  const scheduledRun = await waitTerminal(routineRuns[0].runId!);
  assert.equal(scheduledRun.agentId, specialist.id);
  assert.equal(scheduledRun.principalId, owner);
  assert.equal(scheduledRun.context.routineId, scheduledRoutine.id);
  await engine.tick(firstTick);
  assert.equal((await orchestration.routineRuns(owner, scheduledRoutine.id)).length, 1, 'same cron slot must not run twice');

  // Reconcile completion and verify notification ownership/read state without advancing into a new cron slot.
  await engine.tick(firstTick);
  const notes = await orchestration.notifications(owner);
  assert(notes.some(note => note.kind === 'delegation_started'));
  assert(notes.some(note => note.kind === 'delegation_completed'));
  assert(notes.some(note => note.kind === 'routine_started'));
  assert(notes.some(note => note.kind === 'routine_completed'));
  assert.equal((await orchestration.notifications(otherOwner)).length, 0);
  assert.equal(await orchestration.markNotificationRead(owner, notes[0].id), true);
  assert.equal((await orchestration.notifications(owner, true)).some(note => note.id === notes[0].id), false);

  console.log('Aira Bot orchestration: PASS — ownership, delegation fencing, child provenance, exactly-once routine slots, scheduler execution, notifications');
} finally {
  await closeDb();
  await cleanupDatabase();
}
