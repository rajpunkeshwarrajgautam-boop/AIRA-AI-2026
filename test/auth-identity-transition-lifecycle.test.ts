/**
 * AIRA AI 2026 — End-to-End Identity Transition Lifecycle & Revocation Suite
 * 
 * Deterministic regression tests covering:
 * 1. Account switching during API dispatch (pre-dispatch).
 * 2. In-flight network request abort and response discard on account switch.
 * 3. Guest-to-account transition during guest session bootstrap.
 * 4. Local session purge resilience under remote logout failure.
 * 5. Session restoration rejection and localStorage purge after server-side revocation.
 * 6. Production fail-closed Auth URL configuration.
 */

import assert from 'node:assert/strict';
import {
  NeonAuthClient,
  type NeonSessionData,
  AuthenticationRequiredError,
  authenticatedApiFetch
} from '../src/lib/neonAuth.js';

// Setup mock browser environment
if (typeof globalThis.window === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).window = {
    addEventListener: () => {},
    location: { origin: 'http://localhost:5173' }
  };
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, val: string) => store.set(key, val),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] || null,
    get length() { return store.size; }
  };
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function testAccountSwitchDuringApiDispatch() {
  console.log('Testing: Account switching during API dispatch must abort pre-fetch...');

  const { neonAuth } = await import('../src/lib/neonAuth.js');
  const originalGetValidJwt = neonAuth.getValidJwt;
  const originalFetch = globalThis.fetch;
  localStorage.clear();

  try {
    // 1. Log in Account A
    const sessionA: NeonSessionData = {
      user: { id: 'usr_account_A', email: 'a@example.com', name: 'User A' },
      token: 'tok_session_A',
      jwt: 'jwt_A_initial',
      jwtExpiresAt: Date.now() + 300_000
    };
    (neonAuth as any).saveSession(sessionA);

    // 2. Control getValidJwt to defer resolution
    const jwtDeferred = defer<string | null>();
    (neonAuth as any).getValidJwt = () => jwtDeferred.promise;

    const fetchCalls: Array<{ url: string; headers: any }> = [];
    (globalThis as any).fetch = async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), headers: init?.headers });
      return new Response(JSON.stringify({ data: 'secret_A' }), { status: 200 });
    };

    // 3. Initiate request under Account A
    const requestPromise = authenticatedApiFetch('/api/conversations', { method: 'GET' });

    // 4. While awaiting JWT, user switches to Account B
    const sessionB: NeonSessionData = {
      user: { id: 'usr_account_B', email: 'b@example.com', name: 'User B' },
      token: 'tok_session_B',
      jwt: 'jwt_B_valid',
      jwtExpiresAt: Date.now() + 300_000
    };
    (neonAuth as any).saveSession(sessionB);

    // 5. Now resolve Account A's pending JWT
    jwtDeferred.resolve('jwt_A_refreshed');

    // 6. Request must fail-closed with AuthenticationRequiredError
    await assert.rejects(
      async () => requestPromise,
      (err: any) => {
        assert(err instanceof AuthenticationRequiredError);
        assert(/transitioned/i.test(err.message));
        return true;
      }
    );

    // Assert ZERO requests were sent with Account A credentials
    assert.equal(fetchCalls.length, 0, 'Must NOT dispatch HTTP request when identity changed during token resolution');
    console.log('  ✓ Pre-dispatch identity transition prevented contaminated request dispatch');
  } finally {
    (neonAuth as any).getValidJwt = originalGetValidJwt;
    globalThis.fetch = originalFetch;
  }
}

async function testResponseArrivalAfterAccountSwitching() {
  console.log('Testing: Response arriving after identity switch must be discarded...');

  const { neonAuth } = await import('../src/lib/neonAuth.js');
  const originalGetValidJwt = neonAuth.getValidJwt;
  const originalFetch = globalThis.fetch;
  localStorage.clear();

  try {
    // Log in Account A
    const sessionA: NeonSessionData = {
      user: { id: 'usr_account_A', email: 'a@example.com', name: 'User A' },
      token: 'tok_session_A',
      jwt: 'jwt_A',
      jwtExpiresAt: Date.now() + 300_000
    };
    (neonAuth as any).saveSession(sessionA);
    (neonAuth as any).getValidJwt = async () => 'jwt_A';

    // Defer network response
    const networkDeferred = defer<Response>();
    let capturedSignal: AbortSignal | undefined;

    (globalThis as any).fetch = async (_url: any, init: any) => {
      capturedSignal = init?.signal;
      return networkDeferred.promise;
    };

    // Start request
    const requestPromise = authenticatedApiFetch('/api/conversations/sync', { method: 'GET' });

    // Yield to allow async getValidJwt to resolve and fetch to be dispatched
    await new Promise(r => setTimeout(r, 10));

    // While request is in-flight on the wire, Account A logs out
    assert(capturedSignal, 'Signal must be attached to in-flight request');
    (neonAuth as any).saveSession(null);

    // The in-flight AbortController should have been triggered
    assert.equal(capturedSignal.aborted, true, 'In-flight request signal must be aborted on session change');

    // Resolve network response (simulating delayed arrival)
    networkDeferred.resolve(new Response(JSON.stringify({ privateData: 'account_A_chats' }), { status: 200 }));

    // Caller must reject and NOT receive Account A data
    await assert.rejects(
      async () => requestPromise,
      (err: any) => {
        assert(err instanceof AuthenticationRequiredError);
        return true;
      }
    );

    console.log('  ✓ In-flight network response discarded and aborted on identity change');
  } finally {
    (neonAuth as any).getValidJwt = originalGetValidJwt;
    globalThis.fetch = originalFetch;
  }
}

