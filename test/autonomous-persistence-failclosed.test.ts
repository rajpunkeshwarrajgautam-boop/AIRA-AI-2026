import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PostgresAutonomousTaskRepository,
  InMemoryAutonomousTaskRepository,
  AutonomousPersistenceUnavailableError,
  createOfflinePostgresClient
} from '../packages/agent-runtime/src/autonomous/repository.js';
import type { ExecutionPrincipal, AutonomousAgentTask } from '../packages/contracts/src/index.js';

test('Mission A2 — Durable Autonomous Task Persistence Fail-Closed Certification', async (t) => {
  const principalA: ExecutionPrincipal = {
    userId: 'user_failclosed_a',
    sessionId: 'session_fc_1',
    workspaceId: 'ws_tenant_alpha',
    scopes: ['*']
  };

  const sampleTask: AutonomousAgentTask = {
    taskId: 'task_fc_001',
    principal: principalA,
    objective: 'Fail-closed persistence verification',
    state: 'CREATED',
    observations: [],
    artifacts: [],
    workingMemory: {},
    executionHistory: [{ state: 'CREATED', timestamp: Date.now() }],
    fencingToken: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await t.test('1. PostgresAutonomousTaskRepository Fails Closed on Outage for All Operations', async () => {
    const pgRepo = new PostgresAutonomousTaskRepository(createOfflinePostgresClient());

    // 1a. createTask fails closed
    await assert.rejects(
      async () => {
        await pgRepo.createTask(sampleTask);
      },
      (err: any) => {
        assert.ok(err instanceof AutonomousPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        assert.match(err.message, /createTask/);
        return true;
      }
    );

    // 1b. getTask fails closed
    await assert.rejects(
      async () => {
        await pgRepo.getTask('task_fc_001');
      },
      (err: any) => {
        assert.ok(err instanceof AutonomousPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        assert.match(err.message, /getTask/);
        return true;
      }
    );

    // 1c. updateState fails closed
    await assert.rejects(
      async () => {
        await pgRepo.updateState('task_fc_001', 'PLANNING');
      },
      (err: any) => {
        assert.ok(err instanceof AutonomousPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        assert.match(err.message, /updateState|getTask/);
        return true;
      }
    );

    // 1d. claimTask fails closed
    await assert.rejects(
      async () => {
        await pgRepo.claimTask('task_fc_001', 'worker_01', 30000);
      },
      (err: any) => {
        assert.ok(err instanceof AutonomousPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        return true;
      }
    );

    // 1e. renewLease fails closed
    await assert.rejects(
      async () => {
        await pgRepo.renewLease('task_fc_001', 'worker_01', 30000, 1);
      },
      (err: any) => {
        assert.ok(err instanceof AutonomousPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        return true;
      }
    );

    // 1f. findRecoverableTasks fails closed
    await assert.rejects(
      async () => {
        await pgRepo.findRecoverableTasks(Date.now(), 10);
      },
      (err: any) => {
        assert.ok(err instanceof AutonomousPersistenceUnavailableError);
        assert.equal(err.code, 'PERSISTENCE_UNAVAILABLE');
        return true;
      }
    );
  });

  await t.test('2. Fencing Token Monotonicity & Concurrent Worker Protection', async () => {
    const memRepo = new InMemoryAutonomousTaskRepository();
    const task = await memRepo.createTask(sampleTask);

    assert.equal(task.fencingToken, 0);

    // Advance state: 0 -> 1
    const t1 = await memRepo.updateState(task.taskId, 'PLANNING', 'Start planning');
    assert.equal(t1.fencingToken, 1);

    // Advance state: 1 -> 2
    const t2 = await memRepo.updateState(task.taskId, 'READY', 'Plan established');
    assert.equal(t2.fencingToken, 2);

    // Worker with stale fencing token 1 attempts update -> REJECTED
    await assert.rejects(
      async () => {
        await memRepo.updateState(task.taskId, 'RUNNING', 'Stale worker', undefined, 1);
      },
      /STALE_FENCING_TOKEN/,
      'Must reject update with outdated fencing token'
    );

    // Valid update with current token 2 succeeds
    const t3 = await memRepo.updateState(task.taskId, 'RUNNING', 'Valid worker', undefined, 2);
    assert.equal(t3.fencingToken, 3);
  });

  await t.test('3. Idempotent Retry Safety without Side Effect Duplication', async () => {
    const memRepo = new InMemoryAutonomousTaskRepository();
    const taskA = await memRepo.createTask({
      ...sampleTask,
      taskId: 'task_retry_01',
      idempotencyKey: 'idem_key_retry_safe'
    });

    // Submitting duplicate idempotencyKey returns identical task
    const taskDup = await memRepo.createTask({
      ...sampleTask,
      taskId: 'task_retry_different_id',
      idempotencyKey: 'idem_key_retry_safe',
      objective: 'Ignored text'
    });

    assert.equal(taskDup.taskId, taskA.taskId);
    assert.equal(taskDup.objective, 'Fail-closed persistence verification');
  });
});
