import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousWorkerHost } from '../packages/agent-runtime/src/autonomous/autonomous-worker-host.js';
import type { AutonomousAgentEngine } from '../packages/agent-runtime/src/autonomous/autonomous-engine.js';
import type { IAutonomousTaskRepository } from '../packages/agent-runtime/src/autonomous/repository.js';
import type { AutonomousAgentTask } from '../packages/contracts/src/index.js';

test('autonomous worker aborts execution when lease heartbeat persistence throws', async () => {
  const taskId = 'lease-failure-task';
  let executionAborted = false;
  const repository = {
    getTask: async () => { throw new Error('database connection lost'); }
  } as unknown as IAutonomousTaskRepository;
  const engine = {
    executeAutonomousTask: async (_id: string, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          executionAborted = true;
          resolve();
        } else {
          signal?.addEventListener('abort', () => {
            executionAborted = true;
            resolve();
          }, { once: true });
        }
      });
      return { taskId, state: 'CANCELLED' } as AutonomousAgentTask;
    }
  } as unknown as AutonomousAgentEngine;

  const host = new AutonomousWorkerHost(repository, engine, { heartbeatIntervalMs: 10 });
  const errors: string[] = [];
  host.on('worker.error', (event: { error: string }) => errors.push(event.error));

  await Promise.race([
    (host as unknown as { processTask(task: AutonomousAgentTask): Promise<void> })
      .processTask({ taskId, fencingToken: 1 } as AutonomousAgentTask),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Heartbeat did not abort execution')), 1000))
  ]);

  assert.equal(executionAborted, true);
  assert.deepEqual(errors, ['database connection lost']);
});
