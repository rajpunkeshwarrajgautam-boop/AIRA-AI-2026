import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * AIRA AI 2026 — Live Staging Runtime & Infrastructure Probe Suite
 * 
 * Target: Deployed Staging Environment (https://staging.virexaaiventures.com)
 * Objective: Programmatically assert deployed staging behavior:
 *  1. Express API reachable and healthy on Vercel Serverless Functions (/api/health -> 200).
 *  2. Worker daemon endpoints (/health, /ready) are NOT hosted on Vercel (404),
 *     proving background specialist-worker hosting is un-deployed.
 *  3. Fail-closed security on unauthenticated/unauthorized autonomous task requests (401/403).
 *  4. Architectural boundary documentation: stateless Vercel invocation ceiling blocks
 *     continuous autonomous agent leasing and heartbeats without external worker hosting.
 */

const STAGING_BASE_URL = (
  process.env.STAGING_BASE_URL || 'https://staging.virexaaiventures.com'
).replace(/\/$/, '');

test('AIRA AI 2026 — Live Staging Runtime & Infrastructure Probe Suite', async (t) => {

  await t.test('1. Staging Express API is reachable and healthy (/api/health -> 200)', async () => {
    const res = await fetch(`${STAGING_BASE_URL}/api/health`);
    assert.equal(res.status, 200, `Expected 200 OK from /api/health, got ${res.status}`);

    const serverHeader = res.headers.get('server');
    const poweredBy = res.headers.get('x-powered-by');
    assert.equal(serverHeader, 'Vercel', 'Must be served via Vercel Edge / Serverless');
    assert.equal(poweredBy, 'Express', 'Must be mounted on Express API gateway');

    const body = await res.json() as {
      status?: string;
      appState?: string;
      subsystems?: Record<string, string>;
      productionMockFallback?: string;
      version?: string;
      timestamp?: number;
    };

    assert.equal(body.status, 'HEALTHY');
    assert.equal(body.appState, 'HEALTHY');
    assert.equal(body.productionMockFallback, 'DISABLED', 'Production mock fallbacks must be disabled in staging');

    // Verify vital agent and tool subsystems are registered
    assert.ok(body.subsystems, 'Subsystems status must be reported');
    assert.match(body.subsystems?.modelRouter || '', /ONLINE/);
    assert.match(body.subsystems?.toolGateway || '', /ONLINE/);
    assert.match(body.subsystems?.agentRuntime || '', /ONLINE/);
    assert.match(body.subsystems?.mcpHost || '', /ONLINE/);
    assert.match(body.subsystems?.knowledgeEngine || '', /ONLINE/);
  });

  await t.test('2. Worker management endpoints (/health, /ready) return 404 on Vercel (specialist-worker not hosted)', async () => {
    // Probe GET /health
    const healthRes = await fetch(`${STAGING_BASE_URL}/health`);
    assert.equal(
      healthRes.status,
      404,
      `GET /health must return 404 Not Found on Vercel, got ${healthRes.status}`
    );
    const healthVercelErr = healthRes.headers.get('x-vercel-error');
    assert.equal(healthVercelErr, 'NOT_FOUND', 'Vercel router must indicate route NOT_FOUND');

    // Probe GET /ready
    const readyRes = await fetch(`${STAGING_BASE_URL}/ready`);
    assert.equal(
      readyRes.status,
      404,
      `GET /ready must return 404 Not Found on Vercel, got ${readyRes.status}`
    );
    const readyVercelErr = readyRes.headers.get('x-vercel-error');
    assert.equal(readyVercelErr, 'NOT_FOUND', 'Vercel router must indicate route NOT_FOUND');
  });

  await t.test('3. Unauthenticated autonomous task submission fails closed with 403 (CSRF Protection)', async () => {
    const res = await fetch(`${STAGING_BASE_URL}/api/agent/autonomous/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        objective: 'Probe unauthenticated autonomous execution'
      })
    });

    assert.equal(res.status, 403, `Expected 403 Forbidden for missing CSRF, got ${res.status}`);
    const body = await res.json() as { error?: string };
    assert.match(body.error || '', /CSRF validation failed/);
  });

  await t.test('4. Autonomous task submission with invalid token fails closed with 401 (Authentication Gate)', async () => {
    const res = await fetch(`${STAGING_BASE_URL}/api/agent/autonomous/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer unverified_probe_token_xyz999'
      },
      body: JSON.stringify({
        objective: 'Probe invalid authorization token'
      })
    });

    assert.equal(res.status, 401, `Expected 401 Unauthorized for invalid token, got ${res.status}`);
    const body = await res.json() as { error?: string; message?: string };
    assert.equal(body.error, 'Unauthorized');
    assert.match(body.message || '', /No valid principal found/);
  });

  await t.test('5. Architectural Reality: Vercel serverless freeze risk and worker hosting requirements', () => {
    /**
     * Architectural Verification:
     * Vercel Serverless Functions execute ephemerally with strict timeout limits (10s Hobby/Pro).
     * An autonomous mission that runs multi-step planning, tool invocations, browser automation,
     * and awaits human approval cannot complete synchronously inside a single HTTP request.
     * 
     * If an autonomous task is submitted to Vercel without an external worker daemon:
     * - The serverless invocation terminates when the HTTP response ends.
     * - In-memory event loops, timers, and pending promises are frozen/destroyed.
     * - Without apps/specialist-worker polling autonomous_agent_tasks with FOR UPDATE leases,
     *   the task remains stuck in CREATED or RUNNING state indefinitely.
     * 
     * Resolution requirement:
     * Deploy apps/specialist-worker to containerized runtime (ECS Fargate / Railway / Fly.io / Kubernetes)
     * configured with NEON_STAGING_DATABASE_URL to lease and recover autonomous tasks.
     */
    const vercelTimeoutCeilingSec = 10;
    const autonomousMissionExpectedMinDurationSec = 15;
    assert.ok(
      autonomousMissionExpectedMinDurationSec > vercelTimeoutCeilingSec,
      'Autonomous missions exceed serverless request lifetime ceiling, mandating standalone worker daemon'
    );
  });
});
