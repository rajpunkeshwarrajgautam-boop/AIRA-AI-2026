import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalDecisionSchema, type ApprovalDecision, type ApprovalRequest, type ExecutionPrincipal, type Run, type WorkflowRun } from '../packages/contracts/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { WorkflowEngine } from '../packages/agent-runtime/src/workflow-engine.js';
import { InMemoryToolCallRepository, ToolGateway } from '../packages/tool-runtime/src/index.js';
import type { ToolDefinition } from '../packages/contracts/src/index.js';

const owner: ExecutionPrincipal = {
  userId: 'approval_lifecycle_owner',
  sessionId: 'approval_lifecycle_session',
  role: 'user'
};
const runId = 'run_approval_lifecycle_1';
const workflowId = 'workflow_approval_lifecycle_1';
const stepId = 'step_approval_lifecycle_1';

function createKernelHarness() {
  const requests = new Map<string, ApprovalRequest>();
  const decisions: Array<{ id: string; decision: ApprovalDecision; resolvedBy: string }> = [];
  const grants: Array<{ kind: 'session' | 'always'; values: string[] }> = [];
  const kernel = new ApprovalKernel(
    {
      async saveRequest(request) { requests.set(request.id, request); },
      async getRequest(id) { return requests.get(id); },
      async getPendingForRun(requestRunId) {
        return [...requests.values()].filter(request => request.runId === requestRunId && !request.decision);
      },
      async resolveRequest(id, decision, resolvedBy) {
        decisions.push({ id, decision, resolvedBy });
        const request = requests.get(id);
        if (request) {
          request.decision = decision;
          request.resolvedBy = resolvedBy;
          request.resolvedAt = Date.now();
        }
      }
    },
    {
      async grantSession(...values) { grants.push({ kind: 'session', values }); },
      async grantAlways(...values) { grants.push({ kind: 'always', values }); },
      async hasSessionGrant(grantRunId, tool, principalId) {
        return grants.some(grant =>
          grant.kind === 'session' &&
          grant.values[0] === grantRunId &&
          grant.values[1] === tool &&
          grant.values[2] === principalId
        );
      },
      async hasAlwaysGrant(tool, principalId) {
        return grants.some(grant =>
          grant.kind === 'always' &&
          grant.values[0] === tool &&
          grant.values[1] === principalId
        );
      },
      async clearSession() {}
    }
  );
  return { kernel, requests, decisions, grants };
}

async function makePendingRequest(
  kernel: ApprovalKernel,
  options: {
    workflow?: boolean;
    requestRunId?: string;
    stepName?: string;
    permission?: 'WRITE' | 'DESTRUCTIVE';
  } = {}
): Promise<ApprovalRequest> {
  const requestRunId = options.requestRunId || runId;
  const workflow = options.workflow === true;
  return kernel.createRequest(
    requestRunId,
    {
      id: workflow ? `call_step_${stepId}` : 'call_approval_lifecycle_generic',
      toolId: workflow ? `workflow_step_${stepId}` : 'tool_approval_lifecycle_write',
      name: workflow ? (options.stepName || 'Approval lifecycle workflow step') : 'approval_lifecycle_write',
      arguments: {},
      timestamp: Date.now()
    },
    options.permission || 'WRITE'
  );
}

