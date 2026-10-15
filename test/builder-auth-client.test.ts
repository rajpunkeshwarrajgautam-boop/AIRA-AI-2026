import test from 'node:test';
import assert from 'node:assert/strict';
import { neonAuth } from '../src/lib/neonAuth.js';
import {
  builderStatus,
  streamBuilder,
  cancelBuilder,
  downloadBuilderFile
} from '../src/utils/builderClient.js';

test('DEFECT 1 RED: Authenticated session must NOT be clobbered by builderStatus or streamBuilder', async () => {
  const originalFetch = globalThis.fetch;
  let authSessionCallCount = 0;
  let builderStatusCallCount = 0;

  // Mock authenticated Neon user session
  neonAuth.saveSession({
    user: { id: 'usr_authenticated_principal', email: 'owner@example.com', name: 'Certified Owner' },
    token: 'bff_session',
    csrfToken: 'csrf_secret_token_12345'
  });

  assert.equal(neonAuth.isAuthenticated(), true, 'Precondition: user must be authenticated');
  const initialUser = neonAuth.getCurrentUser();
  assert.equal(initialUser?.id, 'usr_authenticated_principal');

  try {
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString();

      if (urlStr.includes('/api/auth/session')) {
        authSessionCallCount++;
        return new Response(JSON.stringify({ status: 'AUTHENTICATED', userId: 'usr_guest_clobber', sessionId: 'sess_guest' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (urlStr.includes('/api/builder/status')) {
        builderStatusCallCount++;
        return new Response(JSON.stringify({
          ready: true,
          enabled: true,
          allowed: true,
          configured: true,
          providerConfigured: true,
          reason: 'Ready',
          principalId: 'usr_authenticated_principal',
          temporaryMinutes: 15
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response('{}', { status: 200 });
    };

    const status = await builderStatus();
    assert.equal(status.ready, true);
    assert.equal(builderStatusCallCount, 1);

    // CRITICAL: Must NOT call /api/auth/session when user is already authenticated!
    assert.equal(authSessionCallCount, 0, 'DEFECT 1: /api/auth/session was called despite active authenticated session!');
    assert.equal(neonAuth.isAuthenticated(), true);
    assert.equal(neonAuth.getCurrentUser()?.id, 'usr_authenticated_principal');
  } finally {
    globalThis.fetch = originalFetch;
    neonAuth.saveSession(null);
  }
});

test('DEFECT 2 RED: Mutating Builder requests must attach CSRF protection headers via authenticatedApiFetch', async () => {
  const originalFetch = globalThis.fetch;
  let streamHeaders: Headers | null = null;
  let cancelHeaders: Headers | null = null;

  neonAuth.saveSession({
    user: { id: 'usr_csrf_tester', email: 'csrf@example.com', name: 'CSRF Tester' },
    token: 'bff_session',
    csrfToken: 'csrf_token_stream_cancel_abc'
  });

  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString();

      if (urlStr.includes('/api/builder/stream')) {
        streamHeaders = new Headers(init?.headers);
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode('event: builder.completed\ndata: {"summary":"Done"}\n\n'));
            c.close();
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }

      if (urlStr.includes('/api/builder/cancel')) {
        cancelHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ cancelled: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response('{}', { status: 200 });
    };

    // 1. streamBuilder must include X-CSRF-Token and X-Aira-Csrf-Protection
    const events: any[] = [];
    await streamBuilder({ prompt: 'test' }, new AbortController().signal, e => events.push(e));
    assert.ok(streamHeaders !== null, 'streamBuilder must make fetch call');
    assert.equal(
      streamHeaders.get('X-CSRF-Token'),
      'csrf_token_stream_cancel_abc',
      'DEFECT 2: streamBuilder missing X-CSRF-Token header'
    );
    assert.equal(
      streamHeaders.get('X-Aira-Csrf-Protection'),
      '1',
      'DEFECT 2: streamBuilder missing X-Aira-Csrf-Protection header'
    );

    // 2. cancelBuilder must include X-CSRF-Token and X-Aira-Csrf-Protection
    await cancelBuilder('test-ticket-xyz');
    assert.ok(cancelHeaders !== null, 'cancelBuilder must make fetch call');
    assert.equal(
      cancelHeaders.get('X-CSRF-Token'),
      'csrf_token_stream_cancel_abc',
      'DEFECT 2: cancelBuilder missing X-CSRF-Token header'
    );
    assert.equal(
      cancelHeaders.get('X-Aira-Csrf-Protection'),
      '1',
      'DEFECT 2: cancelBuilder missing X-Aira-Csrf-Protection header'
    );
  } finally {
    globalThis.fetch = originalFetch;
    neonAuth.saveSession(null);
  }
});

test('Unauthenticated user calls /api/auth/session to bootstrap guest session', async () => {
  const originalFetch = globalThis.fetch;
  let authSessionCalls = 0;

  neonAuth.saveSession(null);
  assert.equal(neonAuth.isAuthenticated(), false);

  try {
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString();

      if (urlStr.includes('/api/auth/session')) {
        authSessionCalls++;
        return new Response(JSON.stringify({ status: 'AUTHENTICATED', userId: 'usr_guest_bootstrap', sessionId: 'sess_guest' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (urlStr.includes('/api/builder/status')) {
        return new Response(JSON.stringify({
          ready: false,
          enabled: true,
          allowed: false,
          configured: true,
          providerConfigured: true,
          reason: 'Owner approval required',
          principalId: 'usr_guest_bootstrap',
          temporaryMinutes: 15
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response('{}', { status: 200 });
    };

    const status = await builderStatus();
    assert.equal(status.ready, false);
    assert.ok(authSessionCalls >= 1, 'Unauthenticated guest must bootstrap session via /api/auth/session');
  } finally {
    globalThis.fetch = originalFetch;
    neonAuth.saveSession(null);
  }
});

test('Revoked or expired BFF session fails fast before privileged Builder execution', async () => {
  const originalFetch = globalThis.fetch;

  neonAuth.saveSession({
    user: { id: 'usr_revoked_session', email: 'revoked@example.com', name: 'Revoked User' },
    token: 'bff_session',
    csrfToken: 'csrf_revoked_123'
  });

  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString();

      if (urlStr.includes('/api/builder/')) {
        return new Response(JSON.stringify({ error: 'A signed Aira session is required.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response('{}', { status: 200 });
    };

    // All Builder operations must fail immediately when session is rejected with 401
    await assert.rejects(builderStatus());
    await assert.rejects(streamBuilder({ prompt: 'test' }, new AbortController().signal, () => {}));
    await assert.rejects(cancelBuilder('revoked-ticket-token'));
    await assert.rejects(downloadBuilderFile('/api/builder/download?ticket=revoked-ticket', 'test.txt'));
  } finally {
    globalThis.fetch = originalFetch;
    neonAuth.saveSession(null);
  }
});

