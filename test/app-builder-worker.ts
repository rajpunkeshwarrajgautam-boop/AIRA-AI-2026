import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateOfflineDependencyLock, approvedLockfileKey } from '../packages/app-builder/src/dependencies.js';
const execFileAsync = promisify(execFile);
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { once } from 'node:events';
import { DockerProjectWorker, validateProjectPath, stableBuildJobId } from '../packages/app-builder/src/worker.js';
import { ApplicationBuildClient } from '../packages/app-builder/src/client.js';

const root = await mkdtemp(join(tmpdir(), 'aira-build-e2e-'));
const config = {
  root, token: 'test-access-control-token-of-at-least-32-chars',
  port: 4101, previewPort: 4102,
  previewOrigin: 'http://127.0.0.1:4102',
  frameOrigin: 'http://127.0.0.1:5173',
  image: 'node:24-alpine',
  npmCache: process.env.AIRA_WORKER_NPM_CACHE || undefined,
  approvedPackages: process.env.AIRA_WORKER_NPM_CACHE ? { three: '0.180.0' } : {}
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
  assert.equal((await health.json()).dependencyInstall, Boolean(config.npmCache));

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

  // Real worker submission idempotency: retries after lost HTTP responses
  // must reuse exactly the same build, even after the worker reloads state.
  const submissionKey = 'queue:24e6b8ab-1473-4e75-aa45-02cbe9607532:attempt:1';
  const keyedPayload = { ...payload, idempotencyKey: submissionKey };
  const keyed = await fetch('http://127.0.0.1:4101/v1/jobs', {
    method: 'POST', headers: auth, body: JSON.stringify(keyedPayload)
  });
  assert.equal(keyed.status, 202);
  const keyedId = (await keyed.json()).jobId as string;
  assert.equal(keyedId, stableBuildJobId('alice', submissionKey));
  const client = new ApplicationBuildClient({ url: 'http://127.0.0.1:4101', token: config.token });
  assert.equal((await client.findByKey(submissionKey, 'alice'))?.id, keyedId);
  assert.equal(await client.findByKey(submissionKey, 'bob'), undefined);
  const keyedCompleted = await waitFor(keyedId);
  assert.equal(keyedCompleted.state, 'BUILD_PASSED');

  const replay = await fetch('http://127.0.0.1:4101/v1/jobs', {
    method: 'POST', headers: auth, body: JSON.stringify(keyedPayload)
  });
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).jobId, keyedId, 'Same key and bytes reuse completed job');

  const conflict = await fetch('http://127.0.0.1:4101/v1/jobs', {
    method: 'POST', headers: auth, body: JSON.stringify({
      ...keyedPayload, files: keyedPayload.files.map(f =>
        f.path === 'calc.js' ? { ...f, content: f.content + '\n//changed' } : f)
    })
  });
  assert.equal(conflict.status, 400);
  assert.equal((await conflict.json()).error, 'BUILD_IDEMPOTENCY_CONFLICT');
  const ownerReplay = await fetch('http://127.0.0.1:4101/v1/jobs/' + keyedId,
    { headers: { ...auth, 'x-aira-owner': 'bob' } });
  assert.equal(ownerReplay.status, 404);

  const recoveredWorker = new DockerProjectWorker(config);
  await recoveredWorker.initialize();
  const afterRestart = recoveredWorker.getJob(keyedId, 'alice');
  assert.equal(afterRestart?.state, 'BUILD_PASSED');
  assert.equal(afterRestart?.requestDigest?.length, 64);
  assert.equal(afterRestart?.previewTicket, undefined, 'Preview bearer grants must not survive restart');
  const afterRestartRepeat = await recoveredWorker.submit(keyedPayload);
  assert.equal(afterRestartRepeat.id, keyedId);
  assert.equal(afterRestartRepeat.state, 'BUILD_PASSED');
  assert.equal(afterRestartRepeat.previewUrl, undefined, 'Do not invent a working preview on restart');
  console.log('PASS: keyed Docker project submission survives lost response and restart without duplicate execution.');

  const broken = await fetch('http://127.0.0.1:4101/v1/jobs', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ ownerId: 'alice', files: [
      { path: 'index.html', content: '<html>broken</html>' },
      { path: 'broken.js', content: 'function unfinished( {' }
    ], steps: ['syntax', 'build', 'test'] })
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
      { path: 'package.json', content: JSON.stringify({ dependencies: { 'left-pad': '1.3.0' } }) }
    ], steps: ['syntax', 'build', 'test'] })
  });
  assert.equal(deps.status, 202);
  const blocked = await waitFor((await deps.json()).jobId);
  assert.equal(blocked.state, 'FAILED');
  assert.equal(blocked.error, config.npmCache ? 'DEPENDENCY_NOT_APPROVED' : 'DEPENDENCY_INSTALL_NOT_CONFIGURED');
  assert.equal(blocked.previewUrl, undefined);

  const slow = await fetch('http://127.0.0.1:4101/v1/jobs', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      ownerId: 'alice',
      files: [
        { path: 'index.html', content: '<html><body>slow job must never preview</body></html>' },
        { path: 'slow.js', content: 'console.log("waiting");' },
        { path: 'package.json', content: JSON.stringify({
          name: 'test-cancellation', version: '1.0.0',
          scripts: { build: 'node -e "setTimeout(() => {}, 30000)"', test: 'node --check slow.js' }
        }) }
      ],
      steps: ['syntax', 'build', 'test']
    })
  });
  assert.equal(slow.status, 202);
  const slowId = (await slow.json()).jobId as string;
  const deniedCancel = await fetch('http://127.0.0.1:4101/v1/jobs/' + slowId, {
    method: 'DELETE', headers: { ...auth, 'x-aira-owner': 'bob' }
  });
  assert.equal(deniedCancel.status, 404);
  // Let the worker enter its container phase before testing cancellation.
  await new Promise(resolve => setTimeout(resolve, 1200));
  const stop = await fetch('http://127.0.0.1:4101/v1/jobs/' + slowId, {
    method: 'DELETE', headers: auth
  });
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).state, 'CANCELLED');
  await new Promise(resolve => setTimeout(resolve, 1500));
  const cancelled = await fetch('http://127.0.0.1:4101/v1/jobs/' + slowId, { headers: auth });
  assert.equal((await cancelled.json()).state, 'CANCELLED');
  const cancelledSource = await fetch('http://127.0.0.1:4101/v1/jobs/' + slowId + '/source', { headers: auth });
  assert.equal(cancelledSource.status, 404);

  if (config.npmCache) {
    // CI provisions only a reviewed, pinned test tarball into the trusted cache.
    // No user-generated project code receives network access.
    const fixture = await mkdtemp(join(tmpdir(), 'aira-dependency-fixture-'));
    try {
      const dependencyPackage = JSON.stringify({
        name: 'aira-three-dependency-test', version: '1.0.0', type: 'module',
        dependencies: { three: '0.180.0' },
        scripts: { build: 'node --check app.js', test: 'node test.js' }
      });
      await writeFile(join(fixture, 'package.json'), dependencyPackage);
      await execFileAsync('npm', [
        'install', '--package-lock-only', '--offline', '--ignore-scripts',
        '--no-audit', '--no-fund', '--cache', config.npmCache
      ], { cwd: fixture, timeout: 30_000 });
      const lockfile = await readFile(join(fixture, 'package-lock.json'), 'utf8');
      const trustedLocks = join(config.npmCache, 'approved-locks');
      await mkdir(trustedLocks, { recursive: true });
      await writeFile(join(trustedLocks, approvedLockfileKey(dependencyPackage) + '.json'), lockfile);
      assert.doesNotThrow(() => validateOfflineDependencyLock(dependencyPackage, lockfile));
      const invalidLock = JSON.parse(lockfile);
      invalidLock.packages['node_modules/three'].resolved = 'http://127.0.0.1/evil.tgz';
      assert.throws(() => validateOfflineDependencyLock(dependencyPackage, JSON.stringify(invalidLock)),
        /UNTRUSTED_DEPENDENCY_ARCHIVE/);
      const trustedThree = await fetch('http://127.0.0.1:4101/v1/jobs', {
        method: 'POST', headers: auth,
        body: JSON.stringify({
          ownerId: 'alice', files: [
            { path: 'index.html', content: '<html><body>Three dependency installed</body></html>' },
            { path: 'app.js', content: "import { Scene } from 'three'; console.log(new Scene().type);" },
            { path: 'test.js', content: "import assert from 'node:assert/strict'; import { Scene } from 'three'; assert.equal(new Scene().type, 'Scene'); console.log('REAL_THREE_MODULE_LOADED');" },
            { path: 'package.json', content: dependencyPackage },
            { path: 'package-lock.json', content: lockfile }
          ], steps: ['syntax', 'build', 'test']
        })
      });
      assert.equal(trustedThree.status, 202);
      const threeJob = await waitFor((await trustedThree.json()).jobId);
      assert.equal(threeJob.state, 'BUILD_PASSED', JSON.stringify(threeJob));
      assert.deepEqual(threeJob.steps.map((step: { name: string }) => step.name),
        ['install', 'syntax', 'build', 'test']);
      assert.ok(threeJob.steps.some((step: { output: string }) => step.output.includes('REAL_THREE_MODULE_LOADED')));

      const autoLock = await fetch('http://127.0.0.1:4101/v1/jobs', {
        method: 'POST', headers: auth,
        body: JSON.stringify({
          ownerId: 'alice',
          files: [
            { path: 'index.html', content: '<html><body>Model requested approved Three package</body></html>' },
            { path: 'app.js', content: "import { Scene } from 'three'; console.log(new Scene().type);" },
            { path: 'test.js', content: "import assert from 'node:assert/strict'; import { Scene } from 'three'; assert.equal(new Scene().type, 'Scene');" },
            { path: 'package.json', content: dependencyPackage }
          ],
          steps: ['syntax', 'build', 'test']
        })
      });
      assert.equal(autoLock.status, 202);
      const autoJob = await waitFor((await autoLock.json()).jobId);
      assert.equal(autoJob.state, 'BUILD_PASSED', JSON.stringify(autoJob));
      assert.equal(autoJob.steps[0].name, 'resolve', 'Lockfile is taken from vetted operator cache');
      assert.ok(autoJob.manifest.some((file: { path: string }) => file.path === 'package-lock.json'));
      const autoArchive = await fetch('http://127.0.0.1:4101/v1/jobs/' + autoJob.id + '/source', { headers: auth });
      assert.equal(autoArchive.status, 200);

      console.log('PASS: real Three.js dependency installed offline from immutable lockfile and trusted cache.');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }

  // Compile a genuinely different dist/ project and verify the preview serves
  // compiled assets, never merely the original source index.html.
  const compiledSource = {
    ownerId: 'alice',
    files: [
      { path: 'index.html', content: '<html><body>SOURCE_ONLY_MARKER</body></html>' },
      { path: 'build.js', content: [
        "import fs from 'node:fs';",
        "fs.mkdirSync('dist/assets', { recursive: true });",
        "fs.writeFileSync('dist/index.html', '<html><body><button id=\"compiled\">Open</button><output id=\"answer\"></output><script type=\"module\" src=\"./assets/main.js\"></script></body></html>');",
        "fs.writeFileSync('dist/assets/main.js', 'document.querySelector(\"#compiled\").onclick = () => document.querySelector(\"#answer\").textContent = \"COMPILED_OK\";');"
      ].join('\n') },
      { path: 'test.js', content: "import assert from 'node:assert/strict'; assert.equal(4, 2+2);" },
      { path: 'package.json', content: JSON.stringify({
        name: 'aira-compiled-preview-test', version: '1.0.0', type: 'module',
        scripts: { build: 'node build.js', test: 'node test.js' }
      }) }
    ],
    steps: ['syntax', 'build', 'test']
  };
  const builtResponse = await fetch('http://127.0.0.1:4101/v1/jobs', {
    method: 'POST', headers: auth, body: JSON.stringify(compiledSource)
  });
  assert.equal(builtResponse.status, 202);
  const compiledJob = await waitFor((await builtResponse.json()).jobId);
  assert.equal(compiledJob.state, 'BUILD_PASSED', JSON.stringify(compiledJob));
  assert.equal(compiledJob.previewMode, 'compiled');
  assert.ok(compiledJob.previewManifest.some((file: { path: string }) => file.path === 'assets/main.js'));
  const servedBuiltIndex = await fetch(compiledJob.previewUrl);
  assert.equal(servedBuiltIndex.status, 200);
  const servedBuiltText = await servedBuiltIndex.text();
  assert.match(servedBuiltText, /id="compiled"/);
  assert.doesNotMatch(servedBuiltText, /SOURCE_ONLY_MARKER/);
  const builtBrowser = await chromium.launch({ headless: true });
  try {
    const page = await builtBrowser.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(compiledJob.previewUrl);
    await page.locator('#compiled').click();
    assert.equal(await page.locator('#answer').textContent(), 'COMPILED_OK');
    assert.deepEqual(errors, []);
  } finally {
    await builtBrowser.close();
  }
  const privateBuildSource = await fetch(
    'http://127.0.0.1:4102/p/' + compiledJob.previewTicket + '/build.js'
  );
  assert.equal(privateBuildSource.status, 404, 'Compiled preview must not expose source scripts');

  console.log('PASS: Docker worker real container executed syntax, npm build, npm tests, owner isolation, preview, authorization, cancellation and negative cases.');
} finally {
  await Promise.all([
    new Promise<void>(r => controller.close(() => r())),
    new Promise<void>(r => preview.close(() => r()))
  ]);
  await rm(root, { recursive: true, force: true });
}
