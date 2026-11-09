import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  AutonomousAgentTask,
  ExecutionPrincipal,
  AgentObjectivePlan
} from '../packages/contracts/src/index.js';
import { AutonomousAgentEngine } from '../packages/agent-runtime/src/autonomous/autonomous-engine.js';
import { AutonomousWorkerHost } from '../packages/agent-runtime/src/autonomous/autonomous-worker-host.js';
import {
  InMemoryAutonomousTaskRepository,
  PostgresAutonomousTaskRepository
} from '../packages/agent-runtime/src/autonomous/repository.js';

// ============================================================================
// TEST FIXTURES & SIMULATED POSTGRESQL ENGINE
// ============================================================================

const principalAlpha: ExecutionPrincipal = {
  userId: 'usr_stress_alpha',
  sessionId: 'sess_stress_alpha',
  workspaceId: 'ws_stress_alpha',
  scopes: ['*']
};

function createTestPlan(
  levels: Array<'NONE' | 'WRITE' | 'DESTRUCTIVE'> = ['NONE'],
  roles: Array<'researcher' | 'coder' | 'verifier'> = ['coder']
): AgentObjectivePlan {
  const now = Date.now();
  return {
    planId: `plan_${randomUUID().slice(0, 8)}`,
    objective: 'Autonomous Concurrency & Worker Reliability Stress Test',
    estimatedWaves: 1,
    maxBudgetTokens: 12000,
    createdAt: now,
    updatedAt: now,
    steps: levels.map((level, i) => {
      const role = roles[i] || 'coder';
      return {
        stepId: `step_${i + 1}`,
        title: `Operation ${i + 1} (${role})`,
        description: `Stress test step ${i + 1}`,
        role,
        dependencies: i > 0 ? [`step_${i}`] : [],
        suggestedTools: [],
        sideEffectLevel: level,
        status: 'PENDING' as const
      };
    })
  };
}

async function waitForState(
  engineOrRepo: { getTask(id: string): Promise<AutonomousAgentTask | null> },
  taskId: string,
  targetState: string,
  timeoutMs = 2000
): Promise<AutonomousAgentTask> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await engineOrRepo.getTask(taskId);
    if (current?.state === targetState) return current;
    await new Promise(r => setTimeout(r, 10));
  }
  const final = await engineOrRepo.getTask(taskId);
  assert.fail(`Task ${taskId} timed out waiting for state "${targetState}". Found: "${final?.state}"`);
}

/**
 * Creates an in-memory Knex mock that simulates PostgreSQL table behaviors for autonomous_agent_tasks:
 * - Insert with unique idempotency check
 * - Atomic CAS update with where('task_id').andWhere('fencing_token')
 * - Atomic lease check and claim with fencing_token + 1
 * - Heartbeat failure injection
 */
function createSimulatedPostgresKnex() {
  const rows = new Map<string, Record<string, any>>();
  let shouldFailHeartbeat = false;

  const fakeKnex: any = (tableName: string) => {
    assert.equal(tableName, 'autonomous_agent_tasks');

    const queryState: {
      wheres: Record<string, any>;
      andWheres: Array<{ col: string; op?: string; val: any }>;
      whereCallbacks: Array<(qb: any) => void>;
      whereIns: Array<{ col: string; vals: any[] }>;
      limitVal?: number;
      orderByCol?: string;
    } = {
      wheres: {},
      andWheres: [],
      whereCallbacks: [],
      whereIns: []
    };

    const qb: any = {
      where(arg1: any, arg2?: any, arg3?: any) {
        if (typeof arg1 === 'object') {
          Object.assign(queryState.wheres, arg1);
        } else if (typeof arg1 === 'string') {
          if (arg3 !== undefined) {
            queryState.andWheres.push({ col: arg1, op: arg2, val: arg3 });
          } else {
            queryState.wheres[arg1] = arg2;
          }
        }
        return qb;
      },
      andWhere(arg1: any, arg2?: any, arg3?: any) {
        if (typeof arg1 === 'function') {
          queryState.whereCallbacks.push(arg1);
        } else if (arg3 !== undefined) {
          queryState.andWheres.push({ col: arg1, op: arg2, val: arg3 });
        } else {
          queryState.wheres[arg1] = arg2;
        }
        return qb;
      },
      whereIn(col: string, vals: any[]) {
        queryState.whereIns.push({ col, vals });
        return qb;
      },
      orderBy(col: string) {
        queryState.orderByCol = col;
        return qb;
      },
      limit(lim: number) {
        queryState.limitVal = lim;
        return qb;
      },
      async first() {
        const matches = qb.filterRows();
        return matches[0] ? { ...matches[0] } : null;
      },
      async select() {
        const matches = qb.filterRows();
        return matches.map((m: any) => ({ ...m }));
      },
      async insert(data: any) {
        if (shouldFailHeartbeat) {
          const err = new Error('connect ECONNREFUSED 127.0.0.1:5432 (simulated Postgres heartbeat drop)');
          (err as any).code = 'ECONNREFUSED';
          throw err;
        }
        const taskId = data.task_id;
        if (rows.has(taskId)) {
          const err = new Error(`duplicate key value violates unique constraint "autonomous_agent_tasks_pkey"`);
          (err as any).code = '23505';
          throw err;
        }
        rows.set(taskId, { ...data });
        return [taskId];
      },
      async update(updateData: Record<string, any>) {
        if (shouldFailHeartbeat) {
          const err = new Error('connect ECONNREFUSED 127.0.0.1:5432 (simulated Postgres heartbeat drop)');
          (err as any).code = 'ECONNREFUSED';
          throw err;
        }
        const matches = qb.filterRows();
        let affected = 0;
        for (const row of matches) {
          const updatedRow = { ...row };
          for (const [key, val] of Object.entries(updateData)) {
            if (val && typeof val === 'object' && val.__knexRaw) {
              if (key === 'fencing_token') {
                updatedRow[key] = (Number(updatedRow[key]) || 0) + 1;
              }
            } else {
              updatedRow[key] = val;
            }
          }
          rows.set(row.task_id, updatedRow);
          affected++;
        }
        return affected;
      },
      filterRows() {
        const list: any[] = [];
        for (const row of rows.values()) {
          let match = true;
          for (const [k, v] of Object.entries(queryState.wheres)) {
            if (row[k] !== v) { match = false; break; }
          }
          if (!match) continue;
          for (const { col, op, val } of queryState.andWheres) {
            if (op === '<' && !(row[col] < val)) { match = false; break; }
            if (op === '>' && !(row[col] > val)) { match = false; break; }
            if (!op && row[col] !== val) { match = false; break; }
          }
          if (!match) continue;
          for (const { col, vals } of queryState.whereIns) {
            if (!vals.includes(row[col])) { match = false; break; }
          }
          if (!match) continue;
          for (const cb of queryState.whereCallbacks) {
            let subMatch = false;
            const subQb = {
              whereNull: (col: string) => {
                if (row[col] === null || row[col] === undefined) subMatch = true;
                return subQb;
              },
              orWhere: (col: string, opOrVal: any, val?: any) => {
                if (val !== undefined) {
                  if (opOrVal === '<' && row[col] < val) subMatch = true;
                  if (opOrVal === '>' && row[col] > val) subMatch = true;
                } else {
                  if (row[col] === opOrVal) subMatch = true;
                }
                return subQb;
              }
            };
            cb(subQb);
            if (!subMatch) { match = false; break; }
          }
          if (match) list.push(row);
        }
        return list;
      }
    };
    return qb;
  };

  fakeKnex.raw = (expr: string) => ({ __knexRaw: true, expr });
  fakeKnex.setHeartbeatFailure = (flag: boolean) => { shouldFailHeartbeat = flag; };
  fakeKnex._rows = rows;
  return fakeKnex;
}

