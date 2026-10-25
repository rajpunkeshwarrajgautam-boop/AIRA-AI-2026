/**
 * AIRA AI 2026 — Hotfix Regression Tests: CSRF Validation & Origin Verification
 * 
 * Tests the root-cause defects identified in production incident:
 * 1. Guest mutating requests in authenticatedApiFetch must attach X-Aira-Csrf-Protection: '1'.
 * 2. ensureGuestSession must attach X-Aira-Csrf-Protection: '1' on POST /api/auth/session.
 * 3. Authenticated mutating requests must guarantee session CSRF token is resolved before dispatch.
 * 4. verifyCsrfAndOrigin must accept listed origins through a reverse proxy, but never trust forged host headers.
 * 5. Default trusted origins must recognize canonical production and staging origins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyCsrfAndOrigin,
  isAllowedOrigin,
  getTrustedOrigins
} from '../apps/api/src/auth/bff-session.js';
import {
  neonAuth,
  authenticatedApiFetch,
  ensureGuestSession
} from '../src/lib/neonAuth.js';

test('DEFECT 1 VERIFIED: Guest mutating request via authenticatedApiFetch must attach X-Aira-Csrf-Protection header', async () => {
  neonAuth.saveSession(null);
  assert.equal(neonAuth.isAuthenticated(), false);

  const capturedHeaders: Headers[] = [];
  const originalFetch = globalThis.fetch;

  (globalThis as any).fetch = async (input: any, init: any) => {
    const url = String(input);
    if (url.includes('/api/auth/session')) {
      return new Response(JSON.stringify({
        status: 'AUTHENTICATED',
        userId: 'guest_user_123',
        sessionId: 'guest_sess_123',
        expiresAt: Date.now() + 3600000
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.includes('/api/chat/stream')) {
      capturedHeaders.push(new Headers(init?.headers || {}));
      return new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }

    return new Response('{}', { status: 200 });
  };

  try {
    await authenticatedApiFetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Test' })
    });

    assert.equal(capturedHeaders.length, 1, 'Chat stream request should have been dispatched');
    const headers = capturedHeaders[0];
    assert.equal(
      headers.get('X-Aira-Csrf-Protection'),
      '1',
      'Guest mutating request MUST attach X-Aira-Csrf-Protection: 1 header'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DEFECT 2 VERIFIED: ensureGuestSession must attach X-Aira-Csrf-Protection: 1 header on POST /api/auth/session', async () => {
  neonAuth.saveSession(null);
  let sessionRequestHeaders: Headers | null = null;
  const originalFetch = globalThis.fetch;

  (globalThis as any).fetch = async (input: any, init: any) => {
    if (String(input).includes('/api/auth/session')) {
      sessionRequestHeaders = new Headers(init?.headers || {});
      return new Response(JSON.stringify({ status: 'AUTHENTICATED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('{}', { status: 200 });
  };

  try {
    await ensureGuestSession(true);
    assert.ok(sessionRequestHeaders, 'POST /api/auth/session must be called');
    assert.equal(
      sessionRequestHeaders.get('X-Aira-Csrf-Protection'),
      '1',
      'POST /api/auth/session must attach X-Aira-Csrf-Protection: 1'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DEFECT 3 VERIFIED: explicit production origin passes when proxy host differs', () => {
  const req = {
    method: 'POST',
    headers: {
      host: 'internal-10-0-0-1.internal:3000',
      'x-forwarded-host': 'aira-ai-2026.vercel.app',
      origin: 'https://aira-ai-2026.vercel.app',
      'x-aira-csrf-protection': '1'
    }
  } as any;

  const verified = verifyCsrfAndOrigin(req);
  assert.equal(
    verified,
    true,
    'Requests matching x-forwarded-host must be recognized as same-origin by verifyCsrfAndOrigin'
  );
});

test('DEFECT 4 VERIFIED: Default trusted origins must include canonical production and staging origins', () => {
  const trusted = getTrustedOrigins();
  assert.ok(
    trusted.includes('https://aira-ai-2026.vercel.app'),
    'Default trusted origins must include https://aira-ai-2026.vercel.app'
  );
  assert.ok(
    trusted.includes('https://staging.virexaaiventures.com'),
    'Default trusted origins must include https://staging.virexaaiventures.com'
  );

  // Staging origin must pass isAllowedOrigin even with empty host
  assert.equal(
    isAllowedOrigin('https://staging.virexaaiventures.com'),
    true,
    'Staging domain must be recognized as allowed origin by default'
  );
});

test('DEFECT 5 VERIFIED: Authenticated mutating request with uncached CSRF token must ensure token resolution before dispatch', async () => {
  neonAuth.saveSession({
    user: { id: 'usr_auth_123', name: 'Auth User', email: 'auth@example.com' },
    token: 'bff_session'
  });
  neonAuth.setCsrfToken(null);
  assert.equal(neonAuth.isAuthenticated(), true);
  assert.equal(neonAuth.getCsrfToken(), null);

  const capturedHeaders: Headers[] = [];
  const originalFetch = globalThis.fetch;

  (globalThis as any).fetch = async (input: any, init: any) => {
    const url = String(input);
    if (url.includes('/api/auth/session')) {
      return new Response(JSON.stringify({
        status: 'AUTHENTICATED',
        user: { id: 'usr_auth_123', name: 'Auth User', email: 'auth@example.com' },
        csrfToken: 'resolved_csrf_token_xyz'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.includes('/api/chat/stream')) {
      capturedHeaders.push(new Headers(init?.headers || {}));
      return new Response('event: message\ndata: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }

    return new Response('{}', { status: 200 });
  };

  try {
    await authenticatedApiFetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Test' })
    });

    assert.equal(capturedHeaders.length, 1, 'Chat stream request should have been dispatched');
    const headers = capturedHeaders[0];
    assert.equal(
      headers.get('X-CSRF-Token'),
      'resolved_csrf_token_xyz',
      'Authenticated mutating request MUST attach resolved X-CSRF-Token'
    );
    assert.equal(
      headers.get('X-Aira-Csrf-Protection'),
      '1',
      'Authenticated mutating request must attach X-Aira-Csrf-Protection: 1'
    );
  } finally {
    globalThis.fetch = originalFetch;
    neonAuth.saveSession(null);
  }
});



test('Missing Origin and Fetch Metadata requires a custom header for guest mutations', () => {
  const base = { method: 'POST', headers: { host: 'internal:3000' } } as any;
  assert.equal(verifyCsrfAndOrigin(base), false);
  assert.equal(verifyCsrfAndOrigin({
    method: 'POST',
    headers: { host: 'internal:3000', 'x-aira-csrf-protection': '1' }
  } as any), true);
  assert.equal(verifyCsrfAndOrigin({
    method: 'POST',
    headers: { host: 'internal:3000', 'sec-fetch-site': 'cross-site', 'x-aira-csrf-protection': '1' }
  } as any), false);
});

test('Forged forwarded host cannot turn an untrusted Origin into an allowed origin', () => {
  const attackerOrigin = 'https://untrusted.example';
  assert.equal(isAllowedOrigin(attackerOrigin, 'untrusted.example'), false);
  assert.equal(verifyCsrfAndOrigin({
    method: 'POST',
    headers: {
      host: 'internal:3000',
      'x-forwarded-host': 'untrusted.example',
      origin: attackerOrigin,
      'sec-fetch-site': 'same-origin',
      'x-aira-csrf-protection': '1'
    }
  } as any), false);
});

test('Missing authenticated BFF CSRF token fails closed without dispatching inference', async () => {
  neonAuth.saveSession({
    user: { id: 'usr_auth_456', name: 'Auth User', email: 'auth@example.com' },
    token: 'bff_session'
  });
  neonAuth.setCsrfToken(null);
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;

  (globalThis as any).fetch = async (input: any) => {
    if (String(input).includes('/api/chat/stream')) inferenceCalls++;
    return new Response('{}', { status: 503 });
  };

  try {
    await assert.rejects(
      authenticatedApiFetch('/api/chat/stream', { method: 'POST', body: '{}' }),
      { name: 'AuthenticationRequiredError' }
    );
    assert.equal(inferenceCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    neonAuth.saveSession(null);
  }
});

test('Account switch clears the previous principal CSRF token', () => {
  neonAuth.saveSession({
    user: { id: 'usr_one', name: 'One', email: 'one@example.com' },
    token: 'bff_session',
    csrfToken: 'one_csrf_secret'
  });
  assert.equal(neonAuth.getCsrfToken(), 'one_csrf_secret');
  neonAuth.saveSession({
    user: { id: 'usr_two', name: 'Two', email: 'two@example.com' },
    token: 'bff_session'
  });
  assert.equal(neonAuth.getCsrfToken(), null);
  neonAuth.saveSession(null);
});


test('Authenticated BFF session without token never falls back to guest CSRF header', () => {
  const session = { userId: 'verified_user', csrfToken: '' } as any;
  assert.equal(verifyCsrfAndOrigin({
    method: 'POST',
    headers: {
      origin: 'https://aira-ai-2026.vercel.app',
      'sec-fetch-site': 'same-origin',
      'x-aira-csrf-protection': '1'
    }
  } as any, session), false);
});

test('Same authenticated principal losing CSRF proof erases previous token', () => {
  const user = { id: 'same_principal', name: 'Same User', email: 'same@example.test' };
  neonAuth.saveSession({ user, token: 'bff_session', csrfToken: 'prior_token' });
  assert.equal(neonAuth.getCsrfToken(), 'prior_token');
  neonAuth.saveSession({ user, token: 'bff_session' });
  assert.equal(neonAuth.getCsrfToken(), null);
  neonAuth.saveSession(null);
});
