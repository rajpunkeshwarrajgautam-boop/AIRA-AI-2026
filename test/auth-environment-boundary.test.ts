import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import type { Request, Response } from 'express';
import {
  issueSessionToken,
  verifySessionToken,
  ensureAuthenticatedSession,
  SESSION_COOKIE_NAME
} from '../apps/api/src/auth/session-auth.js';
import {
  directOAuthService,
  signFirstPartyJwt,
  verifyFirstPartyJwt,
  type DirectOAuthFlowState
} from '../apps/api/src/auth/direct-oauth.js';
import {
  BFF_COOKIE_NAME_DEV,
  BffSessionStore,
  createBffSessionMiddleware,
  bffSessionStore,
  generateCsrfToken,
  generateSessionId,
  readBffSessionFromCookie,
  serializeBffToken,
  setBffOAuthFlowCookie,
  parseBffOAuthFlowCookie,
  type BffServerSession
} from '../apps/api/src/auth/bff-session.js';
import {
  builderAccess,
  signTicket,
  signingSecret,
  verifyTicket,
  type WorkspaceTicketDraft
} from '../packages/builder-runtime/src/security.js';
import { resolveDeploymentEnvironment } from '../packages/contracts/src/deployment-environment.js';
import { validateApiStartupConfiguration } from '../apps/api/src/startup-config.js';
import { ModelRouter, ProviderUnavailableError } from '../packages/model-router/src/index.js';

const TEST_SESSION_KEY = 'synthetic-session-key-for-isolation-tests-0123456789';
const TEST_BUILDER_KEY = 'synthetic-builder-key-isolated-from-session-0123456789';
const ENV_KEYS = [
  'NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_REF',
  'AIRA_SESSION_SECRET', 'AIRA_SESSION_ACCEPT_LEGACY_V1', 'AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL',
  'AIRA_BFF_ACCEPT_LEGACY_COOKIE', 'AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT',
  'AIRA_BUILDER_SIGNING_SECRET', 'AIRA_BUILDER_ACCEPT_LEGACY_V1',
  'AIRA_ALLOW_MOCK', 'AIRA_FAST_PROVIDER', 'AIRA_FAST_MODEL',
  'AIRA_BUILDER_ENABLED', 'AIRA_BUILDER_ALLOWED_USER_IDS', 'LIGHTNING_SANDBOX_API_KEY',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NVIDIA_API_KEY', 'GROQ_API_KEY',
  'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY'
] as const;

function withEnvironment(environment: 'production' | 'preview' | 'staging' | 'development') {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.AIRA_SESSION_SECRET = TEST_SESSION_KEY;
  for (const key of [
    'AIRA_SESSION_ACCEPT_LEGACY_V1', 'AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL',
    'AIRA_BFF_ACCEPT_LEGACY_COOKIE', 'AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT',
    'AIRA_BUILDER_ACCEPT_LEGACY_V1'
  ]) delete process.env[key];
  if (environment === 'production') {
    process.env.NODE_ENV = 'production';
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'production';
    delete process.env.VERCEL_GIT_COMMIT_REF;
  } else if (environment === 'preview' || environment === 'staging') {
    process.env.NODE_ENV = 'production';
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_REF = environment === 'staging' ? 'staging' : 'security-certification';
  } else {
    process.env.NODE_ENV = 'test';
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_GIT_COMMIT_REF;
  }
  return () => {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function makeResponse(): Response & { headers: Map<string, string> } {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader(name: string, value: number | string | readonly string[]) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
      return this;
    },
    getHeader(name: string) { return headers.get(name.toLowerCase()); }
  } as unknown as Response & { headers: Map<string, string> };
}

function cookiePair(header: string): string {
  return header.split(';', 1)[0];
}

