import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalRequest, ExecutionPrincipal, ApprovalDecision } from '../packages/contracts/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import type { OneTimeAuthorizationBinding } from '../packages/approvals/src/repositories.js';
import { InMemoryToolCallRepository, ToolGateway } from '../packages/tool-runtime/src/index.js';
import type { ToolDefinition } from '../packages/contracts/src/index.js';

const principal: ExecutionPrincipal = {
  userId: 'once_owner',
  sessionId: 'once_session',
  workspaceId: 'once_workspace',
  role: 'user'
};

function makeHarness(maxAttempts = 3) {
  const requests = new Map<string, ApprovalRequest>();
  const authorizationStates = new Map<string, 'NONE' | 'AVAILABLE' | 'CLAIMED' | 'DISPATCHED' | 'COMPLETED' | 'FAILED'>();
  const claimIds = new Map<string, string>();
  const calls: unknown[] = [];
  const repository = {
    async saveRequest(request: ApprovalRequest) {
      requests.set(request.id, request);
      authorizationStates.set(request.id, 'NONE');
    },
    async getRequest(id: string) { return requests.get(id); },
    async getPendingForRun(runId: string) {
      return [...requests.values()].filter((request) => request.runId === runId && !request.decision);
    },
    async resolveRequest() { throw new Error('CAS resolution expected'); },
    async resolvePendingRequest(id: string, decision: ApprovalDecision, resolvedBy: string, _grant?: unknown, issueOnce = false) {
      const request = requests.get(id);
      if (!request) throw new Error('missing');
      if (request.decision) {
        return { request, applied: false, grantHandled: true };
      }
      request.decision = decision;
      request.resolvedBy = resolvedBy;
      authorizationStates.set(id, decision === 'ALLOW_ONCE' && issueOnce ? 'AVAILABLE' : 'NONE');
      return { request, applied: true, grantHandled: true };
    },
    async claimOnceAuthorization(binding: OneTimeAuthorizationBinding) {
      const request = requests.get(binding.requestId);
      if (!request || authorizationStates.get(binding.requestId) !== 'AVAILABLE') return false;
      if (
        binding.principalId !== principal.userId || binding.workspaceId !== principal.workspaceId || binding.runId !== request.runId ||
        binding.toolCallId !== request.toolCall.id || binding.toolId !== request.toolCall.toolId ||
        binding.toolName !== request.toolCall.name || binding.permissionLevel !== request.permissionLevel ||
        binding.toolDefinitionVersion !== request.toolDefinitionVersion ||
        binding.toolPolicyFingerprint !== request.toolPolicyFingerprint ||
        JSON.stringify(binding.arguments) !== JSON.stringify(request.toolCall.arguments)
      ) return false;
      authorizationStates.set(binding.requestId, 'CLAIMED');
      claimIds.set(binding.requestId, binding.claimId);
      return true;
    },
    async markOnceAuthorizationDispatched(requestId: string, claimId: string) {
      if (authorizationStates.get(requestId) !== 'CLAIMED' || claimIds.get(requestId) !== claimId) return false;
      authorizationStates.set(requestId, 'DISPATCHED');
      return true;
    },
    async finishOnceAuthorization(requestId: string, claimId: string, outcome: 'COMPLETED' | 'FAILED') {
      if (authorizationStates.get(requestId) !== 'DISPATCHED' || claimIds.get(requestId) !== claimId) return false;
      authorizationStates.set(requestId, outcome);
      return true;
    }
  };
  const grants = {
    async grantSession() {}, async grantAlways() {},
    async hasSessionGrant() { return false; }, async hasAlwaysGrant() { return false; }, async clearSession() {}
  };
  const kernel = new ApprovalKernel(repository, grants);
  const gateway = new ToolGateway(new InMemoryToolCallRepository(), kernel);
  const definition: ToolDefinition = {
    id: 'tool_once_write', name: 'once_write', description: 'one-shot test tool',
    parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    source: 'native', permissionLevel: 'WRITE', sideEffectLevel: 'WRITE', permissionScopes: [],
    approvalPolicy: 'require_approval', executionRuntime: 'LOCAL', version: 4, category: 'utility',
    executionMode: 'sync', timeoutMs: 1000,
    retryPolicy: { maxAttempts, backoffMs: 0, factor: 2, retryableErrorCodes: [] },
    idempotencyPolicy: { required: false }, availability: 'READY', adapter: 'native', provider: 'test', metadata: {}
  };
  let dispatchCount = 0;
  gateway.registerTool({
    definition,
    async execute(args) {
      dispatchCount += 1;
      calls.push(args);
      return { accepted: true, value: args.value };
    }
  });
  return { gateway, kernel, requests, authorizationStates, calls, dispatchCount: () => dispatchCount };
}

