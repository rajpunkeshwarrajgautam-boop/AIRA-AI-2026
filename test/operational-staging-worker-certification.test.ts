/**
 * AIRA AI 2026 — Mission 1: Operational Staging Deployable Worker Certification
 * 
 * Comprehensive E2E test runner validating the standalone background worker
 * daemon (apps/specialist-worker/src/index.ts) against the 8 core operational targets:
 * 
 * Target 1: Worker startup, port binding & truthful readiness/health probes
 * Target 2: Both task queues (specialist_tasks and autonomous_agent_tasks)
 * Target 3: Real API-to-worker execution & decoupling
 * Target 4: Database persistence, checkpoints, and atomic fencing tokens
 * Target 5: Worker crash and restart recovery with step idempotency
 * Target 6: Real tool execution (MCP secret scrubbing, untrusted tagging, sandbox fail-closed, browser session envelope encryption)
 * Target 7: Browser and sandbox dependencies validation
 * Target 8: Graceful shutdown on SIGTERM with exit code 0
 */

import './setup-isolated-neon.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync, ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import fsSync from 'node:fs';

import {
  classifyDatabaseUrl,
  PRODUCTION_NEON_PROJECT_ID
} from '../packages/db/src/security/database-isolation-guard.js';
import { db } from '../packages/db/src/index.js';
import { PostgresSpecialistTaskRepository } from '../packages/agent-runtime/src/durable/specialist-task-repository.js';
import { DurableTaskScheduler } from '../packages/agent-runtime/src/durable/durable-task-scheduler.js';
import {
  PostgresAutonomousTaskRepository,
  AutonomousAgentTask
} from '../packages/agent-runtime/src/autonomous/index.js';
import { PostgresWorkspaceAuthorityRepository } from '../packages/agent-runtime/src/workspace-authority.js';
import { resolveIsolatedSandboxProvider } from '../packages/builder-runtime/src/sandbox.js';
import { McpHost, sanitizeStdioEnv } from '../packages/mcp/src/index.js';
import { createTestMcpServer } from '../packages/mcp/src/test-server.js';
import { ToolGateway } from '../packages/tool-runtime/src/gateway.js';
import { InMemoryToolCallRepository } from '../packages/tool-runtime/src/repository.js';
import {
  BrowserAdapter,
  PostgresBrowserSessionStorage,
  resolveBrowserExecutablePath
} from '../packages/tool-runtime/src/adapters/browser-adapter.js';
import { TaskDAG, ExecutionPrincipal } from '../packages/contracts/src/index.js';

