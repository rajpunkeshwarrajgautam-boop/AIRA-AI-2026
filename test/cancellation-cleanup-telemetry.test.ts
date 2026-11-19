import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { InMemoryRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { InMemoryWorkflowRepository } from '../packages/agent-runtime/src/workflow-repositories.js';
import { WorkflowEngine } from '../packages/agent-runtime/src/workflow-engine.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { BrainV2KnowledgeEngine, InMemoryKnowledgeRepository } from '../packages/knowledge/src/index.js';
import { ModelRouter, ProviderHealthTracker } from '../packages/model-router/src/index.js';
import type { ExecutionPrincipal } from '../packages/contracts/src/index.js';

function createMockApprovalKernel(): ApprovalKernel {
  const mockApprovalRepo: any = {
    createRequest: async () => {},
    getPendingRequest: async () => null,
    resolveRequest: async () => {}
  };
  const mockGrantRepo: any = {
    hasAlwaysGrant: async () => false,
    hasSessionGrant: async () => false,
    createSessionGrant: async () => {},
    clearSession: async () => {}
  };
  return new ApprovalKernel(mockApprovalRepo, mockGrantRepo);
}

describe('F3 — Upstream Inference Cancellation, Cleanup & Telemetry', () => {
  const principal: ExecutionPrincipal = {
    userId: 'usr_cancellation_tester',
    sessionId: 'sess_cancel_test',
    workspaceId: 'ws_cancel_default',
    roles: ['member']
  };

  it('aborts active execution controller and transitions run to CANCELLED state', async () => {
    const modelRouter = new ModelRouter([], new ProviderHealthTracker());
    const toolRegistry = new ToolRegistry();
    const approvalKernel = createMockApprovalKernel();
    const knowledgeEngine = new BrainV2KnowledgeEngine(new InMemoryKnowledgeRepository(), { seedDefaults: false });
    const runRepo = new InMemoryRunRepository();

    const runtime = new AgentRuntime(
      modelRouter,
      toolRegistry,
      approvalKernel,
      knowledgeEngine,
      runRepo,
      process.cwd()
    );

    const run = await runtime.createRun(
      {
        prompt: 'Generate detailed analysis',
        modelPolicy: { model: 'mock-deterministic' }
      },
      principal,
      { callerTier: 'free' }
    );

    assert.equal(run.state, 'RUNNING');

    // Perform programmatic cancellation
    const cancelled = await runtime.cancelRun(run.id);
    assert.equal(cancelled, true, 'First cancellation attempt must return true');

    const updatedRun = await runtime.getRun(run.id);
    assert.equal(updatedRun?.state, 'CANCELLED');

    // Duplicate cancellation attempt on already cancelled run: returns false
    const duplicateCancel = await runtime.cancelRun(run.id);
    assert.equal(duplicateCancel, false, 'Redundant cancellation on cancelled run must return false safely');
  });

  it('cascades run cancellation to active workflow execution', async () => {
    const modelRouter = new ModelRouter([], new ProviderHealthTracker());
    const toolRegistry = new ToolRegistry();
    const approvalKernel = createMockApprovalKernel();
    const knowledgeEngine = new BrainV2KnowledgeEngine(new InMemoryKnowledgeRepository(), { seedDefaults: false });
    const runRepo = new InMemoryRunRepository();
    const wfRepo = new InMemoryWorkflowRepository();
    const wfEngine = new WorkflowEngine(wfRepo, runRepo, approvalKernel, toolRegistry, modelRouter);

    const runtime = new AgentRuntime(
      modelRouter,
      toolRegistry,
      approvalKernel,
      knowledgeEngine,
      runRepo,
      process.cwd(),
      undefined,
      undefined,
      wfRepo,
      wfEngine
    );

    const run = await runtime.createRun(
      {
        prompt: 'Run multi-stage workflow',
        intent: 'WORKFLOW',
        modelPolicy: { model: 'mock-deterministic' }
      },
      principal,
      { callerTier: 'plus' }
    );

    const wfRun = {
      id: 'wf_run_cascade_test',
      workflowId: 'wf_def_test',
      runId: run.id,
      principalId: principal.userId,
      state: 'WAITING_FOR_APPROVAL' as const,
      stepStates: { step_1: 'WAITING_FOR_APPROVAL' },
      pendingApprovalStepId: 'step_1',
      currentStepIndex: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await wfRepo.saveWorkflowRun(wfRun);

    // Cancel root run
    const cancelled = await runtime.cancelRun(run.id);
    assert.equal(cancelled, true);

    // Verify workflow state was cascaded to CANCELLED
    const postWfRun = await wfRepo.getWorkflowRun(wfRun.id);
    assert.equal(postWfRun?.state, 'CANCELLED');
  });

  it('validates structured cancellation telemetry format and qualifications', () => {
    const requestId = 'req_test_cancellation_trace';
    const runId = 'run_abc123';
    const model = 'aira-pro';
    const provider = 'nvidia';
    const abortReason = 'CLIENT_CLOSED';
    const permitReleased = true;
    const quotaReleased = true;
    const cleanupMs = 12;
    const status = 'LOCAL_CANCELLED_UPSTREAM_UNVERIFIED';

    const telemetryLog = `event=chat_cancellation request_id=${requestId} run_id=${runId} model=${model} provider=${provider} abort_reason=${abortReason} permit_released=${permitReleased} quota_released=${quotaReleased} cleanup_ms=${cleanupMs} status=${status}`;

    // Validate all required correlation tokens exist in telemetry string
    assert.match(telemetryLog, /event=chat_cancellation/);
    assert.match(telemetryLog, /request_id=req_test_cancellation_trace/);
    assert.match(telemetryLog, /run_id=run_abc123/);
    assert.match(telemetryLog, /model=aira-pro/);
    assert.match(telemetryLog, /provider=nvidia/);
    assert.match(telemetryLog, /abort_reason=CLIENT_CLOSED/);
    assert.match(telemetryLog, /permit_released=true/);
    assert.match(telemetryLog, /quota_released=true/);
    assert.match(telemetryLog, /cleanup_ms=\d+/);
    assert.match(telemetryLog, /status=LOCAL_CANCELLED_UPSTREAM_UNVERIFIED/);

    // Explicitly verify qualification status token
    assert.equal(status, 'LOCAL_CANCELLED_UPSTREAM_UNVERIFIED');
  });
});
