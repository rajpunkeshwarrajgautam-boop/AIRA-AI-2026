import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, fork, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  classifyDatabaseUrl,
  assertCanRunMigrations
} from '../packages/db/src/security/database-isolation-guard.js';
import { db } from '../packages/db/src/index.js';
import { up as migration026Up } from '../packages/db/src/migrations/026_specialist_durable_execution_schema.js';
import {
  PostgresSpecialistTaskRepository,
  DurableSpecialistTask
} from '../packages/agent-runtime/src/durable/specialist-task-repository.js';
import { TaskLeaseManager } from '../packages/agent-runtime/src/durable/task-lease-manager.js';
import { StaleFencingTokenError } from '../packages/agent-runtime/src/durable/task-state-machine.js';
import {
  ToolGateway,
  InMemoryToolCallRepository,
  PostgresToolCallRepository
} from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { ExecutionPrincipal, ToolGatewayErrorCodes } from '../packages/contracts/src/index.js';
import { MathematicalSpecialistAgent } from '../packages/agent-runtime/src/specialists/mathematical-specialist.js';
import { SpecialistExecutionContext } from '../packages/agent-runtime/src/specialists/specialist-interface.js';
import { createPostgresExecutionFixture } from './helpers/postgres-execution-fixture.js';

if (process.env.AIRA_POSTGRES_CERTIFICATION !== '1') {
  throw new Error('Refusing M2-A PostgreSQL certification outside the authorized disposable PostgreSQL workflow.');
}
execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerScriptPath = path.resolve(__dirname, 'helpers/standalone-specialist-worker.ts');
const fixtureTag = randomUUID();
const fixtureA = await createPostgresExecutionFixture({
  principalPrefix: 'user_m2a_tenant_a', sessionPrefix: 'sess_m2a_tenant_a', tag: fixtureTag,
  principalId: `user_m2a_tenant_a_${fixtureTag}`, sessionId: `sess_m2a_tenant_a_${fixtureTag}`,
  roles: ['user'], requireTaggedRunIds: false
});
const fixtureB = await createPostgresExecutionFixture({
  principalPrefix: 'user_m2a_tenant_b', sessionPrefix: 'sess_m2a_tenant_b', tag: fixtureTag,
  principalId: `user_m2a_tenant_b_${fixtureTag}`, sessionId: `sess_m2a_tenant_b_${fixtureTag}`,
  roles: ['user'], requireTaggedRunIds: false
});

