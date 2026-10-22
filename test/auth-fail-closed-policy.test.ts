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

async function testAuthenticatedUserNeverFallsBackToGuestOnJwtFailure() {
  console.log('Testing: Authenticated user must fail-closed if JWT retrieval fails (no guest downgrade)...');

  const { neonAuth } = await import('../src/lib/neonAuth.js');
  localStorage.clear();

  // Set an active managed session
  const user: NeonSessionData = {
    user: { id: 'usr_managed_123', email: 'managed@example.com', name: 'Managed User' },
    token: 'tok_active_session',
    jwt: 'jwt_expired',
    jwtExpiresAt: 0 // Expired
  };
  (neonAuth as any).saveSession(user);
  assert.equal(neonAuth.isAuthenticated(), true);

  // Mock getValidJwt to return null (e.g. refresh failed, network offline, or token revoked)
  (neonAuth as any).getValidJwt = async () => null;

  // Track fetch calls
  const fetchCalls: Array<{ url: string; headers: any }> = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), headers: init?.headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  // Attempt API request
  await assert.rejects(
    async () => authenticatedApiFetch('/api/chat/stream', { method: 'POST' }),
    (err: any) => {
      assert(err instanceof AuthenticationRequiredError, 'Error must be AuthenticationRequiredError');
      assert(/expired|invalid|re-authentication/i.test(err.message));
      return true;
    }
  );

  // Assert ZERO requests were sent to the server (neither to /api/auth/session nor /api/chat/stream)
  assert.equal(fetchCalls.length, 0, 'No requests must be dispatched if account JWT retrieval failed!');
  console.log('  ✓ Authenticated user correctly failed closed without silent guest fallback');
}

async function testAuthenticatedUserFailsClosedOnServer401() {
  console.log('Testing: Authenticated user must fail closed on 401 without guest fallback...');

  const { neonAuth } = await import('../src/lib/neonAuth.js');
  localStorage.clear();

  const user: NeonSessionData = {
    user: { id: 'usr_managed_123', email: 'managed@example.com', name: 'Managed User' },
    token: 'tok_active_session',
    jwt: 'jwt_valid',
    jwtExpiresAt: Date.now() + 600000
  };
  (neonAuth as any).saveSession(user);
  (neonAuth as any).getValidJwt = async () => 'jwt_valid';

  const fetchCalls: Array<{ url: string; headers: any }> = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), headers: init?.headers });
    if (String(url) === '/api/auth/session') {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }
    // Server rejects token
    return new Response(JSON.stringify({ error: 'Token revoked or invalid' }), { status: 401 });
  };

  await assert.rejects(
    async () => authenticatedApiFetch('/api/conversations', { method: 'GET' }),
    (err: any) => {
      assert(err instanceof AuthenticationRequiredError, 'Must throw AuthenticationRequiredError on 401');
      return true;
    }
  );

  // Verify that /api/auth/session was NEVER called to downgrade to guest
  const sessionBootstrapCalls = fetchCalls.filter(c => c.url.includes('/api/auth/session'));
  assert.equal(sessionBootstrapCalls.length, 0, 'Must NEVER call /api/auth/session to bootstrap guest for authenticated user');
  console.log('  ✓ Server 401 rejected with AuthenticationRequiredError; zero guest bootstrapping');
}

async function testGuestUserMaintainsGuestSession() {
  console.log('Testing: Guest user properly bootstraps and maintains guest session...');

  const { neonAuth } = await import('../src/lib/neonAuth.js');
  localStorage.clear();
  (neonAuth as any).saveSession(null);
  assert.equal(neonAuth.isAuthenticated(), false);

  const fetchCalls: Array<{ url: string; headers: any }> = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), headers: init?.headers });
    if (String(url) === '/api/auth/session') {
      return new Response(JSON.stringify({ status: 'session_bootstrapped' }), { status: 200 });
    }
    return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
  };

  const res = await authenticatedApiFetch('/api/conversations', { method: 'GET' });
  assert.equal(res.status, 200);

  // Verify guest bootstrap happened
  const sessionCalls = fetchCalls.filter(c => c.url.includes('/api/auth/session'));
  assert(sessionCalls.length >= 1, 'Guest user must bootstrap session');

  // Verify request did not contain Authorization header
  const dataCall = fetchCalls.find(c => c.url.includes('/api/conversations'));
  assert(dataCall);
  const authHeader = (dataCall.headers instanceof Headers)
    ? dataCall.headers.get('Authorization')
    : dataCall.headers?.['Authorization'];
  assert(!authHeader, 'Guest user request must not contain Authorization header');
  console.log('  ✓ Guest user successfully routed through guest session pipeline');
}

async function main() {
  console.log('\n=== AIRA AI 2026 — AUTHENTICATED FAIL-CLOSED POLICY SUITE ===\n');
  await testAuthenticatedUserNeverFallsBackToGuestOnJwtFailure();
  await testAuthenticatedUserFailsClosedOnServer401();
  await testGuestUserMaintainsGuestSession();
  console.log('\nALL FAIL-CLOSED POLICY CHECKS PASSED!\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Fail-closed policy test failed:', err);
  process.exit(1);
});
