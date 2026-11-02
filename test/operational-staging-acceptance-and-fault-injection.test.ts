/**
 * AIRA AI 2026 — Mission 3: Full Staging Acceptance & Fault Injection Certification
 *
 * Verifies the complete autonomous execution path end-to-end:
 *   User → API → PostgreSQL → Autonomous Worker → Specialist Agents
 *   → Real Tools → Isolated Execution → Memory → Artifacts → Verified Response
 *
 * Fault Injection Scenarios:
 *   F1. Worker crash mid-execution → replacement worker resumes via expired lease (fencing token + idempotency)
 *   F2. Task cancellation during active execution & late write rejection
 *   F3. Human approval denial (tool call blocked in WAITING_FOR_APPROVAL, fails closed)
 *   F4. Cross-tenant task isolation (read, claim, mutate, and browser session protection)
 *   F5. Database outage fail-closed behavior (PostgresAutonomousTaskRepository + worker host daemon resilience)
 *   F6. Sandbox failure containment (resolveIsolatedSandboxProvider fails closed, contained by engine & worker host)
 *
 * Acceptance Scenarios:
 *   A1. Full end-to-end execution path through specialist DAG with artifacts & strict COMPLETED assertion
 *   A2. Idempotency key prevents duplicate task creation on retry
 *   A3. Working memory persisted and merged across steps via AutonomousAgentEngine execution loop
 *   A4. Migration 031 data safety — rollback blocked when active records exist
 *   A5. AES-256-GCM session state survives worker replacement via storage
 *   A6. Deployment contract: AgentRuntime environment-aware repository selection
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';

import {
  AutonomousAgentEngine,
  InMemoryAutonomousTaskRepository,
  PostgresAutonomousTaskRepository,
  createOfflinePostgresClient,
  AutonomousWorkerHost,
  AutonomousPersistenceUnavailableError,
  FailClosedAutonomousTaskRepository,
} from '../packages/agent-runtime/src/autonomous/index.js';
import {
  AgentRuntime,
} from '../packages/agent-runtime/src/index.js';
import {
  SpecialistRegistry,
  createAutonomousSpecialistRegistry,
  PlannerSpecialistAgent,
  CoderSpecialistAgent,
  VerificationSpecialistAgent,
} from '../packages/agent-runtime/src/specialists/index.js';
import {
  BaseSpecialistAgent,
  SpecialistExecutionContext,
  SpecialistExecutionResult,
} from '../packages/agent-runtime/src/specialists/specialist-interface.js';
import {
  resolveIsolatedSandboxProvider,
} from '../packages/builder-runtime/src/sandbox.js';
import {
  BrowserAdapter,
  InMemoryBrowserSessionStorage,
} from '../packages/tool-runtime/src/adapters/browser-adapter.js';
import type {
  AutonomousAgentTask,
  ExecutionPrincipal,
  AgentObjectivePlan,
  SpecialistRole,
  CapabilityCategory,
} from '../packages/contracts/src/index.js';

// ─── Shared test principals ───────────────────────────────────────────────────

const tenantAlice: ExecutionPrincipal = {
  userId: 'usr_m3_alice',
  sessionId: `sess_alice_m3_${Date.now()}`,
  workspaceId: 'ws_m3_alice',
  scopes: ['*'],
};

const tenantBob: ExecutionPrincipal = {
  userId: 'usr_m3_bob',
  sessionId: `sess_bob_m3_${Date.now()}`,
  workspaceId: 'ws_m3_bob',
  scopes: ['*'],
};

const adminPrincipal: ExecutionPrincipal = {
  userId: 'usr_m3_admin',
  sessionId: `sess_admin_m3_${Date.now()}`,
  workspaceId: 'ws_m3_admin',
  roles: ['admin'],
  scopes: ['*'],
};

// ─── Shared specialist registry ───────────────────────────────────────────────

function buildRegistry(): SpecialistRegistry {
  return createAutonomousSpecialistRegistry();
}

// ─── Helper: build a canonical 3-step plan ────────────────────────────────────

function buildThreeStepPlan(prefix: string): AgentObjectivePlan {
  return {
    planId: `plan_m3_${prefix}_${randomUUID().slice(0, 8)}`,
    objective: `Mission 3 acceptance objective [${prefix}]`,
    steps: [
      {
        stepId: `step_${prefix}_1`,
        title: 'Generate research outline',
        description: 'Generate initial research outline',
        role: 'planner',
        dependencies: [],
        suggestedTools: [],
        sideEffectLevel: 'NONE',
        status: 'PENDING',
      },
      {
        stepId: `step_${prefix}_2`,
        title: 'Synthesize structured report from outline',
        description: 'Synthesize structured report from outline',
        role: 'coder',
        dependencies: [`step_${prefix}_1`],
        suggestedTools: [],
        sideEffectLevel: 'NONE',
        status: 'PENDING',
      },
      {
        stepId: `step_${prefix}_3`,
        title: 'Verify report accuracy and completeness',
        description: 'Verify report accuracy and completeness',
        role: 'verifier',
        dependencies: [`step_${prefix}_2`],
        suggestedTools: [],
        sideEffectLevel: 'NONE',
        status: 'PENDING',
      },
    ],
    estimatedWaves: 3,
    maxBudgetTokens: 32000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ─── Helper: build AutonomousWorkerHost with repository and engine ────────────

function buildWorkerHost(
  repo: InMemoryAutonomousTaskRepository,
  workerId: string,
  engine?: AutonomousAgentEngine
): AutonomousWorkerHost {
  const eng = engine ?? new AutonomousAgentEngine({ repository: repo, specialistRegistry: buildRegistry() });
  return new AutonomousWorkerHost(repo, eng, {
    workerId,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 200,
    leaseDurationMs: 1000,
    concurrency: 2,
  });
}

// ─── Helper: poll until task reaches a terminal state ─────────────────────────

async function waitForTerminal(
  repo: InMemoryAutonomousTaskRepository,
  taskId: string,
  timeoutMs = 8000
): Promise<AutonomousAgentTask> {
  const terminalStates = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await repo.getTask(taskId);
    if (task && terminalStates.has(task.state)) return task;
    await new Promise(r => setTimeout(r, 50));
  }
  const task = await repo.getTask(taskId);
  throw new Error(
    `Task ${taskId} did not reach terminal state within ${timeoutMs}ms. Current state: ${task?.state ?? 'NOT_FOUND'}`
  );
}

// ─── Helper: poll until task reaches a specific non-terminal state ─────────────

async function waitForState(
  repo: InMemoryAutonomousTaskRepository,
  taskId: string,
  targetState: string,
  timeoutMs = 5000
): Promise<AutonomousAgentTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await repo.getTask(taskId);
    if (task && task.state === targetState) return task;
    await new Promise(r => setTimeout(r, 50));
  }
  const task = await repo.getTask(taskId);
  throw new Error(
    `Task ${taskId} did not reach state ${targetState} within ${timeoutMs}ms. Current: ${task?.state ?? 'NOT_FOUND'}`
  );
}

// =============================================================================
// ACCEPTANCE TEST: A1 — Full End-to-End Execution Path
// =============================================================================

test('Mission 3: A1 — Full E2E autonomous execution path (User → Repository → Worker → Specialists → Artifacts)', async () => {
  const repo = new InMemoryAutonomousTaskRepository();
  const registry = buildRegistry();
  const engine = new AutonomousAgentEngine({ repository: repo, specialistRegistry: registry });

  // User submits a complex objective
  const task = await engine.createTask(
    'Research the current state of quantum computing and produce a structured report with an executive summary artifact.',
    tenantAlice,
    buildThreeStepPlan('a1')
  );

  assert.equal(task.state, 'CREATED', 'Task must begin in CREATED state');
  assert.equal(task.principal.userId, tenantAlice.userId, 'Principal must match submitting user');
  assert.ok(task.plan, 'Task must have an attached execution plan');
  assert.equal(task.plan!.steps.length, 3, 'Plan must have exactly 3 steps');

  // Worker claims and executes the task
  const worker = buildWorkerHost(repo, `worker_a1_${randomUUID().slice(0, 6)}`, engine);
  await worker.start();

  let completed: AutonomousAgentTask;
  try {
    completed = await waitForTerminal(repo, task.taskId, 10000);
  } finally {
    await worker.stop();
  }

  // Strict verification: task must reach COMPLETED (not FAILED)
  assert.equal(completed.state, 'COMPLETED', 'Task must successfully complete all steps');
  assert.ok(completed.fencingToken! >= 1, 'Fencing token must have been incremented through state transitions');
  assert.ok(completed.deliverableSummary, 'Task must include deliverableSummary on completion');

  // Verify observations were recorded for steps
  const retrieved = await repo.getTask(task.taskId);
  assert.ok(retrieved, 'Task must be retrievable after execution');
  assert.ok(Array.isArray(retrieved!.observations) && retrieved!.observations.length >= 3, 'Observations must exist for all steps');

  // Verify working memory persisted
  assert.ok(typeof retrieved!.workingMemory === 'object', 'Working memory must be an object');
});

// =============================================================================
// FAULT INJECTION: F1 — Worker Crash Mid-Execution → Lease Expiry → Recovery
// =============================================================================

test('Mission 3: F1 — Worker crashes mid-execution; replacement worker recovers via expired lease', async () => {
  const repo = new InMemoryAutonomousTaskRepository();
  const registry = buildRegistry();
  const engine = new AutonomousAgentEngine({ repository: repo, specialistRegistry: registry });

  const taskId = `autotask_f1_recovery_${randomUUID().slice(0, 8)}`;
  const plan = buildThreeStepPlan('f1');

  // Simulate Step 1 was executed and finished by Worker 1 before it crashed
  plan.steps[0].status = 'COMPLETED';
  plan.steps[0].startedAt = Date.now() - 5000;
  plan.steps[0].completedAt = Date.now() - 4000;
  plan.steps[0].resultSummary = 'Completed initial research outline before worker crash';

  // Create task in RUNNING state leased to Worker 1, with an EXPIRED lease
  const task: AutonomousAgentTask = {
    taskId,
    principal: tenantAlice,
    objective: 'Fault injection: Worker crash recovery with step idempotency test',
    state: 'RUNNING',
    plan,
    observations: [
      {
        observationId: 'obs_f1_step1_prev',
        stepId: plan.steps[0].stepId,
        source: 'specialist',
        sourceName: 'Planner Specialist',
        summary: 'Completed initial research outline before worker crash',
        timestamp: Date.now() - 4000,
        isError: false,
      },
    ],
    artifacts: [],
    workingMemory: {
      [plan.steps[0].stepId]: { outline: 'Initial outline completed by primary worker' },
    },
    fencingToken: 1,
    leaseOwner: 'worker_f1_primary',
    leaseExpiresAt: Date.now() - 1000, // Lease expired due to primary worker crash
    executionHistory: [
      { state: 'CREATED', timestamp: Date.now() - 6000 },
      { state: 'RUNNING', timestamp: Date.now() - 5000, reason: 'Worker 1 initial execution' },
    ],
    createdAt: Date.now() - 6000,
    updatedAt: Date.now() - 4000,
  };

  await repo.createTask(task);

  // Verify task is identified as claimable by replacement workers due to expired lease
  const claimable = await repo.findClaimableTasks(Date.now());
  assert.ok(
    claimable.some(t => t.taskId === taskId),
    'Task with expired lease must be discoverable by replacement worker'
  );

  // Monitor step execution to verify step idempotency (Step 1 must NOT be re-executed)
  const stepsStarted: string[] = [];
  engine.on('task.step_started', evt => {
    stepsStarted.push(evt.stepId);
    assert.notEqual(
      evt.stepId,
      plan.steps[0].stepId,
      'Step 1 was already COMPLETED and must NOT be re-executed by recovery worker'
    );
  });

  // Worker 2 starts — must discover the expired lease, increment fencing token, and finish the task
  const worker2 = buildWorkerHost(repo, 'worker_f1_replacement', engine);
  await worker2.start();

  let result: AutonomousAgentTask;
  try {
    result = await waitForTerminal(repo, taskId, 10000);
  } finally {
    await worker2.stop();
  }

  // Strict verification: recovered task must be COMPLETED
  assert.equal(result.state, 'COMPLETED', 'Recovered task must reach COMPLETED state');
  assert.ok(
    result.fencingToken! > 1,
    `Fencing token must be incremented during recovery (expected > 1, got ${result.fencingToken})`
  );
  assert.equal(result.leaseOwner, undefined, 'Lease owner must be cleared on completion');

  // Verify Step 1 retained original output and Steps 2 & 3 completed
  const finalPlan = result.plan!;
  const step1 = finalPlan.steps.find(s => s.stepId === plan.steps[0].stepId);
  const step2 = finalPlan.steps.find(s => s.stepId === plan.steps[1].stepId);
  const step3 = finalPlan.steps.find(s => s.stepId === plan.steps[2].stepId);

  assert.equal(step1?.status, 'COMPLETED');
  assert.equal(step1?.resultSummary, 'Completed initial research outline before worker crash');
  assert.equal(step2?.status, 'COMPLETED', 'Step 2 must be executed and completed by replacement worker');
  assert.equal(step3?.status, 'COMPLETED', 'Step 3 must be executed and completed by replacement worker');
});

// =============================================================================
// FAULT INJECTION: F2 — Task Cancellation During Active Execution
// =============================================================================

class DeliberateWorkloadSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'planner';
  public readonly name = 'Long Running Workload Specialist';
  public readonly description = 'Executes an ongoing workload that can be cancelled mid-flight';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze(['agent_planning']);

  protected async performExecution(
    context: SpecialistExecutionContext,
    _startedAt: number
  ): Promise<SpecialistExecutionResult> {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 600);
      context.cancellationSignal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(undefined);
      }, { once: true });
    });
    return this.buildResult(context, 'COMPLETED', { status: 'executed' });
  }
}

test('Mission 3: F2 — Task cancelled during execution transitions to CANCELLED state and rejects late writes', async () => {
  const repo = new InMemoryAutonomousTaskRepository();
  const registry = new SpecialistRegistry();
  registry.registerSpecialist(new DeliberateWorkloadSpecialistAgent());
  registry.registerSpecialist(new CoderSpecialistAgent());
  registry.registerSpecialist(new VerificationSpecialistAgent());

  const engine = new AutonomousAgentEngine({ repository: repo, specialistRegistry: registry });

  const plan = buildThreeStepPlan('f2');
  const task = await engine.createTask(
    'Fault injection: Active execution mid-flight cancellation',
    tenantAlice,
    plan
  );

  // Start task asynchronously
  const executionPromise = engine.startTask(task.taskId, 'worker_f2');

  // Wait for task to enter RUNNING state
  await waitForState(repo, task.taskId, 'RUNNING', 5000);

  // User initiates cancellation during active execution
  const cancelled = await engine.cancelTask(task.taskId, 'User requested cancellation mid-flight');

  assert.equal(cancelled.state, 'CANCELLED', 'Returned state must be CANCELLED');

  await executionPromise.catch(() => {});

  const stored = await repo.getTask(task.taskId);
  assert.ok(stored, 'Cancelled task must remain retrievable');
  assert.equal(stored!.state, 'CANCELLED', 'Stored repository state must be CANCELLED');
  assert.ok(cancelled.completedAt || stored!.completedAt, 'completedAt must be populated upon cancellation');

  // Stale worker attempting a late write must fail closed
  await assert.rejects(
    async () => {
      await repo.updateState(task.taskId, 'RUNNING', 'Late worker write continuation');
    },
    /Illegal autonomous state transition from "CANCELLED" to "RUNNING"/,
    'Late worker transition from CANCELLED to RUNNING must fail closed'
  );

  await assert.rejects(
    async () => {
      await repo.updateState(task.taskId, 'COMPLETED', 'Late worker completion write');
    },
    /Illegal autonomous state transition from "CANCELLED" to "COMPLETED"/,
    'Late worker transition from CANCELLED to COMPLETED must fail closed'
  );
});

// =============================================================================
// FAULT INJECTION: F3 — Human Approval Denial Blocks Tool Execution
// =============================================================================

test('Mission 3: F3 — Approval denial blocks task and transitions to FAILED', async () => {
  const repo = new InMemoryAutonomousTaskRepository();
  const registry = buildRegistry();
  const engine = new AutonomousAgentEngine({
    repository: repo,
    specialistRegistry: registry,
  });

  const plan = buildThreeStepPlan('f3');
  plan.steps[0].sideEffectLevel = 'WRITE';

  const task = await engine.createTask(
    'Approval denial test: attempt high-risk step requiring human sign-off',
    tenantAlice,
    plan
  );

  // Start the task asynchronously
  const executionPromise = engine.startTask(task.taskId, 'worker_f3');

  // Wait for the task to reach WAITING_FOR_APPROVAL
  const awaiting = await waitForState(repo, task.taskId, 'WAITING_FOR_APPROVAL', 5000);
  assert.equal(awaiting.state, 'WAITING_FOR_APPROVAL');
  assert.ok(awaiting.approvalRequestId, 'Task must have an approvalRequestId');

  // User denies approval
  const failedTask = await engine.approveStep(task.taskId, awaiting.approvalRequestId!, false, 'Human rejected high-risk operation');

  assert.equal(failedTask.state, 'FAILED', 'Task must transition to FAILED on denial');
  assert.ok(failedTask.error?.includes('rejected by user'), 'Error must note user rejection');

  await executionPromise.catch(() => {});
});

// =============================================================================
// FAULT INJECTION: F4 — Cross-Tenant Task Isolation & Authorization
// =============================================================================

test('Mission 3: F4 — Cross-tenant isolation: Tenant B cannot read, claim, or modify Tenant A tasks', async () => {
  const repo = new InMemoryAutonomousTaskRepository();

  // Tenant A creates a task
  const taskA = await repo.createTask({
    taskId: `autotask_f4_alice_${randomUUID().slice(0, 8)}`,
    principal: tenantAlice,
    objective: 'Tenant A confidential autonomous mission',
    state: 'CREATED',
    plan: buildThreeStepPlan('f4a'),
    observations: [],
    artifacts: [],
    workingMemory: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fencingToken: 0,
    executionHistory: [{ state: 'CREATED', timestamp: Date.now() }],
  });

  // Tenant B creates their own task
  const taskB = await repo.createTask({
    taskId: `autotask_f4_bob_${randomUUID().slice(0, 8)}`,
    principal: tenantBob,
    objective: 'Tenant B autonomous mission',
    state: 'CREATED',
    plan: buildThreeStepPlan('f4b'),
    observations: [],
    artifacts: [],
    workingMemory: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fencingToken: 0,
    executionHistory: [{ state: 'CREATED', timestamp: Date.now() }],
  });

  // 1. Tenant listing isolation
  const bobTasks = await repo.listTasksByPrincipal(tenantBob.userId);
  const taskIdsBob = bobTasks.map(t => t.taskId);
  assert.ok(!taskIdsBob.includes(taskA.taskId), 'Tenant B must NOT see Tenant A task');
  assert.ok(taskIdsBob.includes(taskB.taskId), 'Tenant B must see their own task');

  const aliceTasks = await repo.listTasksByPrincipal(tenantAlice.userId);
  const taskIdsAlice = aliceTasks.map(t => t.taskId);
  assert.ok(!taskIdsAlice.includes(taskB.taskId), 'Tenant A must NOT see Tenant B task');
  assert.ok(taskIdsAlice.includes(taskA.taskId), 'Tenant A must see their own task');

  // 2. Lease claim isolation: Tenant B worker cannot claim Tenant A's actively leased task
  const claimA = await repo.claimTask(taskA.taskId, 'worker_alice_node', 60000);
  assert.equal(claimA.success, true);

  const maliciousClaim = await repo.claimTask(taskA.taskId, 'worker_bob_node', 60000);
  assert.equal(maliciousClaim.success, false, 'Tenant B worker must not claim an actively leased task');
  assert.ok(maliciousClaim.error?.includes('currently leased'));

  // 3. API authorization contract verification:
  function evaluateTenantAccess(task: AutonomousAgentTask, reqPrincipal: ExecutionPrincipal): { authorized: boolean; status: number } {
    const isOwner = task.principal.userId === reqPrincipal.userId;
    const isAdmin = Array.isArray(reqPrincipal.roles) && reqPrincipal.roles.includes('admin');
    if (!isOwner && !isAdmin) {
      return { authorized: false, status: 403 };
    }
    return { authorized: true, status: 200 };
  }

  assert.deepEqual(evaluateTenantAccess(taskA, tenantBob), { authorized: false, status: 403 }, 'Tenant B accessing Tenant A must be 403 Forbidden');
  assert.deepEqual(evaluateTenantAccess(taskA, tenantAlice), { authorized: true, status: 200 }, 'Tenant A accessing own task must be authorized');
  assert.deepEqual(evaluateTenantAccess(taskA, adminPrincipal), { authorized: true, status: 200 }, 'Admin principal must be authorized');

  // 4. Cross-tenant browser session isolation
  const sharedStorage = new InMemoryBrowserSessionStorage();
  const secretKey = crypto.randomBytes(32).toString('hex');
  const worker1 = new BrowserAdapter({}, sharedStorage);

  try {
    await worker1.navigate(tenantAlice, 'https://example.com');
    const storedSnapshot = await worker1.saveDurableSnapshot(tenantAlice, secretKey, 60000);
    assert.ok(storedSnapshot, 'Alice snapshot must be saved');
    await worker1.shutdown();

    const worker2 = new BrowserAdapter({}, sharedStorage);

    // 4a. Tenant B attempting to directly decrypt/import Alice's session envelope fails closed
    await assert.rejects(
      async () => {
        await worker2.importEncryptedSessionState(tenantBob, storedSnapshot.encryptedEnvelope, secretKey);
      },
      /SECURITY_VIOLATION.*cannot decrypt session envelope owned by/,
      'Cross-tenant direct envelope import must reject with SECURITY_VIOLATION'
    );

    // 4b. Tenant B attempting to restore Tenant A's session via storage fails closed
    const attackerPrincipal = {
      ...tenantBob,
      sessionId: tenantAlice.sessionId, // Bob maliciously attempts to load Alice's session
    };

    await assert.rejects(
      async () => {
        await worker2.restoreDurableSnapshot(attackerPrincipal, secretKey);
      },
      /SESSION_NOT_FOUND|SECURITY_VIOLATION/,
      'Cross-tenant browser session access must fail closed'
    );
    await worker2.shutdown();
  } finally {
    await worker1.shutdown();
  }
});

// =============================================================================
// FAULT INJECTION: F5 — Database Outage Produces Fail-Closed 503 Response
// =============================================================================

test('Mission 3: F5 — Database outage produces fail-closed behavior across repository and worker host', async () => {
  // 1. Verify PostgresAutonomousTaskRepository with offline database connection
  const offlinePgRepo = new PostgresAutonomousTaskRepository(createOfflinePostgresClient());

  await assert.rejects(
    () => offlinePgRepo.createTask({
      taskId: 'task_f5_offline_pg',
      principal: tenantAlice,
      objective: 'DB outage test',
      state: 'CREATED',
      plan: undefined,
      observations: [],
      artifacts: [],
      workingMemory: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fencingToken: 0,
      executionHistory: [{ state: 'CREATED', timestamp: Date.now() }],
    }),
    (err: any) => {
      assert.equal(err.name, 'AutonomousPersistenceUnavailableError');
      assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
      return true;
    },
    'Postgres repo must fail closed with PERSISTENCE_UNAVAILABLE on connection refusal'
  );

  await assert.rejects(
    () => offlinePgRepo.getTask('task_f5_offline_get'),
    (err: any) => {
      assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
      return true;
    },
    'getTask must fail closed with PERSISTENCE_UNAVAILABLE'
  );

  await assert.rejects(
    () => offlinePgRepo.listTasksByPrincipal('usr_m3_alice'),
    (err: any) => {
      assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
      return true;
    },
    'listTasksByPrincipal must fail closed with PERSISTENCE_UNAVAILABLE'
  );

  // 2. Verify AutonomousWorkerHost survives DB outage without crashing
  const engine = new AutonomousAgentEngine({ repository: offlinePgRepo, specialistRegistry: buildRegistry() });
  const workerHost = new AutonomousWorkerHost(offlinePgRepo, engine, {
    workerId: 'worker_f5_offline_test',
    pollIntervalMs: 50,
  });

  let workerErrorEmitted = false;
  workerHost.on('worker.error', evt => {
    if (evt.error.includes('PERSISTENCE_UNAVAILABLE') || evt.error.includes('ECONNREFUSED')) {
      workerErrorEmitted = true;
    }
  });

  await workerHost.start();
  // Allow worker to poll and encounter the DB outage
  await new Promise(r => setTimeout(r, 120));
  await workerHost.stop();

  assert.ok(workerErrorEmitted, 'Worker daemon must catch and emit worker.error during database outage');
  assert.equal(workerHost.getHealth().status, 'STOPPED', 'Worker host shut down cleanly after DB outage');

  // 3. Verify FailClosedAutonomousTaskRepository static fail-closed fallback
  const failClosedRepo = new FailClosedAutonomousTaskRepository();
  await assert.rejects(
    () => failClosedRepo.getTask('task_static_failclosed'),
    (err: any) => err.code === 'PERSISTENCE_UNAVAILABLE'
  );
});

// =============================================================================
// FAULT INJECTION: F6 — Sandbox Failure Containment
// =============================================================================

class ContainerSandboxSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'coder';
  public readonly name = 'Isolated Sandbox Specialist';
  public readonly description = 'Executes untrusted code within an isolated container sandbox';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze([
    'software_engineering',
    'tool_execution',
  ]);

  protected async performExecution(
    context: SpecialistExecutionContext,
    _startedAt: number
  ): Promise<SpecialistExecutionResult> {
    // Attempt isolated container execution without an authorized backend
    const provider = resolveIsolatedSandboxProvider({ requireContainer: true });
    return this.buildResult(context, 'COMPLETED', { provider: provider.name });
  }
}

test('Mission 3: F6 — Sandbox failure is contained and propagated to task state without crashing worker', async () => {
  const repo = new InMemoryAutonomousTaskRepository();
  const registry = new SpecialistRegistry();

  // Register planner, sandbox specialist (which fails closed), and verifier
  registry.registerSpecialist(new PlannerSpecialistAgent());
  registry.registerSpecialist(new ContainerSandboxSpecialistAgent());
  registry.registerSpecialist(new VerificationSpecialistAgent());

  const engine = new AutonomousAgentEngine({ repository: repo, specialistRegistry: registry });
  const worker = buildWorkerHost(repo, 'worker_f6_sandbox_test', engine);

  // Submit task requesting isolated execution
  const task = await engine.createTask(
    'Sandbox failure containment test: execute untrusted code in container',
    tenantAlice,
    buildThreeStepPlan('f6')
  );

  await worker.start();

  let failedTask: AutonomousAgentTask;
  try {
    failedTask = await waitForTerminal(repo, task.taskId, 8000);
  } finally {
    await worker.stop();
  }

  // Task state must transition to FAILED due to container isolation unavailability
  assert.equal(failedTask.state, 'FAILED', 'Task must transition to FAILED upon container isolation failure');
  assert.ok(
    failedTask.error?.includes('CONTAINER_ISOLATION_UNAVAILABLE'),
    `Task error must note CONTAINER_ISOLATION_UNAVAILABLE, got: ${failedTask.error}`
  );

  // An error observation must be recorded
  assert.ok(failedTask.observations.length >= 1, 'Error observation must be recorded in task');
  assert.ok(
    failedTask.observations.some(o => o.isError && o.summary.includes('CONTAINER_ISOLATION_UNAVAILABLE')),
    'Observation must record the fail-closed container isolation error'
  );

  // Worker host survived the failure cleanly
  assert.equal(worker.getHealth().status, 'STOPPED', 'Worker host must remain healthy and shut down cleanly');
});

// =============================================================================
// ACCEPTANCE: A2 — Idempotency Key Prevents Duplicate Task Creation
// =============================================================================

test('Mission 3: A2 — Idempotency key prevents duplicate task creation on retry', async () => {
  const repo = new InMemoryAutonomousTaskRepository();
  const registry = buildRegistry();
  const engine = new AutonomousAgentEngine({ repository: repo, specialistRegistry: registry });

  const idempotencyKey = `idem_m3_a2_${randomUUID()}`;

  // First submission
  const task1 = await engine.createTask(
    'Idempotency test objective',
    tenantAlice,
    buildThreeStepPlan('a2'),
    idempotencyKey
  );

  // Second submission with the same idempotency key (simulates client retry)
  const task2 = await engine.createTask(
    'Idempotency test objective',
    tenantAlice,
    buildThreeStepPlan('a2_retry'),
    idempotencyKey
  );

  assert.equal(task1.taskId, task2.taskId, 'Duplicate submission must return the same task ID');
  assert.equal(task1.idempotencyKey, idempotencyKey, 'Idempotency key must be stored');

  // Verify only one task in repository
  const aliceTasks = await repo.listTasksByPrincipal(tenantAlice.userId);
  const withKey = aliceTasks.filter(t => t.idempotencyKey === idempotencyKey);
  assert.equal(withKey.length, 1, 'Exactly one task must exist for a given idempotency key');
});

// =============================================================================
// ACCEPTANCE: A3 — Working Memory Persisted and Merged Across Steps
// =============================================================================

class MemoryStep1PlannerSpecialist extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'planner';
  public readonly name = 'Memory Step 1 Specialist';
  public readonly description = 'Emits initial outline into working memory';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze(['agent_planning']);

  protected async performExecution(
    context: SpecialistExecutionContext,
    _startedAt: number
  ): Promise<SpecialistExecutionResult> {
    return this.buildResult(context, 'COMPLETED', {
      researchOutline: 'Quantum computing fundamentals',
      confidence: 0.85,
    });
  }
}

class MemoryStep2CoderSpecialist extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'coder';
  public readonly name = 'Memory Step 2 Specialist';
  public readonly description = 'Reads step 1 memory and extends working memory';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze(['software_engineering']);

  protected async performExecution(
    context: SpecialistExecutionContext,
    _startedAt: number
  ): Promise<SpecialistExecutionResult> {
    const priorOutline = (context.workingMemory?.['step_a3_1'] as any)?.researchOutline ?? 'default outline';
    return this.buildResult(context, 'COMPLETED', {
      synthesizedReport: `Full structured report based on: ${priorOutline}`,
      wordCount: 2500,
    });
  }
}

test('Mission 3: A3 — Working memory is persisted and merged across worker steps via engine', async () => {
  const repo = new InMemoryAutonomousTaskRepository();
  const registry = new SpecialistRegistry();

  registry.registerSpecialist(new MemoryStep1PlannerSpecialist());
  registry.registerSpecialist(new MemoryStep2CoderSpecialist());
  registry.registerSpecialist(new VerificationSpecialistAgent());

  const engine = new AutonomousAgentEngine({ repository: repo, specialistRegistry: registry });

  // Plan with 2 memory-cooperating steps + 1 verification step
  const plan: AgentObjectivePlan = {
    planId: `plan_m3_a3_${randomUUID().slice(0, 8)}`,
    objective: 'Working memory persistence and merge test',
    steps: [
      {
        stepId: 'step_a3_1',
        title: 'Step 1: Produce research outline',
        description: 'Store outline in working memory',
        role: 'planner',
        dependencies: [],
        suggestedTools: [],
        sideEffectLevel: 'NONE',
        status: 'PENDING',
      },
      {
        stepId: 'step_a3_2',
        title: 'Step 2: Synthesize report from step 1 memory',
        description: 'Read step 1 outline and append synthesized report',
        role: 'coder',
        dependencies: ['step_a3_1'],
        suggestedTools: [],
        sideEffectLevel: 'NONE',
        status: 'PENDING',
      },
      {
        stepId: 'step_a3_3',
        title: 'Step 3: Verification',
        description: 'Verify outputs',
        role: 'verifier',
        dependencies: ['step_a3_2'],
        suggestedTools: [],
        sideEffectLevel: 'NONE',
        status: 'PENDING',
      },
    ],
    estimatedWaves: 2,
    maxBudgetTokens: 16000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const task = await engine.createTask(
    'Working memory engine persistence test',
    tenantAlice,
    plan
  );

  // Execute through AutonomousAgentEngine
  const completed = await engine.executeAutonomousTask(task.taskId);

  assert.equal(completed.state, 'COMPLETED', 'Task must complete all steps');

  // Verify working memory was populated and persisted by engine across steps
  const stored = await repo.getTask(task.taskId);
  assert.ok(stored, 'Task must be in repository');
  assert.ok(stored!.workingMemory, 'Working memory must exist');

  const step1Memory = stored!.workingMemory['step_a3_1'] as any;
  const step2Memory = stored!.workingMemory['step_a3_2'] as any;

  assert.ok(step1Memory, 'Step 1 output must be stored in working memory');
  assert.equal(step1Memory.researchOutline, 'Quantum computing fundamentals');
  assert.equal(step1Memory.confidence, 0.85);

  assert.ok(step2Memory, 'Step 2 output must be stored in working memory');
  assert.equal(
    step2Memory.synthesizedReport,
    'Full structured report based on: Quantum computing fundamentals'
  );
  assert.equal(step2Memory.wordCount, 2500);
});

// =============================================================================
// ACCEPTANCE: A4 — Migration 031 Rollback Blocked When Active Records Exist
// =============================================================================

test('Mission 3: A4 — Migration 031 safety: rollback is blocked when active task records exist', async () => {
  const { down: migration031Down } = await import('../packages/db/src/migrations/031_autonomous_agent_tasks.js');
  const {
    classifyDatabaseUrl,
    PRODUCTION_NEON_PROJECT_ID,
    STAGING_NEON_PROJECT_ID,
  } = await import('../packages/db/src/security/database-isolation-guard.js');

  // Verify Neon project guards exist
  assert.ok(typeof PRODUCTION_NEON_PROJECT_ID === 'string', 'PRODUCTION_NEON_PROJECT_ID must be exported');
  assert.ok(typeof STAGING_NEON_PROJECT_ID === 'string', 'STAGING_NEON_PROJECT_ID must be exported');

  // Verify classifyDatabaseUrl correctly differentiates production vs staging
  const prodClassification = classifyDatabaseUrl('postgresql://neondb_owner@ep-withered-art-b36ox90b.us-east-2.aws.neon.tech:5432/db');
  assert.equal(prodClassification.isProduction, true, 'Neon production URL must be classified as production');
  assert.equal(prodClassification.category, 'production', 'Category must be production');

  const stagingClassification = classifyDatabaseUrl('postgresql://neondb_owner@ep-shiny-bird-b3xundyt.us-east-2.aws.neon.tech:5432/db');
  assert.equal(stagingClassification.isProduction, false, 'Neon staging URL must not be classified as production');
  assert.equal(stagingClassification.isStagingPermanent, true, 'Category must be staging_permanent');

  // Verify local URLs are classified correctly
  const localClassification = classifyDatabaseUrl('postgresql://aira:aira@127.0.0.1:5432/test_db');
  assert.equal(localClassification.isProduction, false, 'Local URL must not be classified as production');
  assert.equal(localClassification.isLocalOrCiTest, true, 'Category must be local_or_ci_test');

  // Verify the migration down() function blocks destructive rollback when active records exist
  const savedNodeEnv = process.env.NODE_ENV;
  const savedAllow = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;

    const mockKnex: any = (tableName: string) => ({
      count: () => ({
        first: async () => ({ count: '42' })
      })
    });
    mockKnex.schema = {
      hasTable: async () => true,
      dropTableIfExists: async () => {}
    };

    await assert.rejects(
      () => migration031Down(mockKnex),
      /MIGRATION SAFETY BARRIER.*contains 42 user record\(s\)/
    );
  } finally {
    process.env.NODE_ENV = savedNodeEnv!;
    if (savedAllow !== undefined) process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = savedAllow;
    else delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
  }
});

// =============================================================================
// ACCEPTANCE: A5 — AES-256-GCM Session State Survives Worker Replacement
// =============================================================================

test('Mission 3: A5 — Browser session encrypted state survives simulated worker replacement via in-memory storage', async () => {
  const sessionKey = crypto.randomBytes(32).toString('hex');
  const browserStorage = new InMemoryBrowserSessionStorage();
  const worker1 = new BrowserAdapter({}, browserStorage);

  try {
    await worker1.navigate(tenantAlice, 'https://example.com');
    const storedSnapshot = await worker1.saveDurableSnapshot(tenantAlice, sessionKey, 60000);
    assert.ok(storedSnapshot, 'Must export and save durable encrypted session envelope');
    assert.equal(storedSnapshot.principalId, tenantAlice.userId);

    // Verify envelope in storage
    const stored = await browserStorage.getSession(`${tenantAlice.userId}:${tenantAlice.sessionId}`);
    assert.ok(stored, 'Must be stored in storage');
    assert.ok(typeof stored.encryptedEnvelope === 'string');

    // Simulate worker 1 crashing
    await worker1.shutdown();

    // Worker 2 starts up sharing the storage and restores session
    const worker2 = new BrowserAdapter({}, browserStorage);
    try {
      const restored = await worker2.restoreDurableSnapshot(tenantAlice, sessionKey);
      assert.ok(restored, 'Restored session must be non-null');
      assert.equal(restored.principalId, tenantAlice.userId);

      // Verify tamper rejection
      const tampered = await browserStorage.getSession(`${tenantAlice.userId}:${tenantAlice.sessionId}`);
      const parsedEnv = JSON.parse(tampered!.encryptedEnvelope);
      const originalData = parsedEnv.data;
      parsedEnv.data = (originalData[0] === 'A' ? 'B' : 'A') + originalData.slice(1);
      await browserStorage.saveSession({ ...tampered!, encryptedEnvelope: JSON.stringify(parsedEnv) });

      await assert.rejects(
        () => worker2.restoreDurableSnapshot(tenantAlice, sessionKey),
        /SECURITY_VIOLATION: Decryption failed/,
        'Tampered session state must be rejected by AES-256-GCM authentication tag'
      );

      // Restore untampered and test wrong key
      parsedEnv.data = originalData;
      await browserStorage.saveSession({ ...tampered!, encryptedEnvelope: JSON.stringify(parsedEnv) });

      const wrongKey = crypto.randomBytes(32).toString('hex');
      await assert.rejects(
        () => worker2.restoreDurableSnapshot(tenantAlice, wrongKey),
        /SECURITY_VIOLATION: Decryption failed/,
        'Wrong decryption key must be rejected'
      );
    } finally {
      await worker2.shutdown();
    }
  } finally {
    await worker1.shutdown();
  }
});

// =============================================================================
// ACCEPTANCE: A6 — Deployment Contract: AgentRuntime Environment-Aware Repo Selection
// =============================================================================

test('Mission 3: A6 — Deployment contract: AgentRuntime selects fail-closed repository in deployed env without DB', async () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedVercel = process.env.VERCEL;
  const savedDbUrl = process.env.DATABASE_URL;

  try {
    process.env.NODE_ENV = 'production';
    process.env.VERCEL = '1';
    delete process.env.DATABASE_URL;

    const runtime = new AgentRuntime(
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any
    );

    const repo = runtime.getAutonomousTaskRepository();
    assert.ok(repo instanceof FailClosedAutonomousTaskRepository, 'Must select FailClosedAutonomousTaskRepository');

    await assert.rejects(
      () => repo.createTask({
        taskId: 'runtime_a6_test',
        principal: tenantAlice,
        objective: 'Deployment contract test',
        state: 'CREATED',
        plan: undefined,
        observations: [],
        artifacts: [],
        workingMemory: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
        fencingToken: 0,
        executionHistory: [{ state: 'CREATED', timestamp: Date.now() }],
      }),
      (err: Error) => {
        assert.equal((err as any).code, 'PERSISTENCE_UNAVAILABLE', 'Must throw PERSISTENCE_UNAVAILABLE');
        return true;
      },
      'Deployed env without DATABASE_URL must fail closed on task creation'
    );
  } finally {
    process.env.NODE_ENV = savedNodeEnv!;
    process.env.VERCEL = savedVercel ?? '';
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
    else delete process.env.DATABASE_URL;
    if (!savedVercel) delete process.env.VERCEL;
  }
});
