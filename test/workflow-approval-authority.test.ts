import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalRequest, ExecutionPrincipal, Run, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { RunSchema } from '../packages/contracts/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { InMemoryRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { InMemoryWorkflowRepository } from '../packages/agent-runtime/src/workflow-repositories.js';
import { WorkflowEngine } from '../packages/agent-runtime/src/workflow-engine.js';
import { ModelRouter } from '../packages/model-router/src/index.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';

const owner: ExecutionPrincipal = {
  userId: 'workflow_approval_owner',
  sessionId: 'workflow_approval_session',
  workspaceId: 'workflow_approval_workspace',
  roles: ['member']
};

function parentRun(
  principalId = owner.userId,
  workspaceId: string | null = owner.workspaceId,
  id = 'run_workflow_approval_authority_test'
): Run {
  return RunSchema.parse({
    id,
    principalId,
    sessionId: owner.sessionId,
    workspaceId,
    intent: 'WORKFLOW',
    state: 'RUNNING',
    modelPolicy: { model: 'mock-deterministic' },
    prompt: 'Run protected workflow step',
    content: '',
    thinking: '',
    toolsUsed: [],
    toolCalls: [],
    toolResults: [],
    artifacts: [],
    citations: [],
    stepCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
}

function approvalWorkflow(runId: string, principalId = owner.userId): WorkflowDefinition {
  return {
    workflowId: `wf_${runId}`,
    version: 1,
    name: 'Protected workflow approval test',
    principalId,
    inputSchema: {},
    steps: [{
      stepId: 'protected_step',
      name: 'Protected step',
      type: 'TOOL',
      toolName: 'protected_action',
      capability: 'TOOL_ACTION',
      dependsOn: [],
      input: { value: 'must not dispatch before approval' },
      sideEffectLevel: 'DESTRUCTIVE',
      approvalRequired: true,
      timeoutMs: 1000,
      retry: { maxAttempts: 1, backoffMs: 1, factor: 1 }
    }],
    executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 5000 },
    outputSchema: {},
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function makeHarness() {
  const runRepo = new InMemoryRunRepository();
  const workflowRepo = new InMemoryWorkflowRepository();
  const requests = new Map<string, ApprovalRequest>();
  let protectedDispatches = 0;

  const approvalRepository = {
    async saveRequest(request: ApprovalRequest) { requests.set(request.id, request); },
    async getRequest(id: string) { return requests.get(id); },
    async getPendingForRun(runId: string) {
      return [...requests.values()].filter((request) => request.runId === runId && !request.decision);
    },
    async resolveRequest(id: string, decision: ApprovalRequest['decision'], resolvedBy: string) {
      const request = requests.get(id);
      if (request) {
        request.decision = decision;
        request.resolvedBy = resolvedBy;
        request.resolvedAt = Date.now();
      }
    }
  };
  const grants = {
    async grantSession() {},
    async grantAlways() {},
    async hasSessionGrant() { return false; },
    async hasAlwaysGrant() { return false; },
    async clearSession() {}
  };
  const kernel = new ApprovalKernel(approvalRepository as any, grants as any);
  const gateway = {
    async execute() {
      protectedDispatches++;
      return { isError: false, output: { executed: true } };
    }
  };
  const engine = new WorkflowEngine(
    workflowRepo,
    runRepo,
    kernel,
    new ToolRegistry(),
    new ModelRouter(),
    process.cwd(),
    undefined,
    gateway as any
  );

  return { runRepo, workflowRepo, requests, kernel, engine, protectedDispatches: () => protectedDispatches };
}

test('valid persisted parent owner/workspace reaches the intended pending workflow approval', async () => {
  const h = makeHarness();
  const run = parentRun();
  await h.runRepo.saveRun(run);

  const workflow = await h.engine.createWorkflowRun(approvalWorkflow(run.id), run, owner);
  await h.engine.executeWorkflowRun(workflow.id);

  const persisted = await h.workflowRepo.getWorkflowRun(workflow.id);
  const pending = await h.kernel.getPendingForRun(run.id);
  assert.equal(persisted?.state, 'WAITING_FOR_APPROVAL');
  assert.equal(persisted?.pendingApprovalStepId, 'protected_step');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].workspaceId, owner.workspaceId);
  assert.equal(pending[0].runId, run.id);
  assert.equal(pending[0].toolCall.id, 'call_step_protected_step');
  assert.equal(h.protectedDispatches(), 0, 'Protected tool must wait for an authorized approval');
});

test('approval workflow rejects an unpersisted/missing parent run before persisting the workflow', async () => {
  const h = makeHarness();
  const run = parentRun();

  await assert.rejects(
    h.engine.createWorkflowRun(approvalWorkflow(run.id), run, owner),
    /authoritative parent-run workspace matching the workflow owner/
  );
  assert.equal((await h.workflowRepo.listWorkflowRuns()).length, 0);
  assert.equal(h.protectedDispatches(), 0);
});

test('approval workflow rejects a parent workspace different from the authenticated workspace', async () => {
  const h = makeHarness();
  const run = parentRun(owner.userId, 'another_workspace');
  await h.runRepo.saveRun(run);

  await assert.rejects(
    h.engine.createWorkflowRun(approvalWorkflow(run.id), run, owner),
    /authoritative parent-run workspace matching the workflow owner/
  );
  assert.equal((await h.workflowRepo.listWorkflowRuns()).length, 0);
  assert.equal(h.protectedDispatches(), 0);
});

test('approval workflow rejects a parent run owned by another principal', async () => {
  const h = makeHarness();
  const run = parentRun('different_owner');
  await h.runRepo.saveRun(run);

  await assert.rejects(
    h.engine.createWorkflowRun(approvalWorkflow(run.id), run, owner),
    /authoritative parent-run workspace matching the workflow owner/
  );
  assert.equal((await h.workflowRepo.listWorkflowRuns()).length, 0);
  assert.equal(h.protectedDispatches(), 0);
});

test('approval workflow rejects a definition owned by a different principal', async () => {
  const h = makeHarness();
  const run = parentRun();
  await h.runRepo.saveRun(run);

  await assert.rejects(
    h.engine.createWorkflowRun(approvalWorkflow(run.id, 'different_owner'), run, owner),
    /authoritative parent-run workspace matching the workflow owner/
  );
  assert.equal((await h.workflowRepo.listWorkflowRuns()).length, 0);
  assert.equal(h.protectedDispatches(), 0);
});
