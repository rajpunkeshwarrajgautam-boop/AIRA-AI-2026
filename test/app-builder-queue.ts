import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/src/index.js';
import { PostgresApplicationBuildQueue } from '../packages/app-builder/src/queue.js';

const queue = new PostgresApplicationBuildQueue();
const owner = 'test_owner_' + randomUUID().replaceAll('-', '');
const other = 'test_other_' + randomUUID().replaceAll('-', '');
const key = 'queue_' + randomUUID().replaceAll('-', '');
try {
  const first = await queue.enqueue(owner, 'Generate a calculator', key);
  assert.equal(first.state, 'QUEUED');
  const repeated = await queue.enqueue(owner, 'Generate a calculator', key);
  assert.equal(repeated.id, first.id, 'Idempotent enqueues reuse the same record');
  await assert.rejects(queue.enqueue(owner, 'Different objective', key), /IDEMPOTENCY_KEY_CONFLICT/);
  assert.equal(await queue.get(first.id, other), undefined, 'Other tenant cannot inspect');
  const otherJob = await queue.enqueue(other, 'Build another application', key);
  assert.notEqual(otherJob.id, first.id, 'Idempotency keys are per owner');

  const [claimed, competing] = await Promise.all([
    queue.claim('worker_alpha', 60_000), queue.claim('worker_beta', 60_000)
  ]);
  assert.ok(claimed && competing);
  assert.notEqual(claimed.id, competing.id, 'SKIP LOCKED prevents double claim');
  assert.equal(claimed.generation, 1);
  assert.equal(await queue.start(claimed.id, 'fake_worker', 1), false);
  assert.equal(await queue.start(claimed.id, claimed.leaseOwner!, claimed.generation), true);
  assert.equal(await queue.heartbeat(claimed.id, claimed.leaseOwner!, claimed.generation, 60_000), true);
  assert.equal(await queue.finish(claimed.id, 'wrong_worker', claimed.generation, 'COMPLETED', {}), false);
  assert.equal(await queue.finish(claimed.id, claimed.leaseOwner!, claimed.generation, 'COMPLETED',
    { buildOutputSha: 'test-digest', claimGeneration: claimed.generation }), true);
  assert.equal(await queue.finish(claimed.id, claimed.leaseOwner!, claimed.generation, 'FAILED', {}), false);

  const cancelled = await queue.requestCancellation(competing.id, competing.ownerId);
  assert.equal(cancelled?.cancelRequested, true);
  assert.equal(await queue.finish(competing.id, competing.leaseOwner!, competing.generation, 'COMPLETED', {}),
    false, 'Cancellation blocks a late fraudulent success');
  assert.equal(await queue.acknowledgeCancellation(competing.id, 'not-owner', competing.generation), false);
  assert.equal(await queue.acknowledgeCancellation(competing.id, competing.leaseOwner!, competing.generation), true);
  const terminal = await queue.get(competing.id, competing.ownerId);
  assert.equal(terminal?.state, 'CANCELLED');

  const expired = await queue.enqueue(owner, 'Retry lease expiration', key + '_recover');
  const lease = await queue.claim('worker_old', 1000);
  assert.equal(lease?.id, expired.id);
  await db('aira_app_build_jobs').where({ id: lease!.id })
    .update({ lease_expires_at: db.raw("NOW() - INTERVAL '2 seconds'") });
  assert.equal(await queue.recoverExpired(), 1);
  const recovered = await queue.claim('worker_new', 60_000);
  assert.equal(recovered?.id, lease!.id);
  assert.equal(recovered?.generation, 2, 'Reclaim increments fencing generation');
  assert.equal(await queue.start(recovered!.id, 'worker_old', 1), false, 'Stale worker cannot run');
  assert.equal(await queue.start(recovered!.id, 'worker_new', 2), true);
  assert.equal(await queue.finish(recovered!.id, 'worker_old', 1, 'COMPLETED', {}), false);
  assert.equal(await queue.finish(recovered!.id, 'worker_new', 2, 'COMPLETED', { verified: false }), true);

  const pending = await queue.enqueue(owner, 'Cancel before claim', key + '_pending');
  const canceledPending = await queue.requestCancellation(pending.id, owner);
  assert.equal(canceledPending?.state, 'CANCELLED');
  assert.equal(await queue.get(pending.id, other), undefined);
  assert.equal(await queue.get(pending.id, owner).then(r => r?.state), 'CANCELLED');

  console.log('PASS: PostgreSQL durable build queue idempotency, owner isolation, concurrent SKIP LOCKED claims, cancellation, lease recovery and fencing.');
} finally {
  await db('aira_app_build_jobs').whereIn('owner_id', [owner, other]).delete();
  await db.destroy();
}
