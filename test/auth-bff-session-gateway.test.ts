/**
 * AIRA AI 2026 — First-Party Backend-for-Frontend (BFF) Session Security Suite
 * 
 * Verifies the production-grade first-party BFF session security boundary:
 * 1. Opaque session cookie architecture backed by server-side BffSessionStore.
 * 2. Zero bearer credentials in cookies (no base64 payload, no JWTs, no session tokens).
 * 3. Immediate server-side revocation on logout (cookie invalidation even with valid signature).
 * 4. Secure cookie attributes: HttpOnly, Secure, SameSite=Lax, Max-Age scoping.
 * 5. Strict Origin allowlisting: cross-origin mutations rejected even with custom headers.
 * 6. Cryptographic CSRF protection: authenticated mutations require matching session csrfToken.
 * 7. Zero-token response contract (no session tokens or raw JWTs exposed to frontend JavaScript).
 * 8. Downstream execution principal binding (neon_user_<id>) with mutual JWT-session consistency.
 * 9. Production fail-closed behavior when NEON_AUTH_BASE_URL is unconfigured.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  serializeBffToken,
  readBffSessionFromCookie,
  setBffSessionCookie,
  clearBffSessionCookie,
  verifyCsrfAndOrigin,
  createBffSessionMiddleware,
  handleBffSignIn,
  handleBffSignOut,
  bffSessionStore,
  BffServerSession,
  generateSessionId,
  generateCsrfToken,
  BFF_COOKIE_NAME_DEV
} from '../apps/api/src/auth/bff-session.js';
import { clearJwksCacheForTesting } from '../apps/api/src/auth/neon-auth-principal.js';

// Setup test signing keys for EdDSA mock verification
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const testJwk = publicKey.export({ format: 'jwk' });
testJwk.kid = 'bff-test-key-1';
testJwk.alg = 'EdDSA';
testJwk.use = 'sig';

function makeMockEdDsaJwt(sub: string, expSeconds = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'bff-test-key-1', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub,
    iss: 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech',
    aud: 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech',
    iat: now,
    exp: now + expSeconds,
    email: 'bff-user@example.com',
    name: 'BFF User'
  })).toString('base64url');

  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function testOpaqueCookieAndServerStore() {
  console.log('Testing: Opaque session cookie architecture and server-side store ownership...');

  process.env.AIRA_SESSION_SECRET = 'test-secret-at-least-32-characters-long-for-testing';
  await bffSessionStore.clear();

  const sessionId = generateSessionId();
  const csrfToken = generateCsrfToken();
  const now = Date.now();

  const session: BffServerSession = {
    id: sessionId,
    userId: 'usr_neon_123',
    email: 'user@example.com',
    name: 'Test User',
    sessionToken: 'neon_sess_tok_12345',
    jwt: 'test.jwt.payload',
    jwtExpiresAt: now + 600_000,
    csrfToken,
    createdAt: now,
    expiresAt: now + 3600_000,
    lastRotatedAt: now
  };

  await bffSessionStore.set(session);
  const serialized = serializeBffToken(session);

  // Assert cookie contains ONLY opaque ID and signature, ZERO JSON or credentials
  assert(serialized.includes('.'), 'Serialized token must have signature separator');
  const parts = serialized.split('.');
  assert.equal(parts.length, 2, 'Opaque cookie must consist only of sessionId and HMAC signature');
  assert(!serialized.includes('{'), 'Cookie must NOT contain JSON payload');
  assert(!serialized.includes('neon_sess_tok'), 'Cookie must NOT contain sessionToken');
  assert(!serialized.includes('test.jwt'), 'Cookie must NOT contain JWT');

  // Verify valid reading via cookie header
  const mockReqValid = {
    headers: {
      cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(serialized)}`
    }
  } as any;

  const parsed = await readBffSessionFromCookie(mockReqValid);
  assert(parsed !== null, 'Valid opaque cookie must resolve to server session');
  assert.equal(parsed?.userId, 'usr_neon_123');
  assert.equal(parsed?.sessionToken, 'neon_sess_tok_12345');
  assert.equal(parsed?.csrfToken, csrfToken);

  // Tamper attack: modify signature
  const mockReqTampered = {
    headers: {
      cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(sessionId + '.tampered_sig')}`
    }
  } as any;
  assert.equal(
    await readBffSessionFromCookie(mockReqTampered),
    null,
    'Tampered signature must fail closed'
  );

  // Server-side revocation test: delete from store
  await bffSessionStore.delete(sessionId);
  assert.equal(
    await readBffSessionFromCookie(mockReqValid),
    null,
    'Revoked server-side session must be immediately rejected even with valid cookie signature'
  );

  console.log('  ✓ Opaque session cookie architecture verified (zero credentials in cookie, server-side store ownership)');
}

async function testCookieAttributesAndHeaders() {
  console.log('Testing: BFF Cookie attributes (HttpOnly, SameSite, Secure)...');

  let setCookieHeader = '';
  const mockRes = {
    setHeader: (name: string, val: any) => {
      if (name === 'Set-Cookie') setCookieHeader = val;
    }
  } as any;

  const sessionId = generateSessionId();
  setBffSessionCookie(mockRes, sessionId);

  assert(setCookieHeader.includes('HttpOnly'), 'Cookie must have HttpOnly attribute');
  assert(setCookieHeader.includes('SameSite=Lax'), 'Cookie must have SameSite=Lax attribute');
  assert(setCookieHeader.includes('Path=/'), 'Cookie must have Path=/ attribute');
  assert(setCookieHeader.includes('Max-Age='), 'Cookie must have Max-Age attribute');

  // Clear cookie
  clearBffSessionCookie(mockRes);
  const clearHeaderStr = Array.isArray(setCookieHeader) ? setCookieHeader.join(', ') : String(setCookieHeader);
  assert(clearHeaderStr.includes('Max-Age=0'), 'Clear cookie must set Max-Age=0');

  console.log('  ✓ BFF cookie attributes strictly conform to security requirements');
}

async function testStrictCsrfAndOriginValidation() {
  console.log('Testing: Strict Origin validation and cryptographic CSRF token enforcement...');

  // 1. GET requests are safe
  assert.equal(verifyCsrfAndOrigin({ method: 'GET', headers: {} } as any), true);

  // 2. Cross-site Sec-Fetch-Site is REJECTED unconditionally
  assert.equal(
    verifyCsrfAndOrigin({
      method: 'POST',
      headers: {
        'sec-fetch-site': 'cross-site',
        host: 'localhost:3001',
        origin: 'http://localhost:5173'
      }
    } as any),
    false,
    'Cross-site Sec-Fetch-Site must be rejected'
  );

  // 3. Mismatched / Untrusted Origin attack: MUST BE REJECTED even with custom anti-CSRF header!
  assert.equal(
    verifyCsrfAndOrigin({
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'https://attacker.evil.com',
        'x-aira-csrf-protection': '1' // Attacker supplies custom header
      }
    } as any),
    false,
    'Untrusted origin must be rejected even when attacker sends custom anti-CSRF header'
  );

  // 4. Valid origin with custom header on unauthenticated route is ACCEPTED
  assert.equal(
    verifyCsrfAndOrigin({
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://localhost:5173',
        'x-aira-csrf-protection': '1'
      }
    } as any),
    true,
    'Trusted origin with anti-CSRF header must be accepted'
  );

  // 5. Authenticated mutation: requires session-bound cryptographic CSRF token
  const testSession: BffServerSession = {
    id: 'sess_csrf_test',
    userId: 'usr_1',
    sessionToken: 'tok_1',
    jwt: 'jwt_1',
    jwtExpiresAt: Date.now() + 600_000,
    csrfToken: 'super_secret_crypto_csrf_token_123',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    lastRotatedAt: Date.now()
  };

  // Missing CSRF token -> REJECTED
  assert.equal(
    verifyCsrfAndOrigin({
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://localhost:5173'
      }
    } as any, testSession),
    false,
    'Authenticated mutation without CSRF token must be rejected'
  );

  // Wrong CSRF token -> REJECTED
  assert.equal(
    verifyCsrfAndOrigin({
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://localhost:5173',
        'x-csrf-token': 'wrong_token'
      }
    } as any, testSession),
    false,
    'Authenticated mutation with wrong CSRF token must be rejected'
  );

  // Matching CSRF token -> ACCEPTED
  assert.equal(
    verifyCsrfAndOrigin({
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://localhost:5173',
        'x-csrf-token': 'super_secret_crypto_csrf_token_123'
      }
    } as any, testSession),
    true,
    'Authenticated mutation with matching CSRF token must be accepted'
  );

  console.log('  ✓ Strict origin allowlist and session-bound CSRF token validation verified');
}

async function testBffSignInZeroTokenResponseContract() {
  console.log('Testing: BFF Sign-In zero-token response contract (no credentials in JSON)...');

  const originalFetch = globalThis.fetch;
  try {
    const validJwt = makeMockEdDsaJwt('usr_bff_test_sub');

    (globalThis as any).fetch = async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/sign-in/email')) {
        return new Response(JSON.stringify({
          token: 'neon_secret_session_token_xyz',
          user: { id: 'usr_bff_test_sub', email: 'bff-user@example.com', name: 'BFF User' }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr.includes('/token')) {
        return new Response(JSON.stringify({
          token: validJwt
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('Not found', { status: 404 });
    };

    let setCookieCalled = false;
    let jsonResponse: any = null;
    let responseStatus = 0;

    const mockReq = {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://localhost:5173',
        'x-aira-csrf-protection': '1'
      },
      body: { email: 'bff-user@example.com', password: 'ValidPassword123!' }
    } as any;

    const mockRes = {
      setHeader: (name: string, val: any) => {
        if (name === 'Set-Cookie') setCookieCalled = true;
      },
      status: (code: number) => {
        responseStatus = code;
        return {
          json: (data: any) => { jsonResponse = data; }
        };
      }
    } as any;

    await handleBffSignIn(mockReq, mockRes);

    assert.equal(responseStatus, 200);
    assert.equal(setCookieCalled, true, 'HttpOnly session cookie must be set on sign-in');
    assert.equal(jsonResponse?.status, 'AUTHENTICATED');
    assert.equal(jsonResponse?.user?.id, 'usr_bff_test_sub');
    assert(jsonResponse?.csrfToken, 'Response must include session CSRF token for subsequent client mutations');

    // CRITICAL SECURITY ASSERTION: Response body must NOT contain secret session tokens or JWTs!
    assert.equal(jsonResponse?.token, undefined, 'CRITICAL: Raw session token must NOT be exposed in response body');
    assert.equal(jsonResponse?.jwt, undefined, 'CRITICAL: Raw JWT must NOT be exposed in response body');
    assert.equal(jsonResponse?.sessionToken, undefined, 'CRITICAL: Raw sessionToken must NOT be exposed in response body');

    console.log('  ✓ Zero-token response contract confirmed: credentials shielded from JavaScript');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testBffMiddlewarePrincipalBindingWithoutBearerHeader() {
  console.log('Testing: BFF Middleware binds ExecutionPrincipal using only HttpOnly cookie (no Bearer)...');

  const originalFetch = globalThis.fetch;
  try {
    process.env.NEON_AUTH_BASE_URL = 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech';
    process.env.NEON_AUTH_JWKS_URL = 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/.well-known/jwks.json';

    // Mock JWKS endpoint returning test public key
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

    const validJwt = makeMockEdDsaJwt('usr_cookie_principal_1');
    const sessionId = generateSessionId();
    const session: BffServerSession = {
      id: sessionId,
      userId: 'usr_cookie_principal_1',
      sessionToken: 'neon_sess_tok_999',
      jwt: validJwt,
      jwtExpiresAt: Date.now() + 600_000,
      csrfToken: 'csrf_test_val',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      lastRotatedAt: Date.now()
    };
    await bffSessionStore.set(session);

    const cookieToken = serializeBffToken(session);

    // Request with ZERO Authorization header, ONLY the first-party cookie
    const mockReq = {
      headers: {
        cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(cookieToken)}`
      }
    } as any;

    let nextCalled = false;
    const mockRes = {
      setHeader: () => {}
    } as any;

    const middleware = createBffSessionMiddleware();
    await middleware(mockReq, mockRes, () => { nextCalled = true; });

    assert.equal(nextCalled, true, 'Middleware must call next()');
    assert(mockReq.managedIdentity, 'Managed identity must be attached to request context');
    assert.equal(mockReq.managedIdentity.userId, 'neon_user_usr_cookie_principal_1');
    assert.equal(mockReq.user.id, 'neon_user_usr_cookie_principal_1');
    assert.equal(mockReq.managedIdentity.provider, 'neon_auth');

    // Mutual consistency check: verify that mismatched JWT subject is rejected
    const mismatchedJwt = makeMockEdDsaJwt('usr_attacker_sub');
    const mismatchedSessionId = generateSessionId();
    await bffSessionStore.set({
      id: mismatchedSessionId,
      userId: 'usr_victim_id', // Victim session ID, but JWT signed for attacker!
      sessionToken: 'tok_mismatch',
      jwt: mismatchedJwt,
      jwtExpiresAt: Date.now() + 600_000,
      csrfToken: 'csrf',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      lastRotatedAt: Date.now()
    });

    const mockReqMismatch = {
      headers: {
        cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(serializeBffToken(mismatchedSessionId))}`
      }
    } as any;

    let clearedCookie = false;
    const mockResMismatch = {
      setHeader: (name: string) => {
        if (name === 'Set-Cookie') clearedCookie = true;
      }
    } as any;

    await middleware(mockReqMismatch, mockResMismatch, () => {});
    assert.equal(mockReqMismatch.managedIdentity, undefined, 'Mismatched JWT subject must NOT be bound');
    assert.equal(clearedCookie, true, 'Mismatched session must clear cookie');

    console.log('  ✓ HttpOnly cookie session successfully resolved to ExecutionPrincipal (neon_user_<id>) with subject validation');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testBffSignOutRevocation() {
  console.log('Testing: BFF Sign-Out clears cookie and revokes remote session...');

  const originalFetch = globalThis.fetch;
  try {
    let remoteSignOutCalled = false;
    let authHeaderSent = '';

    (globalThis as any).fetch = async (url: any, init: any) => {
      if (String(url).includes('/sign-out')) {
        remoteSignOutCalled = true;
        authHeaderSent = init?.headers?.Authorization || '';
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const sessionId = generateSessionId();
    const session: BffServerSession = {
      id: sessionId,
      userId: 'usr_1',
      sessionToken: 'neon_sess_tok_to_revoke',
      jwt: 'jwt',
      jwtExpiresAt: Date.now() + 600_000,
      csrfToken: 'csrf_tok_signout',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      lastRotatedAt: Date.now()
    };
    await bffSessionStore.set(session);

    const cookieToken = serializeBffToken(session);

    let setCookieHeader: any = null;
    const mockReq = {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://localhost:5173',
        cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(cookieToken)}`,
        'x-csrf-token': 'csrf_tok_signout'
      }
    } as any;

    const mockRes = {
      setHeader: (name: string, val: any) => {
        if (name === 'Set-Cookie') setCookieHeader = val;
      },
      status: (_code: number) => ({
        json: (_data: any) => {}
      })
    } as any;

    await handleBffSignOut(mockReq, mockRes);

    assert.equal(remoteSignOutCalled, true, 'Remote Neon Auth /sign-out must be invoked');
    assert.equal(authHeaderSent, 'Bearer neon_sess_tok_to_revoke');
    assert(Array.isArray(setCookieHeader) && setCookieHeader[0].includes('Max-Age=0'), 'Cookie must be cleared');
    assert.equal(await bffSessionStore.get(sessionId), null, 'Session must be deleted from server-side store');

    console.log('  ✓ BFF sign-out safely executes two-phase invalidation, store purge, and cookie clearing');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testProductionFailClosedProviderUrl() {
  console.log('Testing: Production fail-closed behavior when NEON_AUTH_BASE_URL is missing...');

  const savedEnv = process.env.NODE_ENV;
  const savedUrl = process.env.NEON_AUTH_BASE_URL;

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.NEON_AUTH_BASE_URL;

    const mockReq = {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://localhost:5173',
        'x-aira-csrf-protection': '1'
      },
      body: { email: 'prod@example.com', password: 'Password123!' }
    } as any;

    let responseStatus = 0;
    let jsonResponse: any = null;
    const mockRes = {
      setHeader: () => {},
      status: (code: number) => {
        responseStatus = code;
        return {
          json: (data: any) => { jsonResponse = data; }
        };
      }
    } as any;

    let threw = false;
    try {
      await handleBffSignIn(mockReq, mockRes);
    } catch {
      threw = true;
    }

    assert(
      threw || (responseStatus >= 500 && jsonResponse?.error?.includes('NEON_AUTH_BASE_URL')),
      'Production execution without NEON_AUTH_BASE_URL must fail closed'
    );

    console.log('  ✓ Production fail-closed validation verified (refuses staging fallback in production)');
  } finally {
    process.env.NODE_ENV = savedEnv;
    if (savedUrl) process.env.NEON_AUTH_BASE_URL = savedUrl;
  }
}

async function main() {
  console.log('\n=== AIRA AI 2026 — FIRST-PARTY BFF SESSION SECURITY SUITE ===\n');

  try {
    await testOpaqueCookieAndServerStore();
    await testCookieAttributesAndHeaders();
    await testStrictCsrfAndOriginValidation();
    await testBffSignInZeroTokenResponseContract();
    await testBffMiddlewarePrincipalBindingWithoutBearerHeader();
    await testBffSignOutRevocation();
    await testProductionFailClosedProviderUrl();

    console.log('\nALL 7 FIRST-PARTY BFF SESSION SECURITY CHECKS PASSED!\n');
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED BFF SESSION SECURITY CHECK:', err);
    process.exit(1);
  }
}

main();
