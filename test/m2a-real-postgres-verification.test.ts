import './setup-isolated-neon.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, fork, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { DurableTaskScheduler } from '../packages/agent-runtime/src/durable/durable-task-scheduler.js';
import { StaleFencingTokenError } from '../packages/agent-runtime/src/durable/task-state-machine.js';
import { ToolGateway, InMemoryToolCallRepository } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { TaskDAG, ExecutionPrincipal } from '../packages/contracts/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerScriptPath = path.resolve(__dirname, 'helpers/standalone-specialist-worker.ts');

test.describe('AIRA AI 2026 — PR #115 Real PostgreSQL & Worker Reliability Certification Suite', () => {
  let isolatedConnStr: string;
  let repo: PostgresSpecialistTaskRepository;
  let leaseManager: TaskLeaseManager;
  let scheduler: DurableTaskScheduler;
  const childProcesses: ChildProcess[] = [];

  test.after(() => {
    for (const child of childProcesses) {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {}
    }
  });

  const testPrincipalA: ExecutionPrincipal = {
    userId: 'user_m2a_tenant_a',
    sessionId: 'sess_m2a_tenant_a',
    workspaceId: 'ws_m2a_tenant_a',
    role: 'user'
  };

  const testPrincipalB: ExecutionPrincipal = {
    userId: 'user_m2a_tenant_b',
    sessionId: 'sess_m2a_tenant_b',
    workspaceId: 'ws_m2a_tenant_b',
    role: 'user'
  };

  // Helper to ensure parent run exists in public.runs table (foreign key constraint)
  async function ensureParentRun(runId: string, principalId: string): Promise<void> {
    const existing = await db('runs').where({ id: runId }).first();
    if (!existing) {
      await db('runs').insert({
        id: runId,
        principal_id: principalId,
        session_id: `sess_${principalId}`,
        prompt: `M2-A Integration Parent Run for ${runId}`,
        status: 'RUNNING',
        state: 'RUNNING',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        toolsUsed: JSON.stringify(['calculator']),
        toolCalls: JSON.stringify([]),
        toolResults: JSON.stringify([])
      });
    }
  }

  // ==========================================
  // PHASE 2 — ISOLATED DATABASE VERIFICATION
  // ==========================================

  test('PHASE 2.1: Discover isolated Neon branch and enforce strict production separation', () => {
    // 1. Fetch connection string via neon CLI for isolated branch on mute-frost-50372225
    isolatedConnStr = execSync('neon connection-string br-muddy-wave-b3zxhkqf --project-id mute-frost-50372225', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();

    if (!isolatedConnStr.includes('sslmode=')) {
      isolatedConnStr += (isolatedConnStr.includes('?') ? '&' : '?') + 'sslmode=require';
    }

    assert.ok(isolatedConnStr.length > 0, 'Isolated database connection string must not be empty');

    // 2. Classify database URL using database-isolation-guard
    const classification = classifyDatabaseUrl(isolatedConnStr);

    // STRICT INVARIANTS:
    assert.strictEqual(classification.isProduction, false, 'Database must NOT be classified as production');
    assert.strictEqual(classification.category, 'isolated_neon_preview', 'Must be classified as isolated_neon_preview');
    assert.notStrictEqual(classification.projectId, 'old-sky-50952395', 'Project ID must NOT be production old-sky-50952395');
    assert.ok(!classification.host.includes('ep-withered-art-b36ox90b'), 'Endpoint must NOT be production ep-withered-art-b36ox90b');

    // 3. Verify assertCanRunMigrations permits migration on this target
    assert.doesNotThrow(() => {
      assertCanRunMigrations(isolatedConnStr);
    }, 'assertCanRunMigrations must permit migration on isolated preview branch');

    process.env.DATABASE_URL = isolatedConnStr;
    repo = new PostgresSpecialistTaskRepository();
    leaseManager = new TaskLeaseManager(repo, { defaultLeaseDurationMs: 4000, heartbeatIntervalMs: 1000 });
    scheduler = new DurableTaskScheduler(repo, { maxConcurrency: 3 });
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
    const runId = `run_pg_race_${Date.now()}`;
    const taskId = `task_pg_race_${Date.now()}`;
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
    const runId = `run_pg_fencing_${Date.now()}`;
    const taskId = `task_pg_fencing_${Date.now()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    const task: DurableSpecialistTask = {
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
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
    const runIdA = `run_tenant_a_${Date.now()}`;
    const taskIdA = `task_tenant_a_${Date.now()}`;
    const runIdB = `run_tenant_b_${Date.now()}`;
    const taskIdB = `task_tenant_b_${Date.now()}`;

    await ensureParentRun(runIdA, testPrincipalA.userId);
    await ensureParentRun(runIdB, testPrincipalB.userId);

    const now = Date.now();
    await repo.saveTask({
      id: taskIdA,
      runId: runIdA,
      principalId: testPrincipalA.userId,
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
    const runId = `run_crash_recov_${Date.now()}`;
    const taskId = `task_crash_recov_${Date.now()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    // 1. Submit task into PostgreSQL with short lease duration (2500ms)
    await repo.saveTask({
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
      role: 'analyst',
      objective: 'Calculate ((16384 * 1024) / 4) through ToolGateway under crash conditions',
      state: 'QUEUED',
      dependencies: [],
      inputPayload: {
        expression: '((16384 * 1024) / 4)'
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
    for (let i = 0; i < 20; i++) {
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

    // Stop Worker 2 gracefully
    worker2.kill('SIGTERM');

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
    const runId = `run_pg_exhaust_${Date.now()}`;
    const taskId = `task_pg_exhaust_${Date.now()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    await repo.saveTask({
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
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
});