function createHarness(
  kernel: ApprovalKernel,
  request: ApprovalRequest,
  options: { workflow?: boolean } = {}
) {
  const workflow = options.workflow === true;
  const run = {
    id: request.runId,
    principalId: owner.userId,
    sessionId: owner.sessionId,
    state: 'WAITING_FOR_APPROVAL',
    pendingApproval: request,
    toolCalls: [request.toolCall],
    executionCheckpoint: 'WAITING_FOR_APPROVAL',
    createdAt: Date.now(),
    updatedAt: Date.now()
  } as unknown as Run;
  const savedRuns: Run[] = [];
  const runRepo = {
    async getRun(id: string) { return id === run.id ? run : undefined; },
    async saveRun(saved: Run) { Object.assign(run, saved); savedRuns.push(saved); }
  };

  const workflowRun = workflow ? {
    id: workflowId,
    workflowId,
    runId: run.id,
    principalId: owner.userId,
    sessionId: owner.sessionId,
    state: 'WAITING_FOR_APPROVAL',
    stepStates: { [stepId]: 'WAITING_FOR_APPROVAL' },
    stepOutputs: {},
    stepAttempts: { [stepId]: 0 },
    pendingApprovalStepId: stepId,
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  } as unknown as WorkflowRun : undefined;
  const workflowRepo = {
    async getWorkflowRun(id: string) { return workflowRun?.id === id ? workflowRun : undefined; },
    async getWorkflowRunByRunId(id: string) { return workflowRun?.runId === id ? workflowRun : undefined; },
    async saveWorkflowRun(saved: WorkflowRun) { if (workflowRun) Object.assign(workflowRun, saved); }
  };

  let workflowExecutions = 0;
  const engine = new WorkflowEngine(
    workflowRepo as any,
    runRepo as any,
    kernel,
    {} as any,
    {} as any,
    process.cwd(),
    async () => undefined
  );
  (engine as any).updateStepState = async () => undefined;
  (engine as any).emitWorkflowEvent = async () => undefined;
  engine.executeWorkflowRun = async () => { workflowExecutions++; };

  let runResumptions = 0;
  const runtime = Object.create(AgentRuntime.prototype) as any;
  runtime.approvalKernel = kernel;
  runtime.runRepo = runRepo;
  runtime.inFlightRuns = new Map([[run.id, run]]);
  runtime.workflowRepo = workflowRepo;
  runtime.workflowEngine = engine;
  runtime.pendingRunEvents = new Map();
  runtime.eventStreams = new Map();
  runtime.runDbTelemetry = new Map();
  runtime.emitRunEvent = async () => undefined;
  runtime.transitionRunState = async () => undefined;
  runtime.executeRunLoop = async () => { runResumptions++; };

  return { runtime, run, runRepo, savedRuns, workflowRun, engine, get workflowExecutions() { return workflowExecutions; }, get runResumptions() { return runResumptions; } };
}

function protectedToolDefinition(
  name: string,
  permission: 'WRITE' | 'DESTRUCTIVE'
): ToolDefinition {
  return {
    id: `tool_${name}`,
    name,
    description: 'Protected tool used for workflow grant-isolation regression tests.',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    permissionLevel: permission,
    sideEffectLevel: permission,
    permissionScopes: [],
    approvalPolicy: 'require_approval',
    executionRuntime: 'LOCAL',
    version: 1,
    category: 'utility',
    executionMode: 'sync',
    timeoutMs: 30_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, factor: 2, retryableErrorCodes: [] },
    idempotencyPolicy: { required: false },
    availability: 'READY',
    adapter: 'native',
    provider: 'test',
    metadata: {}
  };
}

function createProtectedGateway(
  kernel: ApprovalKernel,
  toolName: string,
  permission: 'WRITE' | 'DESTRUCTIVE',
  onExecute: () => void
): ToolGateway {
  const gateway = new ToolGateway(new InMemoryToolCallRepository(), kernel);
  gateway.registerTool({
    definition: protectedToolDefinition(toolName, permission),
    execute: async () => {
      onExecute();
      return { adapterExecuted: true };
    }
  });
  return gateway;
}

async function executeProtectedTool(
  gateway: ToolGateway,
  toolName: string,
  targetRunId = runId
) {
  return gateway.execute({
    toolName,
    arguments: {},
    context: { runId: targetRunId, principal: owner }
  });
}

test('submitApproval preserves the authenticated resolver identity for generic approvals', async () => {
  const { kernel, decisions, grants } = createKernelHarness();
  const request = await makePendingRequest(kernel);
  const harness = createHarness(kernel, request);

  const accepted = await harness.runtime.submitApproval(request.id, 'ALLOW_SESSION', owner, request.runId);

  assert.equal(accepted, true);
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0], { id: request.id, decision: 'ALLOW_SESSION', resolvedBy: owner.userId });
  assert.deepEqual(grants, [{ kind: 'session', values: [request.runId, request.toolCall.name, owner.userId] }]);
  assert.equal(harness.runResumptions, 1);
});

test('submitApproval rejects a wrong principal before resolving the request', async () => {
  const { kernel, decisions } = createKernelHarness();
  const request = await makePendingRequest(kernel);
  const harness = createHarness(kernel, request);

  const accepted = await harness.runtime.submitApproval(
    request.id,
    'ALLOW_ONCE',
    { userId: 'different_principal', sessionId: 'different_session', role: 'user' },
    request.runId
  );

  assert.equal(accepted, false);
  assert.equal(decisions.length, 0);
  assert.equal(harness.runResumptions, 0);
});

