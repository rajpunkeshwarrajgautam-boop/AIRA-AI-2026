import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { once } from 'node:events';
import { DockerProjectWorker, validateProjectPath } from '../packages/app-builder/src/worker.js';

const root = await mkdtemp(join(tmpdir(), 'aira-build-e2e-'));
const config = {
  root, token: 'test-access-control-token-of-at-least-32-chars',
  port: 4101, previewPort: 4102,
  previewOrigin: 'http://127.0.0.1:4102',
  frameOrigin: 'http://127.0.0.1:5173',
  image: 'node:24-alpine'
};
const worker = new DockerProjectWorker(config);
await worker.initialize();
const controller = worker.controlServer();
const preview = worker.previewServer();
controller.listen(4101, '127.0.0.1');
preview.listen(4102, '127.0.0.1');
await Promise.all([once(controller, 'listening'), once(preview, 'listening')]);
const auth = {
  Authorization: 'Bearer ' + config.token,
  'x-aira-owner': 'alice',
  'Content-Type': 'application/json'
};
const waitFor = async (id: string) => {
  for (let i = 0; i < 100; i++) {
    const response = await fetch('http://127.0.0.1:4101/v1/jobs/' + id, { headers: auth });
    assert.equal(response.status, 200);
    const job = await response.json();
    if (job.state === 'BUILD_PASSED' || job.state === 'FAILED' || job.state === 'BLOCKED') return job;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error('WORKER_DID_NOT_TERMINATE');
};
try {
  assert.throws(() => validateProjectPath(root, '../outside.js'), /INVALID_PROJECT_PATH/);
  assert.throws(() => validateProjectPath(root, '/etc/passwd'), /INVALID_PROJECT_PATH/);
  assert.throws(() => validateProjectPath(root, '.env'), /INVALID_PROJECT_PATH/);
  assert.throws(() => validateProjectPath(root, 'src/../../foo'), /INVALID_PROJECT_PATH/);

  const unauthenticated = await fetch('http://127.0.0.1:4101/health');
  assert.equal(unauthenticated.status, 401);

  const health = await fetch('http://127.0.0.1:4101/health', { headers: auth });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).dependencyInstall, false);

  const payload = {
    ownerId: 'alice',
    files: [
      { path: 'index.html', content: '<!doctype html><title>Calculator</title><input id="a"><input id="b"><button id="calculate">=</button><output id="result"></output><script type="module" src="./calc.js"></script>' },
      { path: 'calc.js', content: "export function add(a,b) { return a + b; }\nif (typeof document !== 'undefined') { document.querySelector('#calculate').addEventListener('click', () => {document.querySelector('#result').textContent = String(add(Number(document.querySelector('#a').value), Number(document.querySelector('#b').value)));}); }\n" },
      { path: 'test.js', content: "import assert from 'node:assert'; import { add } from './calc.js'; assert.equal(add(2,3),5); console.log('CALCULATION_OK');\n" },
      { path: 'package.json', content: JSON.stringify({ name: 'aira-test-calc', version: '1.0.0', type: 'module', scripts: {
        build: 'node --check calc.js', test: 'node test.js'
      } }) }
    ],
    steps: ['syntax', 'build', 'test']
  };
  const badInput = await fetch('http://127.0.0.1:4101/v1/jobs', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ ...payload, files: [{ path: '../escape', content: 'bad' }] })
  });
  assert.equal(badInput.status, 400);

  const mismatch = await fetch('http://127.0.0.1:4101/v1/jobs', {
    method: 'POST', headers: auth, body: JSON.stringify({ ...payload, ownerId: 'bob' })
  });
  assert.equal(mismatch.status, 403);

  const submitted = await fetch('http://127.0.0.1:4101/v1/jobs', {
    method: 'POST', headers: auth, body: JSON.stringify(payload)
  });
  assert.equal(submitted.status, 202);
  const { jobId } = await submitted.json();
  const hidden = await fetch('http://127.0.0.1:4101/v1/jobs/' + jobId,
    { headers: { ...auth, 'x-aira-owner': 'bob' } });
  assert.equal(hidden.status, 404);

  const success = await waitFor(jobId);
  assert.equal(success.state, 'BUILD_PASSED', JSON.stringify(success));
  assert.deepEqual(success.steps.map((s: { exitCode: number }) => s.exitCode), [0, 0, 0]);
  assert.ok(success.steps.some((s: { output: string }) => s.output.includes('CALCULATION_OK')));
  assert.equal(success.manifest.length, payload.files.length);
  assert.ok(success.previewUrl);
  const visible = await fetch(success.previewUrl);
  assert.equal(visible.status, 200);
  assert.match(await visible.text(), /Calculator/);
  // This is a real browser interaction against the isolated static preview.
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const browserErrors: string[] = [];
    page.on('pageerror', err => browserErrors.push(err.message));
    await page.goto(success.previewUrl!);
    await page.locator('#a').fill('2');
    await page.locator('#b').fill('3');
    await page.locator('#calculate').click();
    assert.equal(await page.locator('#result').textContent(), '5');
    assert.deepEqual(browserErrors, []);
  } finally {
    await browser.close();
  }
  const archive = await fetch('http://127.0.0.1:4101/v1/jobs/' + jobId + '/source', { headers: auth });
  assert.equal(archive.status, 200);
  assert.equal(archive.headers.get('content-type'), 'application/gzip');
  assert.ok((await archive.arrayBuffer()).byteLength > 500);
  const crossOwnerExport = await fetch('http://127.0.0.1:4101/v1/jobs/' + jobId + '/source',
    { headers: { ...auth, 'x-aira-owner': 'bob' } });
  assert.equal(crossOwnerExport.status, 404);

  const forbidden = await fetch('http://127.0.0.1:4102/p/' + success.previewTicket + '/job-state.json');
  assert.equal(forbidden.status, 404);

  const broken = await fetch('http://127.0.0.1:4101/v1/jobs', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ ownerId: 'alice', files: [
      { path: 'index.html', content: '<html>broken</html>' },
      { path: 'broken.js', content: 'function unfinished( {' }
    ], steps: ['syntax'] })
  });
  assert.equal(broken.status, 202);
  const bad = await waitFor((await broken.json()).jobId);
  assert.equal(bad.state, 'FAILED');
  assert.equal(bad.previewUrl, undefined);
  assert.ok(bad.steps[0].exitCode !== 0);

  const deps = await fetch('http://127.0.0.1:4101/v1/jobs', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ ownerId: 'alice', files: [
      { path: 'index.html', content: '<html>deps</html>' },
      { path: 'app.js', content: 'console.log(1)' },
      { path: 'package.json', content: JSON.stringify({ dependencies: { three: '^0.180.0' } }) }
    ], steps: ['syntax'] })
  });
  assert.equal(deps.status, 202);
  const blocked = await waitFor((await deps.json()).jobId);
  assert.equal(blocked.state, 'FAILED');
  assert.equal(blocked.error, 'DEPENDENCY_INSTALL_NOT_CONFIGURED');
  assert.equal(blocked.previewUrl, undefined);

  console.log('PASS: Docker worker real container executed syntax, npm build, npm tests, owner isolation, preview and negative cases.');
} finally {
  await Promise.all([
    new Promise<void>(r => controller.close(() => r())),
    new Promise<void>(r => preview.close(() => r()))
  ]);
  await rm(root, { recursive: true, force: true });
}