// ============================================================================
// SUITE: AUTONOMOUS CONCURRENCY, CRASH RECOVERY & FAIL-CLOSED STRESS TESTING
// ============================================================================

test('Milestone 3 — Section 5 Comprehensive Autonomous Stress Testing', async (t) => {

  // ==========================================================================
  // SCENARIO A: CONCURRENT WORKERS COMPETING FOR TASKS
  // ==========================================================================
  await t.test('Scenario A: Concurrent Workers', async (aSuite) => {

    await aSuite.test('A1: Two workers compete simultaneously to claim one task -> exactly one valid lease holder commits, other rejected', async () => {
      // 1. Test against InMemory repository
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      const initialTask: AutonomousAgentTask = {
        taskId: `task_claim_race_${Date.now()}`,
        principal: principalAlpha,
        objective: 'Concurrent claim competition',
        state: 'READY',
        observations: [],
        artifacts: [],
        workingMemory: {},
        executionHistory: [{ state: 'CREATED', timestamp: Date.now() }, { state: 'READY', timestamp: Date.now() }],
        fencingToken: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await inMemRepo.createTask(initialTask);

      // Two workers attempt atomic claim simultaneously
      const [claim1, claim2] = await Promise.all([
        inMemRepo.claimTask!(initialTask.taskId, 'worker_node_alpha', 15000),
        inMemRepo.claimTask!(initialTask.taskId, 'worker_node_beta', 15000)
      ]);

      // Exactly one succeeds, other fails
      const successCount = [claim1.success, claim2.success].filter(Boolean).length;
      assert.equal(successCount, 1, 'Exactly one worker must win the concurrent task claim');

      const winner = claim1.success ? claim1 : claim2;
      const loser = claim1.success ? claim2 : claim1;
      assert.ok(winner.task);
      assert.ok(winner.task.leaseOwner === 'worker_node_alpha' || winner.task.leaseOwner === 'worker_node_beta');
      assert.ok(winner.task.fencingToken > 1, 'Fencing token must increment on claim');
      assert.equal(loser.success, false);
      assert.match(loser.error || '', /leased/i);

      // 2. Test against Postgres repository with simulated Knex
      const pgKnex = createSimulatedPostgresKnex();
      const pgRepo = new PostgresAutonomousTaskRepository(pgKnex);
      const pgTask: AutonomousAgentTask = {
        ...initialTask,
        taskId: `pg_task_claim_race_${Date.now()}`
      };
      await pgRepo.createTask(pgTask);

      const [pgClaim1, pgClaim2] = await Promise.all([
        pgRepo.claimTask(pgTask.taskId, 'pg_worker_1', 15000),
        pgRepo.claimTask(pgTask.taskId, 'pg_worker_2', 15000)
      ]);

      const pgSuccessCount = [pgClaim1.success, pgClaim2.success].filter(Boolean).length;
      assert.equal(pgSuccessCount, 1, 'PostgreSQL atomic lease update must allow exactly one claim');
      const pgWinner = pgClaim1.success ? pgClaim1 : pgClaim2;
      const pgLoser = pgClaim1.success ? pgClaim2 : pgClaim1;
      assert.ok(pgWinner.task);
      assert.equal(pgLoser.success, false);
      assert.match(pgLoser.error || '', /leased/i);
    });

    await aSuite.test('A2: Valid lease holder commits, stale fencing token rejected (CAS optimistic concurrency)', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      const task: AutonomousAgentTask = {
        taskId: `task_cas_fence_${Date.now()}`,
        principal: principalAlpha,
        objective: 'Fencing token CAS enforcement',
        state: 'READY',
        observations: [],
        artifacts: [],
        workingMemory: {},
        executionHistory: [{ state: 'READY', timestamp: Date.now() }],
        fencingToken: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await inMemRepo.createTask(task);

      // Worker 1 claims task -> token becomes 2
      const claim1 = await inMemRepo.claimTask!(task.taskId, 'worker_node_1', 30000);
      assert.equal(claim1.success, true);
      const token1 = claim1.task!.fencingToken;
      assert.equal(token1, 2);

      // Worker 1 advances state: expected token 2 -> state RUNNING, token becomes 3
      const runningTask = await inMemRepo.updateState(task.taskId, 'RUNNING', 'Worker 1 starting', undefined, token1);
      assert.equal(runningTask.state, 'RUNNING');
      assert.equal(runningTask.fencingToken, 3);

      // Simulate lease expiration / takeover by Worker 2
      const internalTask = (inMemRepo as any).tasks.get(task.taskId);
      if (internalTask) {
        internalTask.leaseExpiresAt = Date.now() - 1000;
      }

      const claim2 = await inMemRepo.claimTask!(task.taskId, 'worker_node_2', 30000);
      assert.equal(claim2.success, true);
      assert.equal(claim2.task?.leaseOwner, 'worker_node_2');
      const token2 = claim2.task!.fencingToken;
      assert.ok(token2 > runningTask.fencingToken);

      // Stale Worker 1 attempts to commit state with old token (token 3)
      await assert.rejects(
        async () => {
          await inMemRepo.updateState(task.taskId, 'COMPLETED', 'Stale worker 1 trying to complete', undefined, 3);
        },
        /STALE_FENCING_TOKEN/,
        'Stale fencing token write must be rejected'
      );

      // Task remains in valid RUNNING state owned by worker_node_2
      const current = await inMemRepo.getTask(task.taskId);
      assert.equal(current?.leaseOwner, 'worker_node_2');
      assert.equal(current?.state, 'RUNNING');
      assert.notEqual(current?.state, 'COMPLETED');
    });

    await aSuite.test('A3: Late specialist results cannot complete cancelled work', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      let releaseSlowSpecialist!: () => void;
      let specialistStarted!: () => void;
      const specialistStartedPromise = new Promise<void>(resolve => { specialistStarted = resolve; });
      const specialistGate = new Promise<void>(resolve => { releaseSlowSpecialist = resolve; });

      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'coder' || role === 'verifier',
        getSpecialist: (role: string) => {
          if (role === 'coder') {
            return {
              requiredCapabilities: ['code_generation'],
              execute: async () => {
                specialistStarted();
                await specialistGate;
                return { outcome: 'COMPLETED', output: { summary: 'Late obsolete calculation' } };
              }
            };
          }
          if (role === 'verifier') {
            return {
              requiredCapabilities: ['result_verification'],
              execute: async () => ({ outcome: 'COMPLETED', output: { summary: 'Verified' } })
            };
          }
          return undefined;
        }
      } as any;

      const engine = new AutonomousAgentEngine({ repository: inMemRepo, specialistRegistry });
      const plan = createTestPlan(['NONE'], ['coder']);
      const task = await engine.createTask('Late specialist cancellation test', principalAlpha, plan);

      // Advance task to READY
      await inMemRepo.updateState(task.taskId, 'PLANNING');
      await inMemRepo.updateState(task.taskId, 'READY');

      // Start execution in background
      const executionPromise = engine.executeAutonomousTask(task.taskId);
      await specialistStartedPromise;

      // While specialist is running, cancel task
      await engine.cancelTask(task.taskId, 'User cancelled long running specialist');
      const afterCancel = await inMemRepo.getTask(task.taskId);
      assert.equal(afterCancel?.state, 'CANCELLED');

      // Now release late specialist result
      releaseSlowSpecialist();
      await executionPromise;

      // Verify late result was discarded and task remains CANCELLED without deliverable
      const finalTask = await inMemRepo.getTask(task.taskId);
      assert.equal(finalTask?.state, 'CANCELLED');
      assert.equal(finalTask?.deliverableSummary, undefined, 'Late specialist result must not set deliverable summary');
      const lateObs = finalTask?.observations.find(o => o.summary.includes('Late obsolete calculation'));
      assert.equal(lateObs, undefined, 'Late specialist observation must be discarded');
    });

    await aSuite.test('A4: Late specialist results rejected after lease theft by competing worker', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      let releaseWorker1Specialist!: () => void;
      let worker1SpecialistStarted!: () => void;
      const startedPromise = new Promise<void>(resolve => { worker1SpecialistStarted = resolve; });
      const gatePromise = new Promise<void>(resolve => { releaseWorker1Specialist = resolve; });

      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'researcher' || role === 'verifier',
        getSpecialist: (role: string) => {
          if (role === 'researcher') {
            return {
              requiredCapabilities: ['research_reasoning'],
              execute: async () => {
                worker1SpecialistStarted();
                await gatePromise;
                return { outcome: 'COMPLETED', output: { summary: 'Worker 1 stale findings' } };
              }
            };
          }
          return {
            requiredCapabilities: ['result_verification'],
            execute: async () => ({ outcome: 'COMPLETED', output: { summary: 'Verified' } })
          };
        }
      } as any;

      const engine = new AutonomousAgentEngine({ repository: inMemRepo, specialistRegistry });
      const plan = createTestPlan(['NONE'], ['researcher']);
      const task = await engine.createTask('Lease theft during specialist', principalAlpha, plan);
      await inMemRepo.updateState(task.taskId, 'PLANNING');
      await inMemRepo.updateState(task.taskId, 'READY');

      // Worker 1 claims with immediate expiry
      const claim1 = await inMemRepo.claimTask!(task.taskId, 'worker_1', -1);
      assert.equal(claim1.success, true);

      // Start execution under Worker 1's fencing token
      const exec1 = engine.executeAutonomousTask(task.taskId, undefined, claim1.task!.fencingToken);
      await startedPromise;

      // Worker 2 steals the lease while specialist is suspended
      const claim2 = await inMemRepo.claimTask!(task.taskId, 'worker_2', 60000);
      assert.equal(claim2.success, true);
      assert.ok(claim2.task!.fencingToken > claim1.task!.fencingToken);

      // Release Worker 1's specialist
      releaseWorker1Specialist();
      await exec1;

      // Worker 1's write is rejected; Worker 2 remains exclusive lease owner
      const current = await inMemRepo.getTask(task.taskId);
      assert.equal(current?.leaseOwner, 'worker_2');
      assert.notEqual(current?.deliverableSummary, 'Worker 1 stale findings');
    });

    await aSuite.test('A5: Duplicate approvals cannot trigger duplicate execution (idempotent approvals)', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      let writeExecutions = 0;

      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'coder' || role === 'verifier',
        getSpecialist: (role: string) => {
          if (role === 'coder') {
            return {
              requiredCapabilities: ['code_generation'],
              execute: async () => {
                writeExecutions++;
                return { outcome: 'COMPLETED', output: { summary: 'Executed sensitive write operation' } };
              }
            };
          }
          if (role === 'verifier') {
            return {
              requiredCapabilities: ['result_verification'],
              execute: async () => ({ outcome: 'COMPLETED', output: { summary: 'Verified write' } })
            };
          }
          return undefined;
        }
      } as any;

      const engine = new AutonomousAgentEngine({ repository: inMemRepo, specialistRegistry });
      const plan = createTestPlan(['WRITE'], ['coder']);
      const task = await engine.createTask('Idempotent approval test', principalAlpha, plan);

      // Prepare task and start execution -> enters WAITING_FOR_APPROVAL
      await inMemRepo.updateState(task.taskId, 'PLANNING');
      await inMemRepo.updateState(task.taskId, 'READY');
      void engine.executeAutonomousTask(task.taskId);

      const waitingTask = await waitForState(engine, task.taskId, 'WAITING_FOR_APPROVAL');
      assert.ok(waitingTask.approvalRequestId);
      assert.equal(writeExecutions, 0, 'No specialist may execute before approval');

      // Two concurrent approval decisions dispatched simultaneously
      const results = await Promise.allSettled([
        engine.approveStep(task.taskId, waitingTask.approvalRequestId!, true),
        engine.approveStep(task.taskId, waitingTask.approvalRequestId!, true)
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exactly one approval request must succeed');
      assert.equal(rejected.length, 1, 'Duplicate approval request must be rejected');

      // Wait for task completion
      const completed = await waitForState(engine, task.taskId, 'COMPLETED');
      assert.equal(completed.state, 'COMPLETED');
      assert.equal(writeExecutions, 1, 'Approved write step must execute exactly ONCE');
    });
  });

  // ==========================================================================
  // SCENARIO B: CRASH RECOVERY
  // ==========================================================================
  await t.test('Scenario B: Crash Recovery', async (bSuite) => {

    await bSuite.test('B1: Worker terminated mid-step -> Incomplete state survives process termination', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      const plan = createTestPlan(['NONE', 'WRITE', 'NONE'], ['researcher', 'coder', 'verifier']);
      const taskId = `task_crash_${Date.now()}`;

      // Simulate Step 1 having completed and Step 2 having been set to RUNNING before worker died
      const crashedTask: AutonomousAgentTask = {
        taskId,
        principal: principalAlpha,
        objective: 'Crash recovery state survival',
        state: 'RUNNING',
        plan: {
          ...plan,
          steps: [
            {
              ...plan.steps[0],
              status: 'COMPLETED',
              resultSummary: 'Step 1 durable research completed before crash',
              completedAt: Date.now() - 5000
            },
            {
              ...plan.steps[1],
              status: 'RUNNING',
              startedAt: Date.now() - 2000
            },
            {
              ...plan.steps[2],
              status: 'PENDING'
            }
          ]
        },
        observations: [
          {
            observationId: 'obs_survived_step_1',
            stepId: 'step_1',
            source: 'specialist',
            sourceName: 'Researcher Specialist',
            summary: 'Step 1 durable research completed before crash',
            timestamp: Date.now() - 5000,
            isError: false
          }
        ],
        artifacts: [],
        workingMemory: { step_1_data: 'survived' },
        executionHistory: [
          { state: 'CREATED', timestamp: Date.now() - 10000 },
          { state: 'PLANNING', timestamp: Date.now() - 8000 },
          { state: 'READY', timestamp: Date.now() - 6000 },
          { state: 'RUNNING', timestamp: Date.now() - 5000 }
        ],
        fencingToken: 4,
        leaseOwner: 'crashed_worker_01',
        leaseExpiresAt: Date.now() - 1000, // Lease expired on crash
        createdAt: Date.now() - 10000,
        updatedAt: Date.now() - 2000
      };

      await inMemRepo.createTask(crashedTask);

      // Verify that findRecoverableTasks finds it
      const recoverable = await inMemRepo.findRecoverableTasks!(Date.now());
      assert.ok(recoverable.some(t => t.taskId === taskId), 'Abandoned task must be found as recoverable');

      // Verify state survived intact
      const queried = await inMemRepo.getTask(taskId);
      assert.ok(queried);
      assert.equal(queried.plan?.steps[0].status, 'COMPLETED');
      assert.equal(queried.plan?.steps[1].status, 'RUNNING');
      assert.equal(queried.observations.length, 1);
      assert.equal(queried.workingMemory?.step_1_data, 'survived');
      assert.equal(queried.executionHistory.length, 4);
    });

    await bSuite.test('B2: Recovery resumes without losing task history', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      const plan = createTestPlan(['NONE', 'NONE'], ['researcher', 'verifier']);
      const taskId = `task_hist_resume_${Date.now()}`;

      const initialHistory = [
        { state: 'CREATED' as const, timestamp: Date.now() - 5000 },
        { state: 'PLANNING' as const, timestamp: Date.now() - 4000 },
        { state: 'READY' as const, timestamp: Date.now() - 3000 },
        { state: 'RUNNING' as const, timestamp: Date.now() - 2000 }
      ];

      const crashedTask: AutonomousAgentTask = {
        taskId,
        principal: principalAlpha,
        objective: 'Preserve history across crash recovery',
        state: 'RUNNING',
        plan: {
          ...plan,
          steps: [
            {
              ...plan.steps[0],
              status: 'COMPLETED',
              resultSummary: 'Already completed research'
            },
            {
              ...plan.steps[1],
              status: 'PENDING'
            }
          ]
        },
        observations: [],
        artifacts: [],
        workingMemory: {},
        executionHistory: [...initialHistory],
        fencingToken: 3,
        leaseOwner: 'crashed_worker',
        leaseExpiresAt: Date.now() - 500,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 2000
      };

      await inMemRepo.createTask(crashedTask);

      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'verifier',
        getSpecialist: (_role: string) => ({
          requiredCapabilities: ['result_verification'],
          execute: async () => ({ outcome: 'COMPLETED', output: { summary: 'Recovery verifier passed' } })
        })
      } as any;

      const engine = new AutonomousAgentEngine({ repository: inMemRepo, specialistRegistry });
      await engine.recoverTask(taskId, 'recovering_worker_beta');

      const completed = await waitForState(engine, taskId, 'COMPLETED');
      assert.equal(completed.state, 'COMPLETED');

      // Ensure all 4 initial history items were preserved
      const states = completed.executionHistory.map(h => h.state);
      assert.ok(states.includes('CREATED'));
      assert.ok(states.includes('PLANNING'));
      assert.ok(states.includes('READY'));
      assert.ok(states.includes('RESUMING'), 'Recovery must append RESUMING');
      assert.ok(states.includes('COMPLETED'), 'Recovery must append COMPLETED');
      assert.ok(completed.executionHistory.length >= 6, 'Execution history must not be truncated or overwritten');
    });

    await bSuite.test('B3: Uncertain write operations require renewed approval', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      let writeExecutionCount = 0;

      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'coder' || role === 'verifier',
        getSpecialist: (role: string) => {
          if (role === 'coder') {
            return {
              requiredCapabilities: ['code_generation'],
              execute: async () => {
                writeExecutionCount++;
                return { outcome: 'COMPLETED', output: { summary: 'Executed re-approved write' } };
              }
            };
          }
          if (role === 'verifier') {
            return {
              requiredCapabilities: ['result_verification'],
              execute: async () => ({ outcome: 'COMPLETED', output: { summary: 'Verified' } })
            };
          }
          return undefined;
        }
      } as any;

      const engine = new AutonomousAgentEngine({ repository: inMemRepo, specialistRegistry });
      const plan = createTestPlan(['WRITE'], ['coder']);
      const taskId = `task_uncertain_write_${Date.now()}`;

      // Simulate a crashed worker that left a WRITE step in RUNNING status
      const crashedTask: AutonomousAgentTask = {
        taskId,
        principal: principalAlpha,
        objective: 'Uncertain write approval requirement',
        state: 'RUNNING',
        plan: {
          ...plan,
          steps: [
            {
              ...plan.steps[0],
              status: 'RUNNING',
              startedAt: Date.now() - 3000
            }
          ]
        },
        observations: [],
        artifacts: [],
        workingMemory: {},
        executionHistory: [{ state: 'RUNNING', timestamp: Date.now() - 3000 }],
        fencingToken: 2,
        leaseOwner: 'crashed_worker',
        leaseExpiresAt: Date.now() - 1000,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 3000
      };
      await inMemRepo.createTask(crashedTask);

      // Trigger recovery
      await engine.recoverTask(taskId, 'recovering_worker');

      // The engine MUST transition to WAITING_FOR_APPROVAL and not execute the write yet
      const waiting = await waitForState(engine, taskId, 'WAITING_FOR_APPROVAL');
      assert.equal(waiting.state, 'WAITING_FOR_APPROVAL');
      assert.ok(waiting.approvalRequestId);
      assert.equal(waiting.plan?.steps[0].status, 'WAITING_FOR_APPROVAL');
      assert.equal(writeExecutionCount, 0, 'Uncertain write operation must NEVER auto-execute without approval');

      // Explicitly approve the step
      await engine.approveStep(taskId, waiting.approvalRequestId!, true);
      const completed = await waitForState(engine, taskId, 'COMPLETED');
      assert.equal(completed.state, 'COMPLETED');
      assert.equal(writeExecutionCount, 1, 'Write specialist executed after explicit user approval');
    });

    await bSuite.test('B4: Failed steps cannot silently become completed steps during recovery', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      let step2Executed = false;

      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'coder' || role === 'verifier',
        getSpecialist: (role: string) => {
          if (role === 'coder') {
            return {
              requiredCapabilities: ['code_generation'],
              execute: async () => {
                step2Executed = true;
                return { outcome: 'COMPLETED', output: { summary: 'Should not execute' } };
              }
            };
          }
          return undefined;
        }
      } as any;

      const engine = new AutonomousAgentEngine({ repository: inMemRepo, specialistRegistry });
      const plan = createTestPlan(['NONE', 'NONE'], ['coder', 'coder']);
      const taskId = `task_failed_step_integrity_${Date.now()}`;

      // Simulate a task where step 1 was marked FAILED before crash
      const crashedTask: AutonomousAgentTask = {
        taskId,
        principal: principalAlpha,
        objective: 'Failed step integrity across recovery',
        state: 'RUNNING',
        plan: {
          ...plan,
          steps: [
            {
              ...plan.steps[0],
              status: 'FAILED',
              resultSummary: 'Database storage quota exceeded during step 1'
            },
            {
              ...plan.steps[1],
              status: 'PENDING'
            }
          ]
        },
        observations: [
          {
            observationId: 'obs_fail_1',
            stepId: 'step_1',
            source: 'specialist',
            sourceName: 'Coder Specialist',
            summary: 'Database storage quota exceeded during step 1',
            timestamp: Date.now() - 3000,
            isError: true
          }
        ],
        artifacts: [],
        workingMemory: {},
        executionHistory: [{ state: 'RUNNING', timestamp: Date.now() - 4000 }],
        fencingToken: 2,
        leaseOwner: 'crashed_worker',
        leaseExpiresAt: Date.now() - 1000,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 3000
      };
      await inMemRepo.createTask(crashedTask);

      // Attempt recovery
      await engine.recoverTask(taskId, 'recovering_worker');

      // The engine MUST fail closed and not promote step 1 to completed or skip to step 2
      const failed = await waitForState(engine, taskId, 'FAILED');
      assert.equal(failed.state, 'FAILED');
      assert.equal(failed.plan?.steps[0].status, 'FAILED');
      assert.equal(failed.plan?.steps[1].status, 'PENDING');
      assert.equal(step2Executed, false, 'Step 2 must NEVER execute if previous step failed');
      assert.equal(failed.deliverableSummary, undefined, 'Failed step cannot yield a deliverable');
      assert.match(failed.executionHistory.at(-1)?.reason || '', /Persisted step/i);
    });
  });

  // ==========================================================================
  // SCENARIO C: HEARTBEAT FAILURES & SAFE ABORTION
  // ==========================================================================
  await t.test('Scenario C: Heartbeat Failures', async (cSuite) => {

    await cSuite.test('C1 & C2: PostgreSQL heartbeat failure injection triggers abortController.abort() and prevents commit', async () => {
      let leaseRenewalAttempts = 0;
      let wasExecutionAborted = false;
      let heartbeatErrorEmitted = false;
      let completedTaskEmitted = false;

      // Custom repository that fails renewLease after 1 renewal
      class HeartbeatFailingRepository extends InMemoryAutonomousTaskRepository {
        override async renewLease(taskId: string, workerId: string, leaseDurationMs: number, fencingToken: number): Promise<boolean> {
          leaseRenewalAttempts++;
          if (leaseRenewalAttempts >= 1) {
            // Inject PostgreSQL connection failure
            const err = new Error('connect ECONNREFUSED 127.0.0.1:5432 (Postgres heartbeat failure)');
            (err as any).code = 'ECONNREFUSED';
            throw err;
          }
          return super.renewLease(taskId, workerId, leaseDurationMs, fencingToken);
        }
      }

      const repo = new HeartbeatFailingRepository();
      const plan = createTestPlan(['NONE'], ['coder']);
      const taskId = `task_hb_fail_${Date.now()}`;
      const task: AutonomousAgentTask = {
        taskId,
        principal: principalAlpha,
        objective: 'Heartbeat failure injection',
        state: 'READY',
        plan,
        observations: [],
        artifacts: [],
        workingMemory: {},
        executionHistory: [{ state: 'READY', timestamp: Date.now() }],
        fencingToken: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await repo.createTask(task);

      // Specialist that listens to cancellationSignal
      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'coder' || role === 'verifier',
        getSpecialist: (_role: string) => ({
          requiredCapabilities: [],
          execute: async (ctx: any) => {
            // Hang until abort signal triggers
            await new Promise<void>(resolve => {
              if (ctx.cancellationSignal?.aborted) {
                wasExecutionAborted = true;
                resolve();
              } else {
                ctx.cancellationSignal?.addEventListener('abort', () => {
                  wasExecutionAborted = true;
                  resolve();
                }, { once: true });
              }
            });
            return { outcome: 'CANCELLED', error: { message: 'Aborted due to heartbeat loss' } };
          }
        })
      } as any;

      const engine = new AutonomousAgentEngine({ repository: repo, specialistRegistry });
      const workerHost = new AutonomousWorkerHost(repo, engine, {
        workerId: 'worker_hb_test',
        pollIntervalMs: 50,
        heartbeatIntervalMs: 20,
        leaseDurationMs: 200,
        concurrency: 1
      });

      workerHost.on('worker.error', (e) => {
        if (e.code === 'HEARTBEAT_FAILED') heartbeatErrorEmitted = true;
      });
      workerHost.on('task.completed', () => {
        completedTaskEmitted = true;
      });

      try {
        await workerHost.start();

        const deadline = Date.now() + 1500;
        while ((!wasExecutionAborted || !heartbeatErrorEmitted) && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 20));
        }

        assert.equal(wasExecutionAborted, true, 'Heartbeat failure must prompt abortController.abort()');
        assert.equal(heartbeatErrorEmitted, true, 'WorkerHost must emit worker.error with HEARTBEAT_FAILED');
        assert.equal(completedTaskEmitted, false, 'Abandoned worker must not emit task.completed');

        // Verify task state in repository was not falsely marked COMPLETED
        const finalTask = await repo.getTask(taskId);
        assert.notEqual(finalTask?.state, 'COMPLETED');
        assert.equal(finalTask?.deliverableSummary, undefined, 'Abandoned worker must not write deliverable');
      } finally {
        await workerHost.stop();
      }
    });

    await cSuite.test('C3: State and audit records stay consistent under heartbeat failure', async () => {
      const pgKnex = createSimulatedPostgresKnex();
      const pgRepo = new PostgresAutonomousTaskRepository(pgKnex);
      const taskId = `task_audit_consistency_${Date.now()}`;

      const task: AutonomousAgentTask = {
        taskId,
        principal: principalAlpha,
        objective: 'Audit record consistency under heartbeat failure',
        state: 'RUNNING',
        observations: [
          {
            observationId: 'obs_initial_audit',
            stepId: 'step_audit_1',
            source: 'specialist',
            sourceName: 'Audit Specialist',
            summary: 'Pre-heartbeat observation',
            timestamp: Date.now() - 1000,
            isError: false
          }
        ],
        artifacts: [],
        workingMemory: { phase: 'pre_heartbeat' },
        executionHistory: [
          { state: 'CREATED', timestamp: Date.now() - 3000 },
          { state: 'PLANNING', timestamp: Date.now() - 2000 },
          { state: 'RUNNING', timestamp: Date.now() - 1000 }
        ],
        fencingToken: 3,
        leaseOwner: 'worker_failing',
        leaseExpiresAt: Date.now() + 5000,
        createdAt: Date.now() - 3000,
        updatedAt: Date.now() - 1000
      };
      await pgRepo.createTask(task);

      // Inject heartbeat database failure into simulated Knex
      pgKnex.setHeartbeatFailure(true);

      // Heartbeat renewal fails closed with AutonomousPersistenceUnavailableError or false
      await assert.rejects(
        async () => {
          await pgRepo.renewLease(taskId, 'worker_failing', 5000, 3);
        },
        (err: any) => {
          assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
          return true;
        }
      );

      // Re-enable DB connection
      pgKnex.setHeartbeatFailure(false);

      // Verify audit integrity
      const queried = await pgRepo.getTask(taskId);
      assert.ok(queried);
      assert.equal(queried.executionHistory.length, 3);
      assert.equal(queried.observations.length, 1);
      assert.equal(queried.observations[0].summary, 'Pre-heartbeat observation');
      assert.equal(queried.fencingToken, 3);
      assert.equal(queried.workingMemory?.phase, 'pre_heartbeat');
    });

    await cSuite.test('C4: Abandoned task can be safely reclaimed by replacement worker after lease timeout', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      const taskId = `task_reclaim_timeout_${Date.now()}`;
      const task: AutonomousAgentTask = {
        taskId,
        principal: principalAlpha,
        objective: 'Reclaim timeout verification',
        state: 'RUNNING',
        observations: [],
        artifacts: [],
        workingMemory: {},
        executionHistory: [{ state: 'RUNNING', timestamp: Date.now() }],
        fencingToken: 1,
        leaseOwner: 'abandoned_worker',
        leaseExpiresAt: Date.now() - 100, // Lease expired due to heartbeat loss
        createdAt: Date.now() - 2000,
        updatedAt: Date.now() - 100
      };
      await inMemRepo.createTask(task);

      // Replacement worker claims the abandoned task
      const replacementClaim = await inMemRepo.claimTask!(taskId, 'replacement_worker', 30000);
      assert.equal(replacementClaim.success, true);
      assert.equal(replacementClaim.task?.leaseOwner, 'replacement_worker');
      assert.equal(replacementClaim.task?.fencingToken, 2);

      // Original abandoned worker tries to commit late write with token 1 -> rejected
      await assert.rejects(
        async () => {
          await inMemRepo.updateState(taskId, 'COMPLETED', 'Abandoned worker trying to write', undefined, 1);
        },
        /STALE_FENCING_TOKEN/
      );

      // Replacement worker commits valid state with token 2 -> succeeds
      const updated = await inMemRepo.updateState(taskId, 'COMPLETED', 'Replacement worker success', undefined, 2);
      assert.equal(updated.state, 'COMPLETED');
      assert.equal(updated.fencingToken, 3);
    });
  });

  // ==========================================================================
  // SCENARIO D: FAIL-CLOSED VERIFICATION
  // ==========================================================================
  await t.test('Scenario D: Fail-Closed Verification', async (dSuite) => {

    await dSuite.test('D1: Verification specialist unavailable fails closed', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      let coderExecuted = false;

      // Registry has coder, but verifier is intentionally absent
      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'coder',
        getSpecialist: (role: string) => {
          if (role === 'coder') {
            return {
              requiredCapabilities: ['code_generation'],
              execute: async () => {
                coderExecuted = true;
                return { outcome: 'COMPLETED', output: { summary: 'Code generated' } };
              }
            };
          }
          return undefined;
        }
      } as any;

      const engine = new AutonomousAgentEngine({
        repository: inMemRepo,
        specialistRegistry,
        requireVerification: true
      });

      const plan = createTestPlan(['NONE'], ['coder']);
      const task = await engine.createTask('Missing verifier test', principalAlpha, plan, undefined, true);
      await inMemRepo.updateState(task.taskId, 'PLANNING');
      await inMemRepo.updateState(task.taskId, 'READY');

      const result = await engine.executeAutonomousTask(task.taskId);
      assert.equal(coderExecuted, true, 'Coder step executed');
      assert.equal(result.state, 'FAILED', 'Task without verifier specialist must fail closed');
      assert.equal(result.deliverableSummary, undefined, 'Missing verifier must not produce deliverable');

      const errorObs = result.observations.find(o => o.isError && o.summary.includes('VERIFICATION_UNAVAILABLE'));
      assert.ok(errorObs, 'Error observation must record VERIFICATION_UNAVAILABLE');
      assert.match(result.executionHistory.at(-1)?.reason || '', /VERIFICATION_UNAVAILABLE/);
    });

    await dSuite.test('D2: Verification specialist returns failure fails closed', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();

      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'coder' || role === 'verifier',
        getSpecialist: (role: string) => {
          if (role === 'coder') {
            return {
              requiredCapabilities: ['code_generation'],
              execute: async () => ({ outcome: 'COMPLETED', output: { summary: 'Step output' } })
            };
          }
          if (role === 'verifier') {
            return {
              requiredCapabilities: ['result_verification'],
              execute: async () => ({
                outcome: 'FAILED',
                error: { message: 'Quality gate rejected: unhandled boundary exception' }
              })
            };
          }
          return undefined;
        }
      } as any;

      const engine = new AutonomousAgentEngine({
        repository: inMemRepo,
        specialistRegistry,
        requireVerification: true
      });

      const plan = createTestPlan(['NONE'], ['coder']);
      const task = await engine.createTask('Failed verifier test', principalAlpha, plan, undefined, true);
      await inMemRepo.updateState(task.taskId, 'PLANNING');
      await inMemRepo.updateState(task.taskId, 'READY');

      const result = await engine.executeAutonomousTask(task.taskId);
      assert.equal(result.state, 'FAILED', 'Failed verification must fail task');
      assert.equal(result.deliverableSummary, undefined, 'Failed verification must not set deliverableSummary');
      assert.match(result.executionHistory.at(-1)?.reason || '', /VERIFICATION_FAILED/);

      const failObs = result.observations.find(o => o.isError && o.summary.includes('unhandled boundary exception'));
      assert.ok(failObs, 'Failure observation must record verifier error detail');
    });

    await dSuite.test('D3: Verification specialist times out fails closed', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();

      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'coder' || role === 'verifier',
        getSpecialist: (role: string) => {
          if (role === 'coder') {
            return {
              requiredCapabilities: ['code_generation'],
              execute: async () => ({ outcome: 'COMPLETED', output: { summary: 'Step output' } })
            };
          }
          if (role === 'verifier') {
            return {
              requiredCapabilities: ['result_verification'],
              execute: async () => ({
                outcome: 'TIMED_OUT',
                error: { message: 'Verification latency ceiling exceeded' }
              })
            };
          }
          return undefined;
        }
      } as any;

      const engine = new AutonomousAgentEngine({
        repository: inMemRepo,
        specialistRegistry,
        requireVerification: true
      });

      const plan = createTestPlan(['NONE'], ['coder']);
      const task = await engine.createTask('Timed out verifier test', principalAlpha, plan, undefined, true);
      await inMemRepo.updateState(task.taskId, 'PLANNING');
      await inMemRepo.updateState(task.taskId, 'READY');

      const result = await engine.executeAutonomousTask(task.taskId);
      assert.equal(result.state, 'FAILED', 'Timed out verification must fail task');
      assert.equal(result.deliverableSummary, undefined);
      assert.match(result.executionHistory.at(-1)?.reason || '', /VERIFICATION_FAILED/);
    });

    await dSuite.test('D4: Verification specialist cancelled fails closed', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();

      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'coder' || role === 'verifier',
        getSpecialist: (role: string) => {
          if (role === 'coder') {
            return {
              requiredCapabilities: ['code_generation'],
              execute: async () => ({ outcome: 'COMPLETED', output: { summary: 'Step output' } })
            };
          }
          if (role === 'verifier') {
            return {
              requiredCapabilities: ['result_verification'],
              execute: async () => ({
                outcome: 'CANCELLED',
                error: { message: 'Verifier cancelled by operator' }
              })
            };
          }
          return undefined;
        }
      } as any;

      const engine = new AutonomousAgentEngine({
        repository: inMemRepo,
        specialistRegistry,
        requireVerification: true
      });

      const plan = createTestPlan(['NONE'], ['coder']);
      const task = await engine.createTask('Cancelled verifier test', principalAlpha, plan, undefined, true);
      await inMemRepo.updateState(task.taskId, 'PLANNING');
      await inMemRepo.updateState(task.taskId, 'READY');

      const result = await engine.executeAutonomousTask(task.taskId);
      assert.equal(result.state, 'FAILED', 'Cancelled verification must fail task');
      assert.equal(result.deliverableSummary, undefined);
      assert.match(result.executionHistory.at(-1)?.reason || '', /VERIFICATION_FAILED/);
    });

    await dSuite.test('D5: Required verification cannot be bypassed (omission test)', async () => {
      let verificationExecuted = false;
      const inMemRepo = new InMemoryAutonomousTaskRepository();

      const specialistRegistry = {
        hasSpecialist: (role: string) => role === 'coder' || role === 'verifier',
        getSpecialist: (role: string) => {
          if (role === 'coder') {
            return {
              requiredCapabilities: ['code_generation'],
              execute: async () => ({ outcome: 'COMPLETED', output: { summary: 'Step output' } })
            };
          }
          if (role === 'verifier') {
            return {
              requiredCapabilities: ['result_verification'],
              execute: async () => {
                verificationExecuted = true;
                return { outcome: 'COMPLETED', output: { summary: 'Verification assertions fully satisfied' } };
              }
            };
          }
          return undefined;
        }
      } as any;

      const engine = new AutonomousAgentEngine({
        repository: inMemRepo,
        specialistRegistry,
        requireVerification: true
      });

      const plan = createTestPlan(['NONE'], ['coder']);
      const task = await engine.createTask('Omission test', principalAlpha, plan, undefined, true);
      await inMemRepo.updateState(task.taskId, 'PLANNING');
      await inMemRepo.updateState(task.taskId, 'READY');

      const result = await engine.executeAutonomousTask(task.taskId);
      assert.equal(result.state, 'COMPLETED');
      assert.equal(verificationExecuted, true, 'Verification gate MUST execute prior to completion');
      assert.match(result.deliverableSummary || '', /Verified: true/);
    });
  });
});
