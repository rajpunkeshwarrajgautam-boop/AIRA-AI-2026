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

async function main() {
  console.log('\n=== AIRA AI 2026 — IDENTITY TRANSITION & REVOCATION SUITE ===\n');

  try {
    await testAccountSwitchDuringApiDispatch();
    await testResponseArrivalAfterAccountSwitching();
    await testGuestToAccountTransitionDuringBootstrap();
    await testRemoteLogoutFailureResilience();
    await testSessionRestorationRejectionAfterRevocation();
    await testProductionAuthUrlFailClosed();

    console.log('\nALL IDENTITY TRANSITION & REVOCATION CHECKS PASSED!\n');
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED IDENTITY TRANSITION CHECK:', err);
    process.exit(1);
  }
}

main();
