import test from 'node:test';
import assert from 'node:assert/strict';
import type { AutonomousAgentTask } from '../packages/contracts/src/index.js';
import { AutonomousAgentEngine } from '../packages/agent-runtime/src/autonomous/autonomous-engine.js';
import { AutonomousWorkerHost } from '../packages/agent-runtime/src/autonomous/autonomous-worker-host.js';
import {
  InMemoryAutonomousTaskRepository,
  PostgresAutonomousTaskRepository
} from '../packages/agent-runtime/src/autonomous/repository.js';

function makeTask(taskId: string): AutonomousAgentTask {
  return {
    taskId,
    principal: { userId: 'isolated_user', sessionId: 'test_session', scopes: ['*'], tier: 'pro' as any },
    objective: 'Verify concurrent worker safety',
    state: 'CREATED',
    observations: [],
    artifacts: [],
    workingMemory: {},
    fencingToken: 0,
    executionHistory: [{ state: 'CREATED', timestamp: Date.now() }],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

test('in-memory task update rejects a snapshot from an earlier worker lease', async () => {
  const repository = new InMemoryAutonomousTaskRepository();
  const original = await repository.createTask(makeTask('in_memory_stale'));
  const claim = await repository.claimTask!(original.taskId, 'worker_next', 60_000);
  assert.equal(claim.success, true);

  original.deliverableSummary = 'Written by stale worker';
  await assert.rejects(() => repository.updateTask(original), /STALE_FENCING_TOKEN|stale fencing token/i);
  assert.equal((await repository.getTask(original.taskId))?.deliverableSummary, undefined);
});

test('failed planning transition releases the execution fence and active controller', async () => {
  const repository = new InMemoryAutonomousTaskRepository();
  const task = await repository.createTask(makeTask('planning_transition_failure'));
  repository.updateState = async () => {
    throw new Error('simulated planning write failure');
  };
  const engine = new AutonomousAgentEngine({ repository });

  await assert.rejects(() => engine.startTask(task.taskId), /simulated planning write failure/);
  assert.equal((engine as any).activeExecutions.has(task.taskId), false);
  assert.equal((engine as any).executionFences.has(task.taskId), false);
});

test('crash recovery refuses a claim superseded before its first state transition', async () => {
  class ReclaimedDuringRecoveryRepository extends InMemoryAutonomousTaskRepository {
    override async claimTask(taskId: string, workerId: string, leaseDurationMs: number) {
      if (workerId !== 'recovering-worker') return super.claimTask(taskId, workerId, leaseDurationMs);
      const original = await super.claimTask(taskId, workerId, -1);
      const newer = await super.claimTask(taskId, 'replacement-worker', 60_000);
      assert.equal(newer.success, true);
      return original;
    }
  }
  const repository = new ReclaimedDuringRecoveryRepository();
  const task = makeTask('recovery_claim_stolen');
  task.state = 'RUNNING';
  await repository.createTask(task);
  const engine = new AutonomousAgentEngine({ repository });

  await assert.rejects(() => engine.recoverTask(task.taskId, 'recovering-worker'), /STALE_FENCING_TOKEN/);
  const current = await repository.getTask(task.taskId);
  assert.equal(current?.leaseOwner, 'replacement-worker');
  assert.equal(current?.state, 'RUNNING');
  assert.equal((engine as any).activeExecutions.has(task.taskId), false);
  assert.equal((engine as any).executionFences.has(task.taskId), false);
});

test('PostgreSQL update does not overwrite newer lease after concurrent claim', async () => {
  const task = makeTask('postgres_stale');
  task.fencingToken = 1;
  const row: Record<string, any> = {
    task_id: task.taskId,
    principal_id: task.principal.userId,
    session_id: task.principal.sessionId,
    objective: task.objective,
    state: task.state,
    fencing_token: 1,
    observations: '[]',
    artifacts: '[]',
    working_memory: '{}',
    execution_history: JSON.stringify(task.executionHistory),
    created_at: task.createdAt,
    updated_at: task.updatedAt
  };
  let raced = false;
  const fakeKnex = (_table: string) => {
    const conditions: Record<string, any> = {};
    const query = {
      where(values: Record<string, any>) { Object.assign(conditions, values); return this; },
      andWhere(column: string, value: any) { conditions[column] = value; return this; },
      async first() { return { ...row }; },
      async update(values: Record<string, any>) {
        if (!raced) {
          raced = true;
          row.fencing_token = 2;
          row.working_memory = '{"newOwner":true}';
        }
        if (Object.entries(conditions).some(([key, expected]) => row[key] !== expected)) return 0;
        Object.assign(row, values);
        return 1;
      }
    };
    return query;
  };

  task.workingMemory = { staleOwner: true };
  const repository = new PostgresAutonomousTaskRepository(fakeKnex);
  await assert.rejects(() => repository.updateTask(task), /stale fencing token|concurrent update/i);
  assert.deepEqual(JSON.parse(row.working_memory), { newOwner: true });
});

test('stale specialist response cannot write after a second worker reclaims the task', async () => {
  const repository = new InMemoryAutonomousTaskRepository();
  const task = makeTask('reclaimed_during_specialist');
  task.state = 'RUNNING';
  task.plan = {
    planId: 'plan_reclaim', objective: task.objective, estimatedWaves: 1, maxBudgetTokens: 1000,
    createdAt: Date.now(), updatedAt: Date.now(),
    steps: [{
      stepId: 'slow_step', title: 'Delayed specialist', description: 'Wait until the claim changes',
      role: 'researcher', dependencies: [], suggestedTools: [], sideEffectLevel: 'NONE', status: 'PENDING'
    }]
  } as NonNullable<AutonomousAgentTask['plan']>;
  await repository.createTask(task);

  let releaseSpecialist!: () => void;
  let specialistEntered!: () => void;
  const specialistHasStarted = new Promise<void>(resolve => { specialistEntered = resolve; });
  const specialistGate = new Promise<void>(resolve => { releaseSpecialist = resolve; });
  const specialistRegistry = {
    hasSpecialist: (role: string) => role === 'researcher',
    getSpecialist: (role: string) => role === 'researcher' ? {
      requiredCapabilities: [],
      execute: async () => {
        specialistEntered();
        await specialistGate;
        return { outcome: 'COMPLETED', output: { summary: 'Late obsolete response' } };
      }
    } : undefined
  } as any;
  const engine = new AutonomousAgentEngine({ repository, specialistRegistry });
  const claimA = await repository.claimTask!(task.taskId, 'workerA', -1);
  assert.ok(claimA.success && claimA.task);

  const stepStarted = new Promise<void>(resolve => engine.once('task.step_started', () => resolve()));
  const executionA = engine.executeAutonomousTask(task.taskId, undefined, claimA.task!.fencingToken);
  await stepStarted;
  await specialistHasStarted;
  const claimB = await repository.claimTask!(task.taskId, 'workerB', 60_000);
  assert.equal(claimB.success, true);
  assert.ok(claimB.task!.fencingToken > claimA.task!.fencingToken);
  assert.equal((await repository.getTask(task.taskId))?.observations.length, 0,
    'new owner begins with no published stale observation');

  releaseSpecialist();
  await executionA;
  const after = await repository.getTask(task.taskId);
  assert.equal(after?.leaseOwner, 'workerB');
  assert.equal(after?.state, 'RUNNING');
  assert.equal(after?.observations.length, 0, 'former worker cannot publish a late result');
  assert.notEqual(after?.deliverableSummary, 'Late obsolete response');
});

test('worker aborts execution when heartbeat storage throws', async () => {
  class BrokenHeartbeatRepository extends InMemoryAutonomousTaskRepository {
    override async getTask(taskId: string) {
      throw new Error(`heartbeat storage unavailable: ${taskId}`);
    }
  }
  const repository = new BrokenHeartbeatRepository();
  await repository.createTask(makeTask('heartbeat_outage'));

  let wasAborted = false;
  const engine = {
    async executeAutonomousTask(_taskId: string, signal: AbortSignal) {
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      wasAborted = true;
      return makeTask('heartbeat_outage');
    }
  } as AutonomousAgentEngine;
  const worker = new AutonomousWorkerHost(repository, engine, {
    workerId: 'heartbeat_failure_worker',
    pollIntervalMs: 50,
    heartbeatIntervalMs: 15,
    leaseDurationMs: 200,
    concurrency: 1
  });
  let falseCompletions = 0;
  worker.on('task.completed', () => { falseCompletions++; });

  try {
    await worker.start();
    const deadline = Date.now() + 700;
    while (!wasAborted && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(wasAborted, true, 'Lost heartbeat must promptly abort execution');
    assert.equal(falseCompletions, 0, 'Lease-loss abort must not be reported as a completed task');
  } finally {
    await worker.stop();
  }
});
