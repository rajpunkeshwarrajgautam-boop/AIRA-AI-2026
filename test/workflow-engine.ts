import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  WorkflowDefinition,
  validateWorkflowDag,
  ExecutionPrincipal,
  Run,
  RunSchema
} from '../packages/contracts/src/index.js';
import { PostgresWorkflowRepository } from '../packages/agent-runtime/src/workflow-repositories.js';
import { PostgresRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { WorkflowEngine } from '../packages/agent-runtime/src/workflow-engine.js';
import { WorkflowCompiler } from '../packages/agent-runtime/src/workflow-compiler.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { PostgresApprovalRepository, PostgresSessionGrantRepository } from '../packages/approvals/src/repositories.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ModelRouter } from '../packages/model-router/src/index.js';
import { CapabilityRegistry } from '../packages/agent-runtime/src/registry.js';
import { ServerIntentRouter } from '../packages/agent-runtime/src/router.js';
import { PostgresWorkspaceAuthorityRepository } from '../packages/agent-runtime/src/workspace-authority.js';

async function main() {
  console.log('================================================================');
  console.log(' AIRA-AI-2026 — WORKFLOW EXECUTION ENGINE CERTIFICATION SUITE   ');
  console.log('================================================================\n');

  const workflowRepo = new PostgresWorkflowRepository();
  const runRepo = new PostgresRunRepository();
  const approvalKernel = new ApprovalKernel(
    new PostgresApprovalRepository(),
    new PostgresSessionGrantRepository()
  );
  const toolRegistry = new ToolRegistry(process.cwd());
  const modelRouter = new ModelRouter();

  const engine = new WorkflowEngine(
    workflowRepo,
    runRepo,
    approvalKernel,
    toolRegistry,
    modelRouter,
    process.cwd()
  );

  const compiler = new WorkflowCompiler(modelRouter);

  const workspaceAuthorities = new PostgresWorkspaceAuthorityRepository();
  const userAId = `usr_cert_alice_${randomUUID()}`;
  const userBId = `usr_cert_bob_${randomUUID()}`;
  const [userAWorkspaceId, userBWorkspaceId] = await Promise.all([
    workspaceAuthorities.resolveWorkspace(userAId),
    workspaceAuthorities.resolveWorkspace(userBId)
  ]);

  const userA: ExecutionPrincipal = {
    userId: userAId,
    sessionId: `sess_cert_alice_${randomUUID()}`,
    workspaceId: userAWorkspaceId,
    roles: ['member']
  };

  const userB: ExecutionPrincipal = {
    userId: userBId,
    sessionId: `sess_cert_bob_${randomUUID()}`,
    workspaceId: userBWorkspaceId,
    roles: ['member']
  };
  assert.strictEqual(await workspaceAuthorities.isWorkspaceActive(userA.userId, userA.workspaceId!), true);
  assert.strictEqual(await workspaceAuthorities.isWorkspaceActive(userB.userId, userB.workspaceId!), true);

  // Helper to create a dummy Run in runRepo
  async function createAiraRun(principal: ExecutionPrincipal, prompt: string): Promise<Run> {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const run: Run = RunSchema.parse({
      id: runId,
      principalId: principal.userId,
      sessionId: principal.sessionId,
      workspaceId: principal.workspaceId,
      intent: 'WORKFLOW',
      state: 'RUNNING',
      modelPolicy: { model: 'mock-deterministic' },
      prompt,
      content: '',
      thinking: '',
      toolsUsed: [],
      toolCalls: [],
      toolResults: [],
      artifacts: [],
      citations: [],
      stepCount: 0,
      createdAt: now,
      updatedAt: now
    });
    await runRepo.saveRun(run);
    return run;
  }

  // --------------------------------------------------------------------------
  // DAG INTEGRITY & TOPOLOGY VALIDATION
  // --------------------------------------------------------------------------
  console.log('--- SECTION 1: DAG INTEGRITY & TOPOLOGY VALIDATION ---');

  // Test 1.1: Reject Duplicate Step IDs
  {
    const badDef: any = {
      workflowId: 'wf_bad_dupe',
      version: 1,
      name: 'Duplicate Steps',
      steps: [
        { stepId: 'step_1', name: 'Step 1', dependsOn: [] },
        { stepId: 'step_1', name: 'Step 1 Duplicate', dependsOn: [] }
      ]
    };
    const res = validateWorkflowDag(badDef);
    assert.strictEqual(res.valid, false);
    assert.ok(res.error?.includes('Duplicate step ID'));
    console.log('PASS: Rejected duplicate step ID in DAG');
  }

  // Test 1.2: Reject Self-Dependency
  {
    const badDef: any = {
      workflowId: 'wf_bad_self',
      version: 1,
      name: 'Self Dependency',
      steps: [
        { stepId: 'step_a', name: 'Step A', dependsOn: ['step_a'] }
      ]
    };
    const res = validateWorkflowDag(badDef);
    assert.strictEqual(res.valid, false);
    assert.ok(res.error?.includes('cannot depend on itself'));
    console.log('PASS: Rejected self-dependency in DAG');
  }

  // Test 1.3: Reject Non-Existent Dependency
  {
    const badDef: any = {
      workflowId: 'wf_bad_ghost',
      version: 1,
      name: 'Ghost Dependency',
      steps: [
        { stepId: 'step_a', name: 'Step A', dependsOn: ['ghost_step'] }
      ]
    };
    const res = validateWorkflowDag(badDef);
    assert.strictEqual(res.valid, false);
    assert.ok(res.error?.includes('depends on non-existent step'));
    console.log('PASS: Rejected ghost dependency in DAG');
  }

  // Test 1.4: Reject Cyclic Dependency Graph
  {
    const cyclicDef: any = {
      workflowId: 'wf_bad_cycle',
      version: 1,
      name: 'Cyclic Graph',
      steps: [
        { stepId: 'step_a', name: 'Step A', dependsOn: ['step_c'] },
        { stepId: 'step_b', name: 'Step B', dependsOn: ['step_a'] },
        { stepId: 'step_c', name: 'Step C', dependsOn: ['step_b'] }
      ]
    };
    const res = validateWorkflowDag(cyclicDef);
    assert.strictEqual(res.valid, false);
    assert.ok(res.error?.includes('Cycle detected'));
    console.log('PASS: Rejected cyclic dependency graph');
  }

  // Test 1.5: Valid Diamond DAG execution wave calculation
  {
    const diamondDef: any = {
      workflowId: 'wf_diamond',
      version: 1,
      name: 'Diamond DAG',
      steps: [
        { stepId: 'step_init', name: 'Init', dependsOn: [] },
        { stepId: 'step_left', name: 'Branch Left', dependsOn: ['step_init'] },
        { stepId: 'step_right', name: 'Branch Right', dependsOn: ['step_init'] },
        { stepId: 'step_join', name: 'Join Branches', dependsOn: ['step_left', 'step_right'] }
      ]
    };
    const res = validateWorkflowDag(diamondDef);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.executionWaves?.length, 3);
    assert.deepStrictEqual(res.executionWaves[0], ['step_init']);
    assert.ok(res.executionWaves[1].includes('step_left') && res.executionWaves[1].includes('step_right'));
    assert.deepStrictEqual(res.executionWaves[2], ['step_join']);
    console.log('PASS: Validated diamond DAG with correct parallel execution waves');
  }

  // --------------------------------------------------------------------------
  // TEST A: LINEAR DAG EXECUTION (A -> B -> C)
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 2: TEST A — LINEAR DAG EXECUTION (A -> B -> C) ---');
  {
    const airaRun = await createAiraRun(userA, 'Execute linear workflow');
    const linearDef: WorkflowDefinition = {
      workflowId: `wf_linear_${Date.now()}`,
      version: 1,
      name: 'Linear Pipeline',
      principalId: userA.userId,
      inputSchema: {},
      steps: [
        {
          stepId: 'step_a',
          name: 'Stage 1: Extract',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: [],
          input: { value: 10 },
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        },
        {
          stepId: 'step_b',
          name: 'Stage 2: Transform',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: ['step_a'],
          input: { multiplier: 2 },
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        },
        {
          stepId: 'step_c',
          name: 'Stage 3: Load',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: ['step_b'],
          input: { target: 'database' },
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        }
      ],
      executionPolicy: { maxConcurrentSteps: 2, timeoutMs: 60000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const wfRun = await engine.createWorkflowRun(linearDef, airaRun, userA);
    assert.strictEqual(wfRun.state, 'CREATED');
    assert.strictEqual(wfRun.stepStates['step_a'], 'PENDING');

    await engine.executeWorkflowRun(wfRun.id);

    const completedRun = await workflowRepo.getWorkflowRun(wfRun.id);
    assert.strictEqual(completedRun?.state, 'COMPLETED');
    assert.strictEqual(completedRun?.stepStates['step_a'], 'COMPLETED');
    assert.strictEqual(completedRun?.stepStates['step_b'], 'COMPLETED');
    assert.strictEqual(completedRun?.stepStates['step_c'], 'COMPLETED');
    assert.ok(completedRun?.artifacts.length > 0, 'Artifact report was produced');

    const steps = await workflowRepo.getWorkflowSteps(wfRun.id);
    assert.strictEqual(steps.length, 3);
    assert.ok(steps[0].completedAt! <= steps[1].startedAt!, 'Step A completed before Step B started');
    assert.ok(steps[1].completedAt! <= steps[2].startedAt!, 'Step B completed before Step C started');
    console.log('PASS: Linear DAG (A -> B -> C) executed with strict sequential ordering');
  }

  // --------------------------------------------------------------------------
  // TEST B: PARALLEL EXECUTION (A -> B, A -> C, B+C -> D)
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 3: TEST B — PARALLEL EXECUTION WITH JOIN (A -> B, A -> C, B+C -> D) ---');
  {
    const airaRun = await createAiraRun(userA, 'Execute parallel diamond workflow');
    const parallelDef: WorkflowDefinition = {
      workflowId: `wf_parallel_${Date.now()}`,
      version: 1,
      name: 'Diamond Parallel Workflow',
      principalId: userA.userId,
      inputSchema: {},
      steps: [
        {
          stepId: 'step_root',
          name: 'Root Task',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: [],
          input: { base: 'data' },
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        },
        {
          stepId: 'step_parallel_1',
          name: 'Parallel Branch 1',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: ['step_root'],
          input: { branch: 1 },
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        },
        {
          stepId: 'step_parallel_2',
          name: 'Parallel Branch 2',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: ['step_root'],
          input: { branch: 2 },
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        },
        {
          stepId: 'step_join',
          name: 'Join Task',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: ['step_parallel_1', 'step_parallel_2'],
          input: { summary: 'combine' },
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        }
      ],
      executionPolicy: { maxConcurrentSteps: 3, timeoutMs: 60000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const wfRun = await engine.createWorkflowRun(parallelDef, airaRun, userA);
    await engine.executeWorkflowRun(wfRun.id);

    const completed = await workflowRepo.getWorkflowRun(wfRun.id);
    assert.strictEqual(completed?.state, 'COMPLETED');
    assert.strictEqual(completed?.stepStates['step_root'], 'COMPLETED');
    assert.strictEqual(completed?.stepStates['step_parallel_1'], 'COMPLETED');
    assert.strictEqual(completed?.stepStates['step_parallel_2'], 'COMPLETED');
    assert.strictEqual(completed?.stepStates['step_join'], 'COMPLETED');

    const steps = await workflowRepo.getWorkflowSteps(wfRun.id);
    const p1 = steps.find(s => s.stepId === 'step_parallel_1')!;
    const p2 = steps.find(s => s.stepId === 'step_parallel_2')!;
    const join = steps.find(s => s.stepId === 'step_join')!;

    assert.ok(p1.completedAt! <= join.startedAt!, 'Join waited for parallel branch 1');
    assert.ok(p2.completedAt! <= join.startedAt!, 'Join waited for parallel branch 2');
    console.log('PASS: Parallel execution succeeded and join step waited for all dependencies');
  }

  // --------------------------------------------------------------------------
  // TEST C: RETRY ON TRANSIENT ERRORS
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 4: TEST C — RETRY WITH BACKOFF ON TRANSIENT ERRORS ---');
  {
    // Register a flaky test tool in ToolRegistry
    let callCount = 0;
    toolRegistry.register({
      definition: {
        id: 'tool_flaky',
        name: 'tool_flaky',
        description: 'Fails once with transient error then succeeds',
        version: '1.0.0',
        runtime: 'LOCAL',
        permissionLevel: 'READ',
        idempotencyClass: 'SAFE_READ',
        parameters: { type: 'object', properties: {} }
      },
      execute: async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('429 Rate Limit Exceeded - Transient upstream congestion');
        }
        return { success: true, attempts: callCount };
      }
    });

    const airaRun = await createAiraRun(userA, 'Retry transient failure');
    const retryDef: WorkflowDefinition = {
      workflowId: `wf_retry_${Date.now()}`,
      version: 1,
      name: 'Retry Verification',
      principalId: userA.userId,
      inputSchema: {},
      steps: [
        {
          stepId: 'step_flaky',
          name: 'Flaky Step',
          type: 'TOOL',
          toolName: 'tool_flaky',
          dependsOn: [],
          input: {},
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 3, backoffMs: 100, factor: 1.5 }
        }
      ],
      executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 30000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const wfRun = await engine.createWorkflowRun(retryDef, airaRun, userA);
    await engine.executeWorkflowRun(wfRun.id);

    const completed = await workflowRepo.getWorkflowRun(wfRun.id);
    assert.strictEqual(completed?.state, 'COMPLETED');
    assert.strictEqual(completed?.stepStates['step_flaky'], 'COMPLETED');
    assert.strictEqual(completed?.stepAttempts['step_flaky'], 2, 'Step attempted exactly twice before succeeding');
    console.log('PASS: Transient error retried with backoff and succeeded on attempt 2');
  }

  // --------------------------------------------------------------------------
  // TEST D: NON-RETRYABLE FAILURE
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 5: TEST D — IMMEDIATE FAILURE ON NON-RETRYABLE ERROR ---');
  {
    toolRegistry.register({
      definition: {
        id: 'tool_access_denied',
        name: 'tool_access_denied',
        description: 'Permanently forbidden',
        version: '1.0.0',
        runtime: 'LOCAL',
        permissionLevel: 'READ',
        idempotencyClass: 'SAFE_READ',
        parameters: { type: 'object', properties: {} }
      },
      execute: async () => {
        throw new Error('Access denied: security constraint violation');
      }
    });

    const airaRun = await createAiraRun(userA, 'Non retryable test');
    const failDef: WorkflowDefinition = {
      workflowId: `wf_non_retry_${Date.now()}`,
      version: 1,
      name: 'Non Retryable Test',
      principalId: userA.userId,
      inputSchema: {},
      steps: [
        {
          stepId: 'step_deny',
          name: 'Access Denied Step',
          type: 'TOOL',
          toolName: 'tool_access_denied',
          dependsOn: [],
          input: {},
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 5, backoffMs: 100, factor: 2 }
        }
      ],
      executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 30000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const wfRun = await engine.createWorkflowRun(failDef, airaRun, userA);
    await engine.executeWorkflowRun(wfRun.id);

    const failedRun = await workflowRepo.getWorkflowRun(wfRun.id);
    assert.strictEqual(failedRun?.state, 'FAILED');
    assert.strictEqual(failedRun?.stepStates['step_deny'], 'FAILED');
    assert.strictEqual(failedRun?.stepAttempts['step_deny'], 1, 'Did not burn retries on Access denied');
    console.log('PASS: Non-retryable error failed immediately on attempt 1 without redundant retries');
  }

  // --------------------------------------------------------------------------
  // TEST E: APPROVAL CHECKPOINT (PAUSE, REJECT, APPROVE & RESUME)
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 6: TEST E — APPROVAL CHECKPOINT & RESUMPTION ---');
  {
    // Part E1: Rejection pauses and fails workflow
    const run1 = await createAiraRun(userA, 'Approval Reject Test');
    const rejectDef: WorkflowDefinition = {
      workflowId: `wf_appr_rej_${Date.now()}`,
      version: 1,
      name: 'Approval Reject Test',
      principalId: userA.userId,
      inputSchema: {},
      steps: [
        {
          stepId: 'step_destructive',
          name: 'Format Database Table',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: [],
          input: { command: 'drop table obsolete_logs' },
          sideEffectLevel: 'DESTRUCTIVE',
          approvalRequired: true,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        }
      ],
      executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 30000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const wfRun1 = await engine.createWorkflowRun(rejectDef, run1, userA);
    await engine.executeWorkflowRun(wfRun1.id);

    const parentRun1 = await runRepo.getRun(run1.id);
    assert.strictEqual(parentRun1?.principalId, userA.userId);
    assert.strictEqual(parentRun1?.workspaceId, userA.workspaceId);
    const pendingApproval1 = await approvalKernel.getPendingForRun(run1.id);
    assert.strictEqual(pendingApproval1.length, 1);
    assert.strictEqual(pendingApproval1[0].runId, run1.id);
    assert.strictEqual(pendingApproval1[0].workspaceId, userA.workspaceId);

    let paused1 = await workflowRepo.getWorkflowRun(wfRun1.id);
    assert.strictEqual(paused1?.state, 'WAITING_FOR_APPROVAL');
    assert.strictEqual(paused1?.pendingApprovalStepId, 'step_destructive');
    console.log('PASS: Destructive step paused in WAITING_FOR_APPROVAL state');

    // Reject approval
    await engine.resolveStepApproval(wfRun1.id, 'step_destructive', 'REJECTED', userA);
    const rejected1 = await workflowRepo.getWorkflowRun(wfRun1.id);
    assert.strictEqual(rejected1?.state, 'FAILED');
    assert.strictEqual(rejected1?.stepStates['step_destructive'], 'FAILED');
    assert.strictEqual(Object.hasOwn(rejected1?.stepOutputs ?? {}, 'step_destructive'), false);
    console.log('PASS: Explicit rejection cleanly transitioned workflow to FAILED');

    // Part E2: Approval resumes and completes workflow
    const run2 = await createAiraRun(userA, 'Approval Accept Test');
    const acceptDef: WorkflowDefinition = {
      workflowId: `wf_appr_acc_${Date.now()}`,
      version: 1,
      name: 'Approval Accept Test',
      principalId: userA.userId,
      inputSchema: {},
      steps: [
        {
          stepId: 'step_guarded',
          name: 'Guarded Mutation',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: [],
          input: { command: 'rotate security credentials' },
          sideEffectLevel: 'DESTRUCTIVE',
          approvalRequired: true,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        }
      ],
      executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 30000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const wfRun2 = await engine.createWorkflowRun(acceptDef, run2, userA);
    await engine.executeWorkflowRun(wfRun2.id);

    let paused2 = await workflowRepo.getWorkflowRun(wfRun2.id);
    assert.strictEqual(paused2?.state, 'WAITING_FOR_APPROVAL');

    // Grant approval and verify resumption
    await engine.resolveStepApproval(wfRun2.id, 'step_guarded', 'APPROVED', userA);

    // Wait for async resumed execution to reach terminal state
    let resumed2 = await workflowRepo.getWorkflowRun(wfRun2.id);
    for (let i = 0; i < 30; i++) {
      if (resumed2?.state === 'COMPLETED') break;
      await new Promise(r => setTimeout(r, 200));
      resumed2 = await workflowRepo.getWorkflowRun(wfRun2.id);
    }

    assert.strictEqual(resumed2?.state, 'COMPLETED');
    assert.strictEqual(resumed2?.stepStates['step_guarded'], 'COMPLETED');
    console.log('PASS: Authenticated user approval resumed workflow to COMPLETED');
  }

  // --------------------------------------------------------------------------
  // TEST F: CRASH RECOVERY & WORKER LEASE RECONCILIATION
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 7: TEST F — CRASH RECOVERY & LEASE RECONCILIATION ---');
  {
    const run = await createAiraRun(userA, 'Recovery Simulation');
    const recDef: WorkflowDefinition = {
      workflowId: `wf_rec_${Date.now()}`,
      version: 1,
      name: 'Recovery Test',
      principalId: userA.userId,
      inputSchema: {},
      steps: [
        {
          stepId: 'step_done',
          name: 'Pre-crash step',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: [],
          input: {},
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        },
        {
          stepId: 'step_todo',
          name: 'Post-crash step',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: ['step_done'],
          input: {},
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        }
      ],
      executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 30000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const wfRun = await engine.createWorkflowRun(recDef, run, userA);

    // Simulate crash after step 1 completed while step 2 was still PENDING
    wfRun.state = 'RUNNING';
    wfRun.stepStates['step_done'] = 'COMPLETED';
    wfRun.stepOutputs['step_done'] = { preCrash: true };
    await workflowRepo.saveWorkflowRun(wfRun);

    // Claim lease by worker
    const claimed = await workflowRepo.claimWorkflowRun(wfRun.id, 'worker_node_alpha', 10000);
    assert.strictEqual(claimed, true, 'Worker node claimed recovery lease');

    // Worker node resumes execution
    await engine.executeWorkflowRun(wfRun.id);

    const recovered = await workflowRepo.getWorkflowRun(wfRun.id);
    assert.strictEqual(recovered?.state, 'COMPLETED');
    assert.strictEqual(recovered?.stepStates['step_done'], 'COMPLETED');
    assert.strictEqual(recovered?.stepStates['step_todo'], 'COMPLETED');
    assert.deepStrictEqual(recovered?.stepOutputs['step_done'], { preCrash: true });
    console.log('PASS: Interrupted workflow recovered with lease protection and completed unfinished step');
  }

  // --------------------------------------------------------------------------
  // TEST G: CANCELLATION
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 8: TEST G — CANCELLATION STOPS FUTURE STEPS ---');
  {
    const run = await createAiraRun(userA, 'Cancel Test');
    const cancelDef: WorkflowDefinition = {
      workflowId: `wf_canc_${Date.now()}`,
      version: 1,
      name: 'Cancellation Test',
      principalId: userA.userId,
      inputSchema: {},
      steps: [
        {
          stepId: 'step_paused',
          name: 'Paused Step',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: [],
          input: {},
          sideEffectLevel: 'DESTRUCTIVE',
          approvalRequired: true,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        },
        {
          stepId: 'step_never_run',
          name: 'Downstream Step',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: ['step_paused'],
          input: {},
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        }
      ],
      executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 30000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const wfRun = await engine.createWorkflowRun(cancelDef, run, userA);
    await engine.executeWorkflowRun(wfRun.id);

    // Cancel while paused
    const cancelled = await engine.cancelWorkflow(wfRun.id, userA);
    assert.strictEqual(cancelled, true);

    const cancelResult = await workflowRepo.getWorkflowRun(wfRun.id);
    assert.strictEqual(cancelResult?.state, 'CANCELLED');
    assert.strictEqual(cancelResult?.stepStates['step_paused'], 'CANCELLED');
    assert.strictEqual(cancelResult?.stepStates['step_never_run'], 'CANCELLED');
    console.log('PASS: Active workflow cancelled cleanly; pending downstream steps marked CANCELLED');
  }

  // --------------------------------------------------------------------------
  // TEST H: IDEMPOTENCY KEY ENFORCEMENT
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 9: TEST H — IDEMPOTENCY ENFORCEMENT ---');
  {
    let toolRuns = 0;
    toolRegistry.register({
      definition: {
        id: 'tool_idempotent_action',
        name: 'tool_idempotent_action',
        description: 'Side effect tool',
        version: '1.0.0',
        runtime: 'LOCAL',
        permissionLevel: 'WRITE',
        idempotencyClass: 'IDEMPOTENT_WRITE',
        parameters: { type: 'object', properties: {} }
      },
      execute: async () => {
        toolRuns++;
        return { executedCount: toolRuns };
      }
    });

    const idemKey = `idem_payment_${Date.now()}`;
    const run1 = await createAiraRun(userA, 'Idempotent Run 1');
    const def1: WorkflowDefinition = {
      workflowId: `wf_idem_1_${Date.now()}`,
      version: 1,
      name: 'Idempotency Run 1',
      principalId: userA.userId,
      inputSchema: {},
      steps: [
        {
          stepId: 'step_idem',
          name: 'Idempotent Task',
          type: 'TOOL',
          toolName: 'tool_idempotent_action',
          dependsOn: [],
          input: {},
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 },
          idempotencyKey: idemKey
        }
      ],
      executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 30000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const wfRun1 = await engine.createWorkflowRun(def1, run1, userA);
    await engine.executeWorkflowRun(wfRun1.id);
    assert.strictEqual(toolRuns, 1, 'First run invoked tool once');

    // Run 2 with the exact same idempotency key
    const run2 = await createAiraRun(userA, 'Idempotent Run 2');
    const def2: WorkflowDefinition = {
      workflowId: `wf_idem_2_${Date.now()}`,
      version: 1,
      name: 'Idempotency Run 2',
      principalId: userA.userId,
      inputSchema: {},
      steps: [
        {
          stepId: 'step_idem_replayed',
          name: 'Idempotent Task Replayed',
          type: 'TOOL',
          toolName: 'tool_idempotent_action',
          dependsOn: [],
          input: {},
          sideEffectLevel: 'NONE',
          approvalRequired: false,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 },
          idempotencyKey: idemKey
        }
      ],
      executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 30000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const wfRun2 = await engine.createWorkflowRun(def2, run2, userA);
    await engine.executeWorkflowRun(wfRun2.id);

    assert.strictEqual(toolRuns, 1, 'Second run did not re-execute tool (reused idempotency output)');
    const step2 = await workflowRepo.getStepByIdempotencyKey(idemKey);
    assert.strictEqual(step2?.state, 'COMPLETED');
    console.log('PASS: Idempotency key prevented duplicate side-effect invocation');
  }

  // --------------------------------------------------------------------------
  // SECURITY MATRIX (PHASE 19)
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 10: PHASE 19 SECURITY TEST MATRIX ---');

  // Test S1: Cross-user cancellation blocked
  {
    const run = await createAiraRun(userA, 'Security Isolation Run');
    const def: WorkflowDefinition = {
      workflowId: `wf_sec_${Date.now()}`,
      version: 1,
      name: 'Security Run',
      principalId: userA.userId,
      inputSchema: {},
      steps: [
        {
          stepId: 'step_wait',
          name: 'Wait',
          type: 'CAPABILITY',
          capability: 'ANSWER',
          dependsOn: [],
          input: {},
          sideEffectLevel: 'DESTRUCTIVE',
          approvalRequired: true,
          timeoutMs: 30000,
          retry: { maxAttempts: 1, backoffMs: 100, factor: 1 }
        }
      ],
      executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 30000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const wfRun = await engine.createWorkflowRun(def, run, userA);
    await engine.executeWorkflowRun(wfRun.id);

    // Bob tries to cancel Alice's workflow
    await assert.rejects(
      async () => {
        await engine.cancelWorkflow(wfRun.id, userB);
      },
      /Unauthorized/
    );
    console.log('PASS: Cross-user cancellation strictly rejected (User B blocked from User A)');

    // Bob tries to approve Alice's workflow step
    await assert.rejects(
      async () => {
        await engine.resolveStepApproval(wfRun.id, 'step_wait', 'APPROVED', userB);
      },
      /Unauthorized/
    );
    console.log('PASS: Cross-user step approval strictly rejected');
  }

  // Test S2: Client cannot downgrade sideEffectLevel
  {
    const registry = new CapabilityRegistry();
    const router = new ServerIntentRouter(registry);

    const spoofDecision = await router.route({
      prompt: 'drop database production; rm -rf /var/data',
      advisoryIntent: 'ANSWER',
      principal: userA
    });

    assert.strictEqual(spoofDecision.sideEffectLevel, 'DESTRUCTIVE');
    assert.strictEqual(spoofDecision.approvalRequired, true);
    console.log('PASS: Client advisory intent cannot downgrade server DESTRUCTIVE policy');
  }

  // --------------------------------------------------------------------------
  // NATURAL LANGUAGE WORKFLOW COMPILER (PHASE 16)
  // --------------------------------------------------------------------------
  console.log('\n--- SECTION 11: NATURAL LANGUAGE WORKFLOW COMPILATION ---');
  {
    const nlPrompt = 'Research the latest solid-state battery developments, summarize the five most important findings, and create a final report.';
    const compiled = await compiler.compile(nlPrompt, userA);

    assert.strictEqual(compiled.steps.length, 3);
    assert.strictEqual(compiled.steps[0].stepId, 'step_1_research');
    assert.strictEqual(compiled.steps[0].capability, 'RESEARCH');
    assert.deepStrictEqual(compiled.steps[0].dependsOn, []);

    assert.strictEqual(compiled.steps[1].stepId, 'step_2_extract_findings');
    assert.deepStrictEqual(compiled.steps[1].dependsOn, ['step_1_research']);

    assert.strictEqual(compiled.steps[2].stepId, 'step_3_final_report');
    assert.deepStrictEqual(compiled.steps[2].dependsOn, ['step_2_extract_findings']);

    const validDag = validateWorkflowDag(compiled);
    assert.strictEqual(validDag.valid, true);
    console.log('PASS: Compiled natural language pipeline into certified 3-step DAG (research -> extract -> report)');
  }

  console.log('\n================================================================');
  console.log(' ALL WORKFLOW ENGINE TESTS COMPLETED WITH 100% PASS RATE!        ');
  console.log('================================================================\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\nWORKFLOW TEST SUITE FAILED:', err);
  process.exit(1);
});
