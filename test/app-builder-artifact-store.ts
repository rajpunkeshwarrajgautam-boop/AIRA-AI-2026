import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { db } from '../packages/db/src/index.js';
import { PostgresBuildArchiveStore } from '../packages/app-builder/src/artifact-store.js';
import { PostgresApplicationBuildQueue } from '../packages/app-builder/src/queue.js';

const store = new PostgresBuildArchiveStore();
const ownerId = 'archive_' + randomUUID().replaceAll('-', '');
let queueJobId = '';
const workerJobId = randomUUID();
const runId = 'run_' + randomUUID().replaceAll('-', '').slice(0, 12);
const archive = gzipSync(Buffer.from('fake tar bytes for storage integrity test', 'utf8'));
try {
  const queued = await new PostgresApplicationBuildQueue().enqueue(
    ownerId, 'Build immutable archived project', 'archive-test-' + randomUUID(), runId
  );
  queueJobId = queued.id;
  const data = { ownerId, queueJobId, workerJobId, runId, archive };
  await assert.rejects(store.save({ ...data, ownerId: 'different_owner' }),
    /BUILD_ARCHIVE_QUEUE_OWNER_MISMATCH/);
  const first = await store.save(data);
  assert.equal(first.sha256.length, 64);
  const duplicate = await store.save(data);
  assert.equal(duplicate.sha256, first.sha256);
  const recovered = await store.get(queueJobId, ownerId);
  assert.ok(recovered);
  assert.deepEqual(recovered.archive, archive);
  assert.equal(recovered.workerJobId, workerJobId);
  assert.equal(await store.get(queueJobId, 'different_owner'), undefined);
  assert.equal(await store.get('not-a-uuid', ownerId), undefined);

  await assert.rejects(store.save({ ...data, archive: gzipSync(Buffer.from('changed content')) }),
    /BUILD_ARCHIVE_IMMUTABILITY_CONFLICT/);
  await assert.rejects(store.save({ ...data, workerJobId: randomUUID() }),
    /BUILD_ARCHIVE_IMMUTABILITY_CONFLICT/);
  await assert.rejects(store.save({ ...data, archive: Buffer.alloc(1_500_001) }),
    /INVALID_BUILD_ARCHIVE_INPUT/);
  await db('aira_app_build_archives').where({ queue_job_id: queueJobId })
    .update({ archive: Buffer.from('tampered data') });
  await assert.rejects(store.get(queueJobId, ownerId), /BUILD_ARCHIVE_INTEGRITY_FAILED/);

  console.log('PASS: immutable PostgreSQL source archives, owner isolation, key conflict, size bound and checksum tampering denial.');
} finally {
  if (queueJobId) {
    await db('aira_app_build_archives').where({ queue_job_id: queueJobId }).delete();
    await db('aira_app_build_jobs').where({ id: queueJobId }).delete();
  }
  await db.destroy();
}