test('submitApproval rejects a request submitted under the wrong run ID', async () => {
  const { kernel, decisions } = createKernelHarness();
  const request = await makePendingRequest(kernel);
  const harness = createHarness(kernel, request);

  const accepted = await harness.runtime.submitApproval(request.id, 'ALLOW_ONCE', owner, 'run_someone_elses');

  assert.equal(accepted, false);
  assert.equal(decisions.length, 0);
  assert.equal(harness.runResumptions, 0);
});

for (const decision of ['ALLOW_ONCE', 'ALLOW_SESSION', 'ALLOW_ALWAYS_FOR_TOOL', 'REJECT'] as const) {
  test(`workflow resolves ${decision} once with the correct approval outcome`, async () => {
    const { kernel, decisions, grants } = createKernelHarness();
    const request = await makePendingRequest(kernel, { workflow: true });
    const harness = createHarness(kernel, request, { workflow: true });

    const accepted = await harness.runtime.submitApproval(request.id, decision, owner, request.runId);

    assert.equal(accepted, true);
    assert.equal(decisions.length, 1, 'approval decision must be resolved exactly once');
    assert.deepEqual(decisions[0], { id: request.id, decision, resolvedBy: owner.userId });
    assert.equal(harness.savedRuns.length, 0, 'workflow route must not re-resolve through generic runtime');

    if (decision === 'REJECT') {
      assert.equal(harness.workflowRun?.state, 'FAILED');
      assert.equal(harness.workflowRun?.stepStates[stepId], 'FAILED');
      assert.equal(harness.workflowExecutions, 0, 'rejected workflow must not dispatch its protected step');
      assert.deepEqual(grants, []);
    } else {
      assert.equal(harness.workflowRun?.state, 'RUNNING');
      assert.equal(harness.workflowRun?.stepStates[stepId], 'READY');
      assert.equal(harness.workflowExecutions, 1);
      assert.deepEqual(grants, [], 'workflow decisions must not create reusable ToolGateway grants');
    }
  });
}

for (const permission of ['WRITE', 'DESTRUCTIVE'] as const) {
  test(`workflow ${permission} display-name collision does not authorize a same-named ToolGateway tool`, async () => {
    const { kernel, grants } = createKernelHarness();
    const toolName = `workflow_collision_${permission.toLowerCase()}`;
    const request = await makePendingRequest(kernel, {
      workflow: true,
      stepName: toolName,
      permission
    });
    const harness = createHarness(kernel, request, { workflow: true });

    assert.equal(
      await harness.runtime.submitApproval(request.id, 'ALLOW_SESSION', owner, request.runId),
      true
    );
    assert.deepEqual(grants, []);

    let adapterCalls = 0;
    const gateway = createProtectedGateway(kernel, toolName, permission, () => { adapterCalls++; });
    const result = await executeProtectedTool(gateway, toolName);

    assert.equal(result.output?.status, 'WAITING_FOR_APPROVAL');
    assert.equal(adapterCalls, 0);
    assert.deepEqual(grants, []);
  });
}

test('ALLOW_ALWAYS_FOR_TOOL workflow collision creates no reusable grant in this or another run', async () => {
  const { kernel, grants } = createKernelHarness();
  const toolName = 'workflow_always_collision_tool';
  const request = await makePendingRequest(kernel, {
    workflow: true,
    stepName: toolName
  });
  const harness = createHarness(kernel, request, { workflow: true });

  assert.equal(
    await harness.runtime.submitApproval(request.id, 'ALLOW_ALWAYS_FOR_TOOL', owner, request.runId),
    true
  );
  assert.deepEqual(grants, []);

  let adapterCalls = 0;
  const gateway = createProtectedGateway(kernel, toolName, 'WRITE', () => { adapterCalls++; });
  const sameRunResult = await executeProtectedTool(gateway, toolName, request.runId);
  const otherRunResult = await executeProtectedTool(gateway, toolName, 'run_other_than_approval');

  assert.equal(sameRunResult.output?.status, 'WAITING_FOR_APPROVAL');
  assert.equal(otherRunResult.output?.status, 'WAITING_FOR_APPROVAL');
  assert.equal(adapterCalls, 0);
  assert.deepEqual(grants, []);
});

