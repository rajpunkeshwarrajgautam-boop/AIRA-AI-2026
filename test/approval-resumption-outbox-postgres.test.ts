import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/src/index.js';
import { PostgresRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { up as repairApprovalResumptionTargets } from '../packages/db/src/migrations/029_authoritative_approval_resumption_targets.js';
import { PostgresApprovalRepository, PostgresSessionGrantRepository, ApprovalGrantRequest, ApprovalResolutionTarget } from '../packages/approvals/src/repositories.js';
import type { ApprovalDecision, ApprovalRequest } from '../packages/contracts/src/index.js';

// This suite is run only inside postgres-certification.yml after its disposable
// PostgreSQL identity checks and migrations. It never discovers or provisions a DB.
const requested = process.env.AIRA_POSTGRES_CERTIFICATION === '1';
function hasDisposablePostgresContract(): boolean {
  if (
    process.env.NODE_ENV !== 'test' || process.env.CI_DISPOSABLE_DATABASE !== 'true' ||
    !process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.ISOLATED_TEST_DATABASE_URL
  ) return false;
  try {
    const url = new URL(process.env.DATABASE_URL);
    const user = process.env.CI_EXPECTED_DATABASE_USER || '';
    const database = process.env.CI_EXPECTED_DATABASE_NAME || '';
    return url.protocol === 'postgresql:' && url.hostname === 'postgres' && url.port === '5432' &&
      decodeURIComponent(url.username) === user && decodeURIComponent(url.pathname.slice(1)) === database &&
      /^aira_ci_[0-9]+-[0-9]+$/.test(user) && /^aira_ci_[0-9]+-[0-9]+$/.test(database) &&
      new RegExp(`^postgresql://${user}:[a-f0-9]{64}@postgres:5432/${database}$`).test(process.env.DATABASE_URL);
  } catch {
    return false;
  }
}
const safeDisposableTarget = hasDisposablePostgresContract();
if (requested && !safeDisposableTarget) {
  throw new Error('Refusing approval integration tests without the isolated run-scoped PostgreSQL contract.');
}
const enabled = requested && safeDisposableTarget;
const repo = new PostgresApprovalRepository();
const owner = 'cert_m2a_approval_owner';
const workspaceId = 'cert_m2a_approval_workspace';

type Fixture = { runId: string; request: ApprovalRequest; target: ApprovalResolutionTarget };

async function fixture(decisionSeed = randomUUID(), workflowStepId?: string, genericToolCallId?: string): Promise<Fixture> {
  const runId = `cert_approval_run_${decisionSeed}`;
  const requestId = `cert_approval_req_${decisionSeed}`;
  const callId = `cert_approval_call_${decisionSeed}`;
  const now = Date.now();
  await db('runs').insert({
    id: runId, principal_id: owner, session_id: `sess_${owner}`, workspace_id: workspaceId,
    prompt: 'disposable approval certification fixture', status: 'WAITING_FOR_APPROVAL',
    state: 'WAITING_FOR_APPROVAL', execution_checkpoint: 'WAITING_FOR_APPROVAL',
    createdAt: now, updatedAt: now, toolsUsed: '[]', toolCalls: '[]', toolResults: '[]',
    pending_approval: null
  });
  const request: ApprovalRequest = {
    id: requestId,
    runId,
    toolCall: {
      id: workflowStepId ? `call_step_${workflowStepId}` : (genericToolCallId || callId), toolId: 'tool_cert_write', name: 'cert_write',
      arguments: { payload: 'isolated-certification-only', count: 1 }, timestamp: now
    },
    risk: 'medium', title: 'Disposable approval fixture', reason: 'Integration certification',
    sanitizedPreview: { payload: 'isolated-certification-only', count: 1 }, requestedAt: now,
    workspaceId, permissionLevel: 'WRITE', toolDefinitionVersion: 1,
    toolPolicyFingerprint: 'a'.repeat(64)
  };
  await repo.saveRequest(request);
  await db('tool_calls').where({ id: request.toolCall.id }).update({ principal_id: owner });
  await db('runs').where({ id: runId }).update({ pending_approval: JSON.stringify(request) });
  const target: ApprovalResolutionTarget = workflowStepId
    ? { type: 'WORKFLOW', workflowRunId: `cert_wf_run_${decisionSeed}`, workflowStepId }
    : { type: 'RUN' };
  if (workflowStepId) {
    const workflowId = `cert_wf_def_${decisionSeed}`;
    const workflowRunId = `cert_wf_run_${decisionSeed}`;
    await db('workflow_definitions').insert({
      id: workflowId, version: 1, name: 'Disposable approval workflow', principal_id: owner,
      input_schema: '{}', steps: JSON.stringify([{ stepId: workflowStepId, name: 'cert-step', type: 'TOOL', dependsOn: [] }]),
      execution_policy: '{}', output_schema: '{}', created_at: now, updated_at: now
    });
    await db('workflow_runs').insert({
      id: workflowRunId, workflow_id: workflowId, run_id: runId, principal_id: owner,
      session_id: `sess_${owner}`, state: 'WAITING_FOR_APPROVAL',
      step_states: JSON.stringify({ [workflowStepId]: 'WAITING_FOR_APPROVAL' }),
      step_outputs: '{}', step_attempts: JSON.stringify({ [workflowStepId]: 1 }),
      pending_approval_step_id: workflowStepId, created_at: now, updated_at: now
    });
    await db('workflow_steps').insert({
      id: `cert_wf_step_${decisionSeed}`, workflow_run_id: workflowRunId, step_id: workflowStepId,
      name: 'cert-step', state: 'WAITING_FOR_APPROVAL', depends_on: '[]', attempt: 1,
      side_effect_level: 'NONE', approval_required: true
    });
  }
  return { runId, request, target };
}

async function cleanup(runId: string): Promise<void> {
  await db('approval_resumption_outbox').where({ run_id: runId }).del();
  await db('session_grants').where({ principal_id: owner, workspace_id: workspaceId }).andWhere('session_id', runId).del();
  const workflow = await db('workflow_runs').where({ run_id: runId }).first();
  await db('runs').where({ id: runId }).del();
  if (workflow?.workflow_id) await db('workflow_definitions').where({ id: workflow.workflow_id }).del();
}

async function resolve(f: Fixture, decision: ApprovalDecision = 'ALLOW_ONCE') {
  const grant = decision === 'ALLOW_SESSION'
    ? { scope: 'SESSION' as const, riskCeiling: 'WRITE' as const }
    : decision === 'ALLOW_ALWAYS_FOR_TOOL'
      ? { scope: 'ALWAYS' as const, riskCeiling: 'WRITE' as const }
      : undefined;
  return repo.resolvePendingRequest(f.request.id, decision, owner, grant,
    decision === 'ALLOW_ONCE', f.target);
}

test('isolated PostgreSQL approval and resumption outbox certification', { skip: !enabled }, async (suite) => {

  await suite.test('concurrent identical decisions commit once; conflicting decisions cannot both win', async () => {
    const f = await fixture();
    try {
      const same = await Promise.all([
        resolve(f, 'ALLOW_SESSION'), resolve(f, 'ALLOW_SESSION')
      ]);
      assert.deepEqual(same.map((result) => result.applied).sort(), [false, true]);
      assert.equal(await db('session_grants').where({ principal_id: owner, session_id: f.runId, tool: 'cert_write' }).count('* as n').then((r) => Number(r[0].n)), 1);
      const grantDelivery = await repo.claimApprovalResumption('grant-consumer', 10_000, f.request.id);
      assert.ok(grantDelivery);
      assert.equal(await repo.applyApprovalResumption(grantDelivery!, 'grant-consumer'), true);
      assert.equal((await db('approval_resumption_outbox').where({ id: grantDelivery!.id }).first()).state, 'DISPATCHED_UNKNOWN');
    } finally { await cleanup(f.runId); }

    const other = await fixture();
    try {
      const results = await Promise.allSettled([resolve(other, 'ALLOW_ONCE'), resolve(other, 'REJECT')]);
      assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value.applied).length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      assert.equal(await db('approval_resumption_outbox').where({ run_id: other.runId }).count('* as n').then((r) => Number(r[0].n)), 1);
    } finally { await cleanup(other.runId); }

    const spoofedPrefix = await fixture(randomUUID(), undefined, `call_step_${randomUUID()}`);
    try {
      await resolve(spoofedPrefix, 'ALLOW_ONCE');
      const intent = await db('approval_resumption_outbox').where({ approval_id: spoofedPrefix.request.id }).first();
      assert.equal(intent.target_type, 'RUN');
      assert.equal(intent.workflow_run_id, null);
    } finally { await cleanup(spoofedPrefix.runId); }
  });

  await suite.test('grant validation failure rolls back decision and outbox atomically', async () => {
    const f = await fixture();
    try {
      await assert.rejects(() => repo.resolvePendingRequest(f.request.id, 'ALLOW_ONCE', 'other-resolver'));
      assert.equal((await db('approvals').where({ id: f.request.id }).first()).status, 'PENDING');
      const invalidGrant: ApprovalGrantRequest = { scope: 'ALWAYS', riskCeiling: 'DESTRUCTIVE' };
      await assert.rejects(() => repo.resolvePendingRequest(f.request.id, 'ALLOW_SESSION', owner, invalidGrant));
      assert.equal((await db('approvals').where({ id: f.request.id }).first()).status, 'PENDING');
      assert.equal(await db('approval_resumption_outbox').where({ approval_id: f.request.id }).first(), undefined);
      assert.equal(await db('session_grants').where({ principal_id: owner, workspace_id: workspaceId, tool: 'cert_write' }).first(), undefined);
    } finally { await cleanup(f.runId); }
  });

  await suite.test('standalone reusable grants derive workspace from an owned parent run', async () => {
    const f = await fixture();
    const grants = new PostgresSessionGrantRepository();
    const tool = `cert_always_${randomUUID()}`;
    try {
      await assert.rejects(() => grants.grantAlways(tool, owner, 'WRITE', f.runId, 'forged-workspace'));
      await assert.rejects(() => grants.grantAlways(tool, 'other-owner', 'WRITE', f.runId, workspaceId));
      assert.equal(await db('session_grants').where({ tool }).first(), undefined);

      await grants.grantAlways(tool, owner, 'WRITE', f.runId, workspaceId);
      const persisted = await db('session_grants').where({ tool, principal_id: owner, permission: 'ALWAYS' }).first();
      assert.equal(persisted?.workspace_id, workspaceId);
      assert.equal(persisted?.risk_ceiling, 'WRITE');
    } finally {
      await db('session_grants').where({ tool }).del();
      await cleanup(f.runId);
    }
  });

  await suite.test('transactional reusable grants persist the parent run workspace and requested risk ceiling', async () => {
    const f = await fixture();
    try {
      await resolve(f, 'ALLOW_ALWAYS_FOR_TOOL');
      const grant = await db('session_grants').where({
        principal_id: owner, workspace_id: workspaceId, tool: 'cert_write', permission: 'ALWAYS'
      }).first();
      assert.equal(grant?.risk_ceiling, 'WRITE');
    } finally {
      await db('session_grants').where({ principal_id: owner, workspace_id: workspaceId, tool: 'cert_write', permission: 'ALWAYS' }).del();
      await cleanup(f.runId);
    }
  });

  await suite.test('outbox claim takeover is fenced; crash recovery never reclaims dispatched-unknown work', async () => {
    const f = await fixture();
    try {
      await resolve(f);
      assert.equal((await db('approval_resumption_outbox').where({ approval_id: f.request.id }).first()).state, 'APPROVED_UNCLAIMED');
      const concurrentClaims = await Promise.all(['worker-a', 'worker-parallel'].map(async (claimOwner) => ({
        claimOwner, event: await repo.claimApprovalResumption(claimOwner, 10_000, f.request.id)
      })));
      assert.equal(concurrentClaims.filter(({ event }) => event).length, 1);
      const winningClaim = concurrentClaims.find(({ event }) => event)!;
      const workerA = winningClaim.event!;
      await db('approval_resumption_outbox').where({ id: workerA.id }).update({ lease_until: Date.now() - 1 });
      assert.equal(await repo.failApprovalResumption(workerA, winningClaim.claimOwner, 'late stale failure'), false);
      const workerB = await repo.claimApprovalResumption('worker-b', 10_000, f.request.id);
      assert.ok(workerB);
      assert.ok(workerB!.fencingToken > workerA.fencingToken);
      assert.equal(await repo.failApprovalResumption(workerA, winningClaim.claimOwner, 'superseded stale failure'), false);
      assert.equal(await repo.applyApprovalResumption(workerA, winningClaim.claimOwner), false);
      assert.equal(await repo.applyApprovalResumption(workerB!, 'worker-b'), true);
      const resumedRun = await db('runs').where({ id: f.runId }).first();
      const persistedApproval = typeof resumedRun.pending_approval === 'string'
        ? JSON.parse(resumedRun.pending_approval) : resumedRun.pending_approval;
      assert.equal(persistedApproval.decision, 'ALLOW_ONCE');
      assert.equal(resumedRun.state, 'RUNNING');
      assert.equal(resumedRun.execution_checkpoint, 'TOOL_APPROVED');
      assert.equal((await db('approval_resumption_outbox').where({ id: workerB!.id }).first()).state, 'DISPATCHED_UNKNOWN');
      assert.equal(await repo.claimApprovalResumption('worker-c', 10_000, f.request.id), undefined);
      // Simulate process loss after the atomic checkpoint commit. The outbox is
      // not replayed; the normal interrupted-run recovery scanner owns restart.
      await db('runs').where({ id: f.runId }).update({ recovery_lease_until: Date.now() - 1 });
      const runRepository = new PostgresRunRepository();
      assert.ok((await runRepository.getInterruptedRuns()).some((candidate) => candidate.id === f.runId));
      assert.equal(await runRepository.claimInterruptedRun(f.runId, 'restart-recovery-worker', 10_000), true);
      assert.equal(await repo.claimApprovalResumption('worker-c', 10_000, f.request.id), undefined);
      assert.equal(await repo.completeApprovalResumption(workerB!.id, { outcome: 'certified-result' }), true);
      assert.equal(await repo.completeApprovalResumption(workerB!.id, { outcome: 'duplicate' }), false);
      assert.equal((await db('approval_resumption_outbox').where({ id: workerB!.id }).first()).state, 'COMPLETED_WITH_RESULT');
    } finally { await cleanup(f.runId); }
  });

  await suite.test('concurrent ALLOW_ONCE claims enforce exact owner, call, argument, version, and policy binding', async () => {
    const f = await fixture();
    try {
      await resolve(f, 'ALLOW_ONCE');
      const resumption = await repo.claimApprovalResumption('once-test-dispatcher', 10_000, f.request.id);
      assert.ok(resumption);
      assert.equal(await repo.applyApprovalResumption(resumption!, 'once-test-dispatcher'), true);
      const base = {
        requestId: f.request.id, principalId: owner, workspaceId, runId: f.runId,
        toolCallId: f.request.toolCall.id, toolId: f.request.toolCall.toolId,
        toolName: f.request.toolCall.name, permissionLevel: 'WRITE' as const,
        toolDefinitionVersion: 1, toolPolicyFingerprint: 'a'.repeat(64),
        arguments: f.request.toolCall.arguments
      };
      await db('runs').where({ id: f.runId }).update({ workspace_id: null });
      const missingWorkspaceBinding = { ...base, workspaceId: undefined, claimId: 'missing-workspace' } as any;
      assert.equal(await repo.claimOnceAuthorization!(missingWorkspaceBinding), false);
      await db('runs').where({ id: f.runId }).update({ workspace_id: workspaceId });
      for (const mismatch of [
        { principalId: 'other-principal' }, { workspaceId: 'other-workspace' },
        { runId: 'other-run' }, { toolCallId: 'other-call' }, { toolId: 'other-tool-id' },
        { toolName: 'other-tool' }, { permissionLevel: 'DESTRUCTIVE' as const },
        { toolDefinitionVersion: 2 }, { toolPolicyFingerprint: 'b'.repeat(64) },
        { arguments: { payload: 'changed', count: 1 } }
      ]) {
        assert.equal(await repo.claimOnceAuthorization!({ ...base, ...mismatch, claimId: `mismatch-${randomUUID()}` }), false);
      }
      const candidates = ['claim-a', 'claim-b'];
      const claims = await Promise.all(candidates.map((claimId) => repo.claimOnceAuthorization!({ ...base, claimId })));
      assert.deepEqual([...claims].sort(), [false, true]);
      const winner = candidates[claims.indexOf(true)];
      const winnerBinding = { ...base, claimId: winner };
      await db('runs').where({ id: f.runId }).update({ workspace_id: 'tampered-workspace' });
      assert.equal(await repo.markOnceAuthorizationDispatched!(winnerBinding), false);
      await db('runs').where({ id: f.runId }).update({ workspace_id: workspaceId });
      assert.equal(await repo.markOnceAuthorizationDispatched!(winnerBinding), true);
      assert.equal(await repo.markOnceAuthorizationDispatched!(winnerBinding), false);
      assert.equal(await repo.claimOnceAuthorization!({ ...base, claimId: 'replay-after-dispatch' }), false);
    } finally { await cleanup(f.runId); }
  });

  await suite.test('workflow approval atomically advances only its matching pending step', async () => {
    const stepId = `cert_step_${randomUUID()}`;
    const f = await fixture(randomUUID(), stepId);
    const otherStepId = `cert_other_step_${randomUUID()}`;
    const otherWorkflow = await fixture(randomUUID(), otherStepId);
    try {
      await assert.rejects(() => repo.resolvePendingRequest(
        f.request.id, 'ALLOW_ONCE', owner, undefined, true,
        { type: 'WORKFLOW', workflowRunId: otherWorkflow.target.type === 'WORKFLOW' ? otherWorkflow.target.workflowRunId : 'invalid', workflowStepId: otherStepId }
      ));
      await assert.rejects(() => repo.resolvePendingRequest(
        f.request.id, 'ALLOW_ONCE', owner, undefined, true,
        { type: 'WORKFLOW', workflowRunId: f.target.type === 'WORKFLOW' ? f.target.workflowRunId : 'invalid', workflowStepId: otherStepId }
      ));
      if (f.target.type !== 'WORKFLOW') throw new Error('Workflow fixture must carry a persisted workflow target.');
      const duplicateStepRowId = `cert_wf_duplicate_${randomUUID()}`;
      await db('workflow_steps').insert({
        id: duplicateStepRowId, workflow_run_id: f.target.workflowRunId, step_id: stepId,
        name: 'ambiguous-duplicate-step', state: 'FAILED', depends_on: '[]', attempt: 1,
        side_effect_level: 'NONE', approval_required: true
      });
      await assert.rejects(() => repo.resolvePendingRequest(
        f.request.id, 'ALLOW_ONCE', owner, undefined, true, f.target
      ));
      await db('workflow_steps').where({ id: duplicateStepRowId }).del();
      assert.equal((await db('approvals').where({ id: f.request.id }).first()).status, 'PENDING');
      assert.equal(await db('approval_resumption_outbox').where({ approval_id: f.request.id }).first(), undefined);
      await resolve(f, 'ALLOW_ONCE');
      // Recreate a 028-era ambiguous intent and prove 029 repairs it only from
      // the persisted workflow-run/step relationship before any claim.
      await db('approval_resumption_outbox').where({ approval_id: f.request.id }).update({
        target_type: 'RUN', workflow_run_id: null, workflow_step_id: null
      });
      await repairApprovalResumptionTargets(db);
      const repairedIntent = await db('approval_resumption_outbox').where({ approval_id: f.request.id }).first();
      assert.equal(repairedIntent.target_type, 'WORKFLOW');
      assert.equal(repairedIntent.workflow_run_id, f.target.type === 'WORKFLOW' ? f.target.workflowRunId : undefined);
      const event = await repo.claimApprovalResumption('workflow-worker', 10_000, f.request.id);
      assert.ok(event);
      assert.equal(event!.targetType, 'WORKFLOW');
      assert.equal(event!.workflowRunId, f.target.type === 'WORKFLOW' ? f.target.workflowRunId : undefined);
      assert.equal(event!.workflowStepId, stepId);
      assert.equal(await repo.applyApprovalResumption(event!, 'workflow-worker'), true);
      const workflowRun = await db('workflow_runs').where({ run_id: f.runId }).first();
      const step = await db('workflow_steps').where({ workflow_run_id: workflowRun.id, step_id: stepId }).first();
      const run = await db('runs').where({ id: f.runId }).first();
      assert.equal(workflowRun.state, 'RUNNING');
      assert.equal(workflowRun.pending_approval_step_id, null);
      assert.equal(step.state, 'READY');
      assert.equal(run.execution_checkpoint, 'WORKFLOW_RUNNING');
      assert.equal(await repo.claimApprovalResumption('workflow-duplicate', 10_000, f.request.id), undefined);
    } finally {
      await cleanup(f.runId);
      await cleanup(otherWorkflow.runId);
    }
  });

  await suite.test('recoverable pre-dispatch failures retry with a newer fence; stale owner/workspace mismatches fail closed', async () => {
    const f = await fixture();
    try {
      await resolve(f);
      const first = await repo.claimApprovalResumption('worker-a', 10_000, f.request.id);
      assert.ok(first);
      assert.equal(await repo.failApprovalResumption(first!, 'worker-a', 'temporary pre-dispatch failure'), true);
      const failed = await db('approval_resumption_outbox').where({ id: first!.id }).first();
      assert.equal(failed.state, 'RECOVERABLY_FAILED');
      await db('approval_resumption_outbox').where({ id: first!.id }).update({ next_attempt_at: Date.now() - 1 });
      const retry = await repo.claimApprovalResumption('worker-b', 10_000, f.request.id);
      assert.ok(retry);
      assert.ok(retry!.fencingToken > first!.fencingToken);
      await db('runs').where({ id: f.runId }).update({ workspace_id: 'revoked-or-mismatched-workspace' });
      assert.equal(await repo.applyApprovalResumption(retry!, 'worker-b'), false);
      assert.equal((await db('approval_resumption_outbox').where({ id: retry!.id }).first()).state, 'CANCELLED_REVOKED');
    } finally { await cleanup(f.runId); }
  });

  await suite.test('cancelled targets become terminally cancelled and are never resumed', async () => {
    const f = await fixture();
    try {
      await resolve(f);
      const claim = await repo.claimApprovalResumption('worker-cancel', 10_000, f.request.id);
      assert.ok(claim);
      await db('runs').where({ id: f.runId }).update({ state: 'CANCELLED', status: 'CANCELLED' });
      assert.equal(await repo.applyApprovalResumption(claim!, 'worker-cancel'), false);
      assert.equal((await db('approval_resumption_outbox').where({ id: claim!.id }).first()).state, 'CANCELLED_REVOKED');
      assert.equal(await repo.claimApprovalResumption('worker-after-cancel', 10_000, f.request.id), undefined);
    } finally { await cleanup(f.runId); }

    const revoked = await fixture();
    try {
      await resolve(revoked, 'ALLOW_SESSION');
      await db('session_grants').where({ principal_id: owner, workspace_id: workspaceId, session_id: revoked.runId }).del();
      const revokedClaim = await repo.claimApprovalResumption('worker-revoked', 10_000, revoked.request.id);
      assert.ok(revokedClaim);
      assert.equal(await repo.applyApprovalResumption(revokedClaim!, 'worker-revoked'), false);
      assert.equal((await db('approval_resumption_outbox').where({ id: revokedClaim!.id }).first()).state, 'CANCELLED_REVOKED');
      assert.equal((await db('runs').where({ id: revoked.runId }).first()).state, 'WAITING_FOR_APPROVAL');
    } finally { await cleanup(revoked.runId); }
  });
});

test.after(async () => { if (enabled) await db.destroy(); });