function signJson(secret: string, payload: Record<string, unknown>, prefix = ''): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${prefix}${encoded}`).digest('base64url');
  return `${encoded}.${signature}`;
}

function signLegacyGuest(uid: string, sid: string, exp: number): string {
  const now = Math.floor(Date.now() / 1000);
  return signJson(TEST_SESSION_KEY, { v: 1, uid, sid, iat: now, exp });
}

test('trusted deployment environment prefers Vercel environment and distinguishes staging', () => {
  assert.equal(resolveDeploymentEnvironment({ NODE_ENV: 'production', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'pr-branch' }), 'preview');
  assert.equal(resolveDeploymentEnvironment({ NODE_ENV: 'production', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'staging' }), 'staging');
  assert.equal(resolveDeploymentEnvironment({ NODE_ENV: 'production', VERCEL_ENV: 'production' }), 'production');
});

test('guest v2 sessions bind issuer, audience, and environment even with the same HMAC key', () => {
  const restore = withEnvironment('preview');
  try {
    const previewToken = issueSessionToken({ uid: 'user_preview', sid: 'session_preview' }).token;
    assert.equal(verifySessionToken(previewToken)?.env, 'preview');

    withEnvironment('production');
    assert.equal(verifySessionToken(previewToken), null, 'Production must reject a Preview token with the same key');
    const productionToken = issueSessionToken({ uid: 'user_production', sid: 'session_production' }).token;
    assert.equal(verifySessionToken(productionToken)?.env, 'production');

    withEnvironment('preview');
    assert.equal(verifySessionToken(productionToken), null, 'Preview must reject a Production token with the same key');
  } finally {
    restore();
  }
});

test('guest verification rejects missing/altered claims, tampering, and expired tokens', () => {
  const restore = withEnvironment('preview');
  try {
    const valid = issueSessionToken({ uid: 'user_1', sid: 'session_1' }).token;
    const [encoded] = valid.split('.');
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    const { aud: _aud, ...missingAudience } = claims;
    assert.equal(verifySessionToken(signJson(TEST_SESSION_KEY, missingAudience)), null);
    const { iss: _iss, ...missingIssuer } = claims;
    assert.equal(verifySessionToken(signJson(TEST_SESSION_KEY, missingIssuer)), null);
    assert.equal(verifySessionToken(signJson(TEST_SESSION_KEY, { ...claims, v: 99 })), null);
    const { env: _env, ...missingEnvironment } = claims;
    assert.equal(verifySessionToken(signJson(TEST_SESSION_KEY, missingEnvironment)), null);
    assert.equal(verifySessionToken(signJson(TEST_SESSION_KEY, { ...claims, env: 'production' })), null);
    assert.equal(verifySessionToken(valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a')), null);
    assert.equal(verifySessionToken(issueSessionToken({ uid: 'user_old', sid: 'session_old', ttlSeconds: -1 }).token), null);
  } finally {
    restore();
  }
});

test('guest renewal preserves uid/sid, refreshes the 30-day expiry, and emits an environment-bound v2 cookie', () => {
  const restore = withEnvironment('preview');
  try {
    const now = Math.floor(Date.now() / 1000);
    const old = issueSessionToken({ uid: 'user_existing', sid: 'session_existing', nowSeconds: now - 25 * 86400 });
    const req = { headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(old.token)}` } } as Request;
    const res = makeResponse();
    const renewed = ensureAuthenticatedSession(req, res);
    assert.equal(renewed.userId, 'user_existing');
    assert.equal(renewed.sessionId, 'session_existing');
    const cookie = res.headers.get('set-cookie');
    assert.ok(cookie);
    const [, token] = cookiePair(cookie).split('=');
    const payload = verifySessionToken(decodeURIComponent(token));
    assert.equal(payload?.v, 2);
    assert.equal(payload?.env, 'preview');
    assert.ok((payload?.exp || 0) > now + 29 * 86400);
  } finally {
    restore();
  }
});