test('non-colliding workflow approval resumes only its step and grants no ToolGateway tool', async () => {
  const { kernel, grants } = createKernelHarness();
  const request = await makePendingRequest(kernel, {
    workflow: true,
    stepName: 'Review quarterly report'
  });
  const harness = createHarness(kernel, request, { workflow: true });

  assert.equal(
    await harness.runtime.submitApproval(request.id, 'ALLOW_SESSION', owner, request.runId),
    true
  );
  assert.equal(harness.workflowExecutions, 1);
  assert.deepEqual(grants, []);

  let adapterCalls = 0;
  const gateway = createProtectedGateway(kernel, 'unrelated_write_tool', 'WRITE', () => { adapterCalls++; });
  const result = await executeProtectedTool(gateway, 'unrelated_write_tool');

  assert.equal(result.output?.status, 'WAITING_FOR_APPROVAL');
  assert.equal(adapterCalls, 0);
  assert.deepEqual(grants, []);
});

test('workflow approval rejects wrong principal, run, or step without resolving or granting', async () => {
  const { kernel, decisions, grants } = createKernelHarness();
  const request = await makePendingRequest(kernel, { workflow: true });
  const harness = createHarness(kernel, request, { workflow: true });

  assert.equal(await harness.runtime.submitApproval(
    request.id,
    'ALLOW_SESSION',
    { userId: 'another_user', sessionId: 'another_session', role: 'user' },
    request.runId
  ), false);
  assert.equal(await harness.runtime.submitApproval(
    request.id,
    'ALLOW_SESSION',
    owner,
    'another_run'
  ), false);
  assert.equal(await harness.engine.resolveStepApproval(
    workflowId,
    'not_the_pending_step',
    'ALLOW_SESSION',
    owner,
    request.id
  ), false);

  assert.equal(decisions.length, 0);
  assert.deepEqual(grants, []);
  assert.equal(harness.workflowExecutions, 0);
});

test('generic ToolGateway ALLOW_SESSION still grants the matching protected tool', async () => {
  const { kernel, grants } = createKernelHarness();
  const toolName = 'generic_session_grant_tool';
  let adapterCalls = 0;
  const gateway = createProtectedGateway(kernel, toolName, 'WRITE', () => { adapterCalls++; });

  const pending = await executeProtectedTool(gateway, toolName);
  assert.equal(pending.output?.status, 'WAITING_FOR_APPROVAL');
  const requestId = pending.output?.requestId;
  assert.equal(typeof requestId, 'string');

  await kernel.decide(requestId as string, 'ALLOW_SESSION', owner.userId);
  assert.deepEqual(grants, [{ kind: 'session', values: [runId, toolName, owner.userId] }]);

  const resumed = await executeProtectedTool(gateway, toolName);
  assert.equal(resumed.isError, false);
  assert.deepEqual(resumed.output, { adapterExecuted: true });
  assert.equal(adapterCalls, 1);
});

test('REJECT never resumes a generic run or dispatches its protected tool', async () => {
  const { kernel, decisions, grants } = createKernelHarness();
  const request = await makePendingRequest(kernel);
  const harness = createHarness(kernel, request);

  const accepted = await harness.runtime.submitApproval(request.id, 'REJECT', owner, request.runId);

  assert.equal(accepted, true);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, 'REJECT');
  assert.equal(harness.runResumptions, 0);
  assert.deepEqual(grants, []);
});

test('legacy workflow APPROVED/REJECTED calls remain compatible', async () => {
  for (const [legacyDecision, expectedDecision] of [
    ['APPROVED', 'ALLOW_SESSION'],
    ['REJECTED', 'REJECT']
  ] as const) {
    const { kernel, decisions, grants } = createKernelHarness();
    const request = await makePendingRequest(kernel, { workflow: true });
    const harness = createHarness(kernel, request, { workflow: true });

    const accepted = await harness.engine.resolveStepApproval(
      workflowId,
      stepId,
      legacyDecision,
      owner
    );

    assert.equal(accepted, true);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, expectedDecision);
    assert.equal(decisions[0].resolvedBy, owner.userId);
    assert.deepEqual(grants, [], 'legacy workflow resolution must not issue reusable grants');
    if (legacyDecision === 'APPROVED') {
      assert.equal(harness.workflowRun?.stepStates[stepId], 'READY');
      assert.equal(harness.workflowExecutions, 1);
    } else {
      assert.equal(harness.workflowRun?.state, 'FAILED');
      assert.equal(harness.workflowRun?.stepStates[stepId], 'FAILED');
      assert.equal(harness.workflowExecutions, 0);
    }
  }
});

test('approval decision contract values remain unchanged', () => {
  for (const decision of ['ALLOW_ONCE', 'ALLOW_SESSION', 'ALLOW_ALWAYS_FOR_TOOL', 'REJECT']) {
    assert.equal(ApprovalDecisionSchema.safeParse(decision).success, true);
  }
});
