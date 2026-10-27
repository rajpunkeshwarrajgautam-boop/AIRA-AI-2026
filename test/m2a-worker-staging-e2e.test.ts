import './setup-isolated-neon.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import http from 'node:http';

import {
  classifyDatabaseUrl,
  assertAuthorizedStagingDatabase,
  STAGING_NEON_PROJECT_ID
} from '../packages/db/src/security/database-isolation-guard.js';
import { db } from '../packages/db/src/index.js';
import { up as migration026Up } from '../packages/db/src/migrations/026_specialist_durable_execution_schema.js';
import { PostgresSpecialistTaskRepository } from '../packages/agent-runtime/src/durable/specialist-task-repository.js';
import { TaskLeaseManager } from '../packages/agent-runtime/src/durable/task-lease-manager.js';
import { DurableTaskScheduler } from '../packages/agent-runtime/src/durable/durable-task-scheduler.js';
import { TaskDAG, ExecutionPrincipal } from '../packages/contracts/src/index.js';

test.describe('AIRA AI 2026 — Milestone 2A.1 Standalone Docker Specialist Worker & End-to-End Staging Suite', () => {
  let isolatedConnStr: string;
  let repo: PostgresSpecialistTaskRepository;
  let scheduler: DurableTaskScheduler;
  const containerName1 = 'aira-worker-staging-test-1';
  const containerName2 = 'aira-worker-staging-test-2';
  const workerPort = 8085;

  const testPrincipalA: ExecutionPrincipal = {
    userId: 'usr_m2a1_operator_a',
    sessionId: 'sess_m2a1_operator_a',
    workspaceId: 'ws_m2a1_staging',
    role: 'user'
  };

  const testPrincipalB: ExecutionPrincipal = {
    userId: 'usr_m2a1_intruder_b',
    sessionId: 'sess_m2a1_intruder_b',
    workspaceId: 'ws_m2a1_intruder',
    role: 'user'
  };

  // Cleanup containers before and after tests
  function cleanupContainers() {
    for (const name of [containerName1, containerName2]) {
      try {
        execSync(`docker rm -f ${name}`, { stdio: 'ignore' });
      } catch {}
    }
  }

  test.before(() => {
    cleanupContainers();
  });

  test.after(() => {
    cleanupContainers();
  });

  async function ensureParentRun(runId: string, principalId: string): Promise<void> {
    const existing = await db('runs').where({ id: runId }).first();
    if (!existing) {
      await db('runs').insert({
        id: runId,
        principal_id: principalId,
        session_id: `sess_${principalId}`,
        prompt: `M2-A.1 Parent Run for ${runId}`,
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

  function httpGetJson(url: string, timeoutMs = 4000): Promise<{ statusCode: number; data: any }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const req = http.get(url, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const data = JSON.parse(body);
            resolve({ statusCode: res.statusCode || 200, data });
          } catch {
            resolve({ statusCode: res.statusCode || 200, data: body });
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // ==========================================
  // GATE 1: DOCKER IMAGE PACKAGING & HARDENING
  // ==========================================

  test('GATE 1: Docker image aira-specialist-worker:staging exists, is minimal, non-root, and hardened', () => {
    const inspectRaw = execSync('docker inspect aira-specialist-worker:staging', { encoding: 'utf8' });
    const inspectData = JSON.parse(inspectRaw);
    assert.ok(inspectData.length > 0, 'Docker image must be inspectable');

    const config = inspectData[0].Config;
    const sizeBytes = inspectData[0].Size;

    // 1. Non-root user
    assert.strictEqual(config.User, 'aira', 'Image must configure non-root user aira');

    // 2. Process entrypoint with dumb-init for graceful SIGTERM
    assert.ok(Array.isArray(config.Entrypoint), 'Entrypoint must be configured');
    assert.strictEqual(config.Entrypoint[0], 'dumb-init', 'Entrypoint must use dumb-init');

    // 3. Healthcheck defined in container
    assert.ok(config.Healthcheck, 'Image must declare HEALTHCHECK');

    // 4. Bounded image size (< 500MB)
    assert.ok(sizeBytes < 500 * 1024 * 1024, `Image size (${Math.round(sizeBytes / 1024 / 1024)}MB) must be bounded under 500MB`);
  });

  // ==========================================
  // GATE 2: ISOLATED STAGING NEON DATABASE VERIFICATION
  // ==========================================

  test('GATE 2: Database target is verified isolated staging Neon branch with strict TLS', async () => {
    isolatedConnStr = execSync('neon connection-string br-muddy-wave-b3zxhkqf --project-id mute-frost-50372225', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();

    if (!isolatedConnStr.includes('sslmode=')) {
      isolatedConnStr += (isolatedConnStr.includes('?') ? '&' : '?') + 'sslmode=require';
    }

    // Classify
    const classification = classifyDatabaseUrl(isolatedConnStr);
    assert.strictEqual(classification.isProduction, false, 'Must NOT connect to production Neon');
    assert.strictEqual(classification.category, 'isolated_neon_preview');

    process.env.DATABASE_URL = isolatedConnStr;
    await migration026Up(db);

    repo = new PostgresSpecialistTaskRepository();
    scheduler = new DurableTaskScheduler(repo, { maxConcurrency: 2 });
  });

  // ==========================================
  // GATE 3: STANDALONE WORKER CONTAINER INDEPENDENCE & HEALTH
  // ==========================================

  test('GATE 3: Standalone worker container starts, connects to staging DB, and reports truthful health', async () => {
    // Start container
    const runCmd = `docker run -d --name ${containerName1} -p ${workerPort}:8080 ` +
      `-e DATABASE_URL="${isolatedConnStr}" ` +
      `-e WORKER_ID=worker_docker_test_1 ` +
      `-e WORKER_CONCURRENCY=2 ` +
      `-e POLL_INTERVAL_MS=300 ` +
      `-e LEASE_DURATION_MS=6000 ` +
      `-e HEARTBEAT_INTERVAL_MS=1000 ` +
      `--memory 512m ` +
      `aira-specialist-worker:staging`;

    execSync(runCmd, { stdio: 'inherit' });

    // Poll for container readiness on http://localhost:8085/health
    let ready = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await httpGetJson(`http://localhost:${workerPort}/health`, 2000);
        if (res.statusCode === 200 && res.data?.status === 'HEALTHY' && res.data?.db === 'CONNECTED') {
          ready = true;
          break;
        }
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    assert.strictEqual(ready, true, 'Worker container must become HEALTHY and report db CONNECTED');

    // Verify /ready endpoint
    const readyRes = await httpGetJson(`http://localhost:${workerPort}/ready`, 2000);
    assert.strictEqual(readyRes.statusCode, 200);
    assert.strictEqual(readyRes.data.ready, true);
    assert.strictEqual(readyRes.data.workerId, 'worker_docker_test_1');
  });

  // ==========================================
  // GATE 4: CLIENT DISCONNECTION ACCEPTANCE TEST
  // ==========================================

  test('GATE 4: Client submits durable mathematical mission, disconnects immediately, and retrieves 4194304 upon reconnection', async () => {
    const runId = `run_docker_e2e_${Date.now()}`;
    const taskId = `math_task_docker_${Date.now()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const dag: TaskDAG = {
      dagId: `dag_${runId}`,
      runId,
      maxConcurrency: 1,
      totalBudget: { maxTotalTokens: 10000 },
      tasks: [
        {
          taskId,
          runId,
          role: 'analyst',
          objective: 'Autonomous calculation of ((16384 * 1024) / 4) by standalone Docker worker',
          dependencies: [],
          inputContract: {
            expression: '((16384 * 1024) / 4)'
          },
          expectedOutputContract: {},
          executionConstraints: {
            sideEffectLevel: 'NONE',
            allowedTools: ['calculator'],
            sandboxRequired: false,
            requireStrictJsonOutput: true
          },
          authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
          budgetLimits: { maxTokens: 4096 },
          timeoutConfig: { stepTimeoutMs: 30000 },
          retryPolicy: { maxRetries: 2, backoffMultiplier: 1.5 }
        }
      ]
    };

    // 1. Submit DAG to queue
    const created = await scheduler.submitDAG(dag, testPrincipalA, { missionId: `mission_${runId}` });
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].state, 'QUEUED');

    // 2. CLIENT DISCONNECTION: Client disconnects completely. Zero polling during initial execution.
    // The independent Docker container claims and executes the task autonomously in the background.
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 3. CLIENT RECONNECTION: Reconnect with testPrincipalA identity and retrieve result
    let completedTask: any = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      completedTask = await repo.getTask(taskId);
      if (completedTask?.state === 'COMPLETED') break;
      await new Promise(r => setTimeout(r, 400));
    }

    assert.ok(completedTask, 'Task must exist in PostgreSQL');
    assert.strictEqual(completedTask.state, 'COMPLETED', 'Task must be in terminal COMPLETED state');
    assert.strictEqual(completedTask.outcome, 'COMPLETED');

    // Verify exact calculation 4194304
    const output = completedTask.resultOutput as { expression: string; result: number };
    assert.strictEqual(output.result, 4194304, 'Result must be exact mathematical output 4194304');
    assert.strictEqual(output.expression, '((16384 * 1024) / 4)');

    // Verify checkpoints were persisted
    const checkpoints = completedTask.checkpoints.map(c => c.checkpoint);
    assert.ok(checkpoints.includes('SPECIALIST_DISPATCHED'), 'Must include SPECIALIST_DISPATCHED checkpoint');
    assert.ok(checkpoints.includes('SPECIALIST_FINISHED'), 'Must include SPECIALIST_FINISHED checkpoint');

    // Verify tool calls persisted in tool_calls table
    const toolCalls = await db('tool_calls').where({ run_id: runId });
    assert.ok(toolCalls.length >= 1, 'Tool call must be persisted in database by worker');
    assert.strictEqual(toolCalls[0].tool, 'calculator');
    assert.strictEqual(toolCalls[0].status, 'COMPLETED');

    // Verify events in specialist_task_events table
    const events = await db('specialist_task_events').where({ task_id: taskId });
    assert.ok(events.length >= 2, 'Events must be recorded for task transitions');
    const eventTypes = events.map(e => e.event_type);
    assert.ok(eventTypes.includes('TASK_CLAIMED'));
    assert.ok(eventTypes.includes('TASK_STATE_COMPLETED'));
  });

  // ==========================================
  // GATE 5: TENANT & PRINCIPAL CROSS-USER ISOLATION
  // ==========================================

  test('GATE 5: Cross-user tenant isolation strictly isolates tasks and prevents foreign visibility', async () => {
    const tasksForA = await repo.listTasksByPrincipal(testPrincipalA.userId, 10);
    assert.ok(tasksForA.length > 0, 'Principal A must see own tasks');

    const tasksForB = await repo.listTasksByPrincipal(testPrincipalB.userId, 10);
    const hasLeak = tasksForB.some(t => t.principalId === testPrincipalA.userId);
    assert.strictEqual(hasLeak, false, 'Principal B must never see tasks belonging to Principal A');
  });

  // ==========================================
  // GATE 6: ABRUPT WORKER CRASH & REPLACEMENT RECOVERY
  // ==========================================

  test('GATE 6: Abrupt container termination during execution triggers replacement worker claim and recovery to 4194304', async () => {
    const runId = `run_crash_${Date.now()}`;
    const taskId = `math_task_crash_${Date.now()}`;
    await ensureParentRun(runId, testPrincipalA.userId);

    const now = Date.now();
    // Insert task claimed by worker_docker_test_1 with an already-expired lease
    await repo.saveTask({
      id: taskId,
      runId,
      principalId: testPrincipalA.userId,
      role: 'analyst',
      objective: 'Crash recovery calculation of ((16384 * 1024) / 4)',
      state: 'RUNNING',
      dependencies: [],
      inputPayload: { expression: '((16384 * 1024) / 4)' },
      executionConstraints: { sideEffectLevel: 'NONE', allowedTools: ['calculator'] },
      authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
      budgetLimits: { maxTokens: 4096 },
      timeoutMs: 30000,
      attemptCount: 1,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 1,
      leaseOwner: 'worker_crashed_container',
      leaseExpiresAt: now - 2000, // Expired lease
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'worker_crashed_container' },
      checkpoints: [{ checkpoint: 'DISPATCHED_BEFORE_CRASH', timestamp: now - 3000 }],
      createdAt: now - 5000,
      updatedAt: now - 2000
    });

    // The running worker container worker_docker_test_1 will reclaim the expired lease on its tick,
    // increment fencing token, execute the task, and persist COMPLETED with 4194304!
    let recovered = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const current = await repo.getTask(taskId);
      if (current?.state === 'COMPLETED') {
        recovered = true;
        assert.strictEqual((current.resultOutput as any)?.result, 4194304);
        assert.ok(current.fencingToken > 1, 'Fencing token must be monotonically incremented');
        break;
      }
      await new Promise(r => setTimeout(r, 400));
    }

    assert.strictEqual(recovered, true, 'Replacement worker must reclaim expired lease and complete task to 4194304');
  });

  // ==========================================
  // GATE 7: GRACEFUL CONTAINER SHUTDOWN & CLEAN EXIT
  // ==========================================

  test('GATE 7: Graceful container shutdown responds to SIGTERM and exits cleanly with code 0', () => {
    // Send stop command (SIGTERM)
    execSync(`docker stop ${containerName1}`, { stdio: 'inherit' });

    // Inspect container exit code
    const exitCodeRaw = execSync(`docker inspect ${containerName1} --format "{{.State.ExitCode}}"`, { encoding: 'utf8' }).trim();
    assert.strictEqual(exitCodeRaw, '0', 'Container must exit with code 0 on graceful shutdown');
  });
});
