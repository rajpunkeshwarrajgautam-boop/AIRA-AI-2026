import assert from 'node:assert/strict';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { ModelRouter } from '../packages/model-router/src/index.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { BrainV2KnowledgeEngine } from '../packages/knowledge/src/index.js';
import { Run, StreamingEvent, ExecutionPrincipal } from '../packages/contracts/src/index.js';
import { RunRepository } from '../packages/agent-runtime/src/repositories.js';
import { closeDb } from '../packages/db/src/index.js';

interface CallRecord {
  method: string;
  args: any[];
  timestamp: number;
}

class SpiedRunRepository implements RunRepository {
  public calls: CallRecord[] = [];
  public runs: Map<string, Run> = new Map();
  public events: Map<string, StreamingEvent[]> = new Map();

  async saveRun(run: Run): Promise<void> {
    this.calls.push({ method: 'saveRun', args: [{ ...run }], timestamp: performance.now() });
    this.runs.set(run.id, { ...run });
  }

  async getRun(id: string): Promise<Run | undefined> {
    this.calls.push({ method: 'getRun', args: [id], timestamp: performance.now() });
    const run = this.runs.get(id);
    return run ? { ...run } : undefined;
  }

  async listRuns(): Promise<Run[]> {
    return Array.from(this.runs.values());
  }

  async listRunsForPrincipal(principalId: string, limit = 50): Promise<Run[]> {
    return Array.from(this.runs.values())
      .filter(r => r.principalId === principalId)
      .slice(0, limit);
  }

  async searchRunsForPrincipal(principalId: string, query: string, limit = 5): Promise<Run[]> {
    this.calls.push({ method: 'searchRunsForPrincipal', args: [principalId, query, limit], timestamp: performance.now() });
    return Array.from(this.runs.values())
      .filter(r => r.principalId === principalId && r.state === 'COMPLETED')
      .slice(0, limit);
  }

  async getInterruptedRuns(): Promise<Run[]> {
    return [];
  }

  async appendRunEvent(event: StreamingEvent): Promise<StreamingEvent> {
    this.calls.push({ method: 'appendRunEvent', args: [{ ...event }], timestamp: performance.now() });
    const list = this.events.get(event.runId) || [];
    const seq = list.length + 1;
    const stored = { ...event, sequence: seq };
    list.push(stored);
    this.events.set(event.runId, list);
    return stored;
  }

  async appendRunEvents(events: StreamingEvent[]): Promise<StreamingEvent[]> {
    this.calls.push({ method: 'appendRunEvents', args: [events.map(e => ({ ...e }))], timestamp: performance.now() });
    const list = this.events.get(events[0]?.runId) || [];
    const storedList: StreamingEvent[] = [];
    for (const event of events) {
      const seq = list.length + 1;
      const stored = { ...event, sequence: seq };
      list.push(stored);
      storedList.push(stored);
    }
    if (events[0]?.runId) {
      this.events.set(events[0].runId, list);
    }
    return storedList;
  }

  async getRunEvents(runId: string): Promise<StreamingEvent[]> {
    return this.events.get(runId) || [];
  }

  async getRunEventsAfter(runId: string, sequence: number): Promise<StreamingEvent[]> {
    const list = this.events.get(runId) || [];
    return list.filter(e => (e.sequence ?? 0) > sequence);
  }

  async getLatestEventSequence(runId: string): Promise<number> {
    const list = this.events.get(runId) || [];
    return list.length;
  }

  async claimInterruptedRun(_runId: string, _owner: string, _ttlMs: number): Promise<boolean> {
    return true;
  }
}

