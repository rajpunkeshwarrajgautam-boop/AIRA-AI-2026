import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../packages/db/src/index.js';
import { PostgresApplicationBuildQueue } from '../packages/app-builder/src/queue.js';
import { PostgresObjectRefStore } from '../packages/app-builder/src/object-ref-store.js';
import { PreviewGrantStore } from '../packages/app-builder/src/preview-grants.js';
import { createSourceArchive } from '../packages/app-builder/src/archive.js';
import { parseCompiledArchive } from '../packages/app-builder/src/compiled-archive.js';
import { validatePreviewGatewayConfig } from '../packages/app-builder/src/preview-gateway.js';

const owner = 'preview_' + randomUUID().replaceAll('-', '');
const runId = 'run_' + randomUUID().replaceAll('-', '');
const dir = await mkdtemp(join(tmpdir(), 'aira-preview-'));
let jobId = '';
try {
  assert.throws(() => validatePreviewGatewayConfig({
    origin: 'https://preview.aira-ai.in',
    appOrigin: 'https://aira-ai.in', port: 4402
  }), /UNSAFE_PREVIEW_ORIGIN_CONFIGURATION/);
  validatePreviewGatewayConfig({
    origin: 'https://preview.aira-sandbox.net',
    appOrigin: 'https://aira-ai.in', port: 4402
  });

  const files = { 'index.html': '<h1>Compiled App</h1>', 'app.js': 'console.log("compiled");' };
  for (const [file, bytes] of Object.entries(files)) await writeFile(join(dir, file), bytes);
  const manifest = Object.entries(files).map(([path, bytes]) => ({
    path, sha256: createHash('sha256').update(bytes).digest('hex')
  }));
  const packed = await createSourceArchive(dir, manifest);
  const extracted = parseCompiledArchive(packed);
  assert.equal(extracted.get('index.html')?.toString(), files['index.html']);
  assert.equal(extracted.get('app.js')?.toString(), files['app.js']);
  await assert.rejects(async () => parseCompiledArchive(Buffer.from('corrupted')),
    /incorrect|invalid|header|archive|compression|gzip/i);

  const queue = new PostgresApplicationBuildQueue();
  const job = await queue.enqueue(owner, 'Build preview app', 'preview-' + randomUUID(), runId);
  jobId = job.id;
  const claimed = await queue.claim('preview_test_worker', 60_000);
  assert.equal(claimed?.id, job.id);
  assert.equal(await queue.start(job.id, 'preview_test_worker', claimed.generation), true);
  assert.equal(await queue.finish(job.id, 'preview_test_worker', claimed.generation, 'COMPLETED', {}), true);
  const ref = {
    key: 'aira-build/v1/' + createHash('sha256').update(owner).digest('hex').slice(0, 32) +
      '/compiled/' + createHash('sha256').update(packed).digest('hex'),
    sha256: createHash('sha256').update(packed).digest('hex'),
    size: packed.length, contentType: 'application/gzip'
  };
  await new PostgresObjectRefStore().save(job.id, owner, runId, 'compiled', ref);
  const grants = new PreviewGrantStore();
  await assert.rejects(grants.issue(job.id, 'different_owner'), /PREVIEW_BUILD_NOT_COMPLETE/);
  const ticket = await grants.issue(job.id, owner);
  assert.equal(ticket.length, 64);
  assert.equal((await grants.resolve(ticket))?.compiledSha256, ref.sha256);
  assert.equal(await grants.resolve('f'.repeat(64)), undefined);
  assert.equal(await grants.revoke(job.id, 'different_owner'), 0);
  assert.equal((await grants.resolve(ticket))?.ownerId, owner);
  assert.equal(await grants.revoke(job.id, owner), 1);
  assert.equal(await grants.resolve(ticket), undefined);
  const expired = await grants.issue(job.id, owner);
  await db('aira_app_preview_grants')
    .where({ ticket_hash: createHash('sha256').update(expired).digest('hex') })
    .update({ expires_at: db.raw("NOW() - INTERVAL '2 seconds'") });
  assert.equal(await grants.resolve(expired), undefined);
  console.log('PASS: compiled archive verification and owner-scoped preview expiry/revocation');
} finally {
  if (jobId) {
    await db('aira_app_preview_grants').where({ queue_job_id: jobId }).delete();
    await db('aira_app_build_object_refs').where({ queue_job_id: jobId }).delete();
    await db('aira_app_build_jobs').where({ id: jobId }).delete();
  }
  await db.destroy();
  await rm(dir, { recursive: true, force: true });
}