test('legacy guest v1 is rejected by default and in Preview; explicit Production grace upgrades identity to v2', () => {
  const restore = withEnvironment('preview');
  try {
    const exp = Math.floor(Date.now() / 1000) + 5 * 86400;
    const legacy = signLegacyGuest('user_legacy', 'session_legacy', exp);
    process.env.AIRA_SESSION_ACCEPT_LEGACY_V1 = 'true';
    assert.equal(verifySessionToken(legacy), null, 'Preview never accepts unbound v1, even with the flag');

    withEnvironment('production');
    delete process.env.AIRA_SESSION_ACCEPT_LEGACY_V1;
    assert.equal(verifySessionToken(legacy), null, 'Production rejects v1 unless an explicit migration opt-in is set');
    process.env.AIRA_SESSION_ACCEPT_LEGACY_V1 = 'true';
    process.env.AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL = new Date(Date.now() + 60_000).toISOString();
    assert.equal(verifySessionToken(legacy)?.legacyV1, true);
    process.env.AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL = new Date(Date.now() - 1_000).toISOString();
    assert.equal(verifySessionToken(legacy), null, 'the same v1 token is rejected at/after the configured cutoff');
    process.env.AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL = new Date(Date.now() + 60_000).toISOString();
    const req = { headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(legacy)}` } } as Request;
    const res = makeResponse();
    const upgraded = ensureAuthenticatedSession(req, res);
    assert.equal(upgraded.userId, 'user_legacy');
    assert.equal(upgraded.sessionId, 'session_legacy');
    const token = decodeURIComponent(cookiePair(res.headers.get('set-cookie')!).split('=')[1]);
    const verified = verifySessionToken(token);
    assert.equal(verified?.v, 2);
    assert.equal(verified?.env, 'production');
  } finally {
    restore();
  }
});

test('Direct OAuth flow state and first-party JWT reject a foreign environment under the same key', () => {
  const restore = withEnvironment('preview');
  try {
    const res = makeResponse();
    const state: DirectOAuthFlowState = {
      flowId: 'flow_synthetic', provider: 'google', timestamp: Date.now(), action: 'signin'
    };
    directOAuthService.setFlowCookie(res, state, false);
    const header = res.headers.get('set-cookie')!;
    const value = cookiePair(header).split('=')[1];
    const request = { headers: { cookie: `${cookiePair(header)}` } } as Request;
    assert.equal(directOAuthService.readFlowCookie(request)?.env, 'preview');
    const tamperedFlow = value.slice(0, -1) + (value.endsWith('a') ? 'b' : 'a');
    assert.equal(directOAuthService.readFlowCookie({ headers: { cookie: `aira_oauth_state=${tamperedFlow}` } } as Request), null);
    const expiredFlowResponse = makeResponse();
    directOAuthService.setFlowCookie(expiredFlowResponse, {
      ...state, timestamp: Date.now() - 11 * 60 * 1000
    }, false);
    assert.equal(directOAuthService.readFlowCookie({
      headers: { cookie: cookiePair(expiredFlowResponse.headers.get('set-cookie')!) }
    } as Request), null);

    const { token } = signFirstPartyJwt('user_oauth', 'session_oauth');
    assert.equal(verifyFirstPartyJwt(token).userId, 'user_oauth');

    withEnvironment('production');
    assert.equal(directOAuthService.readFlowCookie(request), null);
    assert.throws(() => verifyFirstPartyJwt(token), /INVALID_JWT_CLAIMS/);
    const productionJwt = signFirstPartyJwt('user_oauth_prod', 'session_oauth_prod').token;
    withEnvironment('preview');
    assert.throws(() => verifyFirstPartyJwt(productionJwt), /INVALID_JWT_CLAIMS/);

    // Missing and altered environment claims are denied even when correctly HMAC-signed.
    const [headerB64, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
    const { env: _env, ...missingEnvironment } = payload;
    const missingToken = (() => {
      const body = Buffer.from(JSON.stringify(missingEnvironment)).toString('base64url');
      const signature = createHmac('sha256', TEST_SESSION_KEY).update(`${headerB64}.${body}`).digest('base64url');
      return `${headerB64}.${body}.${signature}`;
    })();
    assert.throws(() => verifyFirstPartyJwt(missingToken), /INVALID_JWT_CLAIMS/);
    const { aud: _aud, ...missingAudience } = payload;
    const missingAudienceBody = Buffer.from(JSON.stringify(missingAudience)).toString('base64url');
    const missingAudienceSignature = createHmac('sha256', TEST_SESSION_KEY)
      .update(`${headerB64}.${missingAudienceBody}`).digest('base64url');
    assert.throws(() => verifyFirstPartyJwt(`${headerB64}.${missingAudienceBody}.${missingAudienceSignature}`), /INVALID_JWT_CLAIMS/);
    const tamperedJwt = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    assert.throws(() => verifyFirstPartyJwt(tamperedJwt), /INVALID_JWT_SIGNATURE/);
    assert.ok(value);
  } finally {
    restore();
  }
});

test('legacy direct-OAuth JWTs require Production row-migration opt-in and still expire', () => {
  const restore = withEnvironment('production');
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      sub: 'user_legacy_oauth', sid: 'session_legacy_oauth', iss: 'aira-direct-oauth',
      iat: now, exp: now + 3600, provider: 'direct_oauth'
    })).toString('base64url');
    const signature = createHmac('sha256', TEST_SESSION_KEY).update(`${header}.${payload}`).digest('base64url');
    const legacy = `${header}.${payload}.${signature}`;
    assert.throws(() => verifyFirstPartyJwt(legacy), /INVALID_JWT_CLAIMS/);
    process.env.AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT = 'true';
    assert.equal(verifyFirstPartyJwt(legacy, { allowLegacyProductionSession: true }).legacyV1, true);

    withEnvironment('preview');
    process.env.AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT = 'true';
    assert.throws(() => verifyFirstPartyJwt(legacy, { allowLegacyProductionSession: true }), /INVALID_JWT_CLAIMS/);

    withEnvironment('production');
    process.env.AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT = 'true';
    const expiredPayload = Buffer.from(JSON.stringify({
      sub: 'user_legacy_oauth', sid: 'session_legacy_oauth', iss: 'aira-direct-oauth',
      iat: now - 7200, exp: now - 1, provider: 'direct_oauth'
    })).toString('base64url');
    const expiredSignature = createHmac('sha256', TEST_SESSION_KEY).update(`${header}.${expiredPayload}`).digest('base64url');
    assert.throws(() => verifyFirstPartyJwt(`${header}.${expiredPayload}.${expiredSignature}`, { allowLegacyProductionSession: true }), /JWT_EXPIRED/);
  } finally {
    restore();
  }
});

test('BFF v2 cookies stay row-backed, are environment-bound, and explicit legacy compatibility remains Production-only', async () => {
  const restore = withEnvironment('preview');
  try {
    await bffSessionStore.clear();
    const now = Date.now();
    const sessionId = generateSessionId();
    const session: BffServerSession = {
      id: sessionId, userId: 'account_1', sessionToken: 'synthetic-upstream-token', jwt: 'not-used-here',
      jwtExpiresAt: now + 60000, csrfToken: generateCsrfToken(), createdAt: now,
      expiresAt: now + 86400000, lastRotatedAt: now
    };
    await bffSessionStore.set(session);
    const previewCookie = serializeBffToken(session);
    const req = { headers: { cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(previewCookie)}` } } as Request;
    assert.equal((await readBffSessionFromCookie(req))?.userId, 'account_1');
    const tamperedCookie = previewCookie.slice(0, -1) + (previewCookie.endsWith('a') ? 'b' : 'a');
    assert.equal(await readBffSessionFromCookie({
      headers: { cookie: `${BFF_COOKIE_NAME_DEV}=${tamperedCookie}` }
    } as Request), null);

    withEnvironment('production');
    assert.equal(await readBffSessionFromCookie(req), null, 'foreign-environment cookie rejected before row lookup');
    process.env.AIRA_BFF_ACCEPT_LEGACY_COOKIE = 'true';
    const legacy = `${sessionId}.${createHmac('sha256', TEST_SESSION_KEY).update(sessionId).digest('base64url')}`;
    const legacyReq = { headers: { cookie: `${BFF_COOKIE_NAME_DEV}=${legacy}` } } as Request;
    assert.equal((await readBffSessionFromCookie(legacyReq))?.userId, 'account_1', 'opt-in legacy cookie still requires its server row');
  } finally {
    await bffSessionStore.clear();
    restore();
  }
});