function invoke(harness: ReturnType<typeof makeHarness>, options: {
  requestId?: string;
  decision?: 'ALLOW_ONCE';
  value?: number;
  principal?: ExecutionPrincipal;
  callId?: string;
} = {}) {
  return harness.gateway.execute({
    callId: options.callId || 'call_once_1',
    toolName: 'once_write',
    arguments: { value: options.value ?? 10 },
    context: {
      runId: 'run_once_1',
      principal: options.principal || principal,
      approvalRequestId: options.requestId,
      approvalDecision: options.decision
    }
  });
}

test('ALLOW_ONCE is bound to exact owner, call, arguments, tool version, and policy and is consumed once', async () => {
  const harness = makeHarness();
  const pending = await invoke(harness);
  const requestId = (pending.output as { requestId: string }).requestId;
  const request = harness.requests.get(requestId)!;
  await harness.kernel.decide(requestId, 'ALLOW_ONCE', principal.userId);

  const changedArguments = await invoke(harness, { requestId, decision: 'ALLOW_ONCE', value: 11 });
  assert.equal(changedArguments.isError, true);
  assert.equal(harness.dispatchCount(), 0);
  assert.equal(harness.authorizationStates.get(requestId), 'AVAILABLE');

  const foreign = await invoke(harness, {
    requestId,
    decision: 'ALLOW_ONCE',
    principal: { ...principal, userId: 'foreign_owner' }
  });
  assert.equal(foreign.isError, true);
  assert.equal(harness.dispatchCount(), 0);

  const tool = harness.gateway.getTool('once_write')!;
  harness.gateway.registerTool({ definition: { ...tool.definition, version: 5 }, execute: tool.execute });
  const changedVersion = await invoke(harness, { requestId, decision: 'ALLOW_ONCE' });
  assert.equal(changedVersion.isError, true);
  assert.equal(harness.dispatchCount(), 0);
  harness.gateway.registerTool(tool);

  const changedCall = await invoke(harness, { requestId, decision: 'ALLOW_ONCE', callId: 'call_other' });
  assert.equal(changedCall.isError, true);
  assert.equal(harness.dispatchCount(), 0);

  const executed = await invoke(harness, { requestId, decision: 'ALLOW_ONCE' });
  assert.equal(executed.isError, false);
  assert.equal(harness.dispatchCount(), 1);
  assert.equal(harness.authorizationStates.get(requestId), 'COMPLETED');

  const replay = await invoke(harness, { requestId, decision: 'ALLOW_ONCE' });
  assert.equal(replay.isError, true);
  assert.equal(harness.dispatchCount(), 1);
  assert.equal(harness.authorizationStates.get(requestId), 'COMPLETED');
  assert.equal(request.toolDefinitionVersion, 4);
});

test('ALLOW_ONCE disables adapter retries so ambiguous failures cannot dispatch twice', async () => {
  const harness = makeHarness(5);
  const tool = harness.gateway.getTool('once_write')!;
  let attempts = 0;
  harness.gateway.registerTool({
    definition: tool.definition,
    async execute() {
      attempts += 1;
      throw new Error('temporary network error');
    }
  });
  const pending = await invoke(harness);
  const requestId = (pending.output as { requestId: string }).requestId;
  await harness.kernel.decide(requestId, 'ALLOW_ONCE', principal.userId);
  const result = await invoke(harness, { requestId, decision: 'ALLOW_ONCE' });

  assert.equal(result.isError, true);
  assert.equal(attempts, 1);
  assert.equal(harness.authorizationStates.get(requestId), 'FAILED');
});
