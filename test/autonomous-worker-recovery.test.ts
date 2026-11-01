import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutonomousAgentEngine,
  InMemoryAutonomousTaskRepository,
  PostgresAutonomousTaskRepository,
  createAutonomousSpecialistRegistry
} from '../packages/agent-runtime/src/index.js';
import { ExecutionPrincipal, AutonomousTaskState } from '../packages/contracts/src/index.js';
import { ToolGateway } from '../packages/tool-runtime/src/index.js';

test('Mission A — Autonomous Execution Durability, Fencing Tokens, and Crash Recovery', async (t) => {
  const principalA: ExecutionPrincipal = {
    userId: 'user_mission_a',
    sessionId: 'session_primary',
    workspaceId: 'ws_tenant_alpha',
    scopes: ['*']
  };

  const principalB: ExecutionPrincipal = {
    userId: 'user_mission_b',
    sessionId: 'session_secondary',
    workspaceId: 'ws_tenant_beta',
    scopes: ['*']
  };

  const toolGateway = new ToolGateway();
  const specialistRegistry = createAutonomousSpecialistRegistry(toolGateway);

  await t.test('1. Idempotent Task Creation & Cross-Tenant Isolation', async () => {
    const repo = new InMemoryAutonomousTaskRepository();
    const engine = new AutonomousAgentEngine({ repository: repo, specialistRegistry });

    // Task 1 with idempotency key
    const task1 = await engine.createTask(
      'Analyze quarterly growth telemetry',
      principalA,
      undefined,
      'idem_quarterly_growth_2026'
    );
    assert.ok(task1.taskId);
    assert.equal(task1.idempotencyKey, 'idem_quarterly_growth_2026');

    // Attempt duplicate submission with same idempotency key for same principal
    const taskDuplicate = await engine.createTask(
      'Duplicate objective text ignored',
      principalA,
      undefined,
      'idem_quarterly_growth_2026'
    );
    assert.equal(taskDuplicate.taskId, task1.taskId, 'Idempotent creation must return existing task ID');

    // Different tenant with same idempotency key creates a separate task (tenant boundary)
    const taskTenantB = await engine.createTask(
      'Tenant B isolated objective',
      principalB,
      undefined,
      'idem_quarterly_growth_2026'
    );
    assert.notEqual(taskTenantB.taskId, task1.taskId, 'Tenant B must receive independent task');

    // Verify tenant list isolation
    const listA = await repo.listTasksByPrincipal(principalA.userId);
    assert.equal(listA.length, 1);
    assert.equal(listA[0].taskId, task1.taskId);

    const listB = await repo.listTasksByPrincipal(principalB.userId);
    assert.equal(listB.length, 1);
    assert.equal(listB[0].taskId, taskTenantB.taskId);
  });

  await t.test('2. Atomic State Transitions & Monotonic Fencing Token Enforcement', async () => {
    const repo = new InMemoryAutonomousTaskRepository();
    const engine = new AutonomousAgentEngine({ repository: repo, specialistRegistry });

    const task = await engine.createTask('State transition audit', principalA);
    assert.equal(task.state, 'CREATED');
    assert.equal(task.fencingToken, 0);

    // Transition 1: CREATED -> PLANNING
    const updated1 = await repo.updateState(task.taskId, 'PLANNING', 'Start planning');
    assert.equal(updated1.state, 'PLANNING');
    assert.equal(updated1.fencingToken, 1);

    // Transition 2: PLANNING -> READY
    const updated2 = await repo.updateState(task.taskId, 'READY', 'Plan ready');
    assert.equal(updated2.state, 'READY');
    assert.equal(updated2.fencingToken, 2);

    // Stale fencing token rejection: trying to update using expected fencing token 1 when it is at 2
    await assert.rejects(
      async () => {
        await repo.updateState(task.taskId, 'RUNNING', 'Stale worker attempting transition', undefined, 1);
      },
      /STALE_FENCING_TOKEN/,
      'Stale worker with outdated fencing token must be rejected'
    );

    // Valid fencing token transition: expected 2 -> updates to RUNNING with token 3
    const updated3 = await repo.updateState(task.taskId, 'RUNNING', 'Valid worker', undefined, 2);
    assert.equal(updated3.state, 'RUNNING');
    assert.equal(updated3.fencingToken, 3);

    // Illegal state transition: RUNNING -> CREATED is not allowed
    await assert.rejects(
      async () => {
        await repo.updateState(task.taskId, 'CREATED' as AutonomousTaskState, 'Illegal backwards transition');
      },
      /Illegal autonomous state transition/,
      'Backwards or illegal transitions must fail closed'
    );
  });

  await t.test('3. Worker Crash Mid-Flight and Resumption Without Duplicate Side Effects', async () => {
    // Shared durable repository between worker 1 and worker 2
    const sharedRepo = new InMemoryAutonomousTaskRepository();

    // 1. Worker 1 starts the task
    const worker1Engine = new AutonomousAgentEngine({ repository: sharedRepo, specialistRegistry });
    const task = await worker1Engine.createTask('Durable workflow with worker failure', principalA);

    // Custom 3-step plan: Step 1 (READ), Step 2 (READ), Step 3 (READ)
    const customPlan = {
      planId: `plan_${task.taskId}`,
      objective: task.objective,
      estimatedWaves: 2,
      maxBudgetTokens: 16000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 'step_alpha',
          title: 'Initial Fact Extraction',
          description: 'Extract system facts',
          role: 'researcher' as const,
          dependencies: [],
          suggestedTools: ['web_search'],
          sideEffectLevel: 'NONE' as const,
          status: 'COMPLETED' as const, // Already completed by worker 1 before crash!
          resultSummary: 'Completed fact extraction successfully.',
          startedAt: Date.now() - 5000,
          completedAt: Date.now() - 4000
        },
        {
          stepId: 'step_beta',
          title: 'Core Synthesis',
          description: 'Synthesize findings',
          role: 'coder' as const,
          dependencies: ['step_alpha'],
          suggestedTools: ['calculator'],
          sideEffectLevel: 'NONE' as const,
          status: 'PENDING' as const
        },
        {
          stepId: 'step_gamma',
          title: 'Verification & Quality Check',
          description: 'Verify outputs',
          role: 'verifier' as const,
          dependencies: ['step_beta'],
          suggestedTools: ['calculator'],
          sideEffectLevel: 'NONE' as const,
          status: 'PENDING' as const
        }
      ]
    };

    task.plan = customPlan;
    task.state = 'RUNNING';
    task.observations.push({
      observationId: 'obs_alpha_01',
      stepId: 'step_alpha',
      source: 'specialist',
      sourceName: 'Researcher Specialist',
      summary: 'Completed fact extraction successfully.',
      timestamp: Date.now() - 4000
    });
    // Worker 1 was leased
    task.leaseOwner = 'worker_node_1';
    task.leaseExpiresAt = Date.now() - 1000; // Lease expired because worker 1 crashed
    await sharedRepo.createTask(task);

    // Verify task is identified as recoverable
    const recoverable = await sharedRepo.findRecoverableTasks(Date.now());
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].taskId, task.taskId);

    // 2. Worker 2 boots up and resumes the task
    const worker2Engine = new AutonomousAgentEngine({ repository: sharedRepo, specialistRegistry });
    let completedObsEmitted = 0;
    worker2Engine.on('task.step_started', (evt) => {
      // Step alpha should NEVER be started again
      assert.notEqual(evt.stepId, 'step_alpha', 'Step alpha was already completed and must NOT be re-executed');
    });
    worker2Engine.on('task.step_completed', () => {
      completedObsEmitted++;
    });

    const recovered = await worker2Engine.recoverTask(task.taskId, 'worker_node_2');
    assert.ok(recovered);

    // Wait for worker 2 to complete remaining steps (beta and gamma)
    await new Promise(resolve => setTimeout(resolve, 800));

    const finalTask = await sharedRepo.getTask(task.taskId);
    assert.ok(finalTask);
    assert.equal(finalTask.state, 'COMPLETED');
    assert.ok(finalTask.plan);

    // Confirm Step 1 was not duplicated
    const stepAlpha = finalTask.plan.steps.find(s => s.stepId === 'step_alpha');
    assert.equal(stepAlpha?.status, 'COMPLETED');
    assert.equal(stepAlpha?.resultSummary, 'Completed fact extraction successfully.');

    // Confirm Step 2 and Step 3 completed successfully
    const stepBeta = finalTask.plan.steps.find(s => s.stepId === 'step_beta');
    const stepGamma = finalTask.plan.steps.find(s => s.stepId === 'step_gamma');
    assert.equal(stepBeta?.status, 'COMPLETED');
    assert.equal(stepGamma?.status, 'COMPLETED');

    // Confirm execution history recorded recovery
    const historyStates = finalTask.executionHistory.map(h => h.state);
    assert.ok(historyStates.includes('RESUMING'), 'Execution history must record RESUMING checkpoint');
    assert.ok(historyStates.includes('COMPLETED'), 'Execution history must record COMPLETED checkpoint');
  });

  await t.test('4. PostgresAutonomousTaskRepository Fallback & Contract Conformity', async () => {
    const pgRepo = new PostgresAutonomousTaskRepository();
    const task = await pgRepo.createTask({
      taskId: 'autotask_pg_compat_01',
      principal: principalA,
      objective: 'PostgreSQL contract validation',
      state: 'CREATED',
      observations: [],
      artifacts: [],
      executionHistory: [{ state: 'CREATED', timestamp: Date.now() }],
      fencingToken: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    assert.equal(task.taskId, 'autotask_pg_compat_01');
    const fetched = await pgRepo.getTask('autotask_pg_compat_01');
    assert.ok(fetched);
    assert.equal(fetched.objective, 'PostgreSQL contract validation');

    // Claim lease
    const claim = await pgRepo.claimTask('autotask_pg_compat_01', 'worker_pg_test', 30000);
    assert.equal(claim.success, true);
    assert.equal(claim.task?.leaseOwner, 'worker_pg_test');
  });
});
