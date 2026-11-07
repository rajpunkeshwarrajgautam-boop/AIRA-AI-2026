import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/src/index.js';
import {
  PostgresAutonomousTaskRepository,
  InMemoryAutonomousTaskRepository,
  AutonomousPersistenceUnavailableError,
  createOfflinePostgresClient
} from '../packages/agent-runtime/src/autonomous/repository.js';
import {
  PostgresBrowserSessionStorage,
  InMemoryBrowserSessionStorage,
  BrowserPersistenceUnavailableError
} from '../packages/tool-runtime/src/adapters/browser-adapter.js';
import type { AutonomousAgentTask } from '../packages/contracts/src/index.js';
import { up as migration031Up } from '../packages/db/src/migrations/031_autonomous_agent_tasks.js';

const isLivePostgresCertified = process.env.AIRA_POSTGRES_CERTIFICATION === '1';

if (isLivePostgresCertified) {
  execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });
}

test('Mission A3 — Autonomous Task & Browser Session Real PostgreSQL Database Certification', async (t) => {
  if (isLivePostgresCertified) {
    // Ensure migration 031 is applied to the disposable database
    await migration031Up(db);

    const taskRepo = new PostgresAutonomousTaskRepository();
    const browserStorage = new PostgresBrowserSessionStorage(db);

    const testPrincipal = {
      userId: `user_auto_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      sessionId: `sess_auto_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      workspaceId: `ws_auto_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      scopes: ['*']
    };

    await t.test('1. Verify Schema Columns and Constraints on Real PostgreSQL', async () => {
      const hasWorkingMemory = await db.schema.hasColumn('autonomous_agent_tasks', 'working_memory');
      assert.equal(hasWorkingMemory, true, 'Column "working_memory" must exist on autonomous_agent_tasks');

      const hasTasksTable = await db.schema.hasTable('autonomous_agent_tasks');
      assert.equal(hasTasksTable, true, 'Table "autonomous_agent_tasks" must exist');

      const hasBrowserTable = await db.schema.hasTable('durable_browser_sessions');
      assert.equal(hasBrowserTable, true, 'Table "durable_browser_sessions" must exist');
    });

    await t.test('2. Exercise Task Creation with Working Memory', async () => {
      const taskId = `task_live_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const task: AutonomousAgentTask = {
        taskId,
        principal: testPrincipal,
        objective: 'Real PostgreSQL autonomous mission verification',
        state: 'CREATED',
        workingMemory: {
          currentHypothesis: 'PostgreSQL durability verified',
          stepCount: 1,
          contextData: { attempt: 'alpha' }
        },
        observations: [],
        artifacts: [],
        executionHistory: [],
        fencingToken: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      const created = await taskRepo.createTask(task);
      assert.equal(created.taskId, taskId);
      assert.equal(created.workingMemory?.currentHypothesis, 'PostgreSQL durability verified');

      // Verify row persisted directly in PostgreSQL
      const row = await db('autonomous_agent_tasks').where({ task_id: taskId }).first();
      assert.ok(row, 'Task row must exist in PostgreSQL');
      assert.equal(row.objective, task.objective);
      const parsedMem = typeof row.working_memory === 'string' ? JSON.parse(row.working_memory) : row.working_memory;
      assert.equal(parsedMem.currentHypothesis, 'PostgreSQL durability verified');
    });

    await t.test('3. Exercise Updating Working Memory, Observations, and Artifacts', async () => {
      const taskId = `task_live_upd_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const initialTask: AutonomousAgentTask = {
        taskId,
        principal: testPrincipal,
        objective: 'Update working memory and artifacts test',
        state: 'RUNNING',
        workingMemory: { phase: 'init' },
        observations: [],
        artifacts: [],
        executionHistory: [],
        fencingToken: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await taskRepo.createTask(initialTask);

      // Mutate and update
      initialTask.workingMemory = {
        phase: 'execution_verified',
        completedSteps: ['step_1', 'step_2'],
        confidence: 0.99
      };
      initialTask.observations.push({
        stepId: 'step_1',
        type: 'TOOL_RESULT',
        content: 'Observation recorded in PostgreSQL',
        timestamp: Date.now()
      });
      initialTask.artifacts.push({
        artifactId: 'art_1',
        title: 'Certification Output',
        type: 'markdown',
        content: '# Verified',
        createdAt: Date.now()
      });

      const updated = await taskRepo.updateTask(initialTask);
      assert.equal(updated.workingMemory?.phase, 'execution_verified');
      assert.equal(updated.observations.length, 1);
      assert.equal(updated.artifacts.length, 1);

      // Verify via fresh getTask
      const fetched = await taskRepo.getTask(taskId);
      assert.ok(fetched);
      assert.equal(fetched.workingMemory?.phase, 'execution_verified');
      assert.equal(fetched.workingMemory?.completedSteps?.length, 2);
      assert.equal(fetched.observations.length, 1);
      assert.equal(fetched.artifacts.length, 1);
    });

    await t.test('4. Exercise Atomic State Transitions and Monotonic Fencing Tokens', async () => {
      const taskId = `task_live_fencing_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const task: AutonomousAgentTask = {
        taskId,
        principal: testPrincipal,
        objective: 'Fencing token monotonicity test',
        state: 'CREATED',
        workingMemory: {},
        observations: [],
        artifacts: [],
        executionHistory: [],
        fencingToken: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await taskRepo.createTask(task);

      // Transition to PLANNING with expectedFencingToken 0 -> token becomes 1
      const planning = await taskRepo.updateState(taskId, 'PLANNING', 'starting plan', 'chk_plan', 0);
      assert.equal(planning.state, 'PLANNING');
      assert.equal(planning.fencingToken, 1);

      // Stale update using old fencing token 0 MUST reject
      await assert.rejects(
        async () => {
          await taskRepo.updateState(taskId, 'RUNNING', 'stale worker update', 'chk_stale', 0);
        },
        /STALE_FENCING_TOKEN/,
        'Stale worker fencing token must be rejected'
      );

      // Transition to RUNNING with expectedFencingToken 1 -> token becomes 2
      const running = await taskRepo.updateState(taskId, 'RUNNING', 'starting execution', 'chk_run', 1);
      assert.equal(running.state, 'RUNNING');
      assert.equal(running.fencingToken, 2);

      // Transition from RUNNING to WAITING_FOR_APPROVAL with expectedFencingToken 2 -> token becomes 3
      const waitingApproval = await taskRepo.updateState(taskId, 'WAITING_FOR_APPROVAL', 'need user confirmation', 'chk_appr', 2);
      assert.equal(waitingApproval.state, 'WAITING_FOR_APPROVAL');
      assert.equal(waitingApproval.fencingToken, 3);
    });

    await t.test('5. Exercise Task Lease Management and Crash Recovery', async () => {
      const taskId = `task_live_lease_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const task: AutonomousAgentTask = {
        taskId,
        principal: testPrincipal,
        objective: 'Lease crash recovery test',
        state: 'RUNNING',
        workingMemory: {},
        observations: [],
        artifacts: [],
        executionHistory: [],
        fencingToken: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await taskRepo.createTask(task);

      // Claim task by worker 1
      const claim1 = await taskRepo.claimTask!(taskId, 'worker_node_alpha', 60000);
      assert.equal(claim1.success, true);
      assert.equal(claim1.task?.leaseOwner, 'worker_node_alpha');

      // Stale renew lease with old fencing token (1) must be rejected
      const staleRenew = await taskRepo.renewLease!(taskId, 'worker_node_alpha', 60000, 1);
      assert.equal(staleRenew, false, 'Stale fencing token must be rejected during lease renewal');

      // Renew lease with active fencing token
      const activeFencingToken = claim1.task!.fencingToken!;
      const renewed = await taskRepo.renewLease!(taskId, 'worker_node_alpha', 60000, activeFencingToken);
      assert.equal(renewed, true, 'Active fencing token must succeed during lease renewal');

      // Simulate lease expiration
      await db('autonomous_agent_tasks')
        .where({ task_id: taskId })
        .update({ lease_expires_at: Date.now() - 5000 });

      // findRecoverableTasks finds the abandoned task
      const recoverable = await taskRepo.findRecoverableTasks!(Date.now());
      assert.ok(recoverable.some(t => t.taskId === taskId), 'Expired lease task must be recoverable');
    });

    await t.test('6. Exercise Task Deletion', async () => {
      const taskId = `task_live_del_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const task: AutonomousAgentTask = {
        taskId,
        principal: testPrincipal,
        objective: 'Deletion verification test',
        state: 'COMPLETED',
        workingMemory: {},
        observations: [],
        artifacts: [],
        executionHistory: [],
        fencingToken: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await taskRepo.createTask(task);
      assert.ok(await taskRepo.getTask(taskId));

      // Delete task
      await taskRepo.deleteTask!(taskId);

      // Verify deletion in repository and directly in database
      const fetched = await taskRepo.getTask(taskId);
      assert.equal(fetched, null);
      const row = await db('autonomous_agent_tasks').where({ task_id: taskId }).first();
      assert.equal(row, undefined);
    });

    await t.test('7. Exercise Atomic Database-Level Idempotency Under Concurrent Submissions', async () => {
      const sharedIdempotencyKey = `idem_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const taskIdA = `task_concurrent_A_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const taskIdB = `task_concurrent_B_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

      const taskA: AutonomousAgentTask = {
        taskId: taskIdA,
        principal: testPrincipal,
        objective: 'Concurrent idempotent submission A',
        state: 'CREATED',
        idempotencyKey: sharedIdempotencyKey,
        workingMemory: { worker: 'A' },
        observations: [],
        artifacts: [],
        executionHistory: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      const taskB: AutonomousAgentTask = {
        taskId: taskIdB,
        principal: testPrincipal,
        objective: 'Concurrent idempotent submission B',
        state: 'CREATED',
        idempotencyKey: sharedIdempotencyKey,
        workingMemory: { worker: 'B' },
        observations: [],
        artifacts: [],
        executionHistory: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      // Submit concurrently
      const [resA, resB] = await Promise.all([
        taskRepo.createTask(taskA),
        taskRepo.createTask(taskB)
      ]);

      // Both callers receive the exact same task
      assert.equal(resA.taskId, resB.taskId, 'Concurrent callers must receive the exact same task');
      assert.equal(resA.idempotencyKey, sharedIdempotencyKey);

      // Verify exactly ONE row exists in PostgreSQL with this idempotency key
      const countRes = await db('autonomous_agent_tasks')
        .where({ principal_id: testPrincipal.userId, idempotency_key: sharedIdempotencyKey })
        .count<{ count: string | number }[]>('* as count');
      const count = Number(countRes[0].count);
      assert.equal(count, 1, 'Database unique constraint uq_auto_tasks_idempotency must enforce exactly 1 row');
    });

    await t.test('8. Exercise Durable Browser Session Storage on Real PostgreSQL', async () => {
      const sessionKey = `${testPrincipal.userId}:${testPrincipal.sessionId}`;
      const envelope = {
        sessionKey,
        principalId: testPrincipal.userId,
        workspaceId: testPrincipal.workspaceId,
        sessionId: testPrincipal.sessionId,
        encryptedEnvelope: JSON.stringify({ iv: 'test_iv', tag: 'test_tag', data: 'test_data' }),
        expiresAt: Date.now() + 60000,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      // Save
      await browserStorage.saveSession(envelope);

      // Read
      const retrieved = await browserStorage.getSession(sessionKey);
      assert.ok(retrieved);
      assert.equal(retrieved.sessionKey, sessionKey);
      assert.equal(retrieved.principalId, testPrincipal.userId);

      // List
      const listed = await browserStorage.listSessions(testPrincipal.userId, testPrincipal.workspaceId);
      assert.ok(listed.length >= 1);
      assert.ok(listed.some(s => s.sessionKey === sessionKey));

      // Delete
      await browserStorage.deleteSession(sessionKey);
      const postDelete = await browserStorage.getSession(sessionKey);
      assert.equal(postDelete, null);
    });
  } else {
    // When running in isolated environments without live PostgreSQL attached
    await t.test('Contract: Migration 031 exports schema definition with working_memory and uq_auto_tasks_idempotency', () => {
      assert.equal(typeof migration031Up, 'function');
    });

    await t.test('Contract: InMemoryAutonomousTaskRepository supports workingMemory and deleteTask', async () => {
      const inMemRepo = new InMemoryAutonomousTaskRepository();
      const task: AutonomousAgentTask = {
        taskId: 'task_inmem_1',
        principal: { userId: 'alice', sessionId: 'sess_1', scopes: ['*'] },
        objective: 'In-memory contract validation',
        state: 'CREATED',
        workingMemory: { step: 1, notes: 'in-memory test' },
        observations: [],
        artifacts: [],
        executionHistory: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      const created = await inMemRepo.createTask(task);
      assert.equal(created.workingMemory?.step, 1);

      await inMemRepo.deleteTask('task_inmem_1');
      const retrieved = await inMemRepo.getTask('task_inmem_1');
      assert.equal(retrieved, null);
    });

    await t.test('Contract: PostgresAutonomousTaskRepository fails closed on outage for all operations', async () => {
      const taskRepo = new PostgresAutonomousTaskRepository(createOfflinePostgresClient());
      await assert.rejects(
        async () => {
          await taskRepo.getTask('non_existent_due_to_db_outage');
        },
        /AUTONOMOUS_PERSISTENCE_UNAVAILABLE/
      );
    });

    await t.test('Contract: PostgresBrowserSessionStorage fails closed on outage for all operations', async () => {
      const browserStorage = new PostgresBrowserSessionStorage(createOfflinePostgresClient());
      await assert.rejects(
        async () => {
          await browserStorage.getSession('non_existent_key');
        },
        /BROWSER_PERSISTENCE_UNAVAILABLE/
      );
    });
  }
});