test('Production legacy BFF cookie and direct-OAuth session migrate in place to v2', async () => {
  const restore = withEnvironment('production');
  const store = new BffSessionStore(undefined, { memoryOnly: true });
  try {
    process.env.AIRA_BFF_ACCEPT_LEGACY_COOKIE = 'true';
    process.env.AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT = 'true';
    const sessionId = 'legacy_bff_session';
    const now = Date.now();
    const legacyHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const legacyPayload = Buffer.from(JSON.stringify({
      sub: 'legacy_bff_user', sid: sessionId, iss: 'aira-direct-oauth',
      iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, provider: 'direct_oauth'
    })).toString('base64url');
    const legacyJwtSignature = createHmac('sha256', TEST_SESSION_KEY)
      .update(`${legacyHeader}.${legacyPayload}`).digest('base64url');
    const session: BffServerSession = {
      id: sessionId, userId: 'legacy_bff_user', sessionToken: '',
      jwt: `${legacyHeader}.${legacyPayload}.${legacyJwtSignature}`,
      jwtExpiresAt: now + 3600_000, csrfToken: generateCsrfToken(),
      createdAt: now, expiresAt: now + 86400_000, lastRotatedAt: now
    };
    await store.set(session);
    const oldCookieSignature = createHmac('sha256', TEST_SESSION_KEY).update(sessionId).digest('base64url');
    const req = { headers: { cookie: `${BFF_COOKIE_NAME_DEV}=${sessionId}.${oldCookieSignature}` } } as any;
    let setCookie = '';
    const res = {
      getHeader: () => undefined,
      setHeader: (_name: string, value: string | string[]) => { setCookie = Array.isArray(value) ? value.join('; ') : value; }
    } as any;
    let nextCalled = false;
    await createBffSessionMiddleware(store)(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.principal.userId, 'legacy_bff_user');
    assert.equal(req.principal.sessionId, sessionId);
    assert.match(setCookie, /v2\.aira-bff-session\.production\./);
    const upgraded = await store.get(sessionId);
    assert.ok(upgraded?.jwt.startsWith('eyJ'), 'Upgraded direct-OAuth JWT remains a server-side JWT');
    assert.equal(verifyFirstPartyJwt(upgraded!.jwt).legacyV1, undefined);
  } finally {
    await store.clear();
    restore();
  }
});

