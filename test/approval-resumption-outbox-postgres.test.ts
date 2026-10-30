import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/src/index.js';
import { PostgresRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { up as repairApprovalResumptionTargets } from '../packages/db/src/migrations/029_authoritative_approval_resumption_targets.js';
import { PostgresApprovalRepository, PostgresSessionGrantRepository, ApprovalGrantRequest, ApprovalResolutionTarget } from '../packages/approvals/src/repositories.js';
import { derivePersonalWorkspaceId, PostgresWorkspaceAuthorityRepository } from '../packages/agent-runtime/src/workspace-authority.js';
import { PostgresSpecialistTaskRepository, type DurableSpecialistTask } from '../packages/agent-runtime/src/durable/specialist-task-repository.js';
import { SpecialistWorkerRuntime } from '../packages/agent-runtime/src/durable/specialist-worker-runtime.js';
import { TaskLeaseManager } from '../packages/agent-runtime/src/durable/task-lease-manager.js';
import { SpecialistRegistry } from '../packages/agent-runtime/src/specialists/specialist-registry.js';
import type { SpecialistExecutionResult } from '../packages/agent-runtime/src/specialists/specialist-interface.js';
import type { ApprovalDecision, ApprovalRequest } from '../packages/contracts/src/index.js';
import { createPostgresExecutionFixture } from './helpers/postgres-execution-fixture.js';

// This suite is mandatory only in postgres-certification.yml. Refuse an ordinary
// invocation instead of silently passing with a skipped PostgreSQL test.
if (process.env.AIRA_POSTGRES_CERTIFICATION !== '1') {
  throw new Error('Refusing PostgreSQL approval certification outside the authorized disposable PostgreSQL workflow.');
}
function hasDisposablePostgresContract(): boolean {
  if (
    process.env.NODE_ENV !== 'test' || process.env.CI_DISPOSABLE_DATABASE !== 'true' ||
    !process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.ISOLATED_TEST_DATABASE_URL
  ) return false;
  try {
    const url = new URL(process.env.DATABASE_URL);
    const user = process.env.CI_EXPECTED_DATABASE_USER || '';
    const database = process.env.CI_EXPECTED_DATABASE_NAME || '';
    const isLocal = (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === '55432';
    const isService = url.hostname === 'postgres' && url.port === '5432';
    if (!isLocal && !isService) return false;
    const expectedRegex = isLocal
      ? new RegExp('^postgresql://' + user + ':[a-f0-9]{64}@(127\\.0\\.0\\.1|localhost):55432/' + database + '$')
      : new RegExp('^postgresql://' + user + ':[a-f0-9]{64}@postgres:5432/' + database + '$');
    return url.protocol === 'postgresql:' &&
      decodeURIComponent(url.username) === user && decodeURIComponent(url.pathname.slice(1)) === database &&
      /^aira_ci_[0-9]+-[0-9]+$/.test(user) && /^aira_ci_[0-9]+-[0-9]+$/.test(database) &&
      expectedRegex.test(process.env.DATABASE_URL);
  } catch {
    return false;
  }
}
if (!hasDisposablePostgresContract()) {
  throw new Error('Refusing approval integration tests without the isolated run-scoped PostgreSQL contract.');
}
execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });
const repo = new PostgresApprovalRepository();

type Fixture = {
  runId: string;
  request: ApprovalRequest;
  target: ApprovalResolutionTarget;
  owner: string;
  workspaceId: string;
  sessionId: string;
  executionFixture: Awaited<ReturnType<typeof createPostgresExecutionFixture>>;
  workflowId?: string;
  workflowRunId?: string;
};

