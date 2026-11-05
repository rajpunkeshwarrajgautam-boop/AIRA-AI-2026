import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

test('AIRA AI 2026 — Staging Deployment & Configuration Invariants Suite', async (suite) => {
  const composePath = path.join(REPO_ROOT, 'docker-compose.oracle-staging.yml');
  const systemdPath = path.join(REPO_ROOT, 'deploy', 'systemd', 'aira-oracle-worker.service');

  const composeContent = fs.readFileSync(composePath, 'utf8');
  const systemdContent = fs.readFileSync(systemdPath, 'utf8');

  await suite.test('1. Docker Compose: Project and container name isolation', () => {
    assert.match(composeContent, /^name:\s*aira-autonomous-staging/m, 'Must define top-level project name aira-autonomous-staging');
    assert.match(composeContent, /container_name:\s*\${CONTAINER_NAME:-aira-autonomous-worker-staging}/, 'Must default container_name to aira-autonomous-worker-staging');
    assert.match(composeContent, /container_name:\s*\${SANDBOX_CONTAINER_NAME:-aira-sandbox-runner-staging}/, 'Must default sandbox container_name to aira-sandbox-runner-staging');
  });

  await suite.test('2. Docker Compose: Non-colliding port binding and concurrency defaults', () => {
    assert.match(composeContent, /127\.0\.0\.1:8081:8080/, 'Default port binding must map host loopback 8081 to container 8080');
    assert.doesNotMatch(composeContent, /127\.0\.0\.1:8080:8080/, 'Must NOT default port binding to 8080 (reserved for M2A worker)');
    assert.match(composeContent, /WORKER_CONCURRENCY=\${WORKER_CONCURRENCY:-1}/, 'Default worker concurrency must be 1 for 1 OCPU host');
  });

  await suite.test('3. Docker Compose: Safe credential handling without empty-string clobbering', () => {
    // Assert that DATABASE_URL is not interpolated as ${DATABASE_URL} which clobbers env_file
    assert.match(composeContent, /-\s*DATABASE_URL\r?\n/, 'DATABASE_URL must be pass-through without ${DATABASE_URL} clobbering');
    assert.doesNotMatch(composeContent, /-\s*DATABASE_URL=\${DATABASE_URL}/, 'Must NOT contain DATABASE_URL=${DATABASE_URL}');
    assert.doesNotMatch(composeContent, /-\s*BROWSER_SESSION_ENCRYPTION_KEY=\${BROWSER_SESSION_ENCRYPTION_KEY:-}/, 'Must NOT contain BROWSER_SESSION_ENCRYPTION_KEY=${...}');
  });

  await suite.test('4. Docker Compose: Zero host Docker socket exposure and internal network', () => {
    assert.doesNotMatch(composeContent, /\/var\/run\/docker\.sock/, 'Host docker socket must NEVER be mounted in compose');
    assert.match(composeContent, /sandbox-net:\r?\n\s+internal:\s*true/, 'sandbox-net must be internal: true');
  });

  await suite.test('5. Systemd: Non-destructive startup and correct working directory', () => {
    assert.match(systemdContent, /WorkingDirectory=\/home\/ubuntu\/aira-autonomous-staging/, 'WorkingDirectory must point to actual deployment directory');
    assert.doesNotMatch(systemdContent, /WorkingDirectory=\/opt\/aira/, 'Must NOT reference non-existent /opt/aira');
    assert.doesNotMatch(systemdContent, /down\s+--remove-orphans/, 'ExecStartPre must NEVER tear down containers with --remove-orphans');
    assert.match(systemdContent, /ExecStartPre=.*compose.*config\s+-q/, 'ExecStartPre must perform non-destructive config validation');
    assert.match(systemdContent, /ExecStart=.*-p\s+aira-autonomous-staging/, 'ExecStart must enforce project isolation -p aira-autonomous-staging');
  });

  await suite.test('6. Systemd: Resource bounds appropriate for 1 OCPU / ~6 GB host', () => {
    assert.match(systemdContent, /CPUQuota=90%/, 'CPU quota must be configured for 1 OCPU');
    assert.match(systemdContent, /MemoryMax=2\.2G/, 'MemoryMax must be bounded under 2.5G for ~6 GB host');
    assert.match(systemdContent, /TimeoutStopSec=35/, 'TimeoutStopSec must allow graceful draining');
  });
});
