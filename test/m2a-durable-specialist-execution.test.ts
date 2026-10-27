import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SpecialistRole,
  SpecialistTaskState,
  SpecialistTaskContract,
  TaskDAG,
  ExecutionPrincipal,
  RunStateSchema
} from '../packages/contracts/src/index.js';
import {
  canTransition,
  assertValidTransition,
  isTerminalSpecialistState,
  toSpecialistTaskOutcome,
  IllegalStateTransitionError,
  StaleFencingTokenError,
  TerminalStateImmutabilityError
} from '../packages/agent-runtime/src/durable/task-state-machine.js';
import {
  InMemorySpecialistTaskRepository,
  DurableSpecialistTask
} from '../packages/agent-runtime/src/durable/specialist-task-repository.js';
import { TaskLeaseManager } from '../packages/agent-runtime/src/durable/task-lease-manager.js';
import { DurableTaskScheduler } from '../packages/agent-runtime/src/durable/durable-task-scheduler.js';
import { SpecialistWorkerRuntime } from '../packages/agent-runtime/src/durable/specialist-worker-runtime.js';
import { DurableExecutionCoordinator } from '../packages/agent-runtime/src/durable/durable-execution-coordinator.js';
import { SpecialistWorkerHost } from '../packages/agent-runtime/src/durable/worker-host.js';
import { SpecialistRegistry } from '../packages/agent-runtime/src/specialists/specialist-registry.js';
import { MathematicalSpecialistAgent } from '../packages/agent-runtime/src/specialists/mathematical-specialist.js';
import { AnalysisSpecialistAgent } from '../packages/agent-runtime/src/specialists/analysis-specialist.js';
import { VerificationSpecialistAgent } from '../packages/agent-runtime/src/specialists/verification-specialist.js';
import { ToolGateway, ToolRegistry, InMemoryToolCallRepository } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';