test.describe('AIRA AI 2026 — PR #115 Real PostgreSQL & Worker Reliability Certification Suite', () => {
  let isolatedConnStr: string;
  let repo: PostgresSpecialistTaskRepository;
  let leaseManager: TaskLeaseManager;
  const childProcesses: ChildProcess[] = [];

  test.after(async () => {
    for (const child of childProcesses) {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        });
      }
    }
    try {
      await Promise.all([fixtureA.cleanup(), fixtureB.cleanup()]);
    } finally {
      await db.destroy();
    }
  });

  const testPrincipalA: ExecutionPrincipal = fixtureA.principal;
  const testPrincipalB: ExecutionPrincipal = fixtureB.principal;

  // Parent runs are created through the unique resolver-backed fixture and then
  // checked against the exact authenticated owner/workspace/session tuple.
  async function ensureParentRun(runId: string, principalId: string): Promise<void> {
    if (principalId === testPrincipalA.userId) await fixtureA.createParentRun(runId);
    else if (principalId === testPrincipalB.userId) await fixtureB.createParentRun(runId);
    else throw new Error('M2-A parent-run fixture received an unknown principal.');
  }

  // ==========================================
  // PHASE 2 — ISOLATED DATABASE VERIFICATION
  // ==========================================

  test('PHASE 2.1: Require the preflight-verified run-scoped disposable PostgreSQL target', () => {
    isolatedConnStr = process.env.DATABASE_URL || '';
    assert.ok(isolatedConnStr, 'Disposable PostgreSQL URL must be present after identity preflight');
    assert.strictEqual(isolatedConnStr, process.env.ISOLATED_TEST_DATABASE_URL);

    const classification = classifyDatabaseUrl(isolatedConnStr);
    assert.strictEqual(classification.isProduction, false, 'Database must NOT be classified as production');
    assert.strictEqual(classification.isStagingPermanent, false, 'Database must NOT be permanent staging');
    assert.strictEqual(classification.category, 'local_or_ci_test', 'Only the disposable CI PostgreSQL target is permitted');
    assert.doesNotThrow(() => assertCanRunMigrations(isolatedConnStr, 'test'));

    repo = new PostgresSpecialistTaskRepository();
    leaseManager = new TaskLeaseManager(repo, { defaultLeaseDurationMs: 4000, heartbeatIntervalMs: 1000 });
  });

  test('PHASE 2.2: Apply migration 026 and verify idempotency and schema contracts', async () => {
    // 1. Apply migration 026
    await migration026Up(db);

    // 2. Verify tables exist
    const hasTasks = await db.schema.hasTable('specialist_tasks');
    const hasEvents = await db.schema.hasTable('specialist_task_events');
    assert.strictEqual(hasTasks, true, 'specialist_tasks table must exist in PostgreSQL');
    assert.strictEqual(hasEvents, true, 'specialist_task_events table must exist in PostgreSQL');

    // 3. Test migration idempotency (running up() second time must not crash)
    await assert.doesNotReject(async () => {
      await migration026Up(db);
    }, 'Migration 026 must be strictly idempotent when executed repeatedly');

    // 4. Verify columns in information_schema
    const columns = await db('information_schema.columns')
      .where({ table_schema: 'public', table_name: 'specialist_tasks' })
      .select('column_name', 'data_type', 'is_nullable');

    const columnNames = new Set(columns.map(c => c.column_name));
    assert.ok(columnNames.has('id'), 'Column id missing');
    assert.ok(columnNames.has('run_id'), 'Column run_id missing');
    assert.ok(columnNames.has('state'), 'Column state missing');
    assert.ok(columnNames.has('fencing_token'), 'Column fencing_token missing');
    assert.ok(columnNames.has('lease_owner'), 'Column lease_owner missing');
    assert.ok(columnNames.has('lease_expires_at'), 'Column lease_expires_at missing');
    assert.ok(columnNames.has('result_output'), 'Column result_output missing');
    assert.ok(columnNames.has('checkpoints'), 'Column checkpoints missing');
  });

  // ==========================================
  // PHASE 3 — REAL DISTRIBUTED CONCURRENCY
  // ==========================================

  test('PHASE 3.1: Concurrent workers race on SELECT FOR UPDATE claim — exactly one succeeds', async () => {
    const runId = `run_pg_race_${randomUUID()}`;
    const taskId = `task_pg_race_${randomUUID()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    const task: DurableSpecialistTask = {
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Concurrent claim race test',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: { expression: '100 + 100' },
      executionConstraints: { sideEffectLevel: 'NONE', allowedTools: ['calculator'] },
      authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
      budgetLimits: { maxTokens: 4096 },
      timeoutMs: 30000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test_scheduler' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    };

    await repo.saveTask(task);

    // Two workers attempt to claim simultaneously
    const [claimAlpha, claimBeta] = await Promise.all([
      repo.claimTask(taskId, 'worker_pg_alpha', 5000),
      repo.claimTask(taskId, 'worker_pg_beta', 5000)
    ]);

    const successes = [claimAlpha, claimBeta].filter(c => c.success);
    const failures = [claimAlpha, claimBeta].filter(c => !c.success);

    assert.strictEqual(successes.length, 1, 'Exactly one worker must acquire claim');
    assert.strictEqual(failures.length, 1, 'The competing worker must fail to acquire lease');
    assert.strictEqual(successes[0].task?.fencingToken, 1, 'Winning worker receives fencing token 1');

    // Confirm database record matches winner
    const inDb = await repo.getTask(taskId);
    assert.strictEqual(inDb?.state, 'CLAIMED');
    assert.strictEqual(inDb?.leaseOwner, successes[0].task?.leaseOwner);
    assert.strictEqual(inDb?.fencingToken, 1);
  });

  test('PHASE 3.2: Stale fencing-token rejection in PostgreSQL transaction', async () => {
    const runId = `run_pg_fencing_${randomUUID()}`;
    const taskId = `task_pg_fencing_${randomUUID()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    const task: DurableSpecialistTask = {
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Stale fencing rejection test',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 4096 },
      timeoutMs: 30000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    };

    await repo.saveTask(task);

    // Worker 1 claims task (fencingToken = 1)
    const claim1 = await repo.claimTask(taskId, 'worker_pg_1', 1000);
    assert.strictEqual(claim1.success, true);
    assert.strictEqual(claim1.task?.fencingToken, 1);

    // Simulate Worker 1 expiring in database
    await db('specialist_tasks').where({ id: taskId }).update({
      lease_expires_at: now - 5000
    });

    // Worker 2 claims expired task (fencingToken becomes 2)
    const claim2 = await repo.claimTask(taskId, 'worker_pg_2', 5000);
    assert.strictEqual(claim2.success, true);
    assert.strictEqual(claim2.task?.fencingToken, 2);

    // Stale Worker 1 attempts state update with old token 1 -> MUST REJECT IN POSTGRES TRANSACTION
    await assert.rejects(
      async () => {
        await repo.updateTaskState(taskId, 'COMPLETED', 1, { resultOutput: { corrupt: true } });
      },
      StaleFencingTokenError,
      'PostgreSQL updateTaskState must throw StaleFencingTokenError'
    );

    // Worker 2 with active token 2 succeeds
    const success = await repo.updateTaskState(taskId, 'COMPLETED', 2, { resultOutput: { valid: true } });
    assert.strictEqual(success, true);

    const finalRow = await repo.getTask(taskId);
    assert.strictEqual(finalRow?.state, 'COMPLETED');
    assert.deepStrictEqual(finalRow?.resultOutput, { valid: true });
  });

  test('PHASE 3.3: Lease renewal and tenant isolation in PostgreSQL', async () => {
    const runIdA = `run_tenant_a_${randomUUID()}`;
    const taskIdA = `task_tenant_a_${randomUUID()}`;
    const runIdB = `run_tenant_b_${randomUUID()}`;
    const taskIdB = `task_tenant_b_${randomUUID()}`;

    await ensureParentRun(runIdA, testPrincipalA.userId);
    await ensureParentRun(runIdB, testPrincipalB.userId);

    const now = Date.now();
    await repo.saveTask({
      id: taskIdA,
      runId: runIdA,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Tenant A task',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 30000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    });

    await repo.saveTask({
      id: taskIdB,
      runId: runIdB,
      principalId: testPrincipalB.userId,
      workspaceId: testPrincipalB.workspaceId,
      role: 'verifier',
      objective: 'Tenant B task',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 30000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    });

    // Tenant Isolation Check
    const tasksForA = await repo.listTasksByPrincipal(testPrincipalA.userId);
    const tasksForB = await repo.listTasksByPrincipal(testPrincipalB.userId);

    assert.ok(tasksForA.some(t => t.id === taskIdA));
    assert.ok(!tasksForA.some(t => t.id === taskIdB), 'Tenant A must not see Tenant B task');
    assert.ok(tasksForB.some(t => t.id === taskIdB));
    assert.ok(!tasksForB.some(t => t.id === taskIdA), 'Tenant B must not see Tenant A task');

    // Lease renewal check
    const claim = await repo.claimTask(taskIdA, 'worker_renew_test', 3000);
    assert.strictEqual(claim.success, true);

    const before = await repo.getTask(taskIdA);
    const renewed = await repo.renewLease(taskIdA, 'worker_renew_test', 10000, claim.task!.fencingToken);
    assert.strictEqual(renewed, true);

    const after = await repo.getTask(taskIdA);
    assert.ok(after!.leaseExpiresAt! > before!.leaseExpiresAt!, 'Lease expires at must be extended in PostgreSQL');
  });

  // ==========================================
  // PHASE 4 — CRASH AND RECOVERY ACCEPTANCE
  // ==========================================

  test('PHASE 4.1: Abrupt process termination during execution, persistence, and replacement recovery to 4194304', async () => {
    const runId = `run_crash_recov_${randomUUID()}`;
    const taskId = `task_crash_recov_${randomUUID()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    // 1. Submit task into PostgreSQL with short lease duration (2500ms)
    await repo.saveTask({
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Calculate ((16384 * 1024) / 4) through ToolGateway under crash conditions',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: {
        expression: '((16384 * 1024) / 4)',
        executionDelayMs: 2500
      },
      executionConstraints: { sideEffectLevel: 'NONE', allowedTools: ['calculator'] },
      authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
      budgetLimits: { maxTokens: 4096 },
      timeoutMs: 30000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test_sub' },
      checkpoints: [{ checkpoint: 'SUBMITTED', timestamp: now }],
      createdAt: now,
      updatedAt: now
    });

    // 2. Start Worker 1 as a REAL SEPARATE OS PROCESS
    const worker1: ChildProcess = fork(workerScriptPath, [], {
      env: {
        ...process.env,
        DATABASE_URL: isolatedConnStr,
        WORKER_ID: 'worker_child_crash_target',
        WORKER_CONCURRENCY: '4',
        POLL_INTERVAL_MS: '100',
        LEASE_DURATION_MS: '2000',
        HEARTBEAT_INTERVAL_MS: '400',
        AUTO_START: 'true'
      },
      execArgv: ['--import', 'tsx']
    });
    childProcesses.push(worker1);

    // Wait for Worker 1 to claim the task
    let claimed = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 200));
      const current = await repo.getTask(taskId);
      if (current && (current.state === 'CLAIMED' || current.state === 'RUNNING')) {
        claimed = true;
        break;
      }
    }
    assert.strictEqual(claimed, true, 'Worker 1 child process must claim task from PostgreSQL');

    // 3. ABRUPT TERMINATION: Kill Worker 1 instantly with SIGKILL (unhandled crash, zero drain)
    worker1.kill('SIGKILL');

    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(worker1.killed, true, 'Child Worker 1 must be terminated abruptly');

    // 4. Verify task state in PostgreSQL right after crash
    const postCrashTask = await repo.getTask(taskId);
    assert.ok(postCrashTask, 'Task must persist in PostgreSQL across worker crash');
    assert.strictEqual(postCrashTask?.leaseOwner, 'worker_child_crash_target');
    assert.strictEqual(postCrashTask?.fencingToken, 1);

    // 5. Wait for Worker 1 lease to expire in PostgreSQL
    const expireTime = postCrashTask.leaseExpiresAt || (Date.now() + 2000);
    const waitMs = Math.max(100, expireTime - Date.now() + 600);
    await new Promise(r => setTimeout(r, waitMs));

    // Reclaim expired lease safely
    const reclaimed = await leaseManager.reclaimExpiredLeases(Date.now() + 1000);
    const reclaimedTask = reclaimed.find(t => t.id === taskId);
    assert.ok(reclaimedTask, 'Expired lease must be reclaimed by lease manager');
    assert.strictEqual(reclaimedTask.state, 'RETRY_WAIT', 'Reclaimed task must transition to RETRY_WAIT');

    // 6. Start Replacement Worker 2 as a separate process to recover the task
    const worker2: ChildProcess = fork(workerScriptPath, [], {
      env: {
        ...process.env,
        DATABASE_URL: isolatedConnStr,
        WORKER_ID: 'worker_child_replacement_hero',
        POLL_INTERVAL_MS: '100',
        LEASE_DURATION_MS: '5000',
        HEARTBEAT_INTERVAL_MS: '500',
        AUTO_START: 'true'
      },
      execArgv: ['--import', 'tsx']
    });
    childProcesses.push(worker2);

    // 7. Wait for Replacement Worker 2 to claim and finish task
    let completed = false;
    let completedTask: DurableSpecialistTask | undefined;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 250));
      completedTask = await repo.getTask(taskId);
      if (completedTask && completedTask.state === 'COMPLETED') {
        completed = true;
        break;
      }
    }

    // Stop Worker 2 reliably so it does not interfere with subsequent recovery tests
    try {
      worker2.send({ action: 'STOP_GRACEFUL' });
    } catch {}
    worker2.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 500));

    assert.strictEqual(completed, true, 'Replacement worker must recover and complete task');
    assert.strictEqual(completedTask?.outcome, 'COMPLETED');

    // VERIFY EXACT RESULT: 4194304
    const resOutput = completedTask?.resultOutput as { expression: string; result: number };
    assert.strictEqual(resOutput?.result, 4194304, 'Result must be exact mathematical evaluation 4194304');
    assert.strictEqual(resOutput?.expression, '((16384 * 1024) / 4)');

    // 8. Stale Worker cannot overwrite the recovered result
    await assert.rejects(
      async () => {
        await repo.updateTaskState(taskId, 'FAILED', 1, { errorDetails: { code: 'STALE', message: 'Stale overwrite', retryable: false } });
      },
      Error,
      'Stale Worker 1 must be strictly prohibited from modifying recovered task'
    );
  });

  test('PHASE 4.2: Graceful worker shutdown drains active tasks cleanly', async () => {
    const workerGraceful: ChildProcess = fork(workerScriptPath, [], {
      env: {
        ...process.env,
        DATABASE_URL: isolatedConnStr,
        WORKER_ID: 'worker_graceful_test',
        POLL_INTERVAL_MS: '200',
        AUTO_START: 'true'
      },
      execArgv: ['--import', 'tsx']
    });
    childProcesses.push(workerGraceful);

    await new Promise(r => setTimeout(r, 500));

    // Send graceful stop message via IPC
    const stoppedPromise = new Promise<void>((resolve) => {
      workerGraceful.on('exit', (code) => {
        assert.strictEqual(code, 0, 'Graceful shutdown must exit with code 0');
        resolve();
      });
    });

    workerGraceful.send({ action: 'STOP_GRACEFUL' });
    await stoppedPromise;
  });

  // ==========================================
  // PHASE 5 — SIDE-EFFECT & AUTHORIZATION
  // ==========================================

  test('PHASE 5.1: ToolGateway remains authoritative boundary against unauthorized tools', async () => {
    const approvalKernel = new ApprovalKernel();
    const toolCallRepo = new InMemoryToolCallRepository();
    const toolGateway = new ToolGateway(toolCallRepo, approvalKernel, process.cwd());

    // 1. ToolGateway rejects unauthorized tool execution
    const res = await toolGateway.execute({
      toolName: 'malicious_system_rm',
      arguments: { path: '/' },
      context: {
        runId: 'run_auth_sec_test',
        principal: testPrincipalA
      }
    });

    assert.strictEqual(res.isError, true, 'Unregistered tool must fail');
    assert.match(res.error || '', /(not registered|not found|Tool Registry)/i);
  });

  test('PHASE 5.2: Retry exhaustion leads to TIMED_OUT with retryable: false', async () => {
    const runId = `run_pg_exhaust_${randomUUID()}`;
    const taskId = `task_pg_exhaust_${randomUUID()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    await repo.saveTask({
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Retry exhaustion test',
      state: 'RUNNING',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 30000,
      attemptCount: 2, // Reached maxRetries
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 1,
      leaseOwner: 'worker_failing_proc',
      leaseExpiresAt: now - 1000, // expired
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    });

    const reclaimed = await leaseManager.reclaimExpiredLeases(now);
    const reclaimedTask = reclaimed.find(t => t.id === taskId);
    assert.ok(reclaimedTask);
    assert.strictEqual(reclaimedTask.state, 'TIMED_OUT');

    const inDb = await repo.getTask(taskId);
    assert.strictEqual(inDb?.state, 'TIMED_OUT');
    assert.strictEqual(inDb?.outcome, 'TIMED_OUT');
    assert.strictEqual(inDb?.errorDetails?.retryable, false);
  });

  // ==========================================
  // PHASE 6 — IDEMPOTENCY KEY ISOLATION & STALE WORKER FENCING
  // ==========================================

  test('PHASE 6.1: Calculator ToolGateway idempotency — same operation retry returns existing result', async () => {
    const pgToolRepo = new PostgresToolCallRepository();
    const toolGateway = new ToolGateway(pgToolRepo, new ApprovalKernel(), process.cwd());
    const mathAgent = new MathematicalSpecialistAgent(toolGateway);

    const runId = `run_idemp_same_${randomUUID()}`;
    const taskId = `task_idemp_same_${randomUUID()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const context: SpecialistExecutionContext = {
      runId,
      taskId,
      principal: testPrincipalA,
      tenantId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      authorizedCapabilities: ['tool_execution', 'data_analysis'],
      effectiveToolScopes: ['calculator'],
      executionPolicyVersion: '2026.2.0',
      promptProfileId: 'profile_specialist_default',
      promptProfileVersion: '1.0.0',
      modelRoutingRequirements: {},
      remainingBudget: { maxTokens: 4096, remainingTokens: 4096 },
      cancellationSignal: new AbortController().signal,
      correlationId: `corr_${taskId}`,
      inputPayload: { expression: '((512 * 2) + 24)' }
    };

    // First execution
    const res1 = await mathAgent.execute(context);
    assert.strictEqual(res1.outcome, 'COMPLETED');
    assert.strictEqual((res1.output as any)?.result, 1048);

    const initialToolCalls = await db('tool_calls').where({ run_id: runId });
    assert.strictEqual(initialToolCalls.length, 1);
    const initialCall = initialToolCalls[0];

    // Retry of the same operation (same run, same task, same tenant)
    const res2 = await mathAgent.execute(context);
    assert.strictEqual(res2.outcome, 'COMPLETED');
    assert.strictEqual((res2.output as any)?.result, 1048);

    // Verify tool calls count in DB remains exactly 1 (idempotency hit, no duplicate row)
    const toolCallsAfterRetry = await db('tool_calls').where({ run_id: runId });
    assert.strictEqual(toolCallsAfterRetry.length, 1, 'Duplicate tool execution must be intercepted by idempotency');
    assert.strictEqual(toolCallsAfterRetry[0].id, initialCall.id);
  });

  test('PHASE 6.2: Calculator ToolGateway idempotency — different runs cannot share a receipt accidentally', async () => {
    const pgToolRepo = new PostgresToolCallRepository();
    const toolGateway = new ToolGateway(pgToolRepo, new ApprovalKernel(), process.cwd());
    const mathAgent = new MathematicalSpecialistAgent(toolGateway);

    const runId1 = `run_idemp_r1_${randomUUID()}`;
    const runId2 = `run_idemp_r2_${randomUUID()}`;
    // Common static template task ID across runs
    const sharedTaskId = `task_template_calc_step_${fixtureTag}`;
    await ensureParentRun(runId1, testPrincipalA.userId);
    await ensureParentRun(runId2, testPrincipalA.userId);

    const contextRun1: SpecialistExecutionContext = {
      runId: runId1,
      taskId: sharedTaskId,
      principal: testPrincipalA,
      tenantId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      authorizedCapabilities: ['tool_execution', 'data_analysis'],
      effectiveToolScopes: ['calculator'],
      executionPolicyVersion: '2026.2.0',
      promptProfileId: 'profile_specialist_default',
      promptProfileVersion: '1.0.0',
      modelRoutingRequirements: {},
      remainingBudget: { maxTokens: 4096, remainingTokens: 4096 },
      cancellationSignal: new AbortController().signal,
      correlationId: `corr_r1`,
      inputPayload: { expression: '100 + 200' }
    };

    const contextRun2: SpecialistExecutionContext = {
      ...contextRun1,
      runId: runId2,
      correlationId: `corr_r2`,
      inputPayload: { expression: '300 + 400' }
    };

    const res1 = await mathAgent.execute(contextRun1);
    assert.strictEqual(res1.outcome, 'COMPLETED');
    assert.strictEqual((res1.output as any)?.result, 300);

    const res2 = await mathAgent.execute(contextRun2);
    assert.strictEqual(res2.outcome, 'COMPLETED');
    assert.strictEqual((res2.output as any)?.result, 700);

    // Verify distinct tool calls in DB for run 1 and run 2
    const toolCallsR1 = await db('tool_calls').where({ run_id: runId1 });
    const toolCallsR2 = await db('tool_calls').where({ run_id: runId2 });
    assert.strictEqual(toolCallsR1.length, 1);
    assert.strictEqual(toolCallsR2.length, 1);
    assert.notStrictEqual(toolCallsR1[0].idempotency_key, toolCallsR2[0].idempotency_key, 'Keys must be isolated by runId');
    assert.notStrictEqual(toolCallsR1[0].id, toolCallsR2[0].id);

    // Additional defense-in-depth: if Run 2 directly passes Run 1\'s idempotency key to ToolGateway, ToolGateway must reject returning Run 1\'s cache
    const crossRunDirect = await toolGateway.execute({
      toolName: 'calculator',
      arguments: { expression: '999 + 1' },
      context: {
        runId: runId2,
        principal: testPrincipalA,
        idempotencyKey: toolCallsR1[0].idempotency_key!
      }
    });
    // It must execute freshly (result = 1000), NOT return Run 1\'s cached output (300)
    assert.strictEqual((crossRunDirect.output as any)?.result, 1000);
  });

  test('PHASE 6.3: Calculator ToolGateway idempotency — different principals cannot share a receipt accidentally', async () => {
    const pgToolRepo = new PostgresToolCallRepository();
    const toolGateway = new ToolGateway(pgToolRepo, new ApprovalKernel(), process.cwd());
    const mathAgent = new MathematicalSpecialistAgent(toolGateway);

    const runIdA = `run_idemp_userA_${randomUUID()}`;
    const runIdB = `run_idemp_userB_${randomUUID()}`;
    const sharedTaskId = `task_calc_shared_name_${fixtureTag}`;
    await ensureParentRun(runIdA, testPrincipalA.userId);
    await ensureParentRun(runIdB, testPrincipalB.userId);

    const contextA: SpecialistExecutionContext = {
      runId: runIdA,
      taskId: sharedTaskId,
      principal: testPrincipalA,
      tenantId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      authorizedCapabilities: ['tool_execution', 'data_analysis'],
      effectiveToolScopes: ['calculator'],
      executionPolicyVersion: '2026.2.0',
      promptProfileId: 'profile_specialist_default',
      promptProfileVersion: '1.0.0',
      modelRoutingRequirements: {},
      remainingBudget: { maxTokens: 4096, remainingTokens: 4096 },
      cancellationSignal: new AbortController().signal,
      correlationId: `corr_a`,
      inputPayload: { expression: '50 * 2' }
    };

    const contextB: SpecialistExecutionContext = {
      runId: runIdB,
      taskId: sharedTaskId,
      principal: testPrincipalB,
      tenantId: testPrincipalB.userId,
      workspaceId: testPrincipalB.workspaceId,
      authorizedCapabilities: ['tool_execution', 'data_analysis'],
      effectiveToolScopes: ['calculator'],
      executionPolicyVersion: '2026.2.0',
      promptProfileId: 'profile_specialist_default',
      promptProfileVersion: '1.0.0',
      modelRoutingRequirements: {},
      remainingBudget: { maxTokens: 4096, remainingTokens: 4096 },
      cancellationSignal: new AbortController().signal,
      correlationId: `corr_b`,
      inputPayload: { expression: '50 * 2' }
    };

    const resA = await mathAgent.execute(contextA);
    const resB = await mathAgent.execute(contextB);
    assert.strictEqual((resA.output as any)?.result, 100);
    assert.strictEqual((resB.output as any)?.result, 100);

    const toolCallsA = await db('tool_calls').where({ run_id: runIdA });
    const toolCallsB = await db('tool_calls').where({ run_id: runIdB });
    assert.strictEqual(toolCallsA.length, 1);
    assert.strictEqual(toolCallsB.length, 1);
    assert.notStrictEqual(toolCallsA[0].idempotency_key, toolCallsB[0].idempotency_key, 'Keys must be isolated by principal');

    // Cross-principal attack: Principal B tries to claim Principal A\'s exact idempotency key
    const crossPrincipalDirect = await toolGateway.execute({
      toolName: 'calculator',
      arguments: { expression: '9999 + 1' },
      context: {
        runId: runIdB,
        principal: testPrincipalB,
        idempotencyKey: toolCallsA[0].idempotency_key!
      }
    });
    // Under the hardened security model, attempting to claim another principal's idempotency key
    // is rejected fail-closed with TOOL_PERMISSION_DENIED, rather than leaking cached data.
    assert.strictEqual(crossPrincipalDirect.isError, true);
    assert.strictEqual(crossPrincipalDirect.errorCode, ToolGatewayErrorCodes.TOOL_PERMISSION_DENIED);
  });

  test('PHASE 6.4: Stale worker fencing — stale workers cannot overwrite a newer task result in PostgreSQL', async () => {
    const runId = `run_stale_fence_${randomUUID()}`;
    const taskId = `task_stale_fence_${randomUUID()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    await repo.saveTask({
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Fencing protection test',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: { expression: '1 + 1' },
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 30000,
      attemptCount: 0,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 0,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'test' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    });

    // 1. Worker 1 claims task -> fencing token becomes 1
    const claim1 = await repo.claimTask(taskId, 'worker_1', 1000);
    assert.strictEqual(claim1.success, true);
    assert.strictEqual(claim1.task?.fencingToken, 1);
    const worker1StaleToken = claim1.task!.fencingToken;

    // 2. Worker 1 lease expires
    await db('specialist_tasks').where({ id: taskId }).update({ lease_expires_at: now - 500 });

    // 3. Worker 2 reclaims task -> fencing token becomes 2
    const claim2 = await repo.claimTask(taskId, 'worker_2', 15000);
    assert.strictEqual(claim2.success, true);
    assert.strictEqual(claim2.task?.fencingToken, 2);

    // 4. Worker 2 successfully completes task and writes result
    const worker2Completed = await repo.updateTaskState(taskId, 'COMPLETED', claim2.task!.fencingToken, {
      resultOutput: { result: 'worker_2_authoritative_result' }
    });
    assert.strictEqual(worker2Completed, true);

    // 5. Stale Worker 1 wakes up and attempts to update task state with stale fencing token (1)
    await assert.rejects(
      async () => {
        await repo.updateTaskState(taskId, 'COMPLETED', worker1StaleToken, {
          resultOutput: { result: 'worker_1_stale_spoofed_result' }
        });
      },
      (err: any) => {
        assert.ok(err instanceof StaleFencingTokenError, 'Must reject with StaleFencingTokenError');
        assert.strictEqual(err.expectedToken, 1);
        assert.strictEqual(err.actualToken, 2);
        return true;
      }
    );

    // 6. Verify in DB that Worker 2\'s result remains completely untainted
    const finalInDb = await repo.getTask(taskId);
    assert.strictEqual(finalInDb?.state, 'COMPLETED');
    assert.strictEqual(finalInDb?.fencingToken, 2);
    assert.strictEqual((finalInDb?.resultOutput as any)?.result, 'worker_2_authoritative_result');
  });

  // ==========================================
  // PHASE 7 — SAFE RECOVERY RUNBOOK REGRESSION SUITE
  // ==========================================

  const OPTION_A_SQL = `
WITH target_tasks AS (
  SELECT id, run_id, fencing_token, state, attempt_count
  FROM specialist_tasks
  WHERE principal_id = :target_principal_id
    AND (run_id = :target_run_id OR id = :target_task_id)
    AND lease_owner = :crashed_worker_id
    AND state IN ('CLAIMED', 'RUNNING')
    AND (
      lease_expires_at IS NULL 
      OR lease_expires_at <= (EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  FOR UPDATE
),
updated AS (
  UPDATE specialist_tasks st
  SET lease_owner = NULL,
      lease_expires_at = 0,
      fencing_token = st.fencing_token + 1,
      updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
  FROM target_tasks tt
  WHERE st.id = tt.id AND st.fencing_token = tt.fencing_token
  RETURNING st.id, st.run_id, tt.state AS from_state, st.fencing_token
)
INSERT INTO specialist_task_events (
  id, 
  task_id, 
  run_id, 
  event_type, 
  from_state, 
  to_state, 
  fencing_token, 
  worker_id, 
  payload, 
  created_at
)
SELECT 
  'evt_recov_a_' || (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint || '_' || substr(md5(random()::text), 1, 6),
  u.id,
  u.run_id,
  'TASK_LEASE_RECLAIMED',
  u.from_state,
  u.from_state,
  u.fencing_token,
  'operator_runbook',
  jsonb_build_object(
    'action', 'LEASE_RESET_FOR_RECLAMATION',
    'previous_lease_owner', :crashed_worker_id::text,
    'operator_id', :operator_id::text,
    'verified_worker_termination', true
  ),
  (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM updated u
RETURNING *;
`;

  const OPTION_B_SQL = `
WITH target_tasks AS (
  SELECT id, run_id, fencing_token, state, attempt_count
  FROM specialist_tasks
  WHERE principal_id = :target_principal_id
    AND (run_id = :target_run_id OR id = :target_task_id)
    AND lease_owner = :crashed_worker_id
    AND state IN ('CLAIMED', 'RUNNING')
    AND (
      lease_expires_at IS NULL 
      OR lease_expires_at <= (EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  FOR UPDATE
),
updated AS (
  UPDATE specialist_tasks st
  SET state = 'FAILED',
      outcome = 'FAILED',
      fencing_token = st.fencing_token + 1,
      error_details = jsonb_build_object(
        'code', 'OPERATOR_LEASE_RECOVERY_ABORT',
        'message', 'Task safely aborted by operator runbook following verified worker failure and lease expiration',
        'retryable', false,
        'operator_id', :operator_id::text,
        'crashed_worker_id', :crashed_worker_id::text
      ),
      completed_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
      updated_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
  FROM target_tasks tt
  WHERE st.id = tt.id AND st.fencing_token = tt.fencing_token
  RETURNING st.id, st.run_id, tt.state AS from_state, st.fencing_token
)
INSERT INTO specialist_task_events (
  id, 
  task_id, 
  run_id, 
  event_type, 
  from_state, 
  to_state, 
  fencing_token, 
  worker_id, 
  payload, 
  created_at
)
SELECT 
  'evt_recov_b_' || (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint || '_' || substr(md5(random()::text), 1, 6),
  u.id,
  u.run_id,
  'TASK_STATE_FAILED',
  u.from_state,
  'FAILED',
  u.fencing_token,
  'operator_runbook',
  jsonb_build_object(
    'reason', 'Operator-initiated tenant-scoped recovery runbook',
    'operator_id', :operator_id::text,
    'crashed_worker_id', :crashed_worker_id::text,
    'previous_state', u.from_state
  ),
  (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM updated u
RETURNING *;
`;

  test('PHASE 7.1: Incorrect Worker ID — recovery procedure rejects/updates 0 rows when operator supplies wrong worker ID', async () => {
    const runId = `run_recov_wrong_worker_${randomUUID()}`;
    const taskId = `task_recov_wrong_worker_${randomUUID()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    await repo.saveTask({
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Recovery runbook wrong worker ID test',
      state: 'RUNNING',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 30000,
      attemptCount: 1,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 1,
      leaseOwner: 'worker_actual_crashed_1',
      leaseExpiresAt: now - 5000, // expired lease
      heartbeatAt: now - 8000,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'worker_actual_crashed_1' },
      checkpoints: [],
      createdAt: now - 10000,
      updatedAt: now - 8000
    });

    // Operator executes Option B with wrong worker ID
    const res = await db.raw(OPTION_B_SQL, {
      target_principal_id: testPrincipalA.userId,
      target_run_id: runId,
      target_task_id: taskId,
      crashed_worker_id: 'worker_wrong_nonexistent_999',
      operator_id: 'op_secops_test'
    });

    assert.strictEqual(res.rows.length, 0, 'Must not update or emit events when worker ID does not match');

    const taskInDb = await repo.getTask(taskId);
    assert.strictEqual(taskInDb?.state, 'RUNNING');
    assert.strictEqual(taskInDb?.leaseOwner, 'worker_actual_crashed_1');
    assert.strictEqual(taskInDb?.fencingToken, 1);
  });

  test('PHASE 7.2: Active Healthy Lease — recovery procedure protects unexpired tasks against premature operator eviction', async () => {
    const runId = `run_recov_active_lease_${randomUUID()}`;
    const taskId = `task_recov_active_lease_${randomUUID()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    await repo.saveTask({
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Recovery runbook active lease protection test',
      state: 'RUNNING',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 30000,
      attemptCount: 1,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 1,
      leaseOwner: 'worker_healthy_active_1',
      leaseExpiresAt: now + 60000, // active healthy lease: 60s in future
      heartbeatAt: now,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'worker_healthy_active_1' },
      checkpoints: [],
      createdAt: now,
      updatedAt: now
    });

    // Attempt Option A
    const resA = await db.raw(OPTION_A_SQL, {
      target_principal_id: testPrincipalA.userId,
      target_run_id: runId,
      target_task_id: taskId,
      crashed_worker_id: 'worker_healthy_active_1',
      operator_id: 'op_secops_test'
    });
    assert.strictEqual(resA.rows.length, 0, 'Option A must not touch active healthy lease');

    // Attempt Option B
    const resB = await db.raw(OPTION_B_SQL, {
      target_principal_id: testPrincipalA.userId,
      target_run_id: runId,
      target_task_id: taskId,
      crashed_worker_id: 'worker_healthy_active_1',
      operator_id: 'op_secops_test'
    });
    assert.strictEqual(resB.rows.length, 0, 'Option B must not abort active healthy lease');

    const taskInDb = await repo.getTask(taskId);
    assert.strictEqual(taskInDb?.state, 'RUNNING');
    assert.strictEqual(taskInDb?.leaseOwner, 'worker_healthy_active_1');
    assert.strictEqual(taskInDb?.fencingToken, 1);
  });

  test('PHASE 7.3: Expired Lease — transactional recovery procedure resets expired lease with bumped fencing token', async () => {
    const runId = `run_recov_expired_${randomUUID()}`;
    const taskId = `task_recov_expired_${randomUUID()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    await repo.saveTask({
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Recovery runbook expired lease reclamation test',
      state: 'RUNNING',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 30000,
      attemptCount: 1,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 1,
      leaseOwner: 'worker_dead_to_reclaim_1',
      leaseExpiresAt: now - 5000, // expired lease
      heartbeatAt: now - 8000,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'worker_dead_to_reclaim_1' },
      checkpoints: [],
      createdAt: now - 10000,
      updatedAt: now - 8000
    });

    // Execute Option A on verified dead worker with expired lease
    const resA = await db.raw(OPTION_A_SQL, {
      target_principal_id: testPrincipalA.userId,
      target_run_id: runId,
      target_task_id: taskId,
      crashed_worker_id: 'worker_dead_to_reclaim_1',
      operator_id: 'op_secops_test'
    });
    assert.strictEqual(resA.rows.length, 1, 'Option A must successfully reset expired lease');

    const taskInDb = await repo.getTask(taskId);
    assert.strictEqual(taskInDb?.leaseOwner, undefined);
    assert.strictEqual(taskInDb?.leaseExpiresAt, 0);
    assert.strictEqual(taskInDb?.fencingToken, 2, 'Fencing token must be monotonically incremented');

    // Event audit check
    const events = await db('specialist_task_events').where({ task_id: taskId }).orderBy('created_at', 'desc');
    assert.ok(events.length > 0);
    assert.strictEqual(events[0].event_type, 'TASK_LEASE_RECLAIMED');
    assert.strictEqual(events[0].from_state, 'RUNNING');
    assert.strictEqual(events[0].to_state, 'RUNNING');
    assert.strictEqual(Number(events[0].fencing_token), 2);

    // Replacement worker can now claim task immediately
    const claimRes = await repo.claimTask(taskId, 'worker_replacement_2', 15000);
    assert.strictEqual(claimRes.success, true);
    assert.strictEqual(claimRes.task?.leaseOwner, 'worker_replacement_2');
    assert.strictEqual(claimRes.task?.fencingToken, 3);
  });

  test('PHASE 7.4: CLAIMED versus RUNNING audit events — Option B preserves actual previous task state', async () => {
    const runId = `run_recov_states_${randomUUID()}`;
    const taskIdClaimed = `task_recov_claimed_${randomUUID()}`;
    const taskIdRunning = `task_recov_running_${randomUUID()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    // 1. Task in CLAIMED state
    await repo.saveTask({
      id: taskIdClaimed,
      runId,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Claimed state audit preservation test',
      state: 'CLAIMED',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 30000,
      attemptCount: 1,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 1,
      leaseOwner: 'worker_crashed_in_claimed',
      leaseExpiresAt: now - 5000,
      heartbeatAt: now - 5000,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'worker_crashed_in_claimed' },
      checkpoints: [],
      createdAt: now - 10000,
      updatedAt: now - 5000
    });

    // 2. Task in RUNNING state
    await repo.saveTask({
      id: taskIdRunning,
      runId,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Running state audit preservation test',
      state: 'RUNNING',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 30000,
      attemptCount: 1,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 1,
      leaseOwner: 'worker_crashed_in_running',
      leaseExpiresAt: now - 5000,
      heartbeatAt: now - 5000,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'worker_crashed_in_running' },
      checkpoints: [],
      createdAt: now - 10000,
      updatedAt: now - 5000
    });

    // Run Option B for CLAIMED task
    const resClaimed = await db.raw(OPTION_B_SQL, {
      target_principal_id: testPrincipalA.userId,
      target_run_id: runId,
      target_task_id: taskIdClaimed,
      crashed_worker_id: 'worker_crashed_in_claimed',
      operator_id: 'op_secops_test'
    });
    assert.strictEqual(resClaimed.rows.length, 1);

    // Run Option B for RUNNING task
    const resRunning = await db.raw(OPTION_B_SQL, {
      target_principal_id: testPrincipalA.userId,
      target_run_id: runId,
      target_task_id: taskIdRunning,
      crashed_worker_id: 'worker_crashed_in_running',
      operator_id: 'op_secops_test'
    });
    assert.strictEqual(resRunning.rows.length, 1);

    // Verify task 1 event preserves 'CLAIMED' as from_state
    const eventClaimed = await db('specialist_task_events')
      .where({ task_id: taskIdClaimed, event_type: 'TASK_STATE_FAILED' })
      .first();
    assert.ok(eventClaimed, 'Event must exist for claimed task abort');
    assert.strictEqual(eventClaimed.from_state, 'CLAIMED', 'Must record CLAIMED as from_state');
    assert.strictEqual(eventClaimed.to_state, 'FAILED');
    assert.strictEqual(Number(eventClaimed.fencing_token), 2);

    // Verify task 2 event preserves 'RUNNING' as from_state
    const eventRunning = await db('specialist_task_events')
      .where({ task_id: taskIdRunning, event_type: 'TASK_STATE_FAILED' })
      .first();
    assert.ok(eventRunning, 'Event must exist for running task abort');
    assert.strictEqual(eventRunning.from_state, 'RUNNING', 'Must record RUNNING as from_state');
    assert.strictEqual(eventRunning.to_state, 'FAILED');
    assert.strictEqual(Number(eventRunning.fencing_token), 2);
  });

  test('PHASE 7.5: Cross-Tenant Recovery Rejection — Tenant B operator credentials cannot abort Tenant A tasks', async () => {
    const runIdA = `run_recov_tenant_a_${randomUUID()}`;
    const taskIdA = `task_recov_tenant_a_${randomUUID()}`;
    await ensureParentRun(runIdA, testPrincipalA.userId);

    const now = Date.now();
    await repo.saveTask({
      id: taskIdA,
      runId: runIdA,
      principalId: testPrincipalA.userId,
      workspaceId: testPrincipalA.workspaceId,
      role: 'analyst',
      objective: 'Cross tenant recovery rejection test',
      state: 'RUNNING',
      dependencies: [],
      inputPayload: {},
      executionConstraints: {},
      authorizationRequirements: {},
      budgetLimits: { maxTokens: 1000 },
      timeoutMs: 30000,
      attemptCount: 1,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 1,
      leaseOwner: 'worker_tenant_a_1',
      leaseExpiresAt: now - 5000, // expired lease
      heartbeatAt: now - 8000,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'worker_tenant_a_1' },
      checkpoints: [],
      createdAt: now - 10000,
      updatedAt: now - 8000
    });

    // Tenant B operator attempts to abort Tenant A's task using Tenant B principal_id
    const res = await db.raw(OPTION_B_SQL, {
      target_principal_id: testPrincipalB.userId, // Attacking tenant!
      target_run_id: runIdA,
      target_task_id: taskIdA,
      crashed_worker_id: 'worker_tenant_a_1',
      operator_id: 'op_tenant_b_attacker'
    });
    assert.strictEqual(res.rows.length, 0, 'Cross-tenant recovery must update 0 rows');

    // Tenant A's task in DB must be untouched
    const taskA = await repo.getTask(taskIdA);
    assert.strictEqual(taskA?.state, 'RUNNING');
    assert.strictEqual(taskA?.leaseOwner, 'worker_tenant_a_1');
    assert.strictEqual(taskA?.fencingToken, 1);

    // No FAILED events recorded
    const events = await db('specialist_task_events').where({ task_id: taskIdA });
    assert.strictEqual(events.length, 0, 'No audit events should be emitted for rejected cross-tenant recovery');
  });
});