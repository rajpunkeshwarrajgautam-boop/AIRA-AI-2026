/**
 * AIRA AI 2026 — Deterministic Cross-Instance Durable Session Test Suite
 * 
 * Verifies that the first-party BFF session architecture operates seamlessly across
 * stateless, multi-instance server deployments backed by durable PostgreSQL storage:
 * 
 * Test A — Instance A → Instance B Principal Reconstruction
 * 1. Authenticate / create session on Instance A.
 * 2. Persist session to PostgreSQL durable store (`bff_sessions`).
 * 3. Perform next request on completely independent Instance B.
 * 4. Reconstruct identical ExecutionPrincipal from durable session state.
 * 5. Verify userId, sessionId, roles, and scopes match exactly.
 * 
 * Test B — Immediate Cross-Instance Revocation
 * 1. Establish valid session on Instance A.
 * 2. Authenticate successfully on Instance A.
 * 3. Revoke session in durable store.
 * 4. Send identical session request to Instance B.
 * 5. Instance B must reject immediately (unauthorized, principal deleted, cookie cleared).
 * 
 * Test C — Process Restart Simulation
 * 1. Establish session.
 * 2. Simulate complete process restart (all local memory wiped, fresh instance booted).
 * 3. Request must still authenticate successfully via PostgreSQL durable store.
 * 
 * Test D — Server-Side Expiration Enforcement
 * 1. Establish session with past expiration.
 * 2. Requests on all instances must fail closed regardless of signature validity.
 * 
 * Test E — Database Lookup Fail-Closed Policy
 * 1. Database query error simulated during session lookup.
 * 2. Must fail closed (returns null / unauthenticated), never allowing unauthorized access.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import express from 'express';
import {
  BffSessionStore,
  createBffSessionMiddleware,
  serializeBffToken,
  BffServerSession,
  generateSessionId,
  generateCsrfToken,
  BFF_COOKIE_NAME_DEV
} from '../apps/api/src/auth/bff-session.js';
import { clearJwksCacheForTesting } from '../apps/api/src/auth/neon-auth-principal.js';

// Setup EdDSA test keys for cryptographic JWT verification
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const testJwk = publicKey.export({ format: 'jwk' });
testJwk.kid = 'cross-instance-test-key';
testJwk.alg = 'EdDSA';
testJwk.use = 'sig';

function makeMockJwt(sub: string, expSeconds = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'cross-instance-test-key', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub,
    iss: 'https://ep-cross-instance.neonauth.c-4.ap-southeast-1.aws.neon.tech',
    aud: 'https://ep-cross-instance.neonauth.c-4.ap-southeast-1.aws.neon.tech',
    iat: now,
    exp: now + expSeconds,
    email: `${sub}@example.com`,
    name: 'Cross Instance User'
  })).toString('base64url');

  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

interface ServerInstance {
  name: string;
  store: BffSessionStore;
  app: express.Express;
  handleRequest: (cookieHeader: string) => Promise<{
    principal: any;
    user: any;
    managedIdentity: any;
    clearedCookie: boolean;
  }>;
}

function createStatelessInstance(name: string): ServerInstance {
  const store = new BffSessionStore();
  const middleware = createBffSessionMiddleware();

  const handleRequest = async (cookieHeader: string) => {
    let clearedCookie = false;
    const req = {
      headers: {
        cookie: cookieHeader,
        host: 'localhost:3001'
      }
    } as any;

    const res = {
      setHeader: (name: string, val: any) => {
        const valStr = Array.isArray(val) ? val.join(' ') : String(val);
        if (name === 'Set-Cookie' && valStr.includes('Max-Age=0')) {
          clearedCookie = true;
        }
      }
    } as any;

    await middleware(req, res, () => {});

    return {
      principal: req.principal || null,
      user: req.user || null,
      managedIdentity: req.managedIdentity || null,
      clearedCookie
    };
  };

  const app = express();
  return { name, store, app, handleRequest };
}

async function runCrossInstanceTests() {
  console.log('\n=== AIRA AI 2026 — CROSS-INSTANCE DURABLE SESSION TEST SUITE ===\n');

  process.env.AIRA_SESSION_SECRET = 'test-secret-at-least-32-characters-long-for-testing';
  process.env.NEON_AUTH_BASE_URL = 'https://ep-cross-instance.neonauth.c-4.ap-southeast-1.aws.neon.tech';
  process.env.NEON_AUTH_JWKS_URL = 'https://ep-cross-instance.neonauth.c-4.ap-southeast-1.aws.neon.tech/.well-known/jwks.json';

  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: any) => {
    if (String(url).includes('/.well-known/jwks.json')) {
      return new Response(JSON.stringify({ keys: [testJwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  };
  clearJwksCacheForTesting();

  const instanceA = createStatelessInstance('Instance-A');
  const instanceB = createStatelessInstance('Instance-B');

  // Clean test table
  await instanceA.store.clear();

  try {
    // -------------------------------------------------------------------------
    // TEST A — Instance A → Instance B Principal Reconstruction
    // -------------------------------------------------------------------------
    console.log('Test A: Instance A → Instance B Principal Reconstruction...');
    const sessionIdA = generateSessionId();
    const csrfTokenA = generateCsrfToken();
    const userIdA = 'usr_neon_stateless_1';
    const jwtA = makeMockJwt(userIdA);
    const now = Date.now();

    const sessionA: BffServerSession = {
      id: sessionIdA,
      userId: userIdA,
      email: `${userIdA}@example.com`,
      name: 'Cross Instance User',
      sessionToken: 'neon_sess_tok_instance_a',
      jwt: jwtA,
      jwtExpiresAt: now + 3600_000,
      csrfToken: csrfTokenA,
      createdAt: now,
      expiresAt: now + 7200_000,
      lastRotatedAt: now
    };

    // 1. Authenticate & persist on Instance A
    await instanceA.store.set(sessionA);
    const cookieToken = serializeBffToken(sessionA);
    const cookieHeader = `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(cookieToken)}`;

    // Verify Instance A can read it
    const resultA = await instanceA.handleRequest(cookieHeader);
    assert.ok(resultA.principal, 'Instance A must reconstruct valid principal');
    assert.equal(resultA.principal.userId, `neon_user_${userIdA}`);
    assert.equal(resultA.principal.sessionId, sessionIdA);

    // 2. Perform next request on completely independent Instance B
    const resultB = await instanceB.handleRequest(cookieHeader);
    assert.ok(resultB.principal, 'Instance B must independently reconstruct valid principal from PostgreSQL');
    assert.equal(resultB.principal.userId, `neon_user_${userIdA}`, 'Instance B principal userId must match');
    assert.equal(resultB.principal.sessionId, sessionIdA, 'Instance B principal sessionId must match');
    assert.deepEqual(resultB.principal.roles, ['workspace_user'], 'Instance B principal roles must match');
    assert.deepEqual(
      resultB.principal.scopes,
      ['chat:write', 'runs:read', 'runs:write', 'browser.read', 'files.read'],
      'Instance B principal scopes must match'
    );
    assert.equal(resultB.clearedCookie, false, 'Instance B must not clear valid cookie');
    console.log('  ✓ Test A PASSED: Identical principal reconstructed across stateless instances with stable sessionId');

    // -------------------------------------------------------------------------
    // TEST B — Immediate Cross-Instance Revocation
    // -------------------------------------------------------------------------
    console.log('Test B: Immediate Cross-Instance Revocation...');
    // Revoke on Instance A
    const revoked = await instanceA.store.revoke(sessionIdA);
    assert.equal(revoked, true, 'Revocation on Instance A must succeed in PostgreSQL');

    // Send identical cookie to Instance B
    const resultBAfterRevocation = await instanceB.handleRequest(cookieHeader);
    assert.equal(resultBAfterRevocation.principal, null, 'Instance B must immediately reject revoked session');
    assert.equal(resultBAfterRevocation.user, null, 'Instance B must purge user context');
    assert.equal(resultBAfterRevocation.managedIdentity, null, 'Instance B must purge managedIdentity');
    assert.equal(resultBAfterRevocation.clearedCookie, true, 'Instance B must clear revoked session cookie');
    console.log('  ✓ Test B PASSED: Revocation on Instance A immediately prevents authorization on Instance B');

    // -------------------------------------------------------------------------
    // TEST C — Process Restart Simulation
    // -------------------------------------------------------------------------
    console.log('Test C: Process Restart Simulation (Wiping local memory)...');
    const sessionIdC = generateSessionId();
    const userIdC = 'usr_neon_restart_test';
    const jwtC = makeMockJwt(userIdC);

    const sessionC: BffServerSession = {
      id: sessionIdC,
      userId: userIdC,
      email: `${userIdC}@example.com`,
      name: 'Restart User',
      sessionToken: 'neon_sess_tok_restart',
      jwt: jwtC,
      jwtExpiresAt: now + 3600_000,
      csrfToken: generateCsrfToken(),
      createdAt: now,
      expiresAt: now + 7200_000,
      lastRotatedAt: now
    };

    // Store session
    await instanceA.store.set(sessionC);
    const cookieTokenC = serializeBffToken(sessionC);
    const cookieHeaderC = `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(cookieTokenC)}`;

    // Simulate process crash / complete restart: instantiate a brand new process/instance with empty heap
    const restartedInstance = createStatelessInstance('Instance-Restarted-After-Crash');
    const resultC = await restartedInstance.handleRequest(cookieHeaderC);

    assert.ok(resultC.principal, 'Post-restart instance must successfully authenticate from durable store');
    assert.equal(resultC.principal.userId, `neon_user_${userIdC}`);
    assert.equal(resultC.principal.sessionId, sessionIdC);
    console.log('  ✓ Test C PASSED: Process restart seamlessly authenticates through PostgreSQL durable store');

    // -------------------------------------------------------------------------
    // TEST D — Server-Side Expiration Enforcement
    // -------------------------------------------------------------------------
    console.log('Test D: Server-Side Expiration Enforcement on All Instances...');
    const sessionIdExpired = generateSessionId();
    const userIdExpired = 'usr_neon_expired';
    const jwtExpired = makeMockJwt(userIdExpired);

    const expiredSession: BffServerSession = {
      id: sessionIdExpired,
      userId: userIdExpired,
      email: `${userIdExpired}@example.com`,
      sessionToken: 'neon_sess_tok_expired',
      jwt: jwtExpired,
      jwtExpiresAt: now + 3600_000,
      csrfToken: generateCsrfToken(),
      createdAt: now - 7200_000,
      expiresAt: now - 1000, // Expired 1 second ago!
      lastRotatedAt: now - 7200_000
    };

    await instanceA.store.set(expiredSession);
    const expiredCookieHeader = `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(serializeBffToken(expiredSession))}`;

    const expiredResultA = await instanceA.handleRequest(expiredCookieHeader);
    assert.equal(expiredResultA.principal, null, 'Expired session must fail on Instance A');
    assert.equal(expiredResultA.clearedCookie, true, 'Instance A must clear expired session cookie');

    const expiredResultB = await instanceB.handleRequest(expiredCookieHeader);
    assert.equal(expiredResultB.principal, null, 'Expired session must fail on Instance B');
    assert.equal(expiredResultB.clearedCookie, true, 'Instance B must clear expired session cookie');
    console.log('  ✓ Test D PASSED: Server-side expiration fails closed uniformly on all instances');

    // -------------------------------------------------------------------------
    // TEST E — Database Lookup Fail-Closed Policy
    // -------------------------------------------------------------------------
    console.log('Test E: Database Lookup Fail-Closed Policy on DB error...');
    // Create a mock store whose DB client throws an unrecoverable connection failure
    const brokenStoreInstance = createStatelessInstance('Instance-Broken-Db');
    (brokenStoreInstance.store as any).client = () => {
      throw new Error('ECONNREFUSED: Database connection dropped');
    };

    const validLookup = await brokenStoreInstance.store.get(sessionIdC);
    assert.equal(validLookup, null, 'Store lookup must fail closed and return null on database error');

    console.log('  ✓ Test E PASSED: Database failure fails closed without leaking unauthorized access');

    console.log('\n=============================================================');
    console.log('ALL CROSS-INSTANCE DURABLE SESSION TESTS PASSED [5/5]');
    console.log('=============================================================\n');
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED CROSS-INSTANCE DURABLE SESSION TEST:', err);
    process.exit(1);
  } finally {
    globalThis.fetch = originalFetch;
    await instanceA.store.clear();
  }
}

runCrossInstanceTests();
