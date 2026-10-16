import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  resolveWorkerHealthHost,
  createWorkerHealthServer,
  DEFAULT_HEALTH_HOST
} from '../apps/specialist-worker/src/health.js';

console.log('\n=== AIRA AI 2026 — SPECIALIST WORKER HEALTH & READINESS SECURITY TESTS ===\n');

// ---------------------------------------------------------------------------
// 1. Host Binding Policy Validation (Task 1)
// ---------------------------------------------------------------------------
console.log('1. Testing Health Host Binding Policy Resolution...');

// Default binding must strictly be loopback (127.0.0.1) for native systemd deployments
assert.equal(
  resolveWorkerHealthHost({}),
  DEFAULT_HEALTH_HOST,
  'Default health host must be 127.0.0.1 when unconfigured'
);
assert.equal(
  resolveWorkerHealthHost({ WORKER_HEALTH_HOST: '' }),
  '127.0.0.1',
  'Empty WORKER_HEALTH_HOST must default to 127.0.0.1'
);

// Explicit localhost resolution
assert.equal(
  resolveWorkerHealthHost({ WORKER_HEALTH_HOST: '127.0.0.1' }),
  '127.0.0.1',
  'Explicit 127.0.0.1 must be accepted'
);
assert.equal(
  resolveWorkerHealthHost({ WORKER_HEALTH_HOST: 'localhost' }),
  '127.0.0.1',
  'localhost must normalize to 127.0.0.1'
);
assert.equal(
  resolveWorkerHealthHost({ WORKER_HEALTH_HOST: '::1' }),
  '::1',
  'IPv6 loopback ::1 must be accepted'
);

// Fallback to HEALTH_HOST if WORKER_HEALTH_HOST is not set
assert.equal(
  resolveWorkerHealthHost({ HEALTH_HOST: '127.0.0.1' }),
  '127.0.0.1',
  'HEALTH_HOST fallback must be supported'
);

// Forbidden public/external bindings without container permission
assert.throws(
  () => resolveWorkerHealthHost({ WORKER_HEALTH_HOST: '0.0.0.0' }),
  /SPECIALIST_WORKER_HEALTH_PUBLIC_BINDING_FORBIDDEN/,
  'Binding to 0.0.0.0 without WORKER_HEALTH_ALLOW_EXTERNAL must throw'
);
assert.throws(
  () => resolveWorkerHealthHost({ WORKER_HEALTH_HOST: '192.168.1.50' }),
  /INVALID_WORKER_HEALTH_HOST/,
  'Arbitrary public/LAN IP binding must be rejected'
);
assert.throws(
  () => resolveWorkerHealthHost({ WORKER_HEALTH_HOST: 'example.com' }),
  /INVALID_WORKER_HEALTH_HOST/,
  'External hostname binding must be rejected'
);

// Allowed 0.0.0.0 binding in explicit container environments
assert.equal(
  resolveWorkerHealthHost({ WORKER_HEALTH_HOST: '0.0.0.0', WORKER_HEALTH_ALLOW_EXTERNAL: 'true' }),
  '0.0.0.0',
  '0.0.0.0 must be allowed when WORKER_HEALTH_ALLOW_EXTERNAL=true'
);
assert.equal(
  resolveWorkerHealthHost({ WORKER_HEALTH_HOST: '0.0.0.0', DOCKER_CONTAINER: 'true' }),
  '0.0.0.0',
  '0.0.0.0 must be allowed when DOCKER_CONTAINER=true'
);
assert.equal(
  resolveWorkerHealthHost({ WORKER_HEALTH_HOST: '0.0.0.0', AIRA_WORKER_CONTAINER: 'true' }),
  '0.0.0.0',
  '0.0.0.0 must be allowed when AIRA_WORKER_CONTAINER=true'
);

console.log('✓ Host binding policy strictly enforces loopback default and validates container opt-ins.');

// ---------------------------------------------------------------------------
// 2. HTTP Probe Endpoints & Security Redaction (Tasks 1 & 2)
// ---------------------------------------------------------------------------
console.log('\n2. Testing /health, /live, /ready Endpoints & Error Redaction...');

const testWorkerId = 'specialist-worker-test-uuid-42';
let simulateDbFailure = false;
let simulateSensitiveError = false;
const loggedErrors: any[] = [];

const mockLogger = {
  error: (msg: string) => {
    loggedErrors.push(JSON.parse(msg));
  },
  info: () => {}
};

const server = createWorkerHealthServer({
  workerId: testWorkerId,
  checkDatabase: async () => {
    if (simulateSensitiveError) {
      const sensitiveErr: any = new Error(
        'connect ECONNREFUSED postgresql://aira_super_user:p4ssw0rd_secrets@internal-db.neon.tech:5432/aira_prod_secret'
      );
      sensitiveErr.code = 'ECONNREFUSED';
      sensitiveErr.query = 'SELECT * FROM secret_credentials WHERE tenant_id = 997';
      sensitiveErr.stack = 'Error: connect ECONNREFUSED\n    at internalConnectMultiple (node:net:1339:18)';
      throw sensitiveErr;
    }
    if (simulateDbFailure) {
      const err: any = new Error('Database pool connection timeout');
      err.code = 'ETIMEDOUT';
      throw err;
    }
    // Success path
  },
  uptime: () => 123.456,
  logger: mockLogger
});