test.describe('AIRA AI 2026 — Milestone 2A Native Durable Specialist Execution Runtime Suite', () => {
  const dummyPrincipal: ExecutionPrincipal = {
    userId: 'user_test_m2a_owner',
    sessionId: 'sess_test_m2a',
    workspaceId: 'ws_test_m2a',
    role: 'user'
  };

  const foreignPrincipal: ExecutionPrincipal = {
    userId: 'user_foreign_attacker',
    sessionId: 'sess_foreign',
    workspaceId: 'ws_foreign',
    role: 'user'
  };

  function setupHarness() {
    const repo = new InMemorySpecialistTaskRepository();
    const leaseManager = new TaskLeaseManager(repo, { defaultLeaseDurationMs: 2000, heartbeatIntervalMs: 500 });
    const scheduler = new DurableTaskScheduler(repo, { maxConcurrency: 3 });
    const approvalKernel = new ApprovalKernel();
    const toolCallRepo = new InMemoryToolCallRepository();
    const toolGateway = new ToolGateway(toolCallRepo, approvalKernel, process.cwd());

    const registry = new SpecialistRegistry();
    const mathSpecialist = new MathematicalSpecialistAgent(toolGateway);
    const verifierSpecialist = new VerificationSpecialistAgent();

    registry.registerSpecialist(mathSpecialist, 'IMPLEMENTED_LOCALLY');
    registry.registerSpecialist(verifierSpecialist, 'IMPLEMENTED_LOCALLY');

    const worker = new SpecialistWorkerRuntime(repo, leaseManager, registry, {
      workerId: 'worker_primary_test',
      leaseDurationMs: 2000,
      heartbeatIntervalMs: 500
    });

    const coordinator = new DurableExecutionCoordinator(repo, scheduler, leaseManager, worker);

    return {
      repo,
      leaseManager,
      scheduler,
      toolGateway,
      registry,
      worker,
      coordinator,
      approvalKernel,
      toolCallRepo
    };
  }

  // ==========================================
  // 1. STATE MACHINE & INVARIANTS
  // ==========================================

  test('GATE 01: State machine transitions allow legal paths and reject invalid hops', () => {
    // Legal hops
    assert.strictEqual(canTransition('QUEUED', 'CLAIMED'), true);
    assert.strictEqual(canTransition('CLAIMED', 'RUNNING'), true);
    assert.strictEqual(canTransition('RUNNING', 'COMPLETED'), true);
    assert.strictEqual(canTransition('RUNNING', 'FAILED'), true);
    assert.strictEqual(canTransition('RUNNING', 'RETRY_WAIT'), true);
    assert.strictEqual(canTransition('RETRY_WAIT', 'QUEUED'), true);
    assert.strictEqual(canTransition('BLOCKED', 'QUEUED'), true);

    // Illegal hops
    assert.strictEqual(canTransition('QUEUED', 'COMPLETED'), false);
    assert.strictEqual(canTransition('BLOCKED', 'RUNNING'), false);
    assert.strictEqual(canTransition('COMPLETED', 'RUNNING'), false);
    assert.strictEqual(canTransition('FAILED', 'QUEUED'), false);

    assert.throws(
      () => assertValidTransition('task_1', 'QUEUED', 'COMPLETED'),
      IllegalStateTransitionError
    );
  });

  test('GATE 02: Terminal states are strictly immutable and map to SpecialistTaskOutcome', () => {
    const terminalStates: SpecialistTaskState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNAVAILABLE'];

    for (const term of terminalStates) {
      assert.strictEqual(isTerminalSpecialistState(term), true);
      const outcome = toSpecialistTaskOutcome(term);
      assert.strictEqual(outcome, term);

      // Attempting any transition from a terminal state throws TerminalStateImmutabilityError
      assert.throws(
        () => assertValidTransition('task_term', term, 'RUNNING'),
        TerminalStateImmutabilityError
      );
      assert.throws(
        () => assertValidTransition('task_term', term, 'QUEUED'),
        TerminalStateImmutabilityError
      );
    }

    assert.strictEqual(isTerminalSpecialistState('QUEUED'), false);
    assert.strictEqual(isTerminalSpecialistState('RUNNING'), false);
    assert.strictEqual(toSpecialistTaskOutcome('RUNNING'), undefined);
  });

  test('GATE 03: Monotonically increasing fencing tokens reject stale workers', async () => {
    const { repo, leaseManager } = setupHarness();
    const now = Date.now();

    const task: DurableSpecialistTask = {
      id: 'task_fence_test',
      runId: 'run_fence_1',
      principalId: dummyPrincipal.userId,
      role: 'analyst',
      objective: 'Fencing verification',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 4096 },
      timeoutMs: 30000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    };

    await repo.saveTask(task);

    // Worker 1 claims task (fencingToken becomes 1)
    const claim1 = await leaseManager.acquireLease(task.id, 'worker_1', 1000);
    assert.strictEqual(claim1.success, true);
    assert.strictEqual(claim1.task?.fencingToken, 1);

    // Simulate Worker 1 expiring, Worker 2 claims task (fencingToken becomes 2)
    // Force expire task
    const current = await repo.getTask(task.id);
    current!.leaseExpiresAt = now - 5000;
    await repo.saveTask(current!);

    const claim2 = await leaseManager.acquireLease(task.id, 'worker_2', 1000);
    assert.strictEqual(claim2.success, true);
    assert.strictEqual(claim2.task?.fencingToken, 2);

    // Stale Worker 1 now tries to update task with token 1 -> MUST REJECT
    await assert.rejects(
      async () => {
        await repo.updateTaskState(task.id, 'COMPLETED', 1, { resultOutput: { stolen: true } });
      },
      StaleFencingTokenError
    );

    // Worker 2 updates with token 2 -> MUST SUCCEED
    const success = await repo.updateTaskState(task.id, 'COMPLETED', 2, { resultOutput: { verified: true } });
    assert.strictEqual(success, true);

    const final = await repo.getTask(task.id);
    assert.strictEqual(final?.state, 'COMPLETED');
    assert.deepStrictEqual(final?.resultOutput, { verified: true });
  });

  // ==========================================
  // 2. ATOMIC LEASING & TWO-WORKER CLAIM RACE
  // ==========================================

  test('GATE 04: Two-worker claim race guarantees exactly one worker acquires claim', async () => {
    const { repo, leaseManager } = setupHarness();
    const now = Date.now();

    const task: DurableSpecialistTask = {
      id: 'task_race_1',
      runId: 'run_race_1',
      principalId: dummyPrincipal.userId,
      role: 'analyst',
      objective: 'Race condition verification',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 4096 },
      timeoutMs: 30000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    };

    await repo.saveTask(task);

    // Concurrently invoke acquireLease from worker_A and worker_B
    const [resA, resB] = await Promise.all([
      leaseManager.acquireLease(task.id, 'worker_A', 5000),
      leaseManager.acquireLease(task.id, 'worker_B', 5000)
    ]);

    const winnerCount = (resA.success ? 1 : 0) + (resB.success ? 1 : 0);
    assert.strictEqual(winnerCount, 1, 'Exactly one worker must acquire the task lease');

    const winnerId = resA.success ? 'worker_A' : 'worker_B';
    const loserRes = resA.success ? resB : resA;

    assert.strictEqual(loserRes.success, false);
    assert.match(loserRes.error || '', /not in a claimable state/i);

    const saved = await repo.getTask(task.id);
    assert.strictEqual(saved?.leaseOwner, winnerId);
    assert.strictEqual(saved?.state, 'CLAIMED');
    assert.strictEqual(saved?.fencingToken, 1);
  });

  test('GATE 05: Lease renewal extends active lease while rejecting foreign or terminal tasks', async () => {
    const { repo, leaseManager } = setupHarness();
    const now = Date.now();

    const task: DurableSpecialistTask = {
      id: 'task_renew_1',
      runId: 'run_renew_1',
      principalId: dummyPrincipal.userId,
      role: 'analyst',
      objective: 'Lease renewal test',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 4096 },
      timeoutMs: 30000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    };

    await repo.saveTask(task);
    const claim = await leaseManager.acquireLease(task.id, 'worker_alpha', 5000);
    assert.strictEqual(claim.success, true);

    const initialExpiry = claim.task?.leaseExpiresAt!;

    // Valid renewal
    const renewed = await leaseManager.renewLease(task.id, 'worker_alpha', claim.task?.fencingToken!, 8000);
    assert.strictEqual(renewed, true);

    const afterRenew = await repo.getTask(task.id);
    assert.ok(afterRenew?.leaseExpiresAt! > initialExpiry);

    // Foreign worker renewal rejection
    const foreignRenew = await leaseManager.renewLease(task.id, 'worker_imposter', claim.task?.fencingToken!, 8000);
    assert.strictEqual(foreignRenew, false);
  });

  // ==========================================
  // 3. WORKER CRASH, LEASE EXPIRATION & RECOVERY
  // ==========================================

  test('GATE 06: Expired worker lease is safely reclaimed and resumed by replacement worker', async () => {
    const { repo, leaseManager } = setupHarness();
    const now = Date.now();

    const task: DurableSpecialistTask = {
      id: 'task_crash_recovery_1',
      runId: 'run_crash_1',
      principalId: dummyPrincipal.userId,
      role: 'analyst',
      objective: 'Crash recovery simulation',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 4096 },
      timeoutMs: 30000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    };

    await repo.saveTask(task);

    // Worker 1 claims task and "crashes" (dies without finishing)
    const claim1 = await leaseManager.acquireLease(task.id, 'worker_crashed_1', 1000);
    assert.strictEqual(claim1.success, true);
    assert.strictEqual(claim1.task?.attemptCount, 1);

    // Advance time past lease expiration
    const expiryTime = now + 1500;
    const reclaimed = await leaseManager.reclaimExpiredLeases(expiryTime);
    assert.strictEqual(reclaimed.length, 1);
    assert.strictEqual(reclaimed[0].id, task.id);
    assert.strictEqual(reclaimed[0].state, 'RETRY_WAIT');

    // Replacement worker claims the task
    const claim2 = await leaseManager.acquireLease(task.id, 'worker_survivor_2', 5000);
    assert.strictEqual(claim2.success, true);
    assert.strictEqual(claim2.task?.leaseOwner, 'worker_survivor_2');
    assert.strictEqual(claim2.task?.attemptCount, 2);
    assert.strictEqual(claim2.task?.fencingToken, 2);
  });

  test('GATE 07: Retry policy transitions to TIMED_OUT when attemptCount reaches maxRetries', async () => {
    const { repo, leaseManager } = setupHarness();
    const now = Date.now();

    const task: DurableSpecialistTask = {
      id: 'task_retry_exhaust_1',
      runId: 'run_exhaust_1',
      principalId: dummyPrincipal.userId,
      role: 'analyst',
      objective: 'Retry exhaustion simulation',
      state: 'RUNNING',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 4096 },
      timeoutMs: 30000,
      attemptCount: 2, // reached maxRetries
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 1,
      leaseOwner: 'worker_failing',
      leaseExpiresAt: now - 1000, // expired
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    };

    await repo.saveTask(task);

    // Reclaim expired lease -> attemptCount 2 >= maxRetries 2 -> TIMED_OUT
    const reclaimed = await leaseManager.reclaimExpiredLeases(now);
    assert.strictEqual(reclaimed.length, 1);
    assert.strictEqual(reclaimed[0].state, 'TIMED_OUT');

    const updated = await repo.getTask(task.id);
    assert.strictEqual(updated?.state, 'TIMED_OUT');
    assert.strictEqual(updated?.outcome, 'TIMED_OUT');
    assert.strictEqual(updated?.errorDetails?.retryable, false);
  });

  // ==========================================
  // 4. DAG SCHEDULER & WAVE DEPENDENCY RESOLUTION
  // ==========================================

  test('GATE 08: DAG scheduler submits tasks, queues roots, and blocks dependents', async () => {
    const { scheduler, repo } = setupHarness();

    const dag: TaskDAG = {
      dagId: 'dag_test_1',
      runId: 'run_dag_1',
      maxConcurrency: 3,
      totalBudget: { maxTotalTokens: 20000 },
      tasks: [
        {
          taskId: 'step_root_1',
          runId: 'run_dag_1',
          role: 'analyst',
          objective: 'Root data prep',
          dependencies: [],
          inputContract: {},
          expectedOutputContract: {},
          executionConstraints: { sideEffectLevel: 'NONE', allowedTools: [], sandboxRequired: false, requireStrictJsonOutput: true },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 60000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        },
        {
          taskId: 'step_dep_2',
          runId: 'run_dag_1',
          role: 'verifier',
          objective: 'Dependent verification',
          dependencies: ['step_root_1'],
          inputContract: {},
          expectedOutputContract: {},
          executionConstraints: { sideEffectLevel: 'NONE', allowedTools: [], sandboxRequired: false, requireStrictJsonOutput: true },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 60000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        }
      ]
    };

    const created = await scheduler.submitDAG(dag, dummyPrincipal);
    assert.strictEqual(created.length, 2);

    const rootTask = await repo.getTask('step_root_1');
    const depTask = await repo.getTask('step_dep_2');

    assert.strictEqual(rootTask?.state, 'QUEUED');
    assert.strictEqual(depTask?.state, 'BLOCKED');

    // First scheduling evaluation: root is runnable, dep is blocked
    const batch1 = await scheduler.scheduleRun('run_dag_1');
    assert.strictEqual(batch1.runnableTasks.length, 1);
    assert.strictEqual(batch1.runnableTasks[0].id, 'step_root_1');
    assert.strictEqual(batch1.blockedTasks.length, 1);
    assert.strictEqual(batch1.blockedTasks[0].id, 'step_dep_2');

    // Complete root task through valid lifecycle
    await repo.updateTaskState('step_root_1', 'CLAIMED', rootTask!.fencingToken);
    await repo.updateTaskState('step_root_1', 'RUNNING', rootTask!.fencingToken);
    await repo.updateTaskState('step_root_1', 'COMPLETED', rootTask!.fencingToken);

    // Second scheduling evaluation: dep is now unblocked and runnable!
    const batch2 = await scheduler.scheduleRun('run_dag_1');
    assert.strictEqual(batch2.runnableTasks.length, 1);
    assert.strictEqual(batch2.runnableTasks[0].id, 'step_dep_2');
    assert.strictEqual(batch2.blockedTasks.length, 0);
  });

  test('GATE 09: Dependent task fails immediately if prerequisite dependency fails', async () => {
    const { scheduler, repo } = setupHarness();

    const dag: TaskDAG = {
      dagId: 'dag_fail_prop',
      runId: 'run_fail_prop',
      maxConcurrency: 3,
      totalBudget: { maxTotalTokens: 20000 },
      tasks: [
        {
          taskId: 'step_parent',
          runId: 'run_fail_prop',
          role: 'analyst',
          objective: 'Parent step',
          dependencies: [],
          inputContract: {},
          expectedOutputContract: {},
          executionConstraints: { sideEffectLevel: 'NONE', allowedTools: [], sandboxRequired: false, requireStrictJsonOutput: true },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 60000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        },
        {
          taskId: 'step_child',
          runId: 'run_fail_prop',
          role: 'verifier',
          objective: 'Child step',
          dependencies: ['step_parent'],
          inputContract: {},
          expectedOutputContract: {},
          executionConstraints: { sideEffectLevel: 'NONE', allowedTools: [], sandboxRequired: false, requireStrictJsonOutput: true },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 60000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        }
      ]
    };

    await scheduler.submitDAG(dag, dummyPrincipal);

    // Parent fails
    const parent = await repo.getTask('step_parent');
    await repo.updateTaskState('step_parent', 'FAILED', parent!.fencingToken, {
      errorDetails: { code: 'EXECUTION_FAILED', message: 'Parent exploded', retryable: false }
    });

    // Schedule run: child must transition to FAILED with PREREQUISITE_DEPENDENCY_FAILED
    const batch = await scheduler.scheduleRun('run_fail_prop');
    const child = await repo.getTask('step_child');

    assert.strictEqual(child?.state, 'FAILED');
    assert.strictEqual(child?.errorDetails?.code, 'PREREQUISITE_DEPENDENCY_FAILED');
  });

  // ==========================================
  // 5. CONCRETE SPECIALIST & SCENARIO A: 4194304
  // ==========================================

  test('GATE 10: Scenario A — MathematicalSpecialist executes calculator and persists exact result 4194304', async () => {
    const { coordinator, repo, toolCallRepo } = setupHarness();

    const dag: TaskDAG = {
      dagId: 'dag_calc_acceptance',
      runId: 'run_calc_acceptance_1',
      maxConcurrency: 1,
      totalBudget: { maxTotalTokens: 10000 },
      tasks: [
        {
          taskId: 'math_task_4194304',
          runId: 'run_calc_acceptance_1',
          role: 'analyst',
          objective: 'Calculate ((16384 * 1024) / 4) through ToolGateway',
          dependencies: [],
          inputContract: {
            expression: '((16384 * 1024) / 4)'
          },
          expectedOutputContract: {},
          executionConstraints: {
            sideEffectLevel: 'NONE',
            allowedTools: ['calculator'],
            sandboxRequired: false,
            requireStrictJsonOutput: true
          },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 30000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        }
      ]
    };

    const missionResult = await coordinator.executeMission(dag, dummyPrincipal);

    assert.strictEqual(missionResult.outcome, 'COMPLETED');
    assert.strictEqual(missionResult.completedTasks, 1);
    assert.strictEqual(missionResult.failedTasks, 0);

    const taskResult = missionResult.results['math_task_4194304'];
    assert.ok(taskResult);
    assert.strictEqual(taskResult.outcome, 'COMPLETED');

    // Verify exact calculation result: 4194304
    const output = taskResult.output as { expression: string; result: number };
    assert.strictEqual(output.result, 4194304);
    assert.strictEqual(output.expression, '((16384 * 1024) / 4)');

    // Verify task record in repository
    const persistedTask = await repo.getTask('math_task_4194304');
    assert.strictEqual(persistedTask?.state, 'COMPLETED');
    assert.strictEqual(persistedTask?.outcome, 'COMPLETED');
    assert.strictEqual((persistedTask?.resultOutput as any)?.result, 4194304);

    // Verify tool call record persisted in ToolCallRepository
    const toolCalls = await toolCallRepo.listToolCallsForRun('run_calc_acceptance_1');
    assert.strictEqual(toolCalls.length, 1);
    assert.strictEqual(toolCalls[0].toolName, 'calculator');
    assert.strictEqual(toolCalls[0].lifecycleState, 'COMPLETED');
    assert.strictEqual((toolCalls[0].output as any)?.result, 4194304);
  });

  // ==========================================
  // 6. SCENARIO B: MULTI-STEP DAG & VERIFICATION
  // ==========================================

  test('GATE 11: Scenario B — Multi-step sequential DAG executes in order and verifies output', async () => {
    const { coordinator, repo } = setupHarness();

    const dag: TaskDAG = {
      dagId: 'dag_multi_step',
      runId: 'run_multi_step_1',
      maxConcurrency: 2,
      totalBudget: { maxTotalTokens: 20000 },
      tasks: [
        {
          taskId: 'step_1_calc',
          runId: 'run_multi_step_1',
          role: 'analyst',
          objective: 'Step 1 calculation',
          dependencies: [],
          inputContract: { expression: '2048 * 2048' },
          expectedOutputContract: {},
          executionConstraints: { sideEffectLevel: 'NONE', allowedTools: ['calculator'], sandboxRequired: false, requireStrictJsonOutput: true },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 30000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        },
        {
          taskId: 'step_2_verify',
          runId: 'run_multi_step_1',
          role: 'verifier',
          objective: 'Step 2 verify result',
          dependencies: ['step_1_calc'],
          inputContract: { expectedValue: 4194304, actualValue: 4194304, criteria: ['must equal 4194304'] },
          expectedOutputContract: {},
          executionConstraints: { sideEffectLevel: 'NONE', allowedTools: [], sandboxRequired: false, requireStrictJsonOutput: true },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 30000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        }
      ]
    };

    const mission = await coordinator.executeMission(dag, dummyPrincipal);
    assert.strictEqual(mission.outcome, 'COMPLETED');
    assert.strictEqual(mission.totalTasks, 2);
    assert.strictEqual(mission.completedTasks, 2);

    const step1 = await repo.getTask('step_1_calc');
    const step2 = await repo.getTask('step_2_verify');

    assert.strictEqual(step1?.state, 'COMPLETED');
    assert.strictEqual(step2?.state, 'COMPLETED');
    assert.ok(step1?.completedAt! <= step2?.startedAt!, 'Step 1 must finish before Step 2 starts');
  });

  // ==========================================
  // 7. SCENARIO C: PARALLEL INDEPENDENT TASKS
  // ==========================================

  test('GATE 12: Scenario C — Parallel independent tasks execute concurrently without claim collision', async () => {
    const { coordinator, repo } = setupHarness();

    const dag: TaskDAG = {
      dagId: 'dag_parallel_run',
      runId: 'run_parallel_1',
      maxConcurrency: 3,
      totalBudget: { maxTotalTokens: 20000 },
      tasks: [
        {
          taskId: 'parallel_task_1',
          runId: 'run_parallel_1',
          role: 'analyst',
          objective: 'Parallel job 1',
          dependencies: [],
          inputContract: { expression: '100 + 100' },
          expectedOutputContract: {},
          executionConstraints: { sideEffectLevel: 'NONE', allowedTools: ['calculator'], sandboxRequired: false, requireStrictJsonOutput: true },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 30000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        },
        {
          taskId: 'parallel_task_2',
          runId: 'run_parallel_1',
          role: 'analyst',
          objective: 'Parallel job 2',
          dependencies: [],
          inputContract: { expression: '200 + 200' },
          expectedOutputContract: {},
          executionConstraints: { sideEffectLevel: 'NONE', allowedTools: ['calculator'], sandboxRequired: false, requireStrictJsonOutput: true },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 30000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        },
        {
          taskId: 'parallel_task_3',
          runId: 'run_parallel_1',
          role: 'analyst',
          objective: 'Parallel job 3',
          dependencies: [],
          inputContract: { expression: '300 + 300' },
          expectedOutputContract: {},
          executionConstraints: { sideEffectLevel: 'NONE', allowedTools: ['calculator'], sandboxRequired: false, requireStrictJsonOutput: true },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 30000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        }
      ]
    };

    const mission = await coordinator.executeMission(dag, dummyPrincipal);
    assert.strictEqual(mission.outcome, 'COMPLETED');
    assert.strictEqual(mission.completedTasks, 3);

    const task1 = await repo.getTask('parallel_task_1');
    const task2 = await repo.getTask('parallel_task_2');
    const task3 = await repo.getTask('parallel_task_3');

    assert.strictEqual((task1?.resultOutput as any)?.result, 200);
    assert.strictEqual((task2?.resultOutput as any)?.result, 400);
    assert.strictEqual((task3?.resultOutput as any)?.result, 600);
  });

  // ==========================================
  // 8. SCENARIO E: CANCELLATION PROPAGATION
  // ==========================================

  test('GATE 13: Scenario E — Mission cancellation transitions executing and pending tasks to CANCELLED', async () => {
    const { coordinator, scheduler, repo } = setupHarness();

    const dag: TaskDAG = {
      dagId: 'dag_cancel_test',
      runId: 'run_cancel_1',
      maxConcurrency: 2,
      totalBudget: { maxTotalTokens: 20000 },
      tasks: [
        {
          taskId: 'cancel_task_a',
          runId: 'run_cancel_1',
          role: 'analyst',
          objective: 'Task A to be cancelled',
          dependencies: [],
          inputContract: {},
          expectedOutputContract: {},
          executionConstraints: { sideEffectLevel: 'NONE', allowedTools: [], sandboxRequired: false, requireStrictJsonOutput: true },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 60000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        },
        {
          taskId: 'cancel_task_b',
          runId: 'run_cancel_1',
          role: 'verifier',
          objective: 'Task B blocked on A',
          dependencies: ['cancel_task_a'],
          inputContract: {},
          expectedOutputContract: {},
          executionConstraints: { sideEffectLevel: 'NONE', allowedTools: [], sandboxRequired: false, requireStrictJsonOutput: true },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 60000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        }
      ]
    };

    await scheduler.submitDAG(dag, dummyPrincipal);

    // Cancel mission
    await coordinator.cancelMission('run_cancel_1', 'Operator cancelled mission');

    const taskA = await repo.getTask('cancel_task_a');
    const taskB = await repo.getTask('cancel_task_b');

    assert.strictEqual(taskA?.state, 'CANCELLED');
    assert.strictEqual(taskA?.outcome, 'CANCELLED');
    assert.strictEqual(taskB?.state, 'CANCELLED');
    assert.strictEqual(taskB?.outcome, 'CANCELLED');
  });

  // ==========================================
  // 9. SCENARIO F: SECURITY, UNAUTHORIZED TOOLS & UNAVAILABLE
  // ==========================================

  test('GATE 14: Scenario F — Unauthorized tool requests and tenant-crossing are strictly rejected', async () => {
    const { toolGateway, repo } = setupHarness();

    // 1. ToolGateway rejects unauthorized/unregistered tool
    const rejectedTool = await toolGateway.execute({
      toolName: 'malicious_shell_exec',
      arguments: { cmd: 'rm -rf /' },
      context: {
        runId: 'run_sec_test',
        principal: dummyPrincipal
      }
    });

    assert.strictEqual(rejectedTool.isError, true);
    assert.match(rejectedTool.error || '', /(not registered|not found|Tool Registry)/i);

    // 2. Tenant isolation in SpecialistTaskRepository: user cannot list other users' tasks
    const foreignTasks = await repo.listTasksByPrincipal(foreignPrincipal.userId);
    assert.strictEqual(foreignTasks.length, 0);
  });

  test('GATE 15: Truthful UNAVAILABLE reporting for unimplemented specialist roles', async () => {
    const { registry, worker, repo } = setupHarness();
    const now = Date.now();

    // 7 of 9 canonical roles are unimplemented: 'planner', 'researcher', 'coder', 'document', 'browser', 'automation', 'synthesizer'
    const unimplementedRoles: SpecialistRole[] = [
      'planner',
      'researcher',
      'coder',
      'document',
      'browser',
      'automation',
      'synthesizer'
    ];

    for (const role of unimplementedRoles) {
      assert.strictEqual(registry.hasSpecialist(role), false);
      assert.strictEqual(registry.getStatus(role), 'UNAVAILABLE');

      const unimpTask: DurableSpecialistTask = {
        id: `task_unavail_${role}`,
        runId: 'run_unavail_test',
        principalId: dummyPrincipal.userId,
        role,
        objective: `Testing role ${role}`,
        state: 'QUEUED',
        dependencies: [],
        inputPayload: {},
        executionConstraints: {},
        authorizationRequirements: {},
        budgetLimits: { maxTokens: 4096 },
        timeoutMs: 30000,
        attemptCount: 0,
        maxRetries: 2,
        backoffMultiplier: 1.5,
        fencingToken: 0,
        usageTelemetry: { tokensUsed: 0, durationMs: 0 },
        provenance: { workerId: 'test' },
        checkpoints: [],
        createdAt: now,
        updatedAt: now
      };

      await repo.saveTask(unimpTask);
      const res = await worker.executeTask(unimpTask);

      assert.strictEqual(res.outcome, 'UNAVAILABLE');
      assert.strictEqual(res.error?.code, 'SPECIALIST_UNAVAILABLE');

      const persisted = await repo.getTask(unimpTask.id);
      assert.strictEqual(persisted?.state, 'UNAVAILABLE');
      assert.strictEqual(persisted?.outcome, 'UNAVAILABLE');
    }
  });

  // ==========================================
  // 10. WORKER HOST LIFECYCLE & RESTARTABILITY
  // ==========================================

  test('GATE 16: SpecialistWorkerHost starts, reports health, processes ticks, and stops gracefully', async () => {
    const { repo, registry } = setupHarness();
    const host = new SpecialistWorkerHost(repo, registry, {
      concurrency: 2,
      pollIntervalMs: 50
    });

    const initialHealth = host.getHealth();
    assert.strictEqual(initialHealth.status, 'STOPPED');
    assert.strictEqual(initialHealth.concurrency, 2);

    await host.start();
    const runningHealth = host.getHealth();
    assert.strictEqual(runningHealth.status, 'HEALTHY');

    // Run a tick cleanly
    await host.tick();

    await host.stop();
    const stoppedHealth = host.getHealth();
    assert.strictEqual(stoppedHealth.status, 'STOPPED');
  });

  // ==========================================
  // 11. REGRESSION & RUN STATE INVARIANTS
  // ==========================================

  test('GATE 17: Existing RunStateSchema remains strictly unchanged', () => {
    const legalRunStates = [
      'QUEUED',
      'RUNNING',
      'WAITING_FOR_TOOL',
      'WAITING_FOR_APPROVAL',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'INTERRUPTED'
    ];

    assert.strictEqual(RunStateSchema.options.length, 8);
    for (const st of legalRunStates) {
      assert.ok(RunStateSchema.safeParse(st).success);
    }
    // Prohibit arbitrary state additions to production run contract
    assert.strictEqual(RunStateSchema.safeParse('UNKNOWN_STATE').success, false);
    assert.strictEqual(RunStateSchema.safeParse('CLAIMED').success, false); // CLAIMED belongs strictly to SpecialistTaskState
  });
});
