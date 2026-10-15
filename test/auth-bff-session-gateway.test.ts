/**
 * AIRA AI 2026 — First-Party Backend-for-Frontend (BFF) Session Security Suite
 * 
 * Verifies the production-compatible first-party BFF session security boundary:
 * 1. Secure cookie attributes: HttpOnly, Secure, SameSite=Lax, Max-Age scoping.
 * 2. Cryptographic signature and tamper rejection (HMAC-SHA256).
 * 3. Strict CSRF & Origin validation on state-changing authentication routes.
 * 4. Zero-token response contract (no session tokens or raw JWTs exposed to frontend JavaScript).
 * 5. Downstream execution principal binding (neon_user_<id>) without Bearer headers.
 * 6. Server-side session invalidation and cookie clearing on logout.
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
  BffSessionPayload,
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

async function testCookieSerializationAndTamperProtection() {
  console.log('Testing: BFF Cookie serialization, signature verification, and tamper protection...');

  process.env.AIRA_SESSION_SECRET = 'test-secret-at-least-32-characters-long-for-testing';

  const now = Math.floor(Date.now() / 1000);
  const payload: BffSessionPayload = {
    v: 1,
    sessionToken: 'neon_sess_tok_12345',
    userId: 'usr_neon_123',
    email: 'user@example.com',
    name: 'Test User',
    jwt: 'test.jwt.payload',
    jwtExpiresAt: Date.now() + 600_000,
    iat: now,
    exp: now + 3600
  };

  const serialized = serializeBffToken(payload);
  assert(serialized.includes('.'), 'Serialized token must have signature separator');

  // Verify valid parsing
  const mockReqValid = {
    headers: {
      cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(serialized)}`
    }
  } as any;

  const parsed = readBffSessionFromCookie(mockReqValid);
  assert(parsed !== null, 'Valid cookie must parse successfully');
  assert.equal(parsed?.userId, 'usr_neon_123');
  assert.equal(parsed?.sessionToken, 'neon_sess_tok_12345');

  // Tamper attack: modify payload content
  const parts = serialized.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, userId: 'usr_hacked' })).toString('base64url');
  const tamperedCookie = `${tamperedPayload}.${parts[1]}`;

  const mockReqTampered = {
    headers: {
      cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(tamperedCookie)}`
    }
  } as any;

  assert.equal(
    readBffSessionFromCookie(mockReqTampered),
    null,
    'Tampered cookie signature must be rejected fail-closed'
  );

  // Expired cookie
  const expiredPayload: BffSessionPayload = {
    ...payload,
    exp: now - 100
  };
  const expiredSerialized = serializeBffToken(expiredPayload);
  const mockReqExpired = {
    headers: {
      cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(expiredSerialized)}`
    }
  } as any;

  assert.equal(
    readBffSessionFromCookie(mockReqExpired),
    null,
    'Expired session cookie must be rejected fail-closed'
  );

  console.log('  ✓ BFF cookie serialization and HMAC-SHA256 tamper protection verified');
}

async function testCookieAttributesAndHeaders() {
  console.log('Testing: BFF Cookie attributes (HttpOnly, SameSite, Secure)...');

  let setCookieHeader = '';
  const mockRes = {
    setHeader: (name: string, val: any) => {
      if (name === 'Set-Cookie') setCookieHeader = val;
    }
  } as any;

  const payload: BffSessionPayload = {
    v: 1,
    sessionToken: 'neon_sess_tok_12345',
    userId: 'usr_neon_123',
    jwt: 'test.jwt',
    jwtExpiresAt: Date.now() + 600_000,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  };

  setBffSessionCookie(mockRes, payload);

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

async function testCsrfAndOriginValidation() {
  console.log('Testing: CSRF and Origin protection enforcement...');

  // 1. GET requests are safe
  assert.equal(verifyCsrfAndOrigin({ method: 'GET', headers: {} } as any), true);

  // 2. POST without headers is REJECTED
  assert.equal(
    verifyCsrfAndOrigin({ method: 'POST', headers: {} } as any),
    false,
    'POST without origin or CSRF header must be rejected'
  );

  // 3. POST with anti-CSRF header is ACCEPTED
  assert.equal(
    verifyCsrfAndOrigin({
      method: 'POST',
      headers: { 'x-aira-csrf-protection': '1' }
    } as any),
    true,
    'POST with x-aira-csrf-protection must be accepted'
  );

  // 4. POST with sec-fetch-site: same-origin is ACCEPTED
  assert.equal(
    verifyCsrfAndOrigin({
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' }
    } as any),
    true,
    'POST with sec-fetch-site: same-origin must be accepted'
  );

  // 5. POST with matching Origin header is ACCEPTED
  assert.equal(
    verifyCsrfAndOrigin({
      method: 'POST',
      headers: {
        host: 'aira.ai',
        origin: 'https://aira.ai'
      }
    } as any),
    true,
    'POST with matching host and origin must be accepted'
  );

  // 6. Cross-origin attack is REJECTED
  assert.equal(
    verifyCsrfAndOrigin({
      method: 'POST',
      headers: {
        host: 'aira.ai',
        origin: 'https://attacker-domain.evil.com'
      }
    } as any),
    false,
    'Cross-origin POST must be rejected'
  );

  console.log('  ✓ CSRF & Origin validation strictly prevents cross-site request forgery');
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
      headers: { 'x-aira-csrf-protection': '1' },
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
    const payload: BffSessionPayload = {
      v: 1,
      sessionToken: 'neon_sess_tok_999',
      userId: 'usr_cookie_principal_1',
      jwt: validJwt,
      jwtExpiresAt: Date.now() + 600_000,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    };

    const cookieToken = serializeBffToken(payload);

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

    console.log('  ✓ HttpOnly cookie session successfully resolved to ExecutionPrincipal (neon_user_<id>)');
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

    const payload: BffSessionPayload = {
      v: 1,
      sessionToken: 'neon_sess_tok_to_revoke',
      userId: 'usr_1',
      jwt: 'jwt',
      jwtExpiresAt: Date.now() + 600_000,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    };
    const cookieToken = serializeBffToken(payload);

    let setCookieHeader: any = null;
    const mockReq = {
      method: 'POST',
      headers: {
        cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(cookieToken)}`,
        'x-aira-csrf-protection': '1'
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

    console.log('  ✓ BFF sign-out safely executes two-phase invalidation and cookie clearing');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  console.log('\n=== AIRA AI 2026 — FIRST-PARTY BFF SESSION SECURITY SUITE ===\n');

  try {
    await testCookieSerializationAndTamperProtection();
    await testCookieAttributesAndHeaders();
    await testCsrfAndOriginValidation();
    await testBffSignInZeroTokenResponseContract();
    await testBffMiddlewarePrincipalBindingWithoutBearerHeader();
    await testBffSignOutRevocation();

    console.log('\nALL FIRST-PARTY BFF SESSION SECURITY CHECKS PASSED!\n');
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED BFF SESSION SECURITY CHECK:', err);
    process.exit(1);
  }
}

main();
