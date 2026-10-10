import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { db } from '../packages/db/src/index.js';
import { PostgresApplicationBuildQueue } from '../packages/app-builder/src/queue.js';
import { ApplicationBuildDispatcher } from '../packages/app-builder/src/dispatcher.js';

const q = new PostgresApplicationBuildQueue();
const owner = 'dispatch_' + randomUUID().replaceAll('-', '');
const errors: string[] = [];
let terminalCount = 0;
let cancelledCount = 0;
try {
  const first = await q.enqueue(owner, 'Build calculator', 'first');
  const second = await q.enqueue(owner, 'Build website', 'second');
  const [a, b] = await Promise.all([
    new ApplicationBuildDispatcher(q, async (j, signal) => {
      assert.equal(signal.aborted, false);
      await sleep(30);
      return { state: 'COMPLETED', result: { id: j.id, buildStatus: 'BUILD_PASSED', independentAcceptance: false } };
    }, async () => { terminalCount++; }, undefined, { heartbeatMs: 150, leaseMs: 5_000, pollMs: 75, workerId: 'dispatch_a' }).runOnce(),
    new ApplicationBuildDispatcher(q, async (j) => {
      await sleep(30);
      return { state: 'COMPLETED', result: { id: j.id, buildStatus: 'BUILD_PASSED', independentAcceptance: false } };
    }, async () => { terminalCount++; }, undefined, { heartbeatMs: 150, leaseMs: 5_000, pollMs: 75, workerId: 'dispatch_b' }).runOnce()
  ]);
  assert.equal(a, true); assert.equal(b, true);
  assert.equal((await q.get(first.id, owner))?.state, 'COMPLETED');
  assert.equal((await q.get(second.id, owner))?.state, 'COMPLETED');
  assert.equal(terminalCount, 2, 'terminal callback once per fenced job');

  const job = await q.enqueue(owner, 'Cancel a long-running job', 'cancel');
  let began = false;
  const cancelled = new ApplicationBuildDispatcher(q, async (_item, signal) => {
    began = true;
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { state: 'COMPLETED', result: { error: 'must not commit late success' } };
  }, () => { throw new Error('Cancelled job must not receive terminal completion'); },
  () => { cancelledCount++; },
  { heartbeatMs: 120, leaseMs: 5_000, pollMs: 75, workerId: 'dispatch_cancel' });
  const running = cancelled.runOnce();
  for (let i = 0; !began && i < 80; i++) await sleep(15);
  assert.equal(began, true);
  const flag = await q.requestCancellation(job.id, owner);
  assert.equal(flag?.cancelRequested, true);
  await running;
  assert.equal(cancelledCount, 1);
  assert.equal((await q.get(job.id, owner))?.state, 'CANCELLED');

  const stale = await q.enqueue(owner, 'Recover after lost lease', 'stale');
  let entered = false;
  const old = new ApplicationBuildDispatcher(q, async (_item, signal) => {
    entered = true;
    await new Promise<void>(resolve => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { state: 'COMPLETED', result: { unsafe: 'stale completion' } };
  }, () => { throw new Error('Stale completion must not succeed'); }, undefined,
  { heartbeatMs: 130, leaseMs: 5_000, pollMs: 75, workerId: 'dispatch_stale' });
  const oldJob = old.runOnce();
  for (let i = 0; !entered && i < 80; i++) await sleep(15);
  assert.ok(entered);
  await db('aira_app_build_jobs').where({ id: stale.id })
    .update({ lease_expires_at: db.raw("NOW() - INTERVAL '1 second'") });
  // Old worker heartbeat must fail and abort; no late success.
  await oldJob;
  assert.notEqual((await q.get(stale.id, owner))?.state, 'COMPLETED');
  assert.equal(await q.recoverExpired(), 1);
  const reclaimed = await q.claim('dispatch_recovered', 5_000);
  assert.equal(reclaimed?.id, stale.id);
  assert.equal(reclaimed?.generation, 2);
  assert.equal(await q.start(stale.id, 'dispatch_stale', 1), false);
  assert.equal(await q.start(stale.id, 'dispatch_recovered', 2), true);
  assert.equal(await q.finish(stale.id, 'dispatch_recovered', 2, 'COMPLETED', { certified: false }), true);

  const exhausted = await q.enqueue(owner, 'Never retry infinitely', 'retry-limit');
  const expiring = await q.claim('dispatch_exhausted', 5000);
  assert.equal(expiring?.id, exhausted.id);
  await db('aira_app_build_jobs').where({ id: exhausted.id }).update({
    attempts: 3,
    lease_expires_at: db.raw("NOW() - INTERVAL '2 seconds'")
  });
  assert.equal(await q.recoverExpired(), 1);
  const bounded = await q.get(exhausted.id, owner);
  assert.equal(bounded?.state, 'FAILED');
  assert.equal(bounded?.result?.error, 'BUILD_LEASE_RETRY_LIMIT_EXCEEDED');

  const stopJob = await q.enqueue(owner, 'Abort on dispatcher shutdown', 'stopping');
  let stopStarted = false;
  const stopping = new ApplicationBuildDispatcher(q, async (_item, signal) => {
    stopStarted = true;
    await new Promise<void>(resolve => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { state: 'COMPLETED', result: { shouldNotCommit: true } };
  }, undefined, undefined,
  { heartbeatMs: 130, leaseMs: 5_000, pollMs: 75, workerId: 'dispatch_stopping' });
  const shutdownTask = stopping.runOnce();
  for (let i = 0; !stopStarted && i < 80; i++) await sleep(15);
  assert.ok(stopStarted);
  stopping.stop();
  await shutdownTask;
  assert.notEqual((await q.get(stopJob.id, owner))?.state, 'COMPLETED',
    'Shutdown must not commit a late result');

  assert.deepEqual(errors, []);
  console.log('PASS: dispatched real PostgreSQL jobs with competing workers, fenced terminal result, cancellation, abort and lost-lease recovery');
} finally {
  await db('aira_app_build_jobs').where({ owner_id: owner }).delete();
  await db.destroy();
}