async function testGuestToAccountTransitionDuringBootstrap() {
  console.log('Testing: Guest-to-account transition during session bootstrap...');

  const { neonAuth } = await import('../src/lib/neonAuth.js');
  const originalGetValidJwt = neonAuth.getValidJwt;
  const originalFetch = globalThis.fetch;
  localStorage.clear();
  (neonAuth as any).saveSession(null);
  assert.equal(neonAuth.isAuthenticated(), false);

  try {
    const bootstrapDeferred = defer<Response>();
    const fetchCalls: Array<{ url: string; headers: any }> = [];

    (globalThis as any).fetch = async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), headers: init?.headers });
      if (String(url) === '/api/auth/session') {
        return bootstrapDeferred.promise;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    // Start guest request
    const guestRequestPromise = authenticatedApiFetch('/api/knowledge', { method: 'GET' });

    // Yield to allow ensureGuestSession to initiate /api/auth/session fetch
    await new Promise(r => setTimeout(r, 10));

    // While /api/auth/session is in flight, user signs in to Account A!
    const sessionA: NeonSessionData = {
      user: { id: 'usr_account_A', email: 'a@example.com', name: 'User A' },
      token: 'tok_session_A',
      jwt: 'jwt_A',
      jwtExpiresAt: Date.now() + 300_000
    };
    (neonAuth as any).saveSession(sessionA);
    (neonAuth as any).getValidJwt = async () => 'jwt_A';

    // Bootstrap completes
    bootstrapDeferred.resolve(new Response(JSON.stringify({ status: 'AUTHENTICATED' }), { status: 200 }));

    // The request should re-route cleanly as Account A with Authorization header
    const res = await guestRequestPromise;
    assert.equal(res.status, 200);

    const knowledgeCall = fetchCalls.find(c => c.url.includes('/api/knowledge'));
    assert(knowledgeCall, 'API call must be dispatched');
    const authHeader = (knowledgeCall.headers instanceof Headers)
      ? knowledgeCall.headers.get('Authorization')
      : knowledgeCall.headers?.['Authorization'];
    assert.equal(authHeader, 'Bearer jwt_A', 'Must attach Account A JWT, NOT execute as unauthenticated guest');

    console.log('  ✓ Guest bootstrap safely pivoted to authenticated account request');
  } finally {
    (neonAuth as any).getValidJwt = originalGetValidJwt;
    globalThis.fetch = originalFetch;
  }
}