test('BFF OAuth state binds the deployment environment and expires within 15 minutes', () => {
  const restore = withEnvironment('preview');
  try {
    const res = makeResponse();
    const timestamp = Date.now();
    setBffOAuthFlowCookie(res, 'oauth_flow', timestamp);
    const raw = cookiePair(res.headers.get('set-cookie')!);
    const req = { headers: { cookie: raw } } as Request;
    assert.equal(parseBffOAuthFlowCookie(req)?.flowId, 'oauth_flow');
    const [, encodedFlowClaims] = raw.split('.');
    const parsedFlowClaims = JSON.parse(Buffer.from(encodedFlowClaims, 'base64url').toString('utf8')) as Record<string, unknown>;
    const { aud: _aud, ...missingFlowAudience } = parsedFlowClaims;
    const missingFlowBody = Buffer.from(JSON.stringify(missingFlowAudience)).toString('base64url');
    const missingFlowSig = createHmac('sha256', TEST_SESSION_KEY)
      .update(`aira-bff-oauth-flow:v2:preview:${missingFlowBody}`).digest('base64url');
    assert.equal(parseBffOAuthFlowCookie({
      headers: { cookie: `aira_oauth_flow=v2.${missingFlowBody}.${missingFlowSig}` }
    } as Request), null);
    const expiredResponse = makeResponse();
    setBffOAuthFlowCookie(expiredResponse, 'old_oauth_flow', Date.now() - 16 * 60 * 1000);
    assert.equal(parseBffOAuthFlowCookie({
      headers: { cookie: cookiePair(expiredResponse.headers.get('set-cookie')!) }
    } as Request), null);
    const tampered = raw.replace(/.$/, raw.endsWith('a') ? 'b' : 'a');
    assert.equal(parseBffOAuthFlowCookie({ headers: { cookie: tampered } } as Request), null);
    withEnvironment('production');
    assert.equal(parseBffOAuthFlowCookie(req), null);
  } finally {
    restore();
  }
});

