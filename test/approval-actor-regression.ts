import assert from 'node:assert/strict';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { closeDb } from '../packages/db/src/index.js';

// Unit boundary regression; fixtures do not certify deployed approval execution.
let decisions = 0;
let resolvedBy: string | undefined;
let workflowDecision: string | undefined;
const request = { runId: 'approval-run', toolCall: { toolId: 'workflow_step_fixture' } };
const runtime = {
  approvalKernel: {
    getPendingRequest: async () => request,
    decide: async (_id: string, decision: string, actor: string) => {
      decisions++; resolvedBy = actor;
      return { approved: decision !== 'REJECT', request };
    },
  },
  runRepo: { getRun: async () => ({ principalId: 'owner', sessionId: 'session-owner' }) },
  workflowRepo: { getWorkflowRunByRunId: async () => ({ id: 'workflow-fixture', state: 'WAITING_FOR_APPROVAL', pendingApprovalStepId: 'step-fixture' }) },
  workflowEngine: { resolveStepApproval: async (_id: string, _step: string, decision: string, principal: any) => {
    workflowDecision = decision;
    assert.equal(principal.userId, 'owner');
    assert.deepEqual(principal.roles, ['user']);
  } },
};
try {
  assert.equal(await AgentRuntime.prototype.submitApproval.call(runtime as any, 'request', 'ALLOW_ONCE', 'other-user'), false);
  assert.equal(decisions, 0, 'wrong actor must not mutate approval or grants');
  assert.equal(await AgentRuntime.prototype.submitApproval.call(runtime as any, 'request', 'ALLOW_ONCE', 'owner'), true);
  assert.equal(resolvedBy, 'owner');
  assert.equal(workflowDecision, 'APPROVED', 'ALLOW_ONCE must approve the waiting workflow step');
  await AgentRuntime.prototype.submitApproval.call(runtime as any, 'request', 'REJECT', 'owner');
  assert.equal(workflowDecision, 'REJECTED');
  console.log('PASS: approval actor ownership and workflow decision propagation');
} finally { await closeDb(); }