async function testRemoteLogoutFailureResilience() {
  console.log('Testing: Remote logout failure does not prevent local session purge...');

  const { neonAuth } = await import('../src/lib/neonAuth.js');
  const originalFetch = globalThis.fetch;
  localStorage.clear();

  try {
    const sessionA: NeonSessionData = {
      user: { id: 'usr_account_A', email: 'a@example.com', name: 'User A' },
      token: 'tok_session_A',
      jwt: 'jwt_A',
      jwtExpiresAt: Date.now() + 300_000
    };
    (neonAuth as any).saveSession(sessionA);
    assert.equal(neonAuth.isAuthenticated(), true);

    // Mock remote signout failing with 500
    (globalThis as any).fetch = async (url: any) => {
      if (String(url).includes('/sign-out')) {
        return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const result = await neonAuth.signOut();
    assert.equal(result.remoteSuccess, false, 'Remote success must report false');
    assert(/500/.test(result.error || ''), 'Error must report HTTP 500');

    // Verify local session is STILL strictly purged
    assert.equal(neonAuth.isAuthenticated(), false, 'User must be signed out locally');
    assert.equal(neonAuth.getCurrentSession(), null, 'Session must be null');
    assert.equal(localStorage.getItem('aira_neon_auth_session_v1'), null, 'LocalStorage must be cleared');

    console.log('  ✓ Remote logout failure safely handled with full local session purge');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testSessionRestorationRejectionAfterRevocation() {
  console.log('Testing: Restoring a revoked session from localStorage is rejected and purged...');

  const { neonAuth } = await import('../src/lib/neonAuth.js');
  const originalFetch = globalThis.fetch;
  localStorage.clear();

  try {
    const sessionA: NeonSessionData = {
      user: { id: 'usr_account_A', email: 'a@example.com', name: 'User A' },
      token: 'tok_revoked_session',
      jwt: 'jwt_expired',
      jwtExpiresAt: 0
    };

    // Stale/restored session injected into localStorage
    localStorage.setItem('aira_neon_auth_session_v1', JSON.stringify(sessionA));

    // Reload stored session into client
    (neonAuth as any).currentSession = (neonAuth as any).loadStoredSession();
    assert.equal(neonAuth.isAuthenticated(), true);

    // Mock server returning 401 when attempting to refresh/obtain JWT using revoked session token
    (globalThis as any).fetch = async (url: any) => {
      if (String(url).includes('/token')) {
        return new Response(JSON.stringify({ error: 'Session has been revoked or expired' }), {
          status: 401,
          statusText: 'Unauthorized'
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    // Attempt to make authenticated call
    await assert.rejects(
      async () => authenticatedApiFetch('/api/conversations', { method: 'GET' }),
      (err: any) => {
        assert(err instanceof AuthenticationRequiredError);
        return true;
      }
    );

    // Verify that the invalid/revoked session was purged from localStorage
    assert.equal(neonAuth.isAuthenticated(), false, 'Session must be marked unauthenticated');
    assert.equal(localStorage.getItem('aira_neon_auth_session_v1'), null, 'LocalStorage must be purged on 401 revocation');

    console.log('  ✓ Revoked session restoration correctly fails closed and purges storage');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testProductionAuthUrlFailClosed() {
  console.log('Testing: Production mode fails closed when VITE_NEON_AUTH_URL is missing...');

  const client = new NeonAuthClient();
  client.setBaseUrl('');

  await assert.rejects(
    async () => client.fetchJwtToken('tok'),
    (err: any) => {
      assert(/missing VITE_NEON_AUTH_URL/i.test(err.message));
      return true;
    }
  );

  await assert.rejects(
    async () => client.getValidJwt(),
    (err: any) => {
      assert(/missing VITE_NEON_AUTH_URL/i.test(err.message));
      return true;
    }
  );

  console.log('  ✓ Unconfigured production Auth URL fails closed');
}

async function testSameAccountJwtRefreshDoesNotAbortLegitimateRequest() {
  console.log('Testing: Real JWT refresh on same account must not abort legitimate request...');

  const { neonAuth } = await import('../src/lib/neonAuth.js');
  const originalFetchJwtToken = neonAuth.fetchJwtToken;
  const originalFetch = globalThis.fetch;
  localStorage.clear();

  try {
    const session: NeonSessionData = {
      user: { id: 'usr_refresh_user', email: 'refresh@example.com', name: 'Refresh User' },
      token: 'tok_refresh_session',
      jwt: undefined, // Requires refresh
      jwtExpiresAt: undefined
    };
    (neonAuth as any).saveSession(session);

    (neonAuth as any).fetchJwtToken = async () => {
      return { token: 'jwt_refreshed_valid', expiresAt: Date.now() + 600_000 };
    };

    let endpointReached = false;
    (globalThis as any).fetch = async (url: any, init: any) => {
      if (String(url) === '/api/user/profile') {
        endpointReached = true;
        assert.equal(init?.headers?.get('Authorization'), 'Bearer jwt_refreshed_valid');
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await authenticatedApiFetch('/api/user/profile', { method: 'GET' });
    assert.equal(res.status, 200);
    assert.equal(endpointReached, true, 'API endpoint must be reached after same-account JWT refresh');
    console.log('  ✓ Real JWT refresh on same account succeeded without aborting dispatch');
  } finally {
    (neonAuth as any).fetchJwtToken = originalFetchJwtToken;
    globalThis.fetch = originalFetch;
  }
}

async function testDelayed401DoesNotClearActiveAccountB() {
  console.log('Testing: Delayed 401 rejection from Account A must not wipe Account B or guest...');

  const { neonAuth } = await import('../src/lib/neonAuth.js');
  const originalFetchJwtToken = neonAuth.fetchJwtToken;
  localStorage.clear();

  try {
    // 1. Account A logs in
    const sessionA: NeonSessionData = {
      user: { id: 'usr_A', email: 'a@example.com', name: 'User A' },
      token: 'tok_A',
      jwt: undefined,
      jwtExpiresAt: undefined
    };
    (neonAuth as any).saveSession(sessionA);

    // 2. Account A initiates refresh that gets deferred
    const tokenDeferred = defer<{ token: string; expiresAt: number }>();
    (neonAuth as any).fetchJwtToken = () => tokenDeferred.promise;

    const refreshPromise = neonAuth.getValidJwt();

    // 3. User switches to Account B
    const sessionB: NeonSessionData = {
      user: { id: 'usr_B', email: 'b@example.com', name: 'User B' },
      token: 'tok_B',
      jwt: 'jwt_B_valid',
      jwtExpiresAt: Date.now() + 600_000
    };
    (neonAuth as any).saveSession(sessionB);
    assert.equal(neonAuth.getCurrentUser()?.id, 'usr_B');

    // 4. Account A's deferred refresh rejects with 401
    tokenDeferred.reject(new Error('Failed to obtain JWT token (401): session revoked'));
    await refreshPromise;

    // 5. Account B must remain completely intact
    assert.equal(neonAuth.getCurrentUser()?.id, 'usr_B', 'Account B must not be cleared by delayed 401 from Account A');
    assert.equal(neonAuth.getCurrentSession()?.token, 'tok_B', 'Account B token must remain active');
    console.log('  ✓ Delayed 401 from obsolete session safely discarded without wiping active session');
  } finally {
    (neonAuth as any).fetchJwtToken = originalFetchJwtToken;
  }
}

async function testStreamCancellationAndChunkDiscardOnIdentitySwitch() {
  console.log('Testing: SSE streaming request cancels and suppresses callbacks on identity transition...');

  const { neonAuth } = await import('../src/lib/neonAuth.js');
  const { streamAIResponse } = await import('../src/utils/aiEngine.js');
  const originalFetch = globalThis.fetch;
  localStorage.clear();

  try {
    const sessionA: NeonSessionData = {
      user: { id: 'usr_stream_A', email: 'stream@example.com', name: 'Stream User A' },
      token: 'tok_stream_A',
      jwt: 'jwt_stream_A',
      jwtExpiresAt: Date.now() + 600_000
    };
    (neonAuth as any).saveSession(sessionA);

    const chunkDeferred1 = defer<string>();
    const chunkDeferred2 = defer<string>();

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ text: 'Chunk 1 ' })}\n\n`));
        await chunkDeferred1.promise;
        controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ text: 'Chunk 2 ' })}\n\n`));
        await chunkDeferred2.promise;
        controller.enqueue(new TextEncoder().encode(`event: done\ndata: [DONE]\n\n`));
        controller.close();
      }
    });

    (globalThis as any).fetch = async (url: any) => {
      if (String(url) === '/api/chat/stream') {
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const chunks: string[] = [];
    let completed = false;

    const streamPromise = streamAIResponse(
      'Test',
      [],
      'claude-3-7-sonnet',
      { extendedThinking: false, persistentMemoryEnabled: false } as any,
      undefined,
      {
        onContentChunk: (c) => chunks.push(c),
        onComplete: () => { completed = true; },
        onError: () => {}
      }
    );

    // Allow chunk 1 to arrive
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(chunks, ['Chunk 1 ']);

    // User switches accounts or logs out mid-stream
    (neonAuth as any).saveSession(null);

    // Release downstream chunks
    chunkDeferred1.resolve('go');
    chunkDeferred2.resolve('go');

    await streamPromise;

    assert.equal(chunks.length, 1, 'Subsequent chunks after logout must be discarded');
    assert.equal(completed, false, 'onComplete must not be invoked for an obsolete session');
    console.log('  ✓ Stream safely aborted and obsolete chunks discarded on identity transition');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  console.log('\n=== AIRA AI 2026 — IDENTITY TRANSITION & REVOCATION SUITE ===\n');

  try {
    await testAccountSwitchDuringApiDispatch();
    await testResponseArrivalAfterAccountSwitching();
    await testGuestToAccountTransitionDuringBootstrap();
    await testRemoteLogoutFailureResilience();
    await testSessionRestorationRejectionAfterRevocation();
    await testProductionAuthUrlFailClosed();
    await testSameAccountJwtRefreshDoesNotAbortLegitimateRequest();
    await testDelayed401DoesNotClearActiveAccountB();
    await testStreamCancellationAndChunkDiscardOnIdentitySwitch();

    console.log('\nALL 9 IDENTITY TRANSITION & REVOCATION CHECKS PASSED!\n');
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED IDENTITY TRANSITION CHECK:', err);
    process.exit(1);
  }
}

main();