async function fixture(decisionSeed = randomUUID(), workflowStepId?: string, genericToolCallId?: string): Promise<Fixture> {
  const executionFixture = await createPostgresExecutionFixture({
    principalPrefix: 'cert_m2a_approval_owner', sessionPrefix: 'sess_cert_m2a_approval', tag: decisionSeed,
    roles: ['member'], scopes: ['tools:execute']
  });
  const owner = executionFixture.principal.userId;
  const workspaceId = executionFixture.principal.workspaceId!;
  const sessionId = executionFixture.principal.sessionId;
  const runId = `cert_approval_run_${decisionSeed}`;
  const requestId = `cert_approval_req_${decisionSeed}`;
  const callId = `cert_approval_call_${decisionSeed}`;
  const now = Date.now();
  await executionFixture.createParentRun(runId, {
    prompt: 'disposable approval certification fixture', status: 'WAITING_FOR_APPROVAL',
    state: 'WAITING_FOR_APPROVAL', executionCheckpoint: 'WAITING_FOR_APPROVAL'
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
  let workflowId: string | undefined;
  let workflowRunId: string | undefined;
  const target: ApprovalResolutionTarget = workflowStepId
    ? { type: 'WORKFLOW', workflowRunId: `cert_wf_run_${decisionSeed}`, workflowStepId }
    : { type: 'RUN' };
  if (workflowStepId) {
    workflowId = `cert_wf_def_${decisionSeed}`;
    workflowRunId = `cert_wf_run_${decisionSeed}`;
    await db('workflow_definitions').insert({
      id: workflowId, version: 1, name: 'Disposable approval workflow', principal_id: owner,
      input_schema: '{}', steps: JSON.stringify([{ stepId: workflowStepId, name: 'cert-step', type: 'TOOL', dependsOn: [] }]),
      execution_policy: '{}', output_schema: '{}', created_at: now, updated_at: now
    });
    await db('workflow_runs').insert({
      id: workflowRunId, workflow_id: workflowId, run_id: runId, principal_id: owner,
      session_id: sessionId, state: 'WAITING_FOR_APPROVAL',
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
  return { runId, request, target, owner, workspaceId, sessionId, executionFixture, workflowId, workflowRunId };
}

async function cleanup(f: Fixture): Promise<void> {
  // The helper deletes this run’s RESTRICT-linked outbox rows before the run,
  // which cascades its workflow run; then remove only the owned workflow definition.
  await f.executionFixture.cleanup();
  if (f.workflowRunId) await db('workflow_runs').where({ id: f.workflowRunId }).del();
  if (f.workflowId) await db('workflow_definitions').where({ id: f.workflowId }).del();
}

async function resolve(f: Fixture, decision: ApprovalDecision = 'ALLOW_ONCE') {
  const grant = decision === 'ALLOW_SESSION'
    ? { scope: 'SESSION' as const, riskCeiling: 'WRITE' as const }
    : decision === 'ALLOW_ALWAYS_FOR_TOOL'
      ? { scope: 'ALWAYS' as const, riskCeiling: 'WRITE' as const }
      : undefined;
  return repo.resolvePendingRequest(f.request.id, decision, f.owner, grant,
    decision === 'ALLOW_ONCE', f.target);
}

test('isolated PostgreSQL approval and resumption outbox certification', async (suite) => {
  await suite.test('workspace authority provisions atomically, isolates owners, and preserves revocation tombstones', async () => {
    const authorities = new PostgresWorkspaceAuthorityRepository();
    const principalId = `cert_workspace_${randomUUID()}`;
    const racePrincipalId = `cert_workspace_race_${randomUUID()}`;
    const tombstonePrincipalId = `cert_workspace_revoked_${randomUUID()}`;
    try {
      const [first, second] = await Promise.all([
        authorities.resolveWorkspace(principalId),
        authorities.resolveWorkspace(principalId)
      ]);
      assert.equal(first, derivePersonalWorkspaceId(principalId));
      assert.equal(second, first);
      assert.equal(await db('principal_workspace_authorities').where({ principal_id: principalId }).count('* as n').then(rows => Number(rows[0].n)), 1);
      assert.equal(await authorities.isWorkspaceActive(principalId, first), true);
      assert.equal(await authorities.isWorkspaceActive(`foreign_${principalId}`, first), false);

      await assert.rejects(() => db('principal_workspace_authorities').insert({
        principal_id: `cert_workspace_duplicate_${randomUUID()}`, workspace_id: first,
        state: 'ACTIVE', created_at: Date.now(), updated_at: Date.now(), revoked_at: null
      }));
      await assert.rejects(() => db('principal_workspace_authorities').insert({
        principal_id: `cert_workspace_invalid_state_${randomUUID()}`, workspace_id: `invalid_${randomUUID()}`,
        state: 'INVALID', created_at: Date.now(), updated_at: Date.now(), revoked_at: null
      }));
      await assert.rejects(() => db('principal_workspace_authorities').insert({
        principal_id: `cert_workspace_bad_active_${randomUUID()}`, workspace_id: `invalid_${randomUUID()}`,
        state: 'ACTIVE', created_at: Date.now(), updated_at: Date.now(), revoked_at: Date.now()
      }));
      await assert.rejects(() => db('principal_workspace_authorities').insert({
        principal_id: `cert_workspace_bad_revoked_${randomUUID()}`, workspace_id: `invalid_${randomUUID()}`,
        state: 'REVOKED', created_at: Date.now(), updated_at: Date.now(), revoked_at: null
      }));

      const race = await Promise.allSettled([
        authorities.resolveWorkspace(racePrincipalId),
        authorities.revokeWorkspace(racePrincipalId)
      ]);
      assert.equal(race[1].status, 'fulfilled');
      assert.equal(race[1].status === 'fulfilled' && race[1].value, true);
      const raceWorkspaceId = derivePersonalWorkspaceId(racePrincipalId);
      assert.equal(await authorities.isWorkspaceActive(racePrincipalId, raceWorkspaceId), false);
      await assert.rejects(() => authorities.resolveWorkspace(racePrincipalId), /no active workspace authority/i);

      assert.equal(await authorities.revokeWorkspace(tombstonePrincipalId), true);
      assert.equal(await authorities.isWorkspaceActive(tombstonePrincipalId, derivePersonalWorkspaceId(tombstonePrincipalId)), false);
      await assert.rejects(() => authorities.resolveWorkspace(tombstonePrincipalId), /no active workspace authority/i);
    } finally {
      await db('principal_workspace_authorities')
        .whereIn('principal_id', [principalId, racePrincipalId, tombstonePrincipalId])
        .del();
    }
  });

  await suite.test('legacy run workspace values cannot create an approval without persisted authority', async () => {
    const principalId = `cert_legacy_run_owner_${randomUUID()}`;
    const workspaceId = `legacy_client_workspace_${randomUUID()}`;
    const runId = `cert_legacy_run_${randomUUID()}`;
    const requestId = `cert_legacy_approval_${randomUUID()}`;
    const toolCallId = `cert_legacy_call_${randomUUID()}`;
    const now = Date.now();
    const request: ApprovalRequest = {
      id: requestId,
      runId,
      toolCall: { id: toolCallId, toolId: 'tool_legacy_write', name: 'legacy_write', arguments: { value: 1 }, timestamp: now },
      risk: 'medium', title: 'Legacy workspace approval', reason: 'must fail closed',
      sanitizedPreview: { value: 1 }, requestedAt: now, workspaceId,
      permissionLevel: 'WRITE', toolDefinitionVersion: 1, toolPolicyFingerprint: 'b'.repeat(64)
    };
    try {
      await db('runs').insert({
        id: runId, principal_id: principalId, session_id: `sess_${principalId}`, workspace_id: workspaceId,
        prompt: 'legacy workspace must not gain authority', status: 'WAITING_FOR_APPROVAL',
        state: 'WAITING_FOR_APPROVAL', createdAt: now, updatedAt: now,
        toolsUsed: '[]', toolCalls: '[]', toolResults: '[]'
      });
      assert.equal(await db('principal_workspace_authorities').where({ principal_id: principalId }).first(), undefined);
      await assert.rejects(() => repo.saveRequest(request), /active workspace authority/i);
      assert.equal(await db('tool_calls').where({ id: toolCallId }).first(), undefined);
      assert.equal(await db('approvals').where({ id: requestId }).first(), undefined);
    } finally {
      await db('approvals').where({ id: requestId }).del();
      await db('tool_calls').where({ id: toolCallId }).del();
      await db('runs').where({ id: runId }).del();
      await db('principal_workspace_authorities').where({ principal_id: principalId }).del();
    }
  });

  await suite.test('approval persistence accepts active authority and rejects missing or revoked authority', async () => {
    const authorities = new PostgresWorkspaceAuthorityRepository();
    const cases = [
      { label: 'active', principalId: `cert_save_active_${randomUUID()}` },
      { label: 'missing', principalId: `cert_save_missing_${randomUUID()}` },
      { label: 'revoked', principalId: `cert_save_revoked_${randomUUID()}` }
    ];
    const runIds = cases.map(({ label }) => `cert_save_${label}_run_${randomUUID()}`);
    const requestIds = cases.map(({ label }) => `cert_save_${label}_approval_${randomUUID()}`);
    const callIds = cases.map(({ label }) => `cert_save_${label}_call_${randomUUID()}`);
    const now = Date.now();

    try {
      const activeWorkspaceId = await authorities.resolveWorkspace(cases[0].principalId);
      const missingWorkspaceId = derivePersonalWorkspaceId(cases[1].principalId);
      const revokedWorkspaceId = await authorities.resolveWorkspace(cases[2].principalId);
      assert.equal(await authorities.revokeWorkspace(cases[2].principalId), true);
      const workspaceIds = [activeWorkspaceId, missingWorkspaceId, revokedWorkspaceId];

      for (let index = 0; index < cases.length; index += 1) {
        const { label, principalId } = cases[index];
        const runId = runIds[index];
        const workspaceId = workspaceIds[index];
        const request: ApprovalRequest = {
          id: requestIds[index],
          runId,
          toolCall: {
            id: callIds[index], toolId: 'tool_cert_write', name: 'cert_write',
            arguments: { case: label }, timestamp: now
          },
          risk: 'medium', title: `Authority ${label} approval`, reason: 'Persistence authority regression',
          sanitizedPreview: { case: label }, requestedAt: now, workspaceId,
          permissionLevel: 'WRITE', toolDefinitionVersion: 1, toolPolicyFingerprint: 'c'.repeat(64)
        };
        await db('runs').insert({
          id: runId, principal_id: principalId, session_id: `sess_${principalId}`, workspace_id: workspaceId,
          prompt: `approval persistence ${label} authority`, status: 'WAITING_FOR_APPROVAL',
          state: 'WAITING_FOR_APPROVAL', createdAt: now, updatedAt: now,
          toolsUsed: '[]', toolCalls: '[]', toolResults: '[]'
        });

        if (label === 'active') {
          await repo.saveRequest(request);
          assert.ok(await db('approvals').where({ id: request.id }).first());
          assert.ok(await db('tool_calls').where({ id: request.toolCall.id }).first());
        } else {
          await assert.rejects(() => repo.saveRequest(request), /active workspace authority/i);
          assert.equal(await db('approvals').where({ id: request.id }).first(), undefined);
          assert.equal(await db('tool_calls').where({ id: request.toolCall.id }).first(), undefined);
        }
      }
    } finally {
      await db('approvals').whereIn('id', requestIds).del();
      await db('tool_calls').whereIn('id', callIds).del();
      await db('runs').whereIn('id', runIds).del();
      await db('principal_workspace_authorities').whereIn('principal_id', cases.map(({ principalId }) => principalId)).del();
    }
  });

  await suite.test('PostgreSQL worker recovery requires live authority and never backfills legacy task workspaces', async () => {
    const authorities = new PostgresWorkspaceAuthorityRepository();
    const taskRepository = new PostgresSpecialistTaskRepository();
    const activePrincipalId = `cert_worker_active_${randomUUID()}`;
    const legacyPrincipalId = `cert_worker_legacy_${randomUUID()}`;
    const activeWorkspaceId = await authorities.resolveWorkspace(activePrincipalId);
    const legacyWorkspaceId = `legacy_client_workspace_${randomUUID()}`;
    const activeRunId = `cert_worker_run_${randomUUID()}`;
    const legacyRunId = `cert_worker_run_${randomUUID()}`;
    const activeTaskId = `cert_worker_task_${randomUUID()}`;
    const legacyTaskId = `cert_worker_task_${randomUUID()}`;
    const now = Date.now();

    const insertRun = async (id: string, principalId: string, workspaceId: string) => db('runs').insert({
      id, principal_id: principalId, workspace_id: workspaceId, session_id: `sess_${principalId}`,
      prompt: 'disposable worker authority fixture', status: 'RUNNING', state: 'RUNNING',
      createdAt: now, updatedAt: now, toolsUsed: '[]', toolCalls: '[]', toolResults: '[]'
    });
    const makeTask = (id: string, runId: string, principalId: string, workspaceId: string): DurableSpecialistTask => ({
      id, runId, principalId, workspaceId, role: 'analyst', objective: 'worker authority certification',
      state: 'QUEUED', dependencies: [], inputPayload: { expression: '1 + 1' },
      executionConstraints: { allowedTools: ['calculator'] } as DurableSpecialistTask['executionConstraints'],
      authorizationRequirements: {}, budgetLimits: { maxTokens: 1000 }, timeoutMs: 5000,
      attemptCount: 0, maxRetries: 0, backoffMultiplier: 1.5, fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 }, provenance: { workerId: 'certification' },
      checkpoints: [], createdAt: now, updatedAt: now
    });

    try {
      await insertRun(activeRunId, activePrincipalId, activeWorkspaceId);
      await insertRun(legacyRunId, legacyPrincipalId, legacyWorkspaceId);
      await taskRepository.saveTask(makeTask(activeTaskId, activeRunId, activePrincipalId, activeWorkspaceId));
      await taskRepository.saveTask(makeTask(legacyTaskId, legacyRunId, legacyPrincipalId, legacyWorkspaceId));

      const activeIdentity = await taskRepository.getAuthoritativeExecutionIdentity(activeTaskId);
      assert.equal(activeIdentity?.workspaceAuthorityActive, true);
      assert.equal(activeIdentity?.taskPrincipalId, activePrincipalId);
      assert.equal(activeIdentity?.runPrincipalId, activePrincipalId);
      assert.equal(activeIdentity?.taskWorkspaceId, activeWorkspaceId);
      assert.equal(activeIdentity?.runWorkspaceId, activeWorkspaceId);

      const legacyIdentity = await taskRepository.getAuthoritativeExecutionIdentity(legacyTaskId);
      assert.equal(legacyIdentity?.workspaceAuthorityActive, false);
      assert.equal(await db('principal_workspace_authorities').where({ principal_id: legacyPrincipalId }).first(), undefined,
        'A legacy task must not cause historical workspace data to be backfilled as authority.');

      assert.equal(await authorities.revokeWorkspace(activePrincipalId), true);
      assert.equal((await taskRepository.getAuthoritativeExecutionIdentity(activeTaskId))?.workspaceAuthorityActive, false);
      await assert.rejects(() => authorities.resolveWorkspace(activePrincipalId), /no active workspace authority/i);
      assert.equal((await taskRepository.getAuthoritativeExecutionIdentity(legacyTaskId))?.workspaceAuthorityActive, false);

      let dispatched = false;
      const specialists = new SpecialistRegistry();
      specialists.registerSpecialist({
        role: 'analyst', name: 'PostgreSQL revocation fixture', description: 'must not dispatch after revocation',
        requiredCapabilities: [], canExecute: () => ({ authorized: true }),
        async execute() { dispatched = true; return {} as SpecialistExecutionResult; }
      }, 'IMPLEMENTED_LOCALLY');
      const worker = new SpecialistWorkerRuntime(taskRepository, new TaskLeaseManager(taskRepository), specialists, {
        workerId: 'postgres_revocation_certification', leaseDurationMs: 5000, heartbeatIntervalMs: 1000
      });
      const recovered = await worker.executeTask((await taskRepository.getTask(activeTaskId))!);
      assert.equal(dispatched, false, 'Durable recovery must not dispatch after the persisted authority tombstone.');
      assert.equal(recovered.error?.code, 'WORKER_AUTHORIZATION_DENIED');
      assert.equal((await taskRepository.getTask(activeTaskId))?.state, 'FAILED');
      const legacyRecovered = await worker.executeTask((await taskRepository.getTask(legacyTaskId))!);
      assert.equal(dispatched, false, 'Legacy workspace identifiers must not authorize specialist dispatch.');
      assert.equal(legacyRecovered.error?.code, 'WORKER_AUTHORIZATION_DENIED');
      assert.equal((await taskRepository.getTask(legacyTaskId))?.state, 'FAILED');
    } finally {
      await db('specialist_tasks').whereIn('id', [activeTaskId, legacyTaskId]).del();
      await db('runs').whereIn('id', [activeRunId, legacyRunId]).del();
      await db('principal_workspace_authorities').where({ principal_id: activePrincipalId }).del();
      await db('principal_workspace_authorities').where({ principal_id: legacyPrincipalId }).del();
    }
  });

  await suite.test('concurrent identical decisions commit once; conflicting decisions cannot both win', async () => {
    const f = await fixture();
    try {
      const same = await Promise.all([
        resolve(f, 'ALLOW_SESSION'), resolve(f, 'ALLOW_SESSION')
      ]);
      assert.deepEqual(same.map((result) => result.applied).sort(), [false, true]);
      assert.equal(await db('session_grants').where({ principal_id: f.owner, session_id: f.runId, tool: 'cert_write' }).count('* as n').then((r) => Number(r[0].n)), 1);
      const grantDelivery = await repo.claimApprovalResumption('grant-consumer', 10_000, f.request.id);
      assert.ok(grantDelivery);
      assert.equal(await repo.applyApprovalResumption(grantDelivery!, 'grant-consumer'), true);
      assert.equal((await db('approval_resumption_outbox').where({ id: grantDelivery!.id }).first()).state, 'DISPATCHED_UNKNOWN');
    } finally { await cleanup(f); }

    const other = await fixture();
    try {
      const results = await Promise.allSettled([resolve(other, 'ALLOW_ONCE'), resolve(other, 'REJECT')]);
      assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value.applied).length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      assert.equal(await db('approval_resumption_outbox').where({ run_id: other.runId }).count('* as n').then((r) => Number(r[0].n)), 1);
    } finally { await cleanup(other); }

    const spoofedPrefix = await fixture(randomUUID(), undefined, `call_step_${randomUUID()}`);
    try {
      await resolve(spoofedPrefix, 'ALLOW_ONCE');
      const intent = await db('approval_resumption_outbox').where({ approval_id: spoofedPrefix.request.id }).first();
      assert.equal(intent.target_type, 'RUN');
      assert.equal(intent.workflow_run_id, null);
    } finally { await cleanup(spoofedPrefix); }
  });

  await suite.test('grant validation failure rolls back decision and outbox atomically', async () => {
    const f = await fixture();
    try {
      await assert.rejects(() => repo.resolvePendingRequest(f.request.id, 'ALLOW_ONCE', 'other-resolver'));
      assert.equal((await db('approvals').where({ id: f.request.id }).first()).status, 'PENDING');
      const invalidGrant: ApprovalGrantRequest = { scope: 'ALWAYS', riskCeiling: 'DESTRUCTIVE' };
      await assert.rejects(() => repo.resolvePendingRequest(f.request.id, 'ALLOW_SESSION', f.owner, invalidGrant));
      assert.equal((await db('approvals').where({ id: f.request.id }).first()).status, 'PENDING');
      assert.equal(await db('approval_resumption_outbox').where({ approval_id: f.request.id }).first(), undefined);
      assert.equal(await db('session_grants').where({ principal_id: f.owner, workspace_id: f.workspaceId, tool: 'cert_write' }).first(), undefined);
    } finally { await cleanup(f); }
  });

  await suite.test('revoked workspace authority blocks approval decisions and reusable grants', async () => {
    const f = await fixture();
    const grants = new PostgresSessionGrantRepository();
    const tool = `cert_revoked_${randomUUID()}`;
    try {
      await db('principal_workspace_authorities').where({ principal_id: f.owner, workspace_id: f.workspaceId })
        .update({ state: 'REVOKED', revoked_at: Date.now(), updated_at: Date.now() });
      await assert.rejects(() => resolve(f, 'ALLOW_ONCE'), /active workspace authority/i);
      assert.equal((await db('approvals').where({ id: f.request.id }).first()).status, 'PENDING');
      assert.equal(await db('approval_resumption_outbox').where({ approval_id: f.request.id }).first(), undefined);
      await assert.rejects(() => grants.grantSession(f.runId, tool, f.owner, 'WRITE'), /active workspace authority/i);
      await assert.rejects(() => grants.grantAlways(tool, f.owner, 'WRITE', f.runId, f.workspaceId), /active workspace authority/i);
      assert.equal(await grants.hasSessionGrant(f.runId, tool, f.owner, 'WRITE'), false);
      assert.equal(await grants.hasAlwaysGrant(tool, f.owner, 'WRITE', f.runId), false);
    } finally {
      await db('principal_workspace_authorities').where({ principal_id: f.owner, workspace_id: f.workspaceId })
        .update({ state: 'ACTIVE', revoked_at: null, updated_at: Date.now() });
      await cleanup(f);
    }
  });

  await suite.test('standalone reusable grants derive workspace from an owned parent run', async () => {
    const f = await fixture();
    const grants = new PostgresSessionGrantRepository();
    const tool = `cert_always_${randomUUID()}`;
    try {
      await assert.rejects(() => grants.grantAlways(tool, f.owner, 'WRITE', f.runId, 'forged-workspace'));
      await assert.rejects(() => grants.grantAlways(tool, 'other-owner', 'WRITE', f.runId, f.workspaceId));
      assert.equal(await db('session_grants').where({ tool }).first(), undefined);

      await grants.grantAlways(tool, f.owner, 'WRITE', f.runId, f.workspaceId);
      const persisted = await db('session_grants').where({ tool, principal_id: f.owner, permission: 'ALWAYS' }).first();
      assert.equal(persisted?.workspace_id, f.workspaceId);
      assert.equal(persisted?.risk_ceiling, 'WRITE');
    } finally {
      await db('session_grants').where({ tool }).del();
      await cleanup(f);
    }
  });

  await suite.test('transactional reusable grants persist the parent run workspace and requested risk ceiling', async () => {
    const f = await fixture();
    try {
      await resolve(f, 'ALLOW_ALWAYS_FOR_TOOL');
      const grant = await db('session_grants').where({
        principal_id: f.owner, workspace_id: f.workspaceId, tool: 'cert_write', permission: 'ALWAYS'
      }).first();
      assert.equal(grant?.risk_ceiling, 'WRITE');
    } finally {
      await db('session_grants').where({ principal_id: f.owner, workspace_id: f.workspaceId, tool: 'cert_write', permission: 'ALWAYS' }).del();
      await cleanup(f);
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
    } finally { await cleanup(f); }
  });

  await suite.test('concurrent ALLOW_ONCE claims enforce exact owner, call, argument, version, and policy binding', async () => {
    const f = await fixture();
    try {
      await resolve(f, 'ALLOW_ONCE');
      const resumption = await repo.claimApprovalResumption('once-test-dispatcher', 10_000, f.request.id);
      assert.ok(resumption);
      assert.equal(await repo.applyApprovalResumption(resumption!, 'once-test-dispatcher'), true);
      const base = {
        requestId: f.request.id, principalId: f.owner, workspaceId: f.workspaceId, runId: f.runId,
        toolCallId: f.request.toolCall.id, toolId: f.request.toolCall.toolId,
        toolName: f.request.toolCall.name, permissionLevel: 'WRITE' as const,
        toolDefinitionVersion: 1, toolPolicyFingerprint: 'a'.repeat(64),
        arguments: f.request.toolCall.arguments
      };
      await db('runs').where({ id: f.runId }).update({ workspace_id: null });
      const missingWorkspaceBinding = { ...base, workspaceId: undefined, claimId: 'missing-workspace' } as any;
      assert.equal(await repo.claimOnceAuthorization!(missingWorkspaceBinding), false);
      await db('runs').where({ id: f.runId }).update({ workspace_id: f.workspaceId });
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
      await db('runs').where({ id: f.runId }).update({ workspace_id: f.workspaceId });
      assert.equal(await repo.markOnceAuthorizationDispatched!(winnerBinding), true);
      assert.equal(await repo.markOnceAuthorizationDispatched!(winnerBinding), false);
      assert.equal(await repo.claimOnceAuthorization!({ ...base, claimId: 'replay-after-dispatch' }), false);
    } finally { await cleanup(f); }
  });

  await suite.test('workflow approval atomically advances only its matching pending step', async () => {
    const stepId = `cert_step_${randomUUID()}`;
    const f = await fixture(randomUUID(), stepId);
    const otherStepId = `cert_other_step_${randomUUID()}`;
    const otherWorkflow = await fixture(randomUUID(), otherStepId);
    try {
      await assert.rejects(() => repo.resolvePendingRequest(
        f.request.id, 'ALLOW_ONCE', f.owner, undefined, true,
        { type: 'WORKFLOW', workflowRunId: otherWorkflow.target.type === 'WORKFLOW' ? otherWorkflow.target.workflowRunId : 'invalid', workflowStepId: otherStepId }
      ));
      await assert.rejects(() => repo.resolvePendingRequest(
        f.request.id, 'ALLOW_ONCE', f.owner, undefined, true,
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
        f.request.id, 'ALLOW_ONCE', f.owner, undefined, true, f.target
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
      await cleanup(f);
      await cleanup(otherWorkflow);
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
    } finally { await cleanup(f); }
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
    } finally { await cleanup(f); }

    const revoked = await fixture();
    try {
      await resolve(revoked, 'ALLOW_SESSION');
      await db('session_grants').where({ principal_id: revoked.owner, workspace_id: revoked.workspaceId, session_id: revoked.runId }).del();
      const revokedClaim = await repo.claimApprovalResumption('worker-revoked', 10_000, revoked.request.id);
      assert.ok(revokedClaim);
      assert.equal(await repo.applyApprovalResumption(revokedClaim!, 'worker-revoked'), false);
      assert.equal((await db('approval_resumption_outbox').where({ id: revokedClaim!.id }).first()).state, 'CANCELLED_REVOKED');
      assert.equal((await db('runs').where({ id: revoked.runId }).first()).state, 'WAITING_FOR_APPROVAL');
    } finally { await cleanup(revoked); }
  });
});

test.after(async () => { await db.destroy(); });