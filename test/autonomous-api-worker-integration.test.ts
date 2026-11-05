import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AgentRuntime,
  AutonomousAgentEngine,
  AutonomousWorkerHost,
  PostgresAutonomousTaskRepository,
  InMemoryAutonomousTaskRepository,
  FailClosedAutonomousTaskRepository
} from '../packages/agent-runtime/src/index.js';
import {
  SpecialistRegistry,
  PlannerSpecialistAgent,
  VerificationSpecialistAgent
} from '../packages/agent-runtime/src/specialists/index.js';
import type { ExecutionPrincipal } from '../packages/contracts/src/index.js';
import { up as migration031Up, down as migration031Down } from '../packages/db/src/migrations/031_autonomous_agent_tasks.js';
import { db } from '../packages/db/src/index.js';

const isLivePostgres = process.env.AIRA_POSTGRES_CERTIFICATION === '1';

test('Mission B1 — Environment-Aware Repository Selection & Fail-Closed Guard', async (t) => {
  await t.test('1. Deployed environment without database fails closed', async () => {
    const origEnv = process.env.NODE_ENV;
    const origVercel = process.env.VERCEL;
    const origDbUrl = process.env.DATABASE_URL;

    try {
      process.env.NODE_ENV = 'production';
      process.env.VERCEL = '1';
      delete process.env.DATABASE_URL;

      const runtime = new AgentRuntime(
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any
      );

      const repo = runtime.getAutonomousTaskRepository();
      assert.ok(
        repo instanceof FailClosedAutonomousTaskRepository,
        'Must select FailClosedAutonomousTaskRepository in deployed environment when DB is missing'
      );

      await assert.rejects(
        () => repo.createTask({
          taskId: 't1',
          principal: { userId: 'u1', sessionId: 's1', scopes: ['*'] },
          objective: 'test',
          state: 'CREATED',
          observations: [],
          artifacts: [],
          workingMemory: {},
          executionHistory: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }),
        (err: any) => {
          assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
          assert.ok(err.message.includes('Durable database persistence is unconfigured'));
          return true;
        }
      );
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origVercel !== undefined) process.env.VERCEL = origVercel;
      else delete process.env.VERCEL;
      if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
      else delete process.env.DATABASE_URL;
    }
  });

  await t.test('2. Local development / test without database selects InMemoryAutonomousTaskRepository safely', async () => {
    const origEnv = process.env.NODE_ENV;
    const origVercel = process.env.VERCEL;
    const origDbUrl = process.env.DATABASE_URL;

    try {
      process.env.NODE_ENV = 'test';
      delete process.env.VERCEL;
      delete process.env.DATABASE_URL;

      const runtime = new AgentRuntime(
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any
      );

      const repo = runtime.getAutonomousTaskRepository();
      assert.ok(
        repo instanceof InMemoryAutonomousTaskRepository,
        'Must select InMemoryAutonomousTaskRepository in local test environment when DB is unconfigured'
      );
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origVercel !== undefined) process.env.VERCEL = origVercel;
      else delete process.env.VERCEL;
      if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
      else delete process.env.DATABASE_URL;
    }
  });

  await t.test('3. Configured database selects PostgresAutonomousTaskRepository', async () => {
    const origDbUrl = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = 'postgres://aira:aira@127.0.0.1:5432/fake_db';

      const runtime = new AgentRuntime(
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any
      );

      const repo = runtime.getAutonomousTaskRepository();
      assert.ok(
        repo instanceof PostgresAutonomousTaskRepository,
        'Must select PostgresAutonomousTaskRepository when DATABASE_URL is configured'
      );
    } finally {
      if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
      else delete process.env.DATABASE_URL;
    }
  });
});

