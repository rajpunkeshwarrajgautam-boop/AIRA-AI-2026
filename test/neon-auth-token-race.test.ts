import assert from 'node:assert/strict';
import { NeonAuthClient, type NeonSessionData } from '../src/lib/neonAuth.js';

// Setup mock window and localStorage for node test runner
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function testTokenRefreshRaceAcrossAccounts() {
  console.log('Testing: In-flight token refresh for Account A must not bleed into Account B...');

  localStorage.clear();
  const client = new NeonAuthClient();

  const userA: NeonSessionData = {
    user: { id: 'usr_aaa_111', email: 'userA@example.com', name: 'User A' },
    token: 'session_token_A',
    jwt: 'jwt_expired_A',
    jwtExpiresAt: Date.now() - 1000 // Expired, triggers refresh
  };

  const userB: NeonSessionData = {
    user: { id: 'usr_bbb_222', email: 'userB@example.com', name: 'User B' },
    token: 'session_token_B',
    jwt: 'jwt_valid_B',
    jwtExpiresAt: Date.now() + 600000
  };

  // Set initial session for Account A
  (client as any).saveSession(userA);
  assert.equal(client.getCurrentUser()?.id, 'usr_aaa_111');

  // Deferred mock for fetchJwtToken
  const deferredA = createDeferred<{ token: string; expiresAt: number }>();
  let fetchCallCount = 0;

  (client as any).fetchJwtToken = async (sessionToken?: string) => {
    fetchCallCount++;
    if (sessionToken === 'session_token_A') {
      return deferredA.promise;
    }
    return { token: 'jwt_fresh_B', expiresAt: Date.now() + 600000 };
  };

  // 1. Account A initiates getValidJwt() - refresh begins in background
  const refreshPromiseA = client.getValidJwt();

  // 2. While refresh for Account A is pending, user logs out and switches to Account B
  (client as any).saveSession(userB);
  assert.equal(client.getCurrentUser()?.id, 'usr_bbb_222', 'Active user must now be User B');

  // 3. Deferred refresh for Account A resolves with Account A's newly minted JWT
  deferredA.resolve({
    token: 'jwt_new_minted_A',
    expiresAt: Date.now() + 300000
  });

  // Await the pending promise from step 1
  const resultA = await refreshPromiseA;

  // CRITICAL ASSERTION: The result must NOT be returned as valid for the new session
  // Nor must it be written to User B's session!
  const currentSessionB = client.getCurrentSession();
  assert.equal(currentSessionB?.user?.id, 'usr_bbb_222');
  assert.notEqual(
    currentSessionB?.jwt,
    'jwt_new_minted_A',
    'FAIL: Account A refreshed JWT was written into Account B session!'
  );

  // Stale refresh promise must not return Account A token to an active Account B context
  assert.notEqual(
    resultA,
    'jwt_new_minted_A',
    'FAIL: Stale Account A refresh promise returned Account A token across identity switch!'
  );

  console.log('  ✓ In-flight Account A refresh did not contaminate Account B');
}

async function testTokenRefreshDuringSignOut() {
  console.log('Testing: In-flight token refresh must not resurrect session after signOut...');

  localStorage.clear();
  const client = new NeonAuthClient();

  const userA: NeonSessionData = {
    user: { id: 'usr_aaa_111', email: 'userA@example.com', name: 'User A' },
    token: 'session_token_A',
    jwt: 'jwt_expired_A',
    jwtExpiresAt: Date.now() - 1000
  };

  (client as any).saveSession(userA);

  const deferred = createDeferred<{ token: string; expiresAt: number }>();
  (client as any).fetchJwtToken = async () => deferred.promise;

  // Initiate refresh
  const pendingRefresh = client.getValidJwt();

  // User signs out while in flight
  (client as any).saveSession(null);
  assert.equal(client.getCurrentUser(), null);

  // Deferred refresh resolves
  deferred.resolve({ token: 'jwt_resurrect_attempt', expiresAt: Date.now() + 300000 });
  const result = await pendingRefresh;

  // Session must remain null
  assert.equal(client.getCurrentSession(), null, 'Session must not be resurrected after sign out');
  assert.equal(result, null, 'Refresh promise must return null when user is signed out');
  console.log('  ✓ In-flight refresh did not resurrect signed-out session');
}

