import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpecialistTaskRepository, type DurableSpecialistTask } from '../packages/agent-runtime/src/durable/specialist-task-repository.js';
import { SpecialistWorkerRuntime } from '../packages/agent-runtime/src/durable/specialist-worker-runtime.js';
import { SpecialistRegistry } from '../packages/agent-runtime/src/specialists/specialist-registry.js';
import type { ISpecialistAgent, SpecialistExecutionResult } from '../packages/agent-runtime/src/specialists/specialist-interface.js';
import { validateDurableToolScopes } from '../packages/agent-runtime/src/durable/tool-authorization.js';
import { TaskLeaseManager } from '../packages/agent-runtime/src/durable/task-lease-manager.js';
import { InMemoryToolCallRepository, ToolGateway } from '../packages/tool-runtime/src/index.js';

const principal = { userId: 'worker_owner', sessionId: 'session_owner', workspaceId: 'workspace_owner', role: 'user' as const };

test('durable task repository rejects owner, workspace, or policy changes under an existing task ID', async () => {
  const repository = new InMemorySpecialistTaskRepository();
  const now = Date.now();
  const task: DurableSpecialistTask = {
    id: 'task_identity_locked', runId: 'run_identity_locked', principalId: principal.userId,
    workspaceId: principal.workspaceId, role: 'analyst', objective: 'locked task', state: 'QUEUED',
    dependencies: [], inputPayload: { expression: '1 + 1' },
    executionConstraints: { allowedTools: ['calculator'] } as DurableSpecialistTask['executionConstraints'],
    authorizationRequirements: {}, budgetLimits: { maxTokens: 1000 }, timeoutMs: 5000,
    attemptCount: 0, maxRetries: 0, backoffMultiplier: 1, fencingToken: 0,
    usageTelemetry: { tokensUsed: 0, durationMs: 0 }, provenance: { workerId: 'test' },
    checkpoints: [], createdAt: now, updatedAt: now
  };
  await repository.saveTask(task);
  await assert.rejects(
    () => repository.saveTask({ ...task, principalId: 'attacker' }),
    /identity change rejected/
  );
  await assert.rejects(
    () => repository.saveTask({
      ...task,
      executionConstraints: { allowedTools: ['calculator', 'repo_write'] } as DurableSpecialistTask['executionConstraints']
    }),
    /identity change rejected/
  );
});

test('server durable allowlist rejects tools outside a role policy', () => {
  assert.deepEqual(validateDurableToolScopes('analyst', ['calculator']), {
    valid: true,
    requested: ['calculator']
  });
  assert.equal(validateDurableToolScopes('analyst', ['calculator', 'repo_write']).valid, false);
  assert.equal(validateDurableToolScopes('verifier', ['calculator']).valid, false);
  assert.equal(validateDurableToolScopes('analyst', [' calculator']).valid, false);
});

test('ToolGateway enforces an explicitly empty durable allowlist before adapter execution', async () => {
  const gateway = new ToolGateway(new InMemoryToolCallRepository());
  const result = await gateway.execute({
    toolName: 'calculator',
    arguments: { expression: '2 + 2' },
    context: { runId: 'run_allowlist', principal, effectiveToolScopes: [] }
  });

  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'TOOL_PERMISSION_DENIED');
  assert.match(result.error || '', /effective worker allowlist/);
});

test('worker refuses a task whose persisted owner differs from the parent run owner', async () => {
  class MismatchedIdentityRepository extends InMemorySpecialistTaskRepository {
    override async getAuthoritativeExecutionIdentity(taskId: string) {
      const task = await this.getTask(taskId);
      if (!task) return undefined;
      return {
        taskPrincipalId: task.principalId,
        runPrincipalId: 'foreign_owner',
        taskWorkspaceId: task.workspaceId,
        runWorkspaceId: task.workspaceId
      };
    }
  }

  const repository = new MismatchedIdentityRepository();
  const task: DurableSpecialistTask = {
    id: 'task_owner_mismatch',
    runId: 'run_owner_mismatch',
    principalId: principal.userId,
    workspaceId: principal.workspaceId,
    role: 'analyst',
    objective: 'must not dispatch',
    state: 'QUEUED',
    dependencies: [],
    inputPayload: { expression: '1 + 1' },
    executionConstraints: { allowedTools: ['calculator'] } as DurableSpecialistTask['executionConstraints'],
    authorizationRequirements: {},
    budgetLimits: { maxTokens: 1000 },
    timeoutMs: 5000,
    attemptCount: 0,
    maxRetries: 0,
    backoffMultiplier: 1,
    fencingToken: 0,
    usageTelemetry: { tokensUsed: 0, durationMs: 0 },
    provenance: { workerId: 'test' },
    checkpoints: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  await repository.saveTask(task);
  let dispatched = false;
  const specialist: ISpecialistAgent = {
    role: 'analyst',
    name: 'test analyst',
    description: 'authorization test',
    requiredCapabilities: [],
    canExecute: () => ({ authorized: true }),
    async execute() {
      dispatched = true;
      return {} as SpecialistExecutionResult;
    }
  };
  const registry = new SpecialistRegistry();
  registry.registerSpecialist(specialist, 'IMPLEMENTED_LOCALLY');
  const runtime = new SpecialistWorkerRuntime(repository, new TaskLeaseManager(repository), registry, {
    workerId: 'worker_test',
    leaseDurationMs: 5000,
    heartbeatIntervalMs: 1000
  });

  const result = await runtime.executeTask(task);
  assert.equal(dispatched, false);
  assert.equal(result.error?.code, 'WORKER_AUTHORIZATION_DENIED');
  assert.equal((await repository.getTask(task.id))?.state, 'FAILED');
});