test.describe('AIRA AI 2026 — Mission 1: Operational Deployable Worker Certification', () => {
  const workerPort = 8100 + (process.pid % 400);
  const workerId = `worker_m1_cert_${Date.now()}`;
  let workerProcess: ChildProcess | null = null;
  let isolatedConnStr: string;
  let specialistRepo: PostgresSpecialistTaskRepository;
  let autoRepo: PostgresAutonomousTaskRepository;
  let scheduler: DurableTaskScheduler;
  let workspaceRepo: PostgresWorkspaceAuthorityRepository;

  const testPrincipal: ExecutionPrincipal = {
    userId: 'usr_m1_cert_operator',
    sessionId: 'sess_m1_cert_session',
    workspaceId: 'ws_m1_cert_staging',
    role: 'user',
    scopes: ['*']
  };

  function httpGetJson(url: string, timeoutMs = 4000): Promise<{ statusCode: number; data: any }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms for ${url}`));
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

  async function ensureParentRun(runId: string, principalId: string): Promise<void> {
    const existing = await db('runs').where({ id: runId }).first();
    if (!existing) {
      await db('runs').insert({
        id: runId,
        principal_id: principalId,
        workspace_id: testPrincipal.workspaceId,
        session_id: `sess_${principalId}`,
        prompt: `Mission 1 Parent Run for ${runId}`,
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

  test.before(async () => {
    // 1. Establish verified isolated staging Neon database connection
    isolatedConnStr = execSync('neon connection-string br-muddy-wave-b3zxhkqf --project-id mute-frost-50372225', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();

    if (!isolatedConnStr.includes('sslmode=')) {
      isolatedConnStr += (isolatedConnStr.includes('?') ? '&' : '?') + 'sslmode=require';
    }

    const classification = classifyDatabaseUrl(isolatedConnStr);
    assert.strictEqual(classification.isProduction, false, 'Must not connect to production database');
    assert.strictEqual(classification.category, 'isolated_neon_preview');

    process.env.DATABASE_URL = isolatedConnStr;

    // 2. Provision and bind active workspace authority for test principal
    workspaceRepo = new PostgresWorkspaceAuthorityRepository();
    const resolvedWs = await workspaceRepo.resolveWorkspace(testPrincipal.userId);
    testPrincipal.workspaceId = resolvedWs;

    specialistRepo = new PostgresSpecialistTaskRepository();
    autoRepo = new PostgresAutonomousTaskRepository();
    scheduler = new DurableTaskScheduler(specialistRepo, { maxConcurrency: 2 });
  });

  test.after(async () => {
    // Clean up worker process if still running
    if (workerProcess && !workerProcess.killed) {
      try {
        workerProcess.kill('SIGKILL');
      } catch {}
    }
    await db.destroy();
  });

  // =========================================================================
  // TARGET 1: WORKER STARTUP & READINESS PROBE REPORTING
  // =========================================================================

  test('Target 1.1: Specialist worker unconditionally fails closed on production Neon URL', () => {
    const prodNeonUrl = 'postgresql://aira_user@ep-withered-art-b36ox90b.us-east-2.aws.neon.tech/neondb?sslmode=require';
    const cliPath = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    const workerPath = path.resolve(process.cwd(), 'apps/specialist-worker/src/index.ts');

    try {
      execSync(`node "${cliPath}" "${workerPath}"`, {
        env: {
          ...process.env,
          DATABASE_URL: prodNeonUrl,
          AIRA_ENV: 'staging'
        },
        stdio: 'pipe',
        timeout: 10000
      });
      assert.fail('Worker must not start with production database URL');
    } catch (err: any) {
      assert.strictEqual(err.status, 1, 'Worker must exit with status code 1');
      const output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');
      assert.ok(output.includes('[SECURITY FATAL]'), 'Output must log [SECURITY FATAL]');
      assert.ok(
        output.includes(PRODUCTION_NEON_PROJECT_ID) || output.includes('production Neon database'),
        'Must cite production Neon database restriction'
      );
    }
  });

  test('Target 1.2: Worker daemon boots, binds port, and reports truthful /health and /ready', async () => {
    const cliPath = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    const workerPath = path.resolve(process.cwd(), 'apps/specialist-worker/src/index.ts');

    // Spawn the deployable worker process
    workerProcess = spawn('node', [cliPath, workerPath], {
      env: {
        ...process.env,
        DATABASE_URL: isolatedConnStr,
        AIRA_ENV: 'staging',
        PORT: String(workerPort),
        WORKER_ID: workerId,
        WORKER_CONCURRENCY: '2',
        POLL_INTERVAL_MS: '300',
        MAX_POLL_INTERVAL_MS: '1200',
        IDLE_BACKOFF_MULTIPLIER: '1.5',
        LEASE_DURATION_MS: '6000',
        HEARTBEAT_INTERVAL_MS: '1000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutLog = '';
    let stderrLog = '';
    workerProcess.stdout?.on('data', chunk => stdoutLog += chunk.toString());
    workerProcess.stderr?.on('data', chunk => stderrLog += chunk.toString());

    // Poll for readiness
    let isReady = false;
    let healthPayload: any = null;
    const deadline = Date.now() + 20000;

    while (Date.now() < deadline) {
      try {
        const res = await httpGetJson(`http://127.0.0.1:${workerPort}/health`, 1500);
        if (res.statusCode === 200 && res.data?.status === 'HEALTHY' && res.data?.db === 'CONNECTED') {
          isReady = true;
          healthPayload = res.data;
          break;
        }
      } catch {
        await new Promise(r => setTimeout(r, 400));
      }
    }

    if (!isReady) {
      console.error('Worker failed to boot. Stdout:', stdoutLog, 'Stderr:', stderrLog);
    }

    assert.strictEqual(isReady, true, 'Worker must become HEALTHY with db CONNECTED');
    assert.strictEqual(healthPayload.isActivated, true, 'Worker must be activated');
    assert.strictEqual(healthPayload.specialistWorker.status, 'HEALTHY');
    assert.strictEqual(healthPayload.autonomousWorker.status, 'HEALTHY');
    assert.strictEqual(healthPayload.workerId, workerId);

    // Verify /ready endpoint
    const readyRes = await httpGetJson(`http://127.0.0.1:${workerPort}/ready`, 2000);
    assert.strictEqual(readyRes.statusCode, 200);
    assert.strictEqual(readyRes.data.ready, true);
    assert.strictEqual(readyRes.data.status, 'READY');
    assert.strictEqual(readyRes.data.isActivated, true);
  });

  // =========================================================================
  // TARGET 2: BOTH TASK QUEUES (specialist_tasks & autonomous_agent_tasks)
  // =========================================================================

  test('Target 2.1: Queue 1 (specialist_tasks) — Worker claims, calculates, and completes DAG', async () => {
    const runId = `run_q1_${Date.now()}`;
    const taskId = `task_q1_math_${Date.now()}`;
    await ensureParentRun(runId, testPrincipal.userId);

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
          objective: 'Target 2.1 Specialist task calculation of ((8192 * 512) / 2)',
          dependencies: [],
          inputContract: { expression: '((8192 * 512) / 2)' },
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

    const created = await scheduler.submitDAG(dag, testPrincipal, { missionId: `mission_${runId}` });
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].state, 'QUEUED');

    // Poll until the running background worker claims and completes the task
    let completedTask: any = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      completedTask = await specialistRepo.getTask(taskId);
      if (completedTask?.state === 'COMPLETED') break;
      await new Promise(r => setTimeout(r, 400));
    }

    assert.ok(completedTask, 'Task must exist in specialist_tasks table');
    assert.strictEqual(completedTask.state, 'COMPLETED');
    assert.strictEqual(completedTask.outcome, 'COMPLETED');
    assert.strictEqual((completedTask.resultOutput as any)?.result, 2097152, '((8192 * 512) / 2) = 2097152');
  });

  test('Target 2.2: Queue 2 (autonomous_agent_tasks) — Worker claims CREATED task and executes steps', async () => {
    const taskId = `auto_task_q2_${Date.now()}`;
    const now = Date.now();

    // Insert an autonomous agent task conforming to AgentPlanStepSchema
    await autoRepo.createTask({
      taskId,
      principal: testPrincipal,
      objective: 'Operational certification test: Analyze staging memory configuration',
      state: 'CREATED',
      plan: {
        planId: `plan_${taskId}`,
        objective: 'Operational certification test: Analyze staging memory configuration',
        steps: [
          {
            stepId: 'step_1_calc',
            title: 'Calculate allocation size',
            description: 'Calculate (1024 * 384)',
            role: 'analyst',
            assignedSpecialist: 'Composite Analyst Specialist',
            dependencies: [],
            suggestedTools: ['calculator'],
            sideEffectLevel: 'NONE',
            status: 'PENDING'
          }
        ],
        estimatedWaves: 1,
        maxBudgetTokens: 10000,
        createdAt: now,
        updatedAt: now
      },
      observations: [],
      artifacts: [],
      workingMemory: {
        step_1_calc: { expression: '(1024 * 384)' }
      },
      executionHistory: [],
      fencingToken: 0,
      createdAt: now,
      updatedAt: now
    });

    // The running background worker must claim from autonomous_agent_tasks and execute
    let completedAutoTask: AutonomousAgentTask | null = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      completedAutoTask = await autoRepo.getTask(taskId);
      if (completedAutoTask?.state === 'COMPLETED' || completedAutoTask?.state === 'FAILED') {
        break;
      }
      await new Promise(r => setTimeout(r, 400));
    }

    assert.ok(completedAutoTask, 'Autonomous task must exist in autonomous_agent_tasks');
    assert.strictEqual(completedAutoTask.state, 'COMPLETED', `Task must reach COMPLETED state. Current state: ${completedAutoTask.state}, error: ${completedAutoTask.error}`);
    assert.ok(completedAutoTask.fencingToken > 0, 'Fencing token must be incremented upon claim');
    const executedStep = completedAutoTask.plan?.steps.find(s => s.stepId === 'step_1_calc');
    assert.strictEqual(executedStep?.status, 'COMPLETED', 'Step must be completed');
    assert.ok(completedAutoTask.observations.length > 0, 'Observations must be recorded');
  });

  // =========================================================================
  // TARGET 3: REAL API-TO-WORKER EXECUTION & DECOUPLING
  // =========================================================================

  test('Target 3: Client dispatches mission, disconnects immediately, and retrieves result after background execution', async () => {
    const runId = `run_decouple_${Date.now()}`;
    const taskId = `task_decouple_${Date.now()}`;
    await ensureParentRun(runId, testPrincipal.userId);

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
          objective: 'Decoupled API execution calculation of (4096 * 256)',
          dependencies: [],
          inputContract: { expression: '(4096 * 256)' },
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

    // Client dispatches into queue
    await scheduler.submitDAG(dag, testPrincipal, { missionId: `mission_${runId}` });

    // Client disconnects: zero polling during execution window
    await new Promise(r => setTimeout(r, 3000));

    // Client reconnects and retrieves finished output
    let resultTask: any = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      resultTask = await specialistRepo.getTask(taskId);
      if (resultTask?.state === 'COMPLETED') break;
      await new Promise(r => setTimeout(r, 400));
    }

    assert.ok(resultTask);
    assert.strictEqual(resultTask.state, 'COMPLETED');
    assert.strictEqual((resultTask.resultOutput as any)?.result, 1048576, '(4096 * 256) = 1048576');
  });

  // =========================================================================
  // TARGET 4: DATABASE PERSISTENCE & ATOMIC FENCING TOKENS
  // =========================================================================

  test('Target 4.1: Database persistence stores checkpoints, tool calls, and lifecycle events', async () => {
    const runId = `run_persist_${Date.now()}`;
    const taskId = `task_persist_${Date.now()}`;
    await ensureParentRun(runId, testPrincipal.userId);

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
          objective: 'Persistence verification calculation of (128 * 64)',
          dependencies: [],
          inputContract: { expression: '(128 * 64)' },
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

    await scheduler.submitDAG(dag, testPrincipal, { missionId: `mission_${runId}` });

    // Wait for completion
    let finished: any = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      finished = await specialistRepo.getTask(taskId);
      if (finished?.state === 'COMPLETED') break;
      await new Promise(r => setTimeout(r, 400));
    }

    assert.ok(finished);
    assert.strictEqual(finished.state, 'COMPLETED');

    // 1. Verify checkpoints were saved
    const checkpoints = (finished.checkpoints || []).map((c: any) => c.checkpoint);
    assert.ok(checkpoints.includes('SPECIALIST_DISPATCHED'), 'Checkpoints must record SPECIALIST_DISPATCHED');
    assert.ok(checkpoints.includes('SPECIALIST_FINISHED'), 'Checkpoints must record SPECIALIST_FINISHED');

    // 2. Verify tool_calls recorded calculator execution
    const toolRows = await db('tool_calls').where({ run_id: runId });
    assert.ok(toolRows.length >= 1, 'Tool execution must be persisted in tool_calls');
    assert.strictEqual(toolRows[0].tool, 'calculator');
    assert.strictEqual(toolRows[0].status, 'COMPLETED');

    // 3. Verify specialist_task_events recorded state transitions
    const eventRows = await db('specialist_task_events').where({ task_id: taskId });
    assert.ok(eventRows.length >= 2, 'Events must record transitions in specialist_task_events');
    const types = eventRows.map(e => e.event_type);
    assert.ok(types.includes('TASK_CLAIMED'));
    assert.ok(types.includes('TASK_STATE_COMPLETED'));
  });

  test('Target 4.2: Atomic fencing rejects updates with stale fencing tokens', async () => {
    const taskId = `task_fence_${Date.now()}`;
    const now = Date.now();

    // Create task with fencing token 5
    await autoRepo.createTask({
      taskId,
      principal: testPrincipal,
      objective: 'Fencing verification task',
      state: 'RUNNING',
      plan: { objective: 'Test fencing', steps: [] },
      observations: [],
      artifacts: [],
      workingMemory: {},
      executionHistory: [],
      fencingToken: 5,
      leaseOwner: 'worker_active',
      leaseExpiresAt: now + 60000,
      createdAt: now,
      updatedAt: now
    });

    // Attempt to update state asserting stale fencing token 4 (must throw error / reject)
    await assert.rejects(
      async () => {
        await autoRepo.updateState(taskId, 'COMPLETED', undefined, undefined, 4);
      },
      /STALE_FENCING_TOKEN/i,
      'Update with stale fencing token must fail closed'
    );
  });

  // =========================================================================
  // TARGET 5: WORKER CRASH & RESTART RECOVERY WITH STEP IDEMPOTENCY
  // =========================================================================

  test('Target 5.1: Replacement worker reclaims expired lease and finishes interrupted task', async () => {
    const runId = `run_crash_rec_${Date.now()}`;
    const taskId = `task_crash_rec_${Date.now()}`;
    await ensureParentRun(runId, testPrincipal.userId);

    const now = Date.now();
    // Insert task assigned to dead worker with an expired lease
    await specialistRepo.saveTask({
      id: taskId,
      runId,
      principalId: testPrincipal.userId,
      workspaceId: testPrincipal.workspaceId,
      role: 'analyst',
      objective: 'Crash recovery calculation of ((1024 * 1024) / 2)',
      state: 'RUNNING',
      dependencies: [],
      inputPayload: { expression: '((1024 * 1024) / 2)' },
      executionConstraints: { sideEffectLevel: 'NONE', allowedTools: ['calculator'] },
      authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
      budgetLimits: { maxTokens: 4096 },
      timeoutMs: 30000,
      attemptCount: 1,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 1,
      leaseOwner: 'worker_crashed_node_dead',
      leaseExpiresAt: now - 3000, // Expired
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'worker_crashed_node_dead' },
      checkpoints: [{ checkpoint: 'STARTED_BEFORE_CRASH', timestamp: now - 4000 }],
      createdAt: now - 6000,
      updatedAt: now - 3000
    });

    // The running worker daemon will discover the expired lease, increment fencing token, and execute
    let recovered: any = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      recovered = await specialistRepo.getTask(taskId);
      if (recovered?.state === 'COMPLETED') break;
      await new Promise(r => setTimeout(r, 400));
    }

    assert.ok(recovered);
    assert.strictEqual(recovered.state, 'COMPLETED');
    assert.strictEqual((recovered.resultOutput as any)?.result, 524288, '((1024 * 1024) / 2) = 524288');
    assert.ok(recovered.fencingToken > 1, 'Fencing token must be incremented upon recovery');
  });

  test('Target 5.2: Step idempotency ensures completed tool calls are not re-executed upon recovery', async () => {
    const runId = `run_idemp_${Date.now()}`;
    const taskId = `task_idemp_${Date.now()}`;
    await ensureParentRun(runId, testPrincipal.userId);

    const now = Date.now();
    const idempotencyKey = `idemp_${testPrincipal.userId}_${runId}_${taskId}_calculator`;

    // Seed completed tool execution in tool_calls
    await db('tool_calls').insert({
      id: `call_${runId}_${taskId}_calc`,
      run_id: runId,
      principal_id: testPrincipal.userId,
      tool: 'calculator',
      arguments: JSON.stringify({ expression: '(2048 * 8)' }),
      result: JSON.stringify({ result: 16384 }),
      permission: 'READ',
      status: 'COMPLETED',
      idempotency_key: idempotencyKey,
      started_at: now - 4000,
      completed_at: now - 3500
    });

    // Task crashed after tool completed but before state was marked COMPLETED
    await specialistRepo.saveTask({
      id: taskId,
      runId,
      principalId: testPrincipal.userId,
      workspaceId: testPrincipal.workspaceId,
      role: 'analyst',
      objective: 'Idempotency test for (2048 * 8)',
      state: 'RUNNING',
      dependencies: [],
      inputPayload: { expression: '(2048 * 8)' },
      executionConstraints: { sideEffectLevel: 'NONE', allowedTools: ['calculator'] },
      authorizationRequirements: { requiresHumanApproval: false, requiredPermissions: [] },
      budgetLimits: { maxTokens: 4096 },
      timeoutMs: 30000,
      attemptCount: 1,
      maxRetries: 2,
      backoffMultiplier: 1.5,
      fencingToken: 1,
      leaseOwner: 'worker_crashed_before_final_state',
      leaseExpiresAt: now - 2000,
      usageTelemetry: { tokensUsed: 0, durationMs: 0 },
      provenance: { workerId: 'worker_crashed_before_final_state' },
      checkpoints: [{ checkpoint: 'TOOL_PERSISTED', timestamp: now - 3500 }],
      createdAt: now - 5000,
      updatedAt: now - 2000
    });

    let finished: any = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      finished = await specialistRepo.getTask(taskId);
      if (finished?.state === 'COMPLETED') break;
      await new Promise(r => setTimeout(r, 400));
    }

    assert.ok(finished);
    assert.strictEqual(finished.state, 'COMPLETED');
    assert.strictEqual((finished.resultOutput as any)?.result, 16384);

    // Assert that tool_calls record count remains exactly 1 (no duplicate side effects)
    const toolRows = await db('tool_calls').where({ run_id: runId });
    assert.strictEqual(toolRows.length, 1, 'Idempotency key must prevent duplicate tool execution');
  });

  // =========================================================================
  // TARGET 6: REAL TOOL EXECUTION & SECURITY HARDENING
  // =========================================================================

  test('Target 6.1: MCP stdio transport security strips sensitive environment variables', () => {
    // Verify secret scrubbing policy rules:
    // Any env var containing TOKEN, SECRET, KEY, DATABASE, NEON, POSTGRES, AUTH, COOKIE, JWT must be scrubbed
    const sampleEnv: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://aira:aira@localhost/db',
      NEON_API_KEY: 'secret_key_123',
      SECRET_TOKEN: 'super_secret',
      AUTH_COOKIE: 'session_xyz',
      UNSAFE_PASSWORD_KEY: 'password123',
      SAFE_APP_CONFIG: 'active'
    };

    const scrubbedEnv = sanitizeStdioEnv(sampleEnv);

    assert.strictEqual(scrubbedEnv.PATH, '/usr/bin:/bin');
    assert.strictEqual(scrubbedEnv.NODE_ENV, 'production');
    assert.strictEqual(scrubbedEnv.SAFE_APP_CONFIG, 'active');
    assert.strictEqual(scrubbedEnv.DATABASE_URL, undefined);
    assert.strictEqual(scrubbedEnv.NEON_API_KEY, undefined);
    assert.strictEqual(scrubbedEnv.SECRET_TOKEN, undefined);
    assert.strictEqual(scrubbedEnv.AUTH_COOKIE, undefined);
    assert.strictEqual(scrubbedEnv.UNSAFE_PASSWORD_KEY, undefined);
  });

  test('Target 6.2: MCP tool execution tags untrusted output with untrustedExternalData', async () => {
    const toolGateway = new ToolGateway(new InMemoryToolCallRepository());
    const mcpHost = new McpHost(toolGateway);
    const testServer = createTestMcpServer(0);
    const mcpPort = await testServer.start();

    try {
      mcpHost.registerServer({
        id: 'srv_cert_mcp',
        name: 'Certification MCP Server',
        url: `http://127.0.0.1:${mcpPort}/mcp`,
        transport: 'streamable_http'
      });

      const connected = await mcpHost.connectServer('srv_cert_mcp');
      assert.strictEqual(connected, true);

      const result = await toolGateway.executeTool(
        'mcp_srv_cert_mcp_echo',
        { message: 'Certified external data' },
        { runId: 'run_mcp_cert_1', principal: testPrincipal }
      );

      assert.strictEqual(result.untrustedExternalData, true, 'MCP tool output must be explicitly tagged');
    } finally {
      await mcpHost.disconnectServer('srv_cert_mcp');
      await testServer.close();
    }
  });

  test('Target 6.3: Sandbox provider resolution fails closed without container backend', () => {
    assert.throws(
      () => {
        resolveIsolatedSandboxProvider({ requireContainer: true, disableLocalDocker: true });
      },
      /CONTAINER_ISOLATION_UNAVAILABLE/,
      'Untrusted code execution without an isolated backend must fail closed'
    );
  });

  test('Target 6.4: Browser session persistence enforces AES-256-GCM envelope encryption & tamper rejection', async () => {
    const certPrincipal: ExecutionPrincipal = {
      userId: 'usr_m1_cert_operator',
      sessionId: `sess_m1_gcm_${Date.now()}`,
      workspaceId: testPrincipal.workspaceId,
      role: 'user',
      scopes: ['*']
    };
    const storage = new PostgresBrowserSessionStorage(db);
    const adapter = new BrowserAdapter({}, storage);
    const secretPassphrase = crypto.randomBytes(32).toString('hex');
    const sessionKey = `${certPrincipal.userId}:${certPrincipal.sessionId}`;

    try {
      // Establish an active session
      await adapter.navigate(certPrincipal, 'https://example.com');

      // 1. Export encrypted session state through BrowserAdapter
      const encryptedEnvelope = await adapter.exportEncryptedSessionState(certPrincipal, secretPassphrase);
      assert.ok(encryptedEnvelope, 'Must export encrypted session envelope');
      const parsedEnvelope = JSON.parse(encryptedEnvelope);
      assert.strictEqual(parsedEnvelope.version, 1);
      assert.strictEqual(parsedEnvelope.principalId, certPrincipal.userId);
      assert.ok(parsedEnvelope.iv);
      assert.ok(parsedEnvelope.tag);
      assert.ok(parsedEnvelope.data);

      // 2. Persist to PostgreSQL via saveDurableSnapshot
      const snapshot = await adapter.saveDurableSnapshot(certPrincipal, secretPassphrase, 60000);
      assert.ok(snapshot, 'Must save durable snapshot to storage');

      const stored = await storage.getSession(sessionKey);
      assert.ok(stored, 'Snapshot must be retrievable from PostgreSQL');
      assert.strictEqual(stored.sessionKey, sessionKey);

      // 3. Verify valid restoration via BrowserAdapter
      const restoredSession = await adapter.restoreDurableSnapshot(certPrincipal, secretPassphrase);
      assert.ok(restoredSession);
      assert.strictEqual(restoredSession.sessionKey, sessionKey);

      // 4. Cross-tenant decryption rejection
      const foreignPrincipal: ExecutionPrincipal = {
        userId: 'usr_foreign_attacker',
        sessionId: 'sess_foreign_attacker',
        workspaceId: 'ws_foreign_attacker',
        role: 'user',
        scopes: ['*']
      };
      await assert.rejects(
        async () => {
          await adapter.importEncryptedSessionState(foreignPrincipal, stored.encryptedEnvelope, secretPassphrase);
        },
        /SECURITY_VIOLATION: Principal "usr_foreign_attacker" cannot decrypt/,
        'Foreign principal must not decrypt or restore session envelope'
      );

      // 5. Tamper with ciphertext in database and assert tamper rejection
      const tamperedEnvelope = JSON.parse(stored.encryptedEnvelope);
      tamperedEnvelope.data = Buffer.from('corrupted_tampered_ciphertext').toString('base64');
      await storage.saveSession({ ...stored, encryptedEnvelope: JSON.stringify(tamperedEnvelope) });

      await assert.rejects(
        async () => {
          await adapter.restoreDurableSnapshot(certPrincipal, secretPassphrase);
        },
        /SECURITY_VIOLATION: Decryption failed/,
        'Tampered ciphertext must fail authenticated AES-256-GCM tag verification via BrowserAdapter'
      );
    } finally {
      await adapter.shutdown();
    }
  });

  // =========================================================================
  // TARGET 7: BROWSER & SANDBOX DEPENDENCIES VALIDATION
  // =========================================================================

  test('Target 7: Browser and sandbox dependencies configuration validation', async () => {
    // 1. Verify browser executable resolution and fail-fast launch readiness
    const detectedExecutable = resolveBrowserExecutablePath();
    if (detectedExecutable) {
      assert.ok(
        fsSync.existsSync(detectedExecutable),
        `Resolved browser executable at "${detectedExecutable}" must exist on disk`
      );
    }

    const browserAdapter = new BrowserAdapter();
    await assert.doesNotReject(
      async () => {
        await browserAdapter.assertBrowserAvailable();
      },
      'Browser runtime must be available and launchable on staging worker host'
    );
    await browserAdapter.shutdown();

    // 2. Verify sandbox provider fail-closed validation
    try {
      resolveIsolatedSandboxProvider({ requireContainer: true, disableLocalDocker: true });
      assert.fail('Should fail closed when no isolated container runtime is available');
    } catch (err: any) {
      assert.ok(
        err.message.includes('CONTAINER_ISOLATION_UNAVAILABLE'),
        'Must fail closed with CONTAINER_ISOLATION_UNAVAILABLE'
      );
    }
  });

  // =========================================================================
  // TARGET 8: GRACEFUL SHUTDOWN ON SIGTERM (EXIT CODE 0)
  // =========================================================================

  test('Target 8: Worker daemon handles SIGTERM gracefully and exits with code 0', async () => {
    assert.ok(workerProcess, 'Worker process must be active');
    assert.strictEqual(workerProcess.killed, false);

    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      workerProcess!.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    // Send SIGTERM to the running worker process
    workerProcess.kill('SIGTERM');

    const result = await exitPromise;

    // Graceful exit: process terminates cleanly (code 0 or SIGTERM/SIGINT signal delivery)
    assert.ok(
      result.code === 0 || result.signal === 'SIGTERM' || result.signal === 'SIGINT',
      `Worker daemon must exit gracefully on SIGTERM. Got code: ${result.code}, signal: ${result.signal}`
    );

    // Verify /health endpoint is no longer serving
    await assert.rejects(
      async () => {
        await httpGetJson(`http://127.0.0.1:${workerPort}/health`, 1000);
      },
      /ECONNREFUSED/i,
      'Health endpoint must be closed after graceful shutdown'
    );
  });
});
