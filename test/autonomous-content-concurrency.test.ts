import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryAutonomousTaskRepository } from '../packages/agent-runtime/src/autonomous/repository.js';
import type { AutonomousAgentTask } from '../packages/contracts/src/index.js';

test('stale content snapshots cannot overwrite a concurrent autonomous task update', async () => {
  const repository = new InMemoryAutonomousTaskRepository();
  const created = await repository.createTask({
    taskId: 'content-concurrency-test',
    principal: { userId: 'alice', sessionId: 'session', workspaceId: 'workspace' },
    objective: 'Preserve independently committed work',
    state: 'RUNNING',
    observations: [],
    artifacts: [],
    workingMemory: {},
    executionHistory: [],
    fencingToken: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  } as AutonomousAgentTask);

  const claim = await repository.claimTask(created.taskId, 'worker-a', 60000);
  assert.equal(claim.success, true);
  assert.ok(claim.task);
  const first = (await repository.getTask(created.taskId))!;
  const stale = (await repository.getTask(created.taskId))!;
  assert.equal(await repository.renewLease(created.taskId, 'worker-a', 60000, first.fencingToken), true);

  first.workingMemory = { result: 'first-worker-committed' };
  await repository.updateTask(first);
  stale.workingMemory = { result: 'stale-worker-overwrite' };
  await assert.rejects(repository.updateTask(stale), /STALE_TASK_UPDATE/);
  assert.equal((await repository.getTask(created.taskId))!.workingMemory?.result, 'first-worker-committed');
});
