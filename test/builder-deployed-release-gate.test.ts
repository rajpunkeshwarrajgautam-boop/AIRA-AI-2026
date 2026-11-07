/**
 * AIRA Builder release gate: genuine deployed API, verified managed account,
 * real model and sandbox, real SSE, download, preview and cancellation.
 *
 * This deliberately has NO route mocks, test principals, signed guest bootstrap,
 * or in-process BuilderService. A disabled/unconfigured preview is a BLOCKER,
 * never a successful Builder execution certificate.
 *
 * Required (provide through an authorized, isolated test environment):
 *   AIRA_PREVIEW_URL             Exact HTTPS Vercel PR preview URL
 *   AIRA_EXPECTED_DEPLOYMENT_SHA Exact full PR head SHA
 *   AIRA_LIVE_OAUTH_COOKIE       Full Cookie header for an isolated OAuth test account
 * Optional:
 *   VERCEL_AUTOMATION_BYPASS_SECRET
 *
 * Running this gate executes a real sandbox and may consume provider resources.
 * Never invoke it against Production or with real user workspace data.
 */

import assert from 'node:assert/strict';

type JsonRecord = Record<string, unknown>;
type BuilderEvent = { type: string; data: JsonRecord };

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for deployed Builder certification`);
  return value;
}

function parseEvents(payload: string): BuilderEvent[] {
  const events: BuilderEvent[] = [];
  for (const block of payload.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const event = lines.find(line => line.startsWith('event: '))?.slice(7).trim();
    const data = lines.find(line => line.startsWith('data: '))?.slice(6);
    if (!event || !data) continue;
    const parsed = JSON.parse(data) as unknown;
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `Invalid SSE payload for ${event}`);
    events.push({ type: event, data: parsed as JsonRecord });
  }
  return events;
}

async function json(res: Response, label: string): Promise<JsonRecord> {
  const body = await res.json() as unknown;
  assert.ok(body && typeof body === 'object' && !Array.isArray(body), `${label} returned non-object JSON`);
  return body as JsonRecord;
}

async function main() {
  // All preconditions are checked before any API request or provider activation.
  const preview = new URL(requiredEnv('AIRA_PREVIEW_URL'));
  assert.equal(preview.protocol, 'https:', 'Release gate requires HTTPS');
  assert.ok(preview.hostname.endsWith('.vercel.app'), 'Release gate requires a Vercel preview hostname');
  assert.notEqual(preview.hostname, 'aira-ai-2026.vercel.app', 'Do not run release acceptance against Production');
  assert.equal(preview.pathname, '/', 'Preview URL must be its origin, not a path');
  const expectedSha = requiredEnv('AIRA_EXPECTED_DEPLOYMENT_SHA');
  assert.match(expectedSha, /^[a-f0-9]{40}$/, 'Expected release SHA must be exact');
  const cookie = requiredEnv('AIRA_LIVE_OAUTH_COOKIE');
  assert.ok(cookie.length <= 8192 && !/[\r\n]/.test(cookie), 'Invalid test-account Cookie header');
  assert.match(cookie, /(?:^|;\s*)(?:__Host-aira_auth_session|aira_auth_session)=\S+/, 'A real managed-account BFF session cookie is required');

  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const commonHeaders: Record<string, string> = {
    Accept: 'application/json',
    Cookie: cookie,
    ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}),
  };
  const endpoint = (path: string) => new URL(path, preview);
  const get = (path: string) => fetch(endpoint(path), {
    headers: commonHeaders,
    redirect: 'error',
    signal: AbortSignal.timeout(25_000),
  });

  const versionRes = await get('/api/version');
  assert.equal(versionRes.status, 200, 'Preview /api/version must be available');
  const version = await json(versionRes, 'version');
  assert.equal(version.commitSha, expectedSha, 'Deployed preview SHA differs from PR candidate');

  const healthRes = await get('/api/health');
  assert.equal(healthRes.status, 200, 'Preview /api/health must be available');
  const health = await json(healthRes, 'health');
  assert.equal(health.status, 'HEALTHY');
  assert.equal(health.productionMockFallback, 'DISABLED');

  const identityRes = await get('/api/auth/identity');
  assert.equal(identityRes.status, 200, 'Release gate requires a verified OAuth account, not a signed guest session');
  const identity = await json(identityRes, 'managed identity');
  assert.equal(identity.status, 'AUTHENTICATED');
  assert.ok(typeof identity.userId === 'string' && identity.userId.length > 0, 'Managed account ID missing');
  assert.ok(['direct_oauth', 'neon_auth'].includes(String(identity.provider)), 'Identity must come from a verified managed provider');

  const sessionRes = await get('/api/auth/session');
  assert.equal(sessionRes.status, 200);
  const session = await json(sessionRes, 'BFF session');
  assert.equal(session.status, 'AUTHENTICATED');
  const user = session.user as JsonRecord | undefined;
  assert.equal(user?.id, identity.userId, 'BFF session principal differs from verified account');
  const csrfToken = session.csrfToken;
  assert.ok(typeof csrfToken === 'string' && csrfToken.length > 0, 'Missing session-bound CSRF token');

  const statusRes = await get('/api/builder/status');
  assert.equal(statusRes.status, 200);
  const status = await json(statusRes, 'Builder status');
  assert.equal(status.principalId, identity.userId, 'Builder principal must match verified OAuth account');
  assert.equal(status.ready, true, `Deployed Builder is NOT ready: ${String(status.reason || 'unknown')}`);
  assert.equal(status.allowed, true, 'OAuth account is not explicitly allowed to execute Builder');
  assert.equal(status.configured, true, 'Real sandbox credentials and signing key are required');
  assert.equal(status.providerConfigured, true, 'Real model provider is required');

  const mutationHeaders: Record<string, string> = {
    ...commonHeaders,
    'Content-Type': 'application/json',
    Origin: preview.origin,
    'sec-fetch-site': 'same-origin',
    'x-aira-csrf-token': csrfToken,
    'x-aira-csrf-protection': '1',
  };
  let workspaceTicket: string | undefined;
  let cancelled = false;
  try {
    const streamRes = await fetch(endpoint('/api/builder/stream'), {
      method: 'POST',
      headers: mutationHeaders,
      redirect: 'error',
      signal: AbortSignal.timeout(240_000),
      body: JSON.stringify({
        prompt: 'Create a single self-contained index.html showing the text AIRA RELEASE ACCEPTANCE. Test the HTML, publish index.html, start a preview, then finish.',
        model: 'aira-auto',
        allowExecution: true,
        allowInternet: false,
        allowPreview: true,
      }),
    });
    assert.equal(streamRes.status, 200, `Real Builder streaming failed with HTTP ${streamRes.status}`);
    assert.match(streamRes.headers.get('content-type') || '', /text\/event-stream/);
    const events = parseEvents(await streamRes.text());
    const names = events.map(e => e.type);
    assert.ok(!names.includes('builder.error'), 'Real Builder SSE emitted an error');
    for (const type of ['builder.started', 'builder.tool.started', 'builder.tool.completed', 'builder.file', 'builder.preview', 'builder.completed']) {
      assert.ok(names.includes(type), `Deployed Builder omitted ${type}`);
    }
    const started = events.find(e => e.type === 'builder.started');
    workspaceTicket = typeof started?.data.workspaceTicket === 'string' ? started.data.workspaceTicket : undefined;
    assert.ok(workspaceTicket, 'Deployed Builder must return a signed workspace ticket');
    const previewEvent = events.find(e => e.type === 'builder.preview');
    assert.match(String(previewEvent?.data.url || ''), /^https:\/\//, 'Real sandbox must return HTTPS preview');

    const fileEvent = events.find(e => e.type === 'builder.file' && e.data.path === 'index.html');
    assert.ok(fileEvent, 'Generated index.html was not published');
    const fileUrl = new URL(String(fileEvent.data.url || ''), preview);
    assert.equal(fileUrl.origin, preview.origin, 'File download must remain on first-party origin');
    assert.equal(fileUrl.pathname, '/api/builder/download');
    const downloadRes = await fetch(fileUrl, {
      headers: commonHeaders,
      redirect: 'error',
      signal: AbortSignal.timeout(25_000),
    });
    assert.equal(downloadRes.status, 200, 'Generated file download failed');
    assert.match(downloadRes.headers.get('content-disposition') || '', /^attachment;/);
    assert.equal(downloadRes.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.ok((await downloadRes.text()).includes('AIRA RELEASE ACCEPTANCE'), 'Downloaded file did not contain generated acceptance content');

    console.log(`PASS: exact preview SHA, real OAuth account, Builder readiness, ${events.length} deployed SSE events, sandbox preview and file download`);
  } finally {
    // Always attempt sandbox cleanup, including if SSE validation fails.
    if (workspaceTicket) {
      const cancelRes = await fetch(endpoint('/api/builder/cancel'), {
        method: 'POST',
        headers: mutationHeaders,
        redirect: 'error',
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({ ticket: workspaceTicket }),
      });
      cancelled = cancelRes.status === 200 && (await json(cancelRes, 'Builder cancellation')).cancelled === true;
    }
  }
  assert.equal(cancelled, true, 'Real sandbox workspace cancellation was not confirmed');
  console.log('PASS: deployed Builder cancellation and sandbox cleanup confirmed');
}

main().catch(error => {
  // Never print cookie values, signed URLs, CSRF tokens or credentials.
  console.error(`BLOCKED/FAIL: ${error instanceof Error ? error.message : 'Unknown Builder release-gate failure'}`);
  process.exitCode = 1;
});
