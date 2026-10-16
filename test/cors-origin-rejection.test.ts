import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Set VERCEL=1 to prevent auto-listen on port 3001
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

test('[CORS] Trusted production origin receives normal response and CORS headers', async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    headers: {
      'Origin': 'https://aira-ai-2026.vercel.app'
    }
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://aira-ai-2026.vercel.app');
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  const body = await res.json();
  assert.equal(body.status, 'HEALTHY');
});

test('[CORS] Untrusted foreign origin returns HTTP 403 Forbidden with safe response', async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    headers: {
      'Origin': 'https://evil-attacker.example.com'
    }
  });

  // MUST be HTTP 403, NOT HTTP 500
  assert.equal(res.status, 403, `Expected status 403, got ${res.status}`);
  // MUST NOT set Access-Control-Allow-Origin
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  
  const body = await res.json();
  // Safe error contract: { "error": "Origin not allowed" }
  assert.equal(body.error, 'Origin not allowed');
  // Must NOT leak stack trace, filenames, or internal error message
  assert.equal(body.message, undefined);
  assert.equal(body.stack, undefined);
});

test('[CORS] Malformed origin fails closed with HTTP 403 and safe response', async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    headers: {
      'Origin': 'invalid://malformed::origin'
    }
  });

  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  const body = await res.json();
  assert.equal(body.error, 'Origin not allowed');
});

test('[CORS] Server-to-server request without Origin header succeeds normally', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  const body = await res.json();
  assert.equal(body.status, 'HEALTHY');
});

test('[CORS] Trusted preflight OPTIONS request returns 200/204 with CORS headers', async () => {
  const res = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'https://aira-ai-2026.vercel.app',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type'
    }
  });

  assert.ok(res.status === 200 || res.status === 204, `Preflight status was ${res.status}`);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://aira-ai-2026.vercel.app');
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
});

test('[CORS] Untrusted preflight OPTIONS request returns HTTP 403 without allow-origin', async () => {
  const res = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'https://evil-attacker.example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type'
    }
  });

  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  const body = await res.json();
  assert.equal(body.error, 'Origin not allowed');
});

test('[CORS] CSRF protection remains independently active for mutating requests', async () => {
  // Same-origin POST without anti-CSRF token on protected mutation route must fail CSRF (403),
  // proving CORS allow does not bypass CSRF enforcement.
  const res = await fetch(`${baseUrl}/api/auth/sign-out`, {
    method: 'POST',
    headers: {
      'Origin': 'https://aira-ai-2026.vercel.app'
    }
  });

  // Origin allowed by CORS, but CSRF fails with CSRF validation error
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://aira-ai-2026.vercel.app');
  const body = await res.json();
  assert.match(body.error, /CSRF validation failed/);
});

test('[CORS] Unexpected thrown Error still surfaces as HTTP 500 (not masked as 403)', async () => {
  const res = await fetch(`${baseUrl}/api/test-unhandled-server-error`, {
    headers: {
      'Origin': 'https://aira-ai-2026.vercel.app',
      'x-test-user-id': 'test-user-1',
      'x-test-session-id': 'test-sess-1'
    }
  });

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'Internal server error');
  assert.equal(body.message, 'Simulated unexpected server error');
});
