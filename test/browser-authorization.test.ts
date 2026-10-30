import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { BrowserAdapter } from '../packages/tool-runtime/src/adapters/browser-adapter.js';
import type { ApprovalDecision, ApprovalRequest, ExecutionPrincipal } from '../packages/contracts/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import type { ApprovalGrantRequest, ApprovalRepository, SessionGrantRepository } from '../packages/approvals/src/repositories.js';
import { InMemoryToolCallRepository, ToolGateway } from '../packages/tool-runtime/src/index.js';
import { InMemoryWorkspaceAuthorityRepository } from '../packages/agent-runtime/src/workspace-authority.js';
import { createLocalChromiumAdapter } from './helpers/local-chromium.js';

interface PrincipalRun { principal: ExecutionPrincipal; workspaceId: string; }

class BrowserMemoryApprovalRepository implements ApprovalRepository {
  readonly requests = new Map<string, ApprovalRequest>();
  readonly runOwners = new Map<string, PrincipalRun>();
  readonly grants = new Set<string>();

  registerRun(runId: string, principal: ExecutionPrincipal): void {
    this.runOwners.set(runId, { principal, workspaceId: principal.workspaceId! });
  }

  async saveRequest(request: ApprovalRequest): Promise<void> {
    const owner = this.runOwners.get(request.runId);
    if (!owner || owner.workspaceId !== request.workspaceId) {
      throw new Error('Approval requires a parent run bound to the authenticated principal workspace.');
    }
    this.requests.set(request.id, request);
  }

  async getRequest(id: string): Promise<ApprovalRequest | undefined> { return this.requests.get(id); }

  async getPendingForRun(runId: string): Promise<ApprovalRequest[]> {
    return [...this.requests.values()].filter((request) => request.runId === runId && !request.decision);
  }

  async resolveRequest(): Promise<void> { throw new Error('Atomic test resolver is required.'); }

  async resolvePendingRequest(
    id: string,
    decision: ApprovalDecision,
    resolvedBy: string,
    grant?: ApprovalGrantRequest
  ) {
    const request = this.requests.get(id);
    const owner = request && this.runOwners.get(request.runId);
    if (!request || !owner) throw new Error('Approval request not found.');
    if (
      resolvedBy !== owner.principal.userId ||
      request.workspaceId !== owner.principal.workspaceId
    ) throw new Error('Approval resolver is not the run owner.');
    if (request.decision) throw new Error('Approval request was already resolved.');
    request.decision = decision;
    request.resolvedBy = resolvedBy;
    if (grant && decision === 'ALLOW_SESSION') {
      this.grants.add(`${resolvedBy}:${request.runId}:${request.toolCall.name}:${request.workspaceId}`);
    }
    return { request, applied: true, grantHandled: true };
  }
}

class BrowserMemorySessionGrants implements SessionGrantRepository {
  constructor(private readonly approvals: BrowserMemoryApprovalRepository) {}
  async grantSession(runId: string, tool: string, principalId: string): Promise<void> {
    this.approvals.grants.add(`${principalId}:${runId}:${tool}`);
  }
  async grantAlways(): Promise<void> {}
  async hasSessionGrant(runId: string, tool: string, principalId: string): Promise<boolean> {
    return [...this.approvals.grants].some((grant) => grant.startsWith(`${principalId}:${runId}:${tool}:`) || grant === `${principalId}:${runId}:${tool}`);
  }
  async hasAlwaysGrant(): Promise<boolean> { return false; }
  async clearSession(runId: string): Promise<void> {
    for (const grant of this.approvals.grants) if (grant.includes(`:${runId}:`)) this.approvals.grants.delete(grant);
  }
}