async function testNoCrossAccountRefreshCoalescing() {
  console.log('Testing: Multiple accounts cannot share the same in-flight refresh promise...');

  localStorage.clear();
  const client = new NeonAuthClient();

  const userA: NeonSessionData = {
    user: { id: 'usr_aaa_111', email: 'userA@example.com', name: 'User A' },
    token: 'session_token_A',
    jwtExpiresAt: 0
  };

  const userB: NeonSessionData = {
    user: { id: 'usr_bbb_222', email: 'userB@example.com', name: 'User B' },
    token: 'session_token_B',
    jwtExpiresAt: 0
  };

  (client as any).saveSession(userA);

  const deferredA = createDeferred<{ token: string; expiresAt: number }>();
  const deferredB = createDeferred<{ token: string; expiresAt: number }>();

  (client as any).fetchJwtToken = async (tok?: string) => {
    if (tok === 'session_token_A') return deferredA.promise;
    if (tok === 'session_token_B') return deferredB.promise;
    throw new Error('Unknown token');
  };

  // Account A starts refresh
  const promiseA = client.getValidJwt();

  // Switch to Account B
  (client as any).saveSession(userB);

  // Account B starts refresh
  const promiseB = client.getValidJwt();

  // Promises MUST NOT be identical (they are for different accounts!)
  assert.notEqual(promiseA, promiseB, 'Account B must not coalesce with Account A refresh promise');

  deferredA.resolve({ token: 'jwt_A', expiresAt: Date.now() + 300000 });
  deferredB.resolve({ token: 'jwt_B', expiresAt: Date.now() + 300000 });

  const [resA, resB] = await Promise.all([promiseA, promiseB]);
  assert.notEqual(resB, 'jwt_A', 'Account B must not receive Account A token');
  assert.equal(resB, 'jwt_B', 'Account B must receive its own token');
  console.log('  ✓ Cross-account refresh promises isolated correctly');
}

async function testAccountCycleIsolation() {
  console.log('Testing: Full cycle Account A → Account B → Guest → Account A under concurrent refresh...');

  localStorage.clear();
  const client = new NeonAuthClient();

  const userA: NeonSessionData = {
    user: { id: 'usr_aaa_111', email: 'userA@example.com', name: 'User A' },
    token: 'tok_A',
    jwt: 'jwt_expired_A',
    jwtExpiresAt: 0
  };

  const userB: NeonSessionData = {
    user: { id: 'usr_bbb_222', email: 'userB@example.com', name: 'User B' },
    token: 'tok_B',
    jwt: 'jwt_expired_B',
    jwtExpiresAt: 0
  };

  const deferredCycleA = createDeferred<{ token: string; expiresAt: number }>();
  (client as any).fetchJwtToken = async (tok?: string) => {
    if (tok === 'tok_A') return deferredCycleA.promise;
    return { token: 'jwt_fresh_B', expiresAt: Date.now() + 600000 };
  };

  // 1. Account A starts refresh
  (client as any).saveSession(userA);
  const cyclePromiseA = client.getValidJwt();

  // 2. Transition to Account B
  (client as any).saveSession(userB);
  assert.equal(client.getCurrentUser()?.id, 'usr_bbb_222');

  // 3. Transition to Guest (signOut)
  (client as any).saveSession(null);
  assert.equal(client.getCurrentUser(), null);
  assert.equal(client.isAuthenticated(), false);

  // Guest must never return an authenticated JWT
  const guestJwt = await client.getValidJwt();
  assert.equal(guestJwt, null, 'Guest session must return null JWT');

  // 4. Resolve Account A in-flight refresh while in Guest mode
  deferredCycleA.resolve({ token: 'jwt_leaked_A', expiresAt: Date.now() + 600000 });
  const cycleResultA = await cyclePromiseA;
  assert.equal(cycleResultA, null, 'Stale Account A refresh must resolve to null after transition to guest');
  assert.equal(client.getCurrentSession(), null, 'Guest state must not be corrupted by delayed Account A token');

  // 5. Transition back to Account A fresh
  const userAFresh: NeonSessionData = {
    user: { id: 'usr_aaa_111', email: 'userA@example.com', name: 'User A' },
    token: 'tok_A_fresh',
    jwt: 'jwt_new_A',
    jwtExpiresAt: Date.now() + 600000
  };
  (client as any).saveSession(userAFresh);
  assert.equal(client.getCurrentUser()?.id, 'usr_aaa_111');
  const freshJwt = await client.getValidJwt();
  assert.equal(freshJwt, 'jwt_new_A');

  console.log('  ✓ Account A → Account B → Guest → Account A cycle completed with zero contamination');
}

async function testProductionUrlFailClosed() {
  console.log('Testing: Production fail-closed behavior when VITE_NEON_AUTH_URL is missing...');

  const originalEnv = (globalThis as any).import?.meta?.env;
  // Instantiate client with empty baseUrl
  const client = new NeonAuthClient();
  client.setBaseUrl('');

  assert.equal(client.getBaseUrl(), '');

  await assert.rejects(
    async () => client.fetchJwtToken('dummy_token'),
    /unconfigured in production environment/
  );

  await assert.rejects(
    async () => client.getValidJwt(),
    /unconfigured in production environment/
  );

  console.log('  ✓ Production mode correctly fails closed when auth URL is unconfigured');
}

async function main() {
  console.log('\n=== AIRA AI 2026 — AUTH TOKEN REFRESH CONCURRENCY & RACE SUITE ===\n');
  await testTokenRefreshRaceAcrossAccounts();
  await testTokenRefreshDuringSignOut();
  await testNoCrossAccountRefreshCoalescing();
  await testAccountCycleIsolation();
  await testProductionUrlFailClosed();
  console.log('\nALL TOKEN REFRESH RACE CHECKS PASSED!\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Token refresh race test failed:', err);
  process.exit(1);
});
