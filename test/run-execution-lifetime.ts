import assert from 'node:assert/strict';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { closeDb } from '../packages/db/src/index.js';

// Unit regression: hosting tracks execution before the API returns, while the
// response remains asynchronous. This does not certify deployed AI execution.
try {
  let finish!: () => void;
  let starts = 0;
  let tracked: Promise<void> | undefined;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const runtime = {
    createRun: async () => ({ id: 'lifetime-regression', state: 'QUEUED' }),
    startRun: async (id: string) => {
      assert.equal(id, 'lifetime-regression');
      starts++;
      await pending;
    }
  };
  const run = await AgentRuntime.prototype.createAndExecuteRun.call(runtime as any, {} as any, {} as any, (execution) => { tracked = execution; });
  assert.equal(run.id, 'lifetime-regression');
  assert.ok(tracked, 'execution must be registered before response');
  let settled = false;
  tracked.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(settled, false, 'tracker must encompass actual execution');
  finish();
  await tracked;
  assert.equal(settled, true);
  await AgentRuntime.prototype.createAndExecuteRun.call(runtime as any, {} as any, {} as any);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 2, 'local execution remains available without tracker');
  console.log('PASS: request lifecycle tracks deferred execution through completion');
} finally {
  await closeDb();
}
