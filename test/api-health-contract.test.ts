import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Configure environment to prevent binding conflict and ensure predictable evaluation
process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.AIRA_SESSION_SECRET = process.env.AIRA_SESSION_SECRET || 'test-secret-at-least-32-chars-long-for-testing';
process.env.ALLOWED_ORIGINS = 'https://aira-ai-2026.vercel.app,http://localhost:5173';

const { default: app } = await import('../apps/api/src/index.js');

let server: http.Server;
let baseUrl: string;

test.before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

test('[API Contract] /api/health returns authentic schema matching production source', async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    headers: {
      Origin: 'https://aira-ai-2026.vercel.app',
    },
  });

  assert.equal(res.status, 200);
  const data = await res.json() as any;

  // Primary top-level contract
  assert.equal(typeof data.status, 'string');
  assert.ok(['HEALTHY', 'DEGRADED'].includes(data.status), `status must be HEALTHY or DEGRADED, got: ${data.status}`);
  assert.equal(typeof data.appState, 'string');
  assert.equal(typeof data.readiness, 'string');
  assert.equal(data.version, '2026.2.0');
  assert.equal(typeof data.timestamp, 'number');
  assert.ok(typeof data.productionMockFallback === 'string');

  // Subsystems object verification
  assert.ok(data.subsystems && typeof data.subsystems === 'object');
  const expectedSubsystemKeys = [
    'modelRouter',
    'toolRuntime',
    'toolGateway',
    'approvalKernel',
    'mcpHost',
    'knowledgeEngine',
    'agentRuntime',
    'automationEngine',
    'capabilityRegistry',
    'intentRouter',
    'workflowEngine',
    'conversationSearch',
  ];

  for (const key of expectedSubsystemKeys) {
    assert.ok(
      key in data.subsystems,
      `Expected subsystem key '${key}' to exist in /api/health subsystems map`
    );
    assert.equal(typeof data.subsystems[key], 'string');
  }

  // Verify absence of fabricated subsystem keys from earlier draft reports
  assert.equal(data.subsystems.taskQueue, undefined, 'taskQueue should not exist in /api/health subsystems');
  assert.equal(data.subsystems.artifactStore, undefined, 'artifactStore should not exist in /api/health subsystems');
  assert.equal(data.subsystems.hitlApproval, undefined, 'hitlApproval was renamed/governed by approvalKernel');
});

test('[API Contract] /api/ready returns authentic status and timestamp contract', async () => {
  const res = await fetch(`${baseUrl}/api/ready`, {
    headers: {
      Origin: 'https://aira-ai-2026.vercel.app',
    },
  });

  // Depending on database configuration in local test environment, can be 200 or 503
  assert.ok([200, 503].includes(res.status), `Expected 200 or 503, got: ${res.status}`);
  const data = await res.json() as any;

  // Real schema check
  assert.ok(typeof data.status === 'string');
  assert.ok(['READY', 'NOT_READY'].includes(data.status));
  assert.equal(typeof data.timestamp, 'number');

  // Assert absence of fabricated fields in /api/ready response
  assert.equal(data.database, undefined, '/api/ready does not return database status directly');
  assert.equal(data.migrations, undefined, '/api/ready does not return migration numbers directly');
  assert.equal(data.agentExecution, undefined, '/api/ready does not return agentExecution directly');
});
