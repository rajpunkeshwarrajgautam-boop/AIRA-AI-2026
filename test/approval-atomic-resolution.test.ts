import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalDecision, ApprovalRequest } from '../packages/contracts/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';

function makeHarness() {
  const requests = new Map<string, ApprovalRequest>();
  const committedGrants: unknown[] = [];
  let commitCount = 0;
  const repository = {
    async saveRequest(request: ApprovalRequest) { requests.set(request.id, request); },
    async getRequest(id: string) { return requests.get(id); },
    async getPendingForRun(runId: string) {
      return [...requests.values()].filter((request) => request.runId === runId && !request.decision);
    },
    async resolveRequest() { throw new Error('atomic resolution should be used'); },
    async resolvePendingRequest(id: string, decision: ApprovalDecision, resolvedBy: string, grant?: unknown) {
      const request = requests.get(id);
      if (!request) throw new Error('missing');
      if (request.decision) {
        if (request.decision === decision && request.resolvedBy === resolvedBy) {
          return { request, applied: false, grantHandled: true };
        }
        throw new Error('conflict');
      }
      request.decision = decision;
      request.resolvedBy = resolvedBy;
      commitCount += 1;
      if (grant) committedGrants.push(grant);
      return { request, applied: true, grantHandled: true };
    }
  };
  const grantRepo = {
    async grantSession() { throw new Error('grant must be committed with decision'); },
    async grantAlways() { throw new Error('grant must be committed with decision'); },
    async hasSessionGrant() { return false; },
    async hasAlwaysGrant() { return false; },
    async clearSession() {}
  };
  return { kernel: new ApprovalKernel(repository, grantRepo), commitCount: () => commitCount, committedGrants, requests };
}

async function requestFor(kernel: ApprovalKernel) {
  return kernel.createRequest('run_atomic_1', {
    id: 'call_atomic_1',
    toolId: 'tool_atomic_write',
    name: 'atomic_write',
    arguments: { amount: 10 },
    timestamp: 1
  }, 'WRITE', 'review this write', 'workspace_atomic_1', 7);
}

test('concurrent identical decisions commit once and return applied=false for the duplicate', async () => {
  const harness = makeHarness();
  const request = await requestFor(harness.kernel);
  const results = await Promise.all([
    harness.kernel.decide(request.id, 'ALLOW_SESSION', 'principal_atomic'),
    harness.kernel.decide(request.id, 'ALLOW_SESSION', 'principal_atomic')
  ]);

  assert.equal(harness.commitCount(), 1);
  assert.deepEqual(results.map((result) => result.applied).sort(), [false, true]);
  assert.equal(harness.committedGrants.length, 1);
  assert.deepEqual(harness.committedGrants[0], { scope: 'SESSION', riskCeiling: 'WRITE' });
});

test('conflicting concurrent decisions cannot both resolve the same request', async () => {
  const harness = makeHarness();
  const request = await requestFor(harness.kernel);
  const results = await Promise.allSettled([
    harness.kernel.decide(request.id, 'ALLOW_ONCE', 'principal_atomic'),
    harness.kernel.decide(request.id, 'REJECT', 'principal_atomic')
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value.applied).length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(harness.commitCount(), 1);
  assert.equal(harness.committedGrants.length, 0);
});

test('retrying an already committed decision does not grant again or mark it newly applied', async () => {
  const harness = makeHarness();
  const request = await requestFor(harness.kernel);
  const first = await harness.kernel.decide(request.id, 'ALLOW_ALWAYS_FOR_TOOL', 'principal_atomic');
  const retry = await harness.kernel.decide(request.id, 'ALLOW_ALWAYS_FOR_TOOL', 'principal_atomic');

  assert.equal(first.applied, true);
  assert.equal(retry.applied, false);
  assert.equal(harness.commitCount(), 1);
  assert.equal(harness.committedGrants.length, 1);
  assert.deepEqual(harness.committedGrants[0], { scope: 'ALWAYS', riskCeiling: 'WRITE' });
});