await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve());
});

const port = (server.address() as AddressInfo).port;
const baseUrl = `http://127.0.0.1:${port}`;

async function requestJson(path: string): Promise<{ status: number; headers: Record<string, string>; body: any; rawText: string }> {
  const res = await fetch(`${baseUrl}${path}`);
  const rawText = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = rawText;
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((val, key) => {
    headers[key.toLowerCase()] = val;
  });
  return { status: res.status, headers, body, rawText };
}

try {
  // Test /health liveness probe
  const healthRes = await requestJson('/health');
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.body.status, 'HEALTHY');
  assert.equal(healthRes.body.kind, 'specialist-worker');
  assert.equal(healthRes.body.workerId, testWorkerId);
  assert.equal(healthRes.body.uptime, 123.456);
  assert.ok(healthRes.body.timestamp);
  assert.equal(healthRes.headers['x-content-type-options'], 'nosniff');

  // Test /live alias
  const liveRes = await requestJson('/live');
  assert.equal(liveRes.status, 200);
  assert.equal(liveRes.body.status, 'HEALTHY');

  // Test /ready probe on HEALTHY database
  simulateDbFailure = false;
  simulateSensitiveError = false;
  const readyHealthyRes = await requestJson('/ready');
  assert.equal(readyHealthyRes.status, 200);
  assert.equal(readyHealthyRes.body.status, 'READY');
  assert.equal(readyHealthyRes.body.kind, 'specialist-worker');
  assert.equal(readyHealthyRes.body.database, 'CONNECTED');
  assert.equal(readyHealthyRes.body.leaseMs, 30000);
  assert.equal(readyHealthyRes.body.heartbeatMs, 5000);
  assert.equal(readyHealthyRes.body.workerId, testWorkerId);

  // Test /ready probe on UNAVAILABLE database with SENSITIVE credentials error
  simulateSensitiveError = true;
  const readyFailedRes = await requestJson('/ready');

  // HTTP status must be 503 Service Unavailable
  assert.equal(readyFailedRes.status, 503, 'Readiness failure must return HTTP 503');

  // Body must have generic, non-disclosing error structure
  assert.equal(readyFailedRes.body.status, 'NOT_READY');
  assert.equal(readyFailedRes.body.error, 'DATABASE_UNREACHABLE');
  assert.equal(readyFailedRes.body.message, 'Database readiness check failed');

  // NEGATIVE ASSERTIONS: ABSOLUTELY ZERO CREDENTIALS, HOSTNAMES, URLS, OR SQL IN RESPONSE
  const rawResponse = readyFailedRes.rawText;
  assert.equal(rawResponse.includes('p4ssw0rd_secrets'), false, 'Response must not disclose database password');
  assert.equal(rawResponse.includes('aira_super_user'), false, 'Response must not disclose database username');
  assert.equal(rawResponse.includes('internal-db.neon.tech'), false, 'Response must not disclose internal database host');
  assert.equal(rawResponse.includes('aira_prod_secret'), false, 'Response must not disclose database name');
  assert.equal(rawResponse.includes('postgresql://'), false, 'Response must not disclose postgresql protocol URL');
  assert.equal(rawResponse.includes('SELECT * FROM secret_credentials'), false, 'Response must not disclose internal SQL query');
  assert.equal(rawResponse.includes('internalConnectMultiple'), false, 'Response must not disclose internal stack traces');

  // Verify server-side restricted diagnostic logging occurred safely
  assert.ok(loggedErrors.length > 0, 'Diagnostic error must be logged server-side');
  const lastLog = loggedErrors[loggedErrors.length - 1];
  assert.equal(lastLog.level, 'error');
  assert.equal(lastLog.event, 'SPECIALIST_WORKER_READINESS_CHECK_FAILED');
  assert.equal(lastLog.workerId, testWorkerId);
  assert.equal(lastLog.code, 'ECONNREFUSED');
  assert.equal(JSON.stringify(lastLog).includes('p4ssw0rd_secrets'), false, 'Server log must not log credentials');

  // Test 404 on unmapped route
  const notFoundRes = await requestJson('/unmapped-admin-path');
  assert.equal(notFoundRes.status, 404);
  assert.equal(notFoundRes.body.error, 'NOT_FOUND');

  console.log('✓ Health and readiness endpoints verified across 200 and 503 paths.');
  console.log('✓ Error disclosure prevention confirmed: ZERO database URLs, credentials, hostnames, SQL, or stack traces leaked.');
} finally {
  server.close();
}

console.log('\n=== ALL SPECIALIST WORKER HEALTH SECURITY TESTS PASSED ===\n');
