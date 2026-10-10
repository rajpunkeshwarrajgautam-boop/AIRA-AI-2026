import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { db } from '../packages/db/src/index.js';
import { PostgresApplicationBuildQueue } from '../packages/app-builder/src/queue.js';
import { S3ImmutableObjectStore } from '../packages/app-builder/src/object-store.js';
import { PostgresObjectRefStore } from '../packages/app-builder/src/object-ref-store.js';

const objects = new Map<string, Buffer>();
let corrupt = false;
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const pathname = req.url || '';
  if (!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=') ||
      !/^\d{8}T\d{6}Z$/.test(String(req.headers['x-amz-date'])) ||
      req.headers['x-amz-content-sha256'] !== createHash('sha256').update(bytes).digest('hex')) {
    res.writeHead(403); return res.end('UNSIGNED');
  }
  if (req.method === 'PUT') {
    if (objects.has(pathname) && req.headers['if-none-match'] === '*') {
      res.writeHead(412); return res.end();
    }
    if (req.headers['x-amz-meta-sha256'] !== createHash('sha256').update(bytes).digest('hex')) {
      res.writeHead(400); return res.end();
    }
    objects.set(pathname, bytes);
    res.writeHead(200); return res.end();
  }
  if (req.method === 'GET') {
    const value = objects.get(pathname);
    if (!value) { res.writeHead(404); return res.end(); }
    const returned = corrupt ? Buffer.from('TAMPER') : value;
    res.writeHead(200, { 'content-length': String(returned.length) }); return res.end(returned);
  }
  res.writeHead(405); res.end();
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const config = {
  endpoint: 'http://127.0.0.1:' + address.port,
  region: 'us-east-1', bucket: 'aira-test-build-objects',
  accessKeyId: 'test-access-key', secretAccessKey: 'test-only-secret-key-123456789'
};
const objectsClient = new S3ImmutableObjectStore(config);
const refs = new PostgresObjectRefStore();
const owner = 'object_test_' + randomUUID().replaceAll('-', '');
const stranger = 'another_owner_' + randomUUID().replaceAll('-', '');
const run = 'run_' + randomUUID().replaceAll('-', '');
let jobId = '';
try {
  await assert.rejects(async () => new S3ImmutableObjectStore({
    ...config, endpoint: 'http://storage.example.com'
  }), /OBJECT_STORE_HTTPS_REQUIRED/);
  const queue = await new PostgresApplicationBuildQueue().enqueue(owner, 'Create a project',
    'store:' + randomUUID(), run);
  jobId = queue.id;
  const content = Buffer.from('a real versioned project source', 'utf8');
  const source = await objectsClient.put(owner, 'source', content);
  assert.equal(source.size, content.length);
  assert.deepEqual(await objectsClient.get(source), content);
  const duplicate = await objectsClient.put(owner, 'source', content);
  assert.deepEqual(duplicate, source, 'Identical source must reuse immutable object');
  assert.equal(objects.size, 1);
  const other = await objectsClient.put(stranger, 'source', content);
  assert.notEqual(other.key, source.key, 'Different tenants must not share the same key');
  assert.equal(objects.size, 2);

  await assert.rejects(refs.save(jobId, stranger, run, 'source', source), /BUILD_OBJECT_OWNER_MISMATCH/);
  await refs.save(jobId, owner, run, 'source', source);
  const record = await refs.get(jobId, owner, 'source');
  assert.deepEqual(record, source);
  assert.equal(await refs.get(jobId, stranger, 'source'), undefined);
  assert.equal(await refs.get(jobId, owner, 'compiled'), undefined);
  await refs.save(jobId, owner, run, 'source', source);
  await assert.rejects(refs.save(jobId, owner, run, 'source', { ...source, sha256: 'a'.repeat(64) }),
    /BUILD_OBJECT_IMMUTABILITY_CONFLICT/);

  const compiled = await objectsClient.put(owner, 'compiled',
    Buffer.from('prebuilt-dist-bytes', 'utf8'));
  await refs.save(jobId, owner, run, 'compiled', compiled);
  const reopened = new S3ImmutableObjectStore(config);
  assert.deepEqual(await reopened.get((await refs.get(jobId, owner, 'compiled'))!), Buffer.from('prebuilt-dist-bytes'));
  corrupt = true;
  await assert.rejects(reopened.get(source), /OBJECT_STORE_INTEGRITY_FAILED/);
  corrupt = false;
  assert.equal(await refs.get(jobId, stranger, 'compiled'), undefined);

  console.log('PASS: SigV4 uploads, immutable object deduplication, tenant namespace, real PostgreSQL owner binding, compiled artifact retrieval and tamper denial');
} finally {
  if (jobId) {
    await db('aira_app_build_object_refs').where({ queue_job_id: jobId }).delete();
    await db('aira_app_build_jobs').where({ id: jobId }).delete();
  }
  await db.destroy();
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}