test('builder tickets use a dedicated key and reject missing, altered, expired, and foreign environment claims', () => {
  const restore = withEnvironment('preview');
  try {
    process.env.AIRA_BUILDER_SIGNING_SECRET = TEST_BUILDER_KEY;
    process.env.AIRA_SESSION_SECRET = TEST_SESSION_KEY;
    const draft: WorkspaceTicketDraft = {
      purpose: 'workspace', userId: 'builder_user', sessionId: 'builder_session', sandboxId: 'sandbox_1',
      expiresAt: Date.now() + 60_000, allowInternet: false, allowPreview: false
    };
    const previewTicket = signTicket(draft);
    assert.equal(verifyTicket(previewTicket, { userId: 'builder_user', sessionId: 'builder_session' }, 'workspace').environment, 'preview');

    withEnvironment('production');
    process.env.AIRA_BUILDER_SIGNING_SECRET = TEST_BUILDER_KEY;
    assert.throws(() => verifyTicket(previewTicket, { userId: 'builder_user', sessionId: 'builder_session' }, 'workspace'), /environment|claims/i);

    withEnvironment('preview');
    process.env.AIRA_BUILDER_SIGNING_SECRET = TEST_BUILDER_KEY;
    const [encoded] = previewTicket.split('.');
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    const { environment: _environment, ...missingEnvironment } = claims;
    const missing = signJson(TEST_BUILDER_KEY, missingEnvironment, 'aira-builder-v2:preview:');
    assert.throws(() => verifyTicket(missing, { userId: 'builder_user', sessionId: 'builder_session' }, 'workspace'), /environment|claims/i);
    const alteredPayload = Buffer.from(JSON.stringify({ ...claims, environment: 'production' })).toString('base64url');
    const alteredSignature = createHmac('sha256', TEST_BUILDER_KEY).update(`aira-builder-v2:production:${alteredPayload}`).digest('base64url');
    assert.throws(() => verifyTicket(`${alteredPayload}.${alteredSignature}`, { userId: 'builder_user', sessionId: 'builder_session' }, 'workspace'), /environment|claims/i);
    assert.throws(() => verifyTicket(signTicket({ ...draft, expiresAt: Date.now() - 1 }), { userId: 'builder_user', sessionId: 'builder_session' }, 'workspace'), /expired/i);

    const legacyBuilderPayload = Buffer.from(JSON.stringify({
      version: 1, purpose: 'workspace', userId: 'builder_user', sessionId: 'builder_session',
      sandboxId: 'sandbox_legacy', expiresAt: Date.now() + 60_000, allowInternet: false, allowPreview: false
    })).toString('base64url');
    const legacyBuilderSig = createHmac('sha256', TEST_BUILDER_KEY).update(`aira-builder-v1:${legacyBuilderPayload}`).digest('base64url');
    const legacyBuilderToken = `${legacyBuilderPayload}.${legacyBuilderSig}`;
    withEnvironment('production');
    process.env.AIRA_BUILDER_SIGNING_SECRET = TEST_BUILDER_KEY;
    process.env.AIRA_BUILDER_ACCEPT_LEGACY_V1 = 'true';
    assert.equal(verifyTicket(legacyBuilderToken, { userId: 'builder_user', sessionId: 'builder_session' }, 'workspace').sandboxId, 'sandbox_legacy');
    withEnvironment('preview');
    process.env.AIRA_BUILDER_SIGNING_SECRET = TEST_BUILDER_KEY;
    process.env.AIRA_BUILDER_ACCEPT_LEGACY_V1 = 'true';
    assert.throws(() => verifyTicket(legacyBuilderToken, { userId: 'builder_user', sessionId: 'builder_session' }, 'workspace'), /version/i);

    delete process.env.AIRA_BUILDER_SIGNING_SECRET;
    assert.throws(() => signingSecret(), /AIRA_BUILDER_SIGNING_SECRET/);
    process.env.LIGHTNING_SANDBOX_API_KEY = 'synthetic-lightning-key';
    process.env.AIRA_BUILDER_ENABLED = 'true';
    process.env.AIRA_BUILDER_ALLOWED_USER_IDS = 'builder_user';
    assert.equal(builderAccess({ userId: 'builder_user', sessionId: 'builder_session' }).configured, false);
  } finally {
    restore();
  }
});

