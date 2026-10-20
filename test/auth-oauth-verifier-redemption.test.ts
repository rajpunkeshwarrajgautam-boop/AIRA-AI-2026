/**
 * AIRA AI 2026 — Google OAuth Session Verifier Redemption & Contract Test
 * 
 * Verifies the exact Neon Auth / Better Auth OAuth contract:
 * 1. handleBffOAuthGoogleStart forwards upstream Set-Cookie challenge headers (__Secure-neon-auth.session_challenge)
 * 2. handleBffOAuthGoogleCallback redeems neon_auth_session_verifier via Neon Auth /get-session with challenge cookies
 * 3. Bridges upstream session and signed session_token cookie to mint EdDSA JWT and first-party BFF session
 * 4. Error isolation: Sanitized redirect on exchange failure without uncaught exceptions or token exposure
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  handleBffOAuthGoogleStart,
  handleBffOAuthGoogleCallback,
  handleBffOAuthGithubStart,
  handleBffOAuthGithubCallback,
  setBffOAuthFlowCookie,
  readBffSessionFromCookie,
  BFF_COOKIE_NAME_DEV,
  BFF_FLOW_COOKIE_NAME_DEV
} from '../apps/api/src/auth/bff-session.js';
import { clearJwksCacheForTesting } from '../apps/api/src/auth/neon-auth-principal.js';

// Setup mock EdDSA signing keys for testing JWT cryptographic verification
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const testJwk = publicKey.export({ format: 'jwk' });
testJwk.kid = 'oauth-contract-key-1';
testJwk.alg = 'EdDSA';
testJwk.use = 'sig';

const TEST_ISSUER = 'https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';

function makeMockEdDsaJwt(sub: string, email: string, name: string, expSeconds = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'oauth-contract-key-1', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub,
    iss: TEST_ISSUER,
    aud: TEST_ISSUER,
    iat: now,
    exp: now + expSeconds,
    email,
    name
  })).toString('base64url');

  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

for (const provider of ['google', 'github'] as const) {
const start = provider === 'google' ? handleBffOAuthGoogleStart : handleBffOAuthGithubStart;
const callback = provider === 'google' ? handleBffOAuthGoogleCallback : handleBffOAuthGithubCallback;
const prefix = provider === 'github' ? 'github.' : '';
test(`${provider}: Neon Auth OAuth Verifier Contract & Handoff Suite`, async (t) => {
  const originalFetch = globalThis.fetch;
  process.env.NEON_AUTH_BASE_URL = TEST_ISSUER;
  process.env.NEON_AUTH_JWKS_URL = `${TEST_ISSUER}/.well-known/jwks.json`;

  t.after(() => {
    globalThis.fetch = originalFetch;
    clearJwksCacheForTesting();
  });

  const mockGoogleUser = {
    id: 'google_contract_user_1',
    email: 'antigravitypower490@gmail.com',
    name: 'elliot anderson',
    image: 'https://lh3.googleusercontent.com/a/mock-contract-avatar'
  };
  const mockRawSessionToken = 'L6ZnYq3Rs5FrOiRpkIXWJjIS2h7edH9F';
  const mockSignedSessionTokenCookie = '__Secure-neon-auth.session_token=L6ZnYq3Rs5FrOiRpkIXWJjIS2h7edH9F.mock_sig_123; Path=/; HttpOnly; Secure; SameSite=Lax';
  const mockChallengeCookie = '__Secure-neon-auth.session_challenge=mock_challenge_abc_123.mock_sig; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=None; Partitioned';
  const mockLegacyChallengeCookie = '__Secure-neon-auth.session_challange=mock_challenge_abc_123.mock_sig; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=None; Partitioned';
  const validVerifier = 'c0tgtrMtkt8WTbeI';

  let upstreamGetSessionCalled = false;
  let upstreamGetSessionHeaders: Record<string, string> = {};
  let upstreamTokenCalled = false;
  let upstreamTokenHeaders: Record<string, string> = {};

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<any> => {
    const urlStr = typeof input === 'string' ? input : input.toString();

    // 1. JWKS
    if (urlStr.includes('/.well-known/jwks.json')) {
      const body = JSON.stringify({ keys: [testJwk] });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(body.length), 'content-type': 'application/json' }),
        text: async () => body,
        json: async () => ({ keys: [testJwk] })
      };
    }

    // 2. /sign-in/social
    if (urlStr.includes('/sign-in/social')) {
      const payload = JSON.parse(init?.body as string);
      assert.equal(payload.provider, provider);
      const landing = new URL(payload.callbackURL);
      assert.equal(landing.pathname, `/api/auth/oauth/${provider}/callback`);
      assert.equal(landing.searchParams.get('flowId')?.startsWith('github.'), provider === 'github');
      const headers = new Headers();
      headers.append('set-cookie', mockChallengeCookie);
      headers.append('set-cookie', mockLegacyChallengeCookie);
      headers.set('content-type', 'application/json');

      return {
        ok: true,
        status: 200,
        headers,
        text: async () => JSON.stringify({ url: 'https://accounts.google.com/mock-redirect' }),
        json: async () => ({ url: 'https://accounts.google.com/mock-redirect' })
      };
    }

    // 3. /get-session with neon_auth_session_verifier
    if (urlStr.includes('/get-session')) {
      upstreamGetSessionCalled = true;
      upstreamGetSessionHeaders = (init?.headers as Record<string, string>) || {};
      const u = new URL(urlStr);
      const verifier = u.searchParams.get('neon_auth_session_verifier');
      const cookie = upstreamGetSessionHeaders['Cookie'] || '';

      if (verifier === validVerifier && cookie.includes('mock_challenge_abc_123')) {
        const body = JSON.stringify({
          user: mockGoogleUser,
          session: {
            id: 'sess_12345',
            userId: mockGoogleUser.id,
            token: mockRawSessionToken,
            expiresAt: new Date(Date.now() + 86400000).toISOString()
          }
        });
        const headers = new Headers();
        headers.append('set-cookie', mockSignedSessionTokenCookie);
        headers.set('content-type', 'application/json');
        return {
          ok: true,
          status: 200,
          headers,
          text: async () => body,
          json: async () => JSON.parse(body)
        };
      }

      if (!cookie.includes('mock_challenge_abc_123')) {
        return {
          ok: false,
          status: 400,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ error: 'Session challenge cookie not found', code: 'SESSION_CHALLENGE_COOKIE_NOT_FOUND' }),
          json: async () => ({ error: 'Session challenge cookie not found', code: 'SESSION_CHALLENGE_COOKIE_NOT_FOUND' })
        };
      }

      return {
        ok: false,
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ error: 'Verification not found', code: 'VERIFICATION_NOT_FOUND' }),
        json: async () => ({ error: 'Verification not found', code: 'VERIFICATION_NOT_FOUND' })
      };
    }

    // 4. /token
    if (urlStr.includes('/token')) {
      upstreamTokenCalled = true;
      upstreamTokenHeaders = (init?.headers as Record<string, string>) || {};
      const cookie = upstreamTokenHeaders['Cookie'] || '';
      const auth = upstreamTokenHeaders['Authorization'] || '';

      // Requires signed cookie or valid auth header
      if (cookie.includes('mock_sig_123') || auth.includes(mockRawSessionToken)) {
        const jwt = makeMockEdDsaJwt(mockGoogleUser.id, mockGoogleUser.email, mockGoogleUser.name);
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ token: jwt }),
          json: async () => ({ token: jwt })
        };
      }

      return {
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ message: 'Unauthorized', code: 'UNAUTHORIZED' }),
        json: async () => ({ message: 'Unauthorized', code: 'UNAUTHORIZED' })
      };
    }

    return originalFetch(input, init);
  };

  await t.test('1. handleBffOAuthGoogleStart forwards upstream challenge cookies to client browser', async () => {
    let setCookieHeaders: string[] = [];
    let responseBody: any = null;

    const mockReq = {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://localhost:5173',
        'x-aira-csrf-protection': '1'
      }
    } as any;

    const mockRes = {
      status: (code: number) => ({
        json: (data: any) => { responseBody = data; }
      }),
      append: (name: string, val: string) => {
        if (name === 'Set-Cookie') setCookieHeaders.push(val);
      },
      getHeader: (name: string) => (name === 'Set-Cookie' ? setCookieHeaders : undefined),
      setHeader: (name: string, val: any) => {
        if (name === 'Set-Cookie') setCookieHeaders = Array.isArray(val) ? val : [val];
      }
    } as any;

    await start(mockReq, mockRes);

    assert.ok(responseBody?.url?.includes('accounts.google.com'));
    // Flow cookie must be set
    assert.ok(setCookieHeaders.some(h => h.includes(BFF_FLOW_COOKIE_NAME_DEV)));
    // Upstream session challenge cookie MUST be forwarded to browser!
    assert.ok(
      setCookieHeaders.some(h => h.includes('session_challenge')),
      'Must forward upstream __Secure-neon-auth.session_challenge cookie'
    );
  });

  await t.test('2. handleBffOAuthGoogleCallback redeems neon_auth_session_verifier and establishes authenticated BFF session', async () => {
    const flowId = `${prefix}test_flow_verifier_valid`;
    const now = Date.now();
    let setCookieHeaders: string[] = [];

    const cookieGenRes = {
      getHeader: () => undefined,
      setHeader: (name: string, val: any) => {
        if (name === 'Set-Cookie') setCookieHeaders = Array.isArray(val) ? val : [val];
      }
    } as any;
    setBffOAuthFlowCookie(cookieGenRes, flowId, now);
    const flowCookieHeader = setCookieHeaders[0];

    const incomingCookieHeader = [
      flowCookieHeader,
      '__Secure-neon-auth.session_challenge=mock_challenge_abc_123.mock_sig'
    ].join('; ');

    let redirectCode = 0;
    let redirectUrl = '';
    let callbackSetCookies: string[] = [];

    const mockReq = {
      query: {
        flowId,
        neon_auth_session_verifier: validVerifier
      },
      headers: {
        host: 'localhost:3001',
        cookie: incomingCookieHeader
      }
    } as any;

    const mockRes = {
      append: (name: string, val: string) => {
        if (name === 'Set-Cookie') callbackSetCookies.push(val);
      },
      getHeader: (name: string) => (name === 'Set-Cookie' ? callbackSetCookies : undefined),
      setHeader: (name: string, val: any) => {
        if (name === 'Set-Cookie') callbackSetCookies = Array.isArray(val) ? val : [val];
      },
      redirect: (code: number, url: string) => {
        redirectCode = code;
        redirectUrl = url;
      }
    } as any;

    upstreamGetSessionCalled = false;
    upstreamTokenCalled = false;

    await callback(mockReq, mockRes);

    assert.equal(upstreamGetSessionCalled, true, 'Must call Neon Auth /get-session with verifier');
    assert.ok(upstreamGetSessionHeaders['Cookie']?.includes('mock_challenge_abc_123'), 'Must forward challenge cookie to Neon Auth');
    assert.equal(upstreamTokenCalled, true, 'Must call Neon Auth /token for EdDSA JWT');
    assert.equal(redirectCode, 302);
    assert.ok(redirectUrl.includes('/?auth_success=1'), 'Redirect must target /?auth_success=1');

    // Verify BFF session cookie is set
    const bffCookie = callbackSetCookies.find(h => h.includes(BFF_COOKIE_NAME_DEV));
    assert.ok(bffCookie, 'Must set first-party BFF session cookie');
    assert.ok(bffCookie.includes('HttpOnly'), 'BFF session cookie must be HttpOnly');

    // Verify session store has authenticated identity
    const sessionCookieVal = bffCookie.split(';')[0].split('=')[1];
    const dummyReq = {
      headers: {
        cookie: `${BFF_COOKIE_NAME_DEV}=${sessionCookieVal}`
      }
    } as any;
    const session = await readBffSessionFromCookie(dummyReq);
    assert.ok(session, 'Must resolve session from store');
    assert.equal(session.userId, mockGoogleUser.id);
    assert.equal(session.email, mockGoogleUser.email);
    assert.equal(session.name, mockGoogleUser.name);
  });

  await t.test('3. handleBffOAuthGoogleCallback redirects to exchange_failed when Neon Auth rejects verifier/challenge', async () => {
    const flowId = `${prefix}test_flow_invalid_challenge`;
    const now = Date.now();
    let setCookieHeaders: string[] = [];

    const cookieGenRes = {
      getHeader: () => undefined,
      setHeader: (name: string, val: any) => {
        if (name === 'Set-Cookie') setCookieHeaders = Array.isArray(val) ? val : [val];
      }
    } as any;
    setBffOAuthFlowCookie(cookieGenRes, flowId, now);
    const flowCookieHeader = setCookieHeaders[0];

    // Request missing session_challenge cookie!
    const mockReq = {
      query: {
        flowId,
        neon_auth_session_verifier: validVerifier
      },
      headers: {
        host: 'localhost:3001',
        cookie: flowCookieHeader
      }
    } as any;

    let redirectCode = 0;
    let redirectUrl = '';

    const mockRes = {
      append: () => {},
      getHeader: () => undefined,
      setHeader: () => {},
      redirect: (code: number, url: string) => {
        redirectCode = code;
        redirectUrl = url;
      }
    } as any;

    await callback(mockReq, mockRes);

    assert.equal(redirectCode, 302);
    assert.ok(redirectUrl.includes('/?auth_error=exchange_failed'), 'Must safely redirect to /?auth_error=exchange_failed');
  });
  await t.test('rejects a state cookie issued for the other OAuth provider before redemption', async () => {
    const flowId = provider === 'github' ? 'google_nonce' : 'github.other_nonce';
    let cookies: string[] = [];
    let redirect = '';
    const res = {
      getHeader: () => cookies,
      setHeader: (_name: string, value: string | string[]) => { cookies = Array.isArray(value) ? value : [value]; },
      redirect: (_status: number, url: string) => { redirect = url; }
    } as any;
    setBffOAuthFlowCookie(res, flowId, Date.now());
    upstreamGetSessionCalled = false;
    await callback({ query: { flowId, neon_auth_session_verifier: validVerifier },
      headers: { host: 'localhost:3001', cookie: cookies[0].split(';')[0] } } as any, res);
    assert.ok(redirect.endsWith('auth_error=state_mismatch'));
    assert.equal(upstreamGetSessionCalled, false);
  });

});
}
