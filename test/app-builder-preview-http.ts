import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { db } from '../packages/db/src/index.js';
import { S3ImmutableObjectStore } from '../packages/app-builder/src/object-store.js';
import { PostgresObjectRefStore } from '../packages/app-builder/src/object-ref-store.js';
import { PostgresApplicationBuildQueue } from '../packages/app-builder/src/queue.js';
import { PreviewGrantStore } from '../packages/app-builder/src/preview-grants.js';
import { createPreviewGateway } from '../packages/app-builder/src/preview-gateway.js';
import { createSourceArchive } from '../packages/app-builder/src/archive.js';

const objects = new Map<string, Buffer>();
const bucket = 'aira-preview-test-bucket';
const mock = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) {
    res.writeHead(403); res.end(); return;
  }
  if (req.method === 'PUT') {
    objects.set(req.url!, Buffer.concat(chunks)); res.writeHead(200); res.end(); return;
  }
  const data = objects.get(req.url!);
  if (!data) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-length': data.length }); res.end(data);
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const port = (mock.address() as {port:number}).port;
const root = await mkdtemp(join(tmpdir(), 'aira-preview-http-'));
const ownerId = 'http_' + randomUUID().replaceAll('-', '');
const runId = 'run_' + randomUUID().replaceAll('-', '');
const config = {
  endpoint: 'http://127.0.0.1:' + port, bucket, region: 'us-east-1',
  accessKeyId: 'testingkey', secretAccessKey: 'development-key-not-for-production'
};
process.env.AIRA_OBJECT_STORE_ENDPOINT = config.endpoint;
process.env.AIRA_OBJECT_STORE_BUCKET = bucket;
process.env.AIRA_OBJECT_STORE_REGION = config.region;
process.env.AIRA_OBJECT_STORE_ACCESS_KEY_ID = config.accessKeyId;
process.env.AIRA_OBJECT_STORE_SECRET_ACCESS_KEY = config.secretAccessKey;
const gatewayConfig = {
  origin: 'https://preview.isolated-aira-test.net',
  appOrigin: 'https://aira-ai.in',
  port: 4402
};
let gateway: ReturnType<typeof createPreviewGateway> | undefined;
let jobId = '';
try {
  const job = await new PostgresApplicationBuildQueue().enqueue(ownerId, 'Build compiled UI',
    'http_' + randomUUID(), runId);
  jobId = job.id;
  const q = new PostgresApplicationBuildQueue();
  const lease = await q.claim('preview_http_test', 60_000);
  assert.equal(lease?.id, jobId);
  assert.equal(await q.start(jobId, 'preview_http_test', lease.generation), true);
  assert.equal(await q.finish(jobId, 'preview_http_test', lease.generation, 'COMPLETED', {}), true);

  const html = '<!doctype html><html><body>COMPILED_PREVIEW_HTTP</body></html>';
  await writeFile(join(root, 'index.html'), html);
  const archive = await createSourceArchive(root, [{
    path: 'index.html', sha256: createHash('sha256').update(html).digest('hex')
  }]);
  const ref = await new S3ImmutableObjectStore(config).put(ownerId, 'compiled', archive);
  await new PostgresObjectRefStore().save(jobId, ownerId, runId, 'compiled', ref);
  const grants = new PreviewGrantStore();
  const ticket = await grants.issue(jobId, ownerId);
  gateway = createPreviewGateway(gatewayConfig);
  await new Promise<void>(resolve => gateway!.listen(0, '127.0.0.1', resolve));
  const gatewayPort = (gateway.address() as {port:number}).port;
  const fetchAsset = (name: string) => new Promise<{status:number;body:string;headers:Record<string,string|string[]|undefined>}>((resolve,reject) => {
    const req = request({
      host:'127.0.0.1', port:gatewayPort, method:'GET', path:name,
      headers:{ Host:new URL(gatewayConfig.origin).host }
    }, res => {
      const chunks:Buffer[]=[];
      res.on('data',chunk=>chunks.push(Buffer.from(chunk)));
      res.on('end',()=>resolve({
        status:res.statusCode||0, body:Buffer.concat(chunks).toString('utf8'),
        headers:res.headers
      }));
    });
    req.on('error',reject); req.end();
  });
  const page = await fetchAsset('/p/' + ticket + '/index.html');
  assert.equal(page.status, 200);
  assert.match(page.body,/COMPILED_PREVIEW_HTTP/);
  assert.match(String(page.headers['content-security-policy']),/connect-src 'none'/);
  assert.equal((await fetchAsset('/p/' + ticket + '/missing.js')).status,404);
  assert.equal((await fetchAsset('/p/' + 'a'.repeat(64) + '/index.html')).status,404);
  assert.equal(await grants.revoke(jobId, ownerId),1);
  assert.equal((await fetchAsset('/p/' + ticket + '/index.html')).status,404);
  console.log('PASS: HTTP preview serves private compiled object and blocks missing/revoked grants');
} finally {
  if (gateway) await new Promise<void>(r=>gateway!.close(()=>r()));
  await new Promise<void>(r=>mock.close(()=>r()));
  if (jobId) {
    await db('aira_app_preview_grants').where({queue_job_id:jobId}).delete();
    await db('aira_app_build_object_refs').where({queue_job_id:jobId}).delete();
    await db('aira_app_build_jobs').where({id:jobId}).delete();
  }
  await db.destroy();
  await rm(root,{recursive:true,force:true});
}