test('real local Chromium + ToolGateway preserve browser approval and principal isolation without network access', async () => {
  const authority = new InMemoryWorkspaceAuthorityRepository();
  const suffix = randomUUID();
  const ownerA: ExecutionPrincipal = {
    userId: `browser_unit_a_${suffix}`, sessionId: `browser_unit_session_a_${suffix}`,
    workspaceId: await authority.resolveWorkspace(`browser_unit_a_${suffix}`), scopes: ['browser.read', 'browser.write']
  };
  const ownerB: ExecutionPrincipal = {
    userId: `browser_unit_b_${suffix}`, sessionId: `browser_unit_session_b_${suffix}`,
    workspaceId: await authority.resolveWorkspace(`browser_unit_b_${suffix}`), scopes: ['browser.read', 'browser.write']
  };
  const approvalRepository = new BrowserMemoryApprovalRepository();
  const grantRepository = new BrowserMemorySessionGrants(approvalRepository);
  const approvalKernel = new ApprovalKernel(approvalRepository, grantRepository);
  const browserAdapter = await createLocalChromiumAdapter();
  await browserAdapter.assertBrowserAvailable();
  const gateway = new ToolGateway(
    new InMemoryToolCallRepository(), approvalKernel, process.cwd(), authority, browserAdapter
  );
  const runA = `browser_unit_run_a_${suffix}`;
  const runA2 = `browser_unit_run_a2_${suffix}`;
  const runB = `browser_unit_run_b_${suffix}`;
  approvalRepository.registerRun(runA, ownerA);
  approvalRepository.registerRun(runA2, ownerA);
  approvalRepository.registerRun(runB, ownerB);

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Local Browser Approval Fixture</title><form><input id="value" name="value" value=""><button type="button">Local only</button></form>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const localUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/form`;
  let adapterDispatches = 0;

  try {
    const navigate = await gateway.execute({
      toolName: 'browser_navigate', arguments: { url: localUrl },
      context: { runId: runA, principal: ownerA }
    });
    assert.equal(navigate.isError, false);
    assert.equal(navigate.output?.title, 'Local Browser Approval Fixture');
    const read = await gateway.execute({
      toolName: 'browser_extract', arguments: {}, context: { runId: runA, principal: ownerA }
    });
    assert.equal(read.isError, false);
    assert.equal(read.output?.inputs.find((input: { name: string }) => input.name === 'value')?.value, '');

    const realTypeAdapter = gateway.getTool('browser_type');
    assert.ok(realTypeAdapter);
    gateway.registerTool({
      definition: realTypeAdapter.definition,
      execute: async (args, context) => {
        adapterDispatches += 1;
        return realTypeAdapter.execute(args, context);
      }
    });
    const args = { selector: '#value', text: 'authorized-once-per-run' };
    const pending = await gateway.execute({
      toolName: 'browser_type', arguments: args, context: { runId: runA, principal: ownerA }
    });
    assert.equal(pending.isError, false);
    assert.equal(pending.output?.status, 'WAITING_FOR_APPROVAL');
    assert.equal(pending.output?.approvalRequired, true);
    assert.equal(adapterDispatches, 0);
    assert.equal((await approvalKernel.getPendingRequest(pending.output.requestId))?.workspaceId, ownerA.workspaceId);
    const pendingDom = await gateway.execute({
      toolName: 'browser_extract', arguments: {}, context: { runId: runA, principal: ownerA }
    });
    assert.equal(pendingDom.output?.inputs.find((input: { name: string }) => input.name === 'value')?.value, '');

    await assert.rejects(
      () => approvalKernel.decide(pending.output.requestId, 'ALLOW_SESSION', ownerB.userId),
      /resolver is not the run owner/i
    );
    assert.ok(await approvalKernel.getPendingRequest(pending.output.requestId));
    await approvalKernel.decide(pending.output.requestId, 'REJECT', ownerA.userId);
    const rejectedRetry = await gateway.execute({
      toolName: 'browser_type', arguments: args, context: { runId: runA, principal: ownerA }
    });
    assert.equal(rejectedRetry.output?.status, 'WAITING_FOR_APPROVAL', 'A rejection must not authorize retry.');
    assert.equal(adapterDispatches, 0);
    await approvalKernel.decide(rejectedRetry.output.requestId, 'REJECT', ownerA.userId);

    const approvedRequest = await gateway.execute({
      toolName: 'browser_type', arguments: args, context: { runId: runA, principal: ownerA }
    });
    await approvalKernel.decide(approvedRequest.output.requestId, 'ALLOW_SESSION', ownerA.userId);
    const allowed = await gateway.execute({
      toolName: 'browser_type', arguments: args, context: { runId: runA, principal: ownerA }
    });
    assert.equal(allowed.isError, false);
    assert.equal(allowed.output?.success, true);
    assert.equal(adapterDispatches, 1);
    const typedDom = await gateway.execute({
      toolName: 'browser_extract', arguments: {}, context: { runId: runA, principal: ownerA }
    });
    assert.equal(typedDom.output?.inputs.find((input: { name: string }) => input.name === 'value')?.value, args.text);

    const crossRun = await gateway.execute({
      toolName: 'browser_type', arguments: args, context: { runId: runA2, principal: ownerA }
    });
    assert.equal(crossRun.output?.status, 'WAITING_FOR_APPROVAL', 'Run-bound grants must not cross runs.');
    assert.equal(adapterDispatches, 1);
    await approvalKernel.decide(crossRun.output.requestId, 'REJECT', ownerA.userId);

    await gateway.execute({
      toolName: 'browser_navigate', arguments: { url: localUrl }, context: { runId: runB, principal: ownerB }
    });
    const crossWorkspace = await gateway.execute({
      toolName: 'browser_type', arguments: args, context: { runId: runB, principal: ownerB }
    });
    assert.equal(crossWorkspace.output?.status, 'WAITING_FOR_APPROVAL', 'Workspace/principal grants must not cross accounts.');
    assert.equal(adapterDispatches, 1);
    await approvalKernel.decide(crossWorkspace.output.requestId, 'REJECT', ownerB.userId);

    const foreignRunAccess = await gateway.execute({
      toolName: 'browser_type', arguments: args, context: { runId: runA, principal: ownerB }
    });
    assert.equal(foreignRunAccess.isError, true);
    assert.equal(foreignRunAccess.errorCode, 'TOOL_APPROVAL_DENIED');
    assert.equal(adapterDispatches, 1, 'A foreign principal must never dispatch through another owner’s run.');
  } finally {
    await gateway.getBrowserAdapter().shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('browser certification readiness fails closed when all Chromium launch attempts fail', async () => {
  const originalLaunch = chromium.launch;
  let launchAttempts = 0;
  (chromium as unknown as { launch: (...args: any[]) => Promise<unknown> }).launch = async () => {
    launchAttempts += 1;
    throw new Error('deterministic Chromium unavailable fixture');
  };
  const adapter = new BrowserAdapter();
  try {
    await assert.rejects(adapter.assertBrowserAvailable(), /deterministic Chromium unavailable fixture/);
    assert.equal(launchAttempts, 3, 'System Chrome, Edge, and bundled Chromium launch paths must all fail visibly.');
  } finally {
    (chromium as unknown as { launch: typeof chromium.launch }).launch = originalLaunch;
    await adapter.shutdown();
  }
});