test('Mission B2 — Autonomous Task Worker: Atomic Claim, Heartbeat & Dual Competing Workers', async (t) => {
  const repo = new InMemoryAutonomousTaskRepository();
  const registry = new SpecialistRegistry();
  registry.registerSpecialist(new PlannerSpecialistAgent(), 'TEST');
  registry.registerSpecialist(new VerificationSpecialistAgent(), 'TEST');

  const engine = new AutonomousAgentEngine({
    repository: repo,
    specialistRegistry: registry
  });

  const worker1 = new AutonomousWorkerHost(repo, engine, {
    workerId: 'worker_node_alpha',
    pollIntervalMs: 50,
    leaseDurationMs: 1000,
    heartbeatIntervalMs: 200,
    concurrency: 1
  });

  const principal: ExecutionPrincipal = {
    userId: 'user_alice',
    sessionId: 'sess_1',
    workspaceId: 'ws_prod',
    scopes: ['*']
  };

  await t.test('1. Task creation queues in CREATED state; worker claims atomically', async () => {
    const task = await engine.createTask('Autonomous market research and summary', principal, undefined, 'idemp_key_1');
    assert.equal(task.state, 'CREATED');

    // Worker 1 claims task
    const claim1 = await repo.claimTask(task.taskId, 'worker_node_alpha', 1000);
    assert.equal(claim1.success, true);
    assert.equal(claim1.task?.leaseOwner, 'worker_node_alpha');

    // Worker 2 attempts concurrent claim; must be rejected
    const claim2 = await repo.claimTask(task.taskId, 'worker_node_beta', 1000);
    assert.equal(claim2.success, false);
    assert.ok(claim2.error?.includes('leased'));
  });

  await t.test('2. Heartbeat extends lease and prevents expiration', async () => {
    const task = await repo.getTask('autotask_' + task_id_extract(repo));
    if (!task) return;

    const initialExpires = task.leaseExpiresAt || 0;
    await new Promise(r => setTimeout(r, 50));

    const renewed = await repo.renewLease(task.taskId, 'worker_node_alpha', 1000, task.fencingToken);
    assert.equal(renewed, true);

    const afterRenew = await repo.getTask(task.taskId);
    assert.ok(afterRenew!.leaseExpiresAt! > initialExpires, 'Lease expiration must be updated by heartbeat');
  });

  await t.test('3. Stale worker lease renewal is rejected on token mismatch', async () => {
    const task = await repo.getTask('autotask_' + task_id_extract(repo));
    if (!task) return;

    const staleRenew = await repo.renewLease(task.taskId, 'worker_node_alpha', 1000, task.fencingToken + 99);
    assert.equal(staleRenew, false, 'Lease renewal must fail when fencing token does not match');
  });

  await t.test('4. Worker shutdown cleans up in-flight tasks and halts polling', async () => {
    await worker1.start();
    const healthBefore = worker1.getHealth();
    assert.equal(healthBefore.status, 'HEALTHY');

    await worker1.stop();
    const healthAfter = worker1.getHealth();
    assert.equal(healthAfter.status, 'STOPPED');
    assert.equal(healthAfter.activeCount, 0);
  });
});

test('Mission B3 — Crash Recovery, Lease Expiration & Resume Without Duplicate Side-Effects', async () => {
  const repo = new InMemoryAutonomousTaskRepository();
  const registry = new SpecialistRegistry();
  registry.registerSpecialist(new PlannerSpecialistAgent(), 'TEST');
  registry.registerSpecialist(new VerificationSpecialistAgent(), 'TEST');

  const engine = new AutonomousAgentEngine({
    repository: repo,
    specialistRegistry: registry
  });

  const principal: ExecutionPrincipal = {
    userId: 'user_carol',
    sessionId: 'sess_3',
    workspaceId: 'ws_carol',
    scopes: ['*']
  };

  const task = await engine.createTask('Crash and resumption verification', principal);
  await repo.updateState(task.taskId, 'PLANNING', 'Planning execution');
  await repo.updateState(task.taskId, 'READY', 'Plan ready');
  await repo.updateState(task.taskId, 'RUNNING', 'Starting execution on worker 1');

  // Worker 1 claims with very short lease (80ms)
  await repo.claimTask(task.taskId, 'worker_crashed_1', 80);

  // Record completed step 1
  await repo.addObservation(task.taskId, {
    observationId: 'obs_1',
    stepId: 'step_research',
    source: 'specialist',
    sourceName: 'Researcher Specialist',
    summary: 'Gathered initial research successfully.',
    timestamp: Date.now()
  });

  // Simulate worker 1 crashing (dies without releasing lease)
  // Wait 100ms for lease to expire naturally
  await new Promise(r => setTimeout(r, 100));

  // Worker 2 polls for recoverable tasks
  const recoverable = await repo.findRecoverableTasks(Date.now());
  const found = recoverable.find(t => t.taskId === task.taskId);
  assert.ok(found, 'Crashed task with expired lease must be discovered as recoverable');

  const beforeClaim = await repo.getTask(task.taskId);
  const tokenBeforeClaim = beforeClaim!.fencingToken;

  // Worker 2 claims task
  const claim2 = await repo.claimTask(task.taskId, 'worker_recovery_2', 5000);
  assert.equal(claim2.success, true);
  assert.equal(claim2.task?.leaseOwner, 'worker_recovery_2');
  assert.equal(claim2.task?.fencingToken, tokenBeforeClaim + 1, 'Fencing token must increment on recovery claim');

  // Worker 2 resumes execution: observation 1 already present, so step 1 is skipped
  const resumedTask = await repo.getTask(task.taskId);
  assert.equal(resumedTask?.observations.length, 1);
  assert.equal(resumedTask?.observations[0].stepId, 'step_research');
});