async function runTests() {
  console.log('=== P1.5 DATABASE CRITICAL PATH RED REGRESSION TEST SUITE ===');

  const repo = new SpiedRunRepository();
  const modelRouter = new ModelRouter();
  const toolRegistry = new ToolRegistry(process.cwd());
  const approvalKernel = new ApprovalKernel(
    { saveRequest: async () => {}, getRequest: async () => undefined, listRequests: async () => [], listPendingRequests: async () => [] } as any,
    { saveGrant: async () => {}, getGrant: async () => undefined, hasActiveGrant: async () => false, revokeGrant: async () => {} } as any
  );
  const knowledgeEngine = new BrainV2KnowledgeEngine();

  const runtime = new AgentRuntime(
    modelRouter,
    toolRegistry,
    approvalKernel,
    knowledgeEngine,
    repo,
    process.cwd()
  );

  const principal: ExecutionPrincipal = {
    userId: 'usr_test_p1_5',
    sessionId: 'sess_test_p1_5',
    roles: ['workspace_user'],
    scopes: ['chat:write', 'runs:read', 'runs:write']
  };

  // -------------------------------------------------------------------------
  // TEST 1: Zero Redundant Read-After-Write queries on pre-token path
  // -------------------------------------------------------------------------
  console.log('\n[TEST 1] Redundant DB read elimination: getRun must not be called repeatedly');

  const tStart = performance.now();
  let firstDeltaTimestamp: number | null = null;

  const run = await runtime.createRun({
    prompt: 'Hello world test prompt.',
    modelPolicy: { model: 'aira-auto' }
  }, principal);

  console.log('run.routingDecision:', JSON.stringify(run.routingDecision));

  const stream = runtime.getEventStream(run.id);

  stream.on('event', (evt: any) => {
    if (evt.type === 'content.delta' && firstDeltaTimestamp === null) {
      firstDeltaTimestamp = performance.now();
    }
  });

  await runtime.startRun(run.id);

  const preDeltaCalls = repo.calls.filter(c => firstDeltaTimestamp === null || c.timestamp < firstDeltaTimestamp);
  const preDeltaGetRunCalls = preDeltaCalls.filter(c => c.method === 'getRun');

  console.log(`Pre-first-token total DB calls: ${preDeltaCalls.length}`);
  console.log('Pre-first-token DB calls:', preDeltaCalls.map(c => c.method));
  console.log('Call 1:', repo.calls[0]?.args[0]?.state, repo.calls[0]?.args[0]?.executionCheckpoint);
  console.log('Call 2:', repo.calls[1]?.args[0]?.state, repo.calls[1]?.args[0]?.executionCheckpoint);
  console.log(`Pre-first-token getRun calls: ${preDeltaGetRunCalls.length}`);

  assert.equal(
    preDeltaGetRunCalls.length,
    0,
    `CRITICAL PATH REGRESSION: Expected 0 redundant getRun calls before first token, got ${preDeltaGetRunCalls.length}`
  );

  console.log('PASS: Zero redundant read-after-write queries before first token.');

  // -------------------------------------------------------------------------
  // TEST 2: No non-critical event write before provider dispatch
  // -------------------------------------------------------------------------
  console.log('\n[TEST 2] Lifecycle event persistence must not block first token delivery');

  const preDeltaAppendEvents = preDeltaCalls.filter(c => c.method === 'appendRunEvent');
  console.log(`Pre-first-token appendRunEvent calls: ${preDeltaAppendEvents.length}`);

  assert.equal(
    preDeltaAppendEvents.length,
    0,
    `CRITICAL PATH REGRESSION: Expected 0 blocking appendRunEvent calls before first token, got ${preDeltaAppendEvents.length}`
  );

  console.log('PASS: No blocking event writes on first-token critical path.');

  // -------------------------------------------------------------------------
  // TEST 3: Pre-provider DB query count ceiling (<= 1 consolidated write or 0)
  // -------------------------------------------------------------------------
  console.log('\n[TEST 3] Maximum pre-provider DB query count ceiling');
  assert.ok(
    preDeltaCalls.length <= 1,
    `CRITICAL PATH REGRESSION: Expected <= 1 DB operations before first token, got ${preDeltaCalls.length}`
  );
  console.log('PASS: Pre-token DB operations within strict latency ceiling (<= 1).');

  // -------------------------------------------------------------------------
  // TEST 4: Full data durability acceptance at completion
  // -------------------------------------------------------------------------
  console.log('\n[TEST 4] Data durability acceptance at completion');
  const storedRun = repo.runs.get(run.id);
  assert.ok(storedRun, 'Run must be durably stored in repository');
  assert.equal(storedRun?.state, 'COMPLETED', 'Final run state must be COMPLETED');
  assert.ok(storedRun?.content && storedRun.content.length > 0, 'Run content must be durably persisted');

  const storedEvents = repo.events.get(run.id) || [];
  assert.ok(storedEvents.length > 0, 'Run events must be durably stored');
  assert.ok(
    storedEvents.some(e => e.type === 'run.completed'),
    'run.completed event must be durably persisted'
  );
  console.log('PASS: Full durability verified at completion.');

  console.log('\n=== ALL P1.5 CRITICAL PATH TESTS PASSED ===');
  await closeDb();
  process.exit(0);
}

runTests().catch(async err => {
  console.error('\nFAILED:', err.message);
  await closeDb().catch(() => {});
  process.exit(1);
});