test('provider-free PR Preview boots, Production and staging retain provider requirements, no mock dispatch', () => {
  const preview = validateApiStartupConfiguration({
    NODE_ENV: 'production', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'pr-branch',
    AIRA_SESSION_SECRET: TEST_SESSION_KEY
  });
  assert.deepEqual(preview.errors, []);

  const productionMissingMigrationPolicy = validateApiStartupConfiguration({
    NODE_ENV: 'production', VERCEL_ENV: 'production', AIRA_SESSION_SECRET: TEST_SESSION_KEY
  });
  assert.equal(productionMissingMigrationPolicy.errors.filter(error => error.includes('must explicitly set')).length, 3);

  const productionBase = {
    NODE_ENV: 'production', VERCEL_ENV: 'production', AIRA_SESSION_SECRET: TEST_SESSION_KEY,
    AIRA_SESSION_ACCEPT_LEGACY_V1: 'false',
    AIRA_BFF_ACCEPT_LEGACY_COOKIE: 'false',
    AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT: 'false',
    NVIDIA_API_KEY: 'synthetic-provider-key'
  } as const;
  assert.deepEqual(validateApiStartupConfiguration(productionBase).errors, [], 'Option A is complete and strict by default');

  const graceDeadline = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
  const optionB = validateApiStartupConfiguration({
    ...productionBase,
    AIRA_SESSION_ACCEPT_LEGACY_V1: 'true',
    AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL: graceDeadline,
    AIRA_BFF_ACCEPT_LEGACY_COOKIE: 'true',
    AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT: 'true'
  });
  assert.deepEqual(optionB.errors, [], 'Option B requires an explicit short UTC deadline');

  const tooLongGrace = validateApiStartupConfiguration({
    ...productionBase,
    AIRA_SESSION_ACCEPT_LEGACY_V1: 'true',
    AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString()
  });
  assert.ok(tooLongGrace.errors.some(error => error.includes('no more than 7 days')));
  const missingDeadline = validateApiStartupConfiguration({
    ...productionBase, AIRA_SESSION_ACCEPT_LEGACY_V1: 'true'
  });
  assert.ok(missingDeadline.errors.some(error => error.includes('requires AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL')));
  const mismatchedDeadline = validateApiStartupConfiguration({
    ...productionBase,
    AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL: graceDeadline
  });
  assert.ok(mismatchedDeadline.errors.some(error => error.includes('must be unset')));
  const ambiguousOAuthPolicy = validateApiStartupConfiguration({
    ...productionBase,
    AIRA_BFF_ACCEPT_LEGACY_DIRECT_OAUTH_JWT: 'true'
  });
  assert.ok(ambiguousOAuthPolicy.errors.some(error => error.includes('requires AIRA_BFF_ACCEPT_LEGACY_COOKIE=true')));
  const nonExactFlag = validateApiStartupConfiguration({
    ...productionBase, AIRA_BFF_ACCEPT_LEGACY_COOKIE: 'TRUE'
  });
  assert.ok(nonExactFlag.errors.some(error => error.includes('exact value true or false')));
  const previewLegacyEnabled = validateApiStartupConfiguration({
    NODE_ENV: 'production', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'pr-branch',
    AIRA_SESSION_SECRET: TEST_SESSION_KEY, AIRA_SESSION_ACCEPT_LEGACY_V1: 'true'
  });
  assert.ok(previewLegacyEnabled.errors.some(error => error.includes('Production-only')));
  const expiredGrace = validateApiStartupConfiguration({
    ...productionBase,
    AIRA_SESSION_ACCEPT_LEGACY_V1: 'true',
    AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL: '2020-01-01T00:00:00.000Z'
  });
  assert.deepEqual(expiredGrace.errors, []);
  assert.equal(expiredGrace.warnings.length, 1, 'expired grace remains bootable but fails closed for v1 tokens');

  const stagingNoProvider = validateApiStartupConfiguration({
    NODE_ENV: 'production', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'staging',
    AIRA_SESSION_SECRET: TEST_SESSION_KEY
  });
  assert.ok(stagingNoProvider.errors.some(error => error.includes('staging deployment requires')));
  const stagingWithProvider = validateApiStartupConfiguration({
    NODE_ENV: 'production', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'staging',
    AIRA_SESSION_SECRET: TEST_SESSION_KEY, NVIDIA_API_KEY: 'synthetic-provider-key'
  });
  assert.deepEqual(stagingWithProvider.errors, []);

  const restore = withEnvironment('preview');
  try {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NVIDIA_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY']) delete process.env[key];
    process.env.AIRA_ALLOW_MOCK = 'true';
    const router = new ModelRouter();
    assert.deepEqual(router.listProviders(), []);
    assert.throws(() => router.resolveExecution('aira-fast'), (error: unknown) => error instanceof ProviderUnavailableError && error.code === 'PROVIDER_UNAVAILABLE');
  } finally {
    restore();
  }
});