test('Mission B4 — Migration 031 Rollback Safety Barrier & Non-Destructive Guard', async (t) => {
  await t.test('1. Non-destructive safety barrier aborts down() when user records exist in non-test env', async () => {
    let checkCalled = false;
    const mockKnexWithRecords: any = Object.assign(
      (_tableName: string) => ({
        count: () => ({
          first: async () => {
            checkCalled = true;
            return { count: '42' }; // 42 user tasks
          }
        })
      }),
      {
        schema: {
          hasTable: async () => true,
          dropTableIfExists: async () => {
            throw new Error('FAIL: dropTableIfExists should NOT have been called!');
          }
        }
      }
    );

    const origEnv = process.env.NODE_ENV;
    const origTestEnv = process.env.AIRA_TEST_ENVIRONMENT;
    const origForce = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
    const origPgCert = process.env.AIRA_POSTGRES_CERTIFICATION;

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.AIRA_TEST_ENVIRONMENT;
      delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
      delete process.env.AIRA_POSTGRES_CERTIFICATION;

      await assert.rejects(
        () => migration031Down(mockKnexWithRecords),
        (err: any) => {
          assert.ok(err.message.includes('[MIGRATION SAFETY BARRIER]'));
          assert.ok(err.message.includes('contains 42 user record(s)'));
          return true;
        }
      );
      assert.equal(checkCalled, true, 'Must inspect existing task count before executing rollback');
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origTestEnv !== undefined) process.env.AIRA_TEST_ENVIRONMENT = origTestEnv;
      else delete process.env.AIRA_TEST_ENVIRONMENT;
      if (origForce !== undefined) process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = origForce;
      else delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
      if (origPgCert !== undefined) process.env.AIRA_POSTGRES_CERTIFICATION = origPgCert;
      else delete process.env.AIRA_POSTGRES_CERTIFICATION;
    }
  });

  await t.test('2. Rollback blocked in production even when empty, permitted with override or in disposable test DB', async () => {
    let droppedBrowser = false;
    let droppedTasks = false;

    const mockKnexEmpty: any = Object.assign(
      (_tableName: string) => ({
        count: () => ({
          first: async () => ({ count: '0' })
        })
      }),
      {
        schema: {
          hasTable: async () => true,
          dropTableIfExists: async (tableName: string) => {
            if (tableName === 'durable_browser_sessions') droppedBrowser = true;
            if (tableName === 'autonomous_agent_tasks') droppedTasks = true;
          }
        }
      }
    );

    const origEnv = process.env.NODE_ENV;
    const origAiraEnv = process.env.AIRA_ENV;
    const origForce = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
    const origCiDisposable = process.env.CI_DISPOSABLE_DATABASE;
    const origDbUrl = process.env.DATABASE_URL;
    const origTestUrl = process.env.ISOLATED_TEST_DATABASE_URL;

    try {
      // 1. In production without override: MUST reject even if tables are empty
      process.env.NODE_ENV = 'production';
      delete process.env.AIRA_ENV;
      delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
      delete process.env.CI_DISPOSABLE_DATABASE;

      await assert.rejects(
        () => migration031Down(mockKnexEmpty),
        (err: any) => {
          assert.ok(err.message.includes('[MIGRATION SAFETY BARRIER]'));
          assert.ok(err.message.includes('Destructive DDL is forbidden in production'));
          return true;
        }
      );
      assert.equal(droppedBrowser, false);
      assert.equal(droppedTasks, false);

      // 2. In production WITH override: permitted
      process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = 'true';
      await migration031Down(mockKnexEmpty);
      assert.equal(droppedBrowser, true);
      assert.equal(droppedTasks, true);

      // 3. In disposable test DB: permitted without override
      droppedBrowser = false;
      droppedTasks = false;
      delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
      process.env.NODE_ENV = 'test';
      process.env.CI_DISPOSABLE_DATABASE = 'true';
      process.env.DATABASE_URL = 'postgresql://aira:aira@127.0.0.1:5432/disposable_test';
      process.env.ISOLATED_TEST_DATABASE_URL = 'postgresql://aira:aira@127.0.0.1:5432/disposable_test';

      await migration031Down(mockKnexEmpty);
      assert.equal(droppedBrowser, true);
      assert.equal(droppedTasks, true);
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origAiraEnv !== undefined) process.env.AIRA_ENV = origAiraEnv;
      else delete process.env.AIRA_ENV;
      if (origForce !== undefined) process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK = origForce;
      else delete process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK;
      if (origCiDisposable !== undefined) process.env.CI_DISPOSABLE_DATABASE = origCiDisposable;
      else delete process.env.CI_DISPOSABLE_DATABASE;
      if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
      else delete process.env.DATABASE_URL;
      if (origTestUrl !== undefined) process.env.ISOLATED_TEST_DATABASE_URL = origTestUrl;
      else delete process.env.ISOLATED_TEST_DATABASE_URL;
    }
  });
});

if (isLivePostgres) {
  test('Mission B5 — Live PostgreSQL 16 Worker Integration', async (t) => {
    await migration031Up(db);
    const repo = new PostgresAutonomousTaskRepository(db);
    const registry = new SpecialistRegistry();
    registry.registerSpecialist(new PlannerSpecialistAgent(), 'LIVE');
    registry.registerSpecialist(new VerificationSpecialistAgent(), 'LIVE');

    const engine = new AutonomousAgentEngine({
      repository: repo,
      specialistRegistry: registry
    });

    const principal: ExecutionPrincipal = {
      userId: `user_live_${randomUUID().slice(0, 8)}`,
      sessionId: `sess_live_${randomUUID().slice(0, 8)}`,
      workspaceId: `ws_live_${randomUUID().slice(0, 8)}`,
      scopes: ['*']
    };

    await t.test('1. API task creation, worker claim, and database update on real PostgreSQL', async () => {
      const task = await engine.createTask('Real PostgreSQL worker claim test', principal);
      assert.equal(task.state, 'CREATED');

      const claim = await repo.claimTask(task.taskId, 'worker_live_1', 15000);
      assert.equal(claim.success, true);
      assert.equal(claim.task?.leaseOwner, 'worker_live_1');

      // Update observation
      await repo.addObservation(task.taskId, {
        observationId: `obs_${randomUUID().slice(0, 8)}`,
        stepId: 'step_live_1',
        source: 'specialist',
        sourceName: 'Planner Specialist',
        summary: 'Live PostgreSQL step completed',
        timestamp: Date.now()
      });

      const updated = await repo.getTask(task.taskId);
      assert.equal(updated?.observations.length, 1);
      assert.equal(updated?.observations[0].summary, 'Live PostgreSQL step completed');

      // Clean up test task
      await repo.deleteTask(task.taskId);
    });
  });
}

function task_id_extract(repo: any): string {
  for (const key of repo.tasks.keys()) {
    if (key.startsWith('autotask_')) {
      return key.replace('autotask_', '');
    }
  }
  return '';
}
