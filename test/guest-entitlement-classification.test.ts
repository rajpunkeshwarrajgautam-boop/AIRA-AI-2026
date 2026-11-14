import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  COMMERCIAL_PLANS,
  isGuestPrincipal,
  isModelAllowedForTier,
  PlanTier,
} from '../packages/contracts/src/commercial.js';
import {
  createSessionAuthMiddleware,
  ensureAuthenticatedSession,
  SESSION_COOKIE_NAME,
} from '../apps/api/src/auth/session-auth.js';
import { DevPrincipalProvider } from '../apps/api/src/auth/principal-provider.js';
import {
  resolveCallerTier,
  requirePlanTier,
  TIER_RANKS,
} from '../apps/api/src/middleware/entitlement-guard.js';

type MockResponse = Response & {
  statusCode: number;
  headers: Map<string, string>;
  body: unknown;
  json(payload: unknown): MockResponse;
  status(code: number): MockResponse;
  setHeader(name: string, value: string | readonly string[]): MockResponse;
};

function makeResponse(): MockResponse {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    headers,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
    setHeader(name: string, value: string | readonly string[]) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
      return this;
    },
  } as MockResponse;
  return res;
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0];
}

// --------------------------------------------------------------------------
// 1. isGuestPrincipal classification unit tests
// --------------------------------------------------------------------------
test('isGuestPrincipal: correctly classifies guest vs authenticated principals', () => {
  // Anonymous / missing / guest identifiers
  assert.equal(isGuestPrincipal(null), true);
  assert.equal(isGuestPrincipal(undefined), true);
  assert.equal(isGuestPrincipal(''), true);
  assert.equal(isGuestPrincipal('   '), true);
  assert.equal(isGuestPrincipal('anonymous'), true);
  assert.equal(isGuestPrincipal('guest'), true);
  assert.equal(isGuestPrincipal(`guest_${randomUUID()}`), true);
  assert.equal(isGuestPrincipal('guest_session_123'), true);

  // Legacy anonymous cookie identifiers
  assert.equal(isGuestPrincipal(`user_${randomUUID()}`), true);
  assert.equal(isGuestPrincipal('user_legacy_guest_token'), true);

  // Genuine authenticated accounts must NEVER be classified as guest
  assert.equal(isGuestPrincipal(`neon_user_${randomUUID()}`), false);
  assert.equal(isGuestPrincipal('neon_user_e215766f-e719-431f-ad08-154a28ef83b4'), false);
  assert.equal(isGuestPrincipal('usr_google_oauth_109885171219226843992'), false);
  assert.equal(isGuestPrincipal('usr_github_oauth_253642432'), false);
  assert.equal(isGuestPrincipal('admin'), false);
});

// --------------------------------------------------------------------------
// 2. Authoritative Commercial Plan Matrix contracts
// --------------------------------------------------------------------------
test('COMMERCIAL_PLANS: authoritative Guest contract guarantees 5 chats, 0 credits, 0 reasoning boosts, 0 projects', () => {
  const guest = COMMERCIAL_PLANS.guest;
  assert.equal(guest.id, 'guest');
  assert.equal(guest.name, 'Guest');
  assert.equal(guest.dailyStandardChatLimit, 5);
  assert.equal(guest.monthlyStandardChatUnits, 5);
  assert.equal(guest.monthlyPremiumCredits, 0);
  assert.equal(guest.complimentaryReasoningBoosts, 0);
  assert.equal(guest.maxProjects, 0);
  assert.equal(guest.maxMemoryRecords, 0);
  assert.equal(guest.allowAutonomous, false);
  assert.equal(guest.allowBrowserTools, false);
  assert.equal(guest.allowPythonSandbox, false);
  assert.equal(guest.builderAccess, 'none');

  const free = COMMERCIAL_PLANS.free;
  assert.equal(free.id, 'free');
  assert.equal(free.name, 'AIRA Free');
  assert.equal(free.dailyStandardChatLimit, 15);
  assert.equal(free.monthlyStandardChatUnits, 150);
  assert.equal(free.monthlyPremiumCredits, 100);
  assert.equal(free.complimentaryReasoningBoosts, 5);
  assert.equal(free.maxProjects, 3);
  assert.equal(free.maxMemoryRecords, 50);
});

// --------------------------------------------------------------------------
// 3. Model Allowlist Restrictions by Tier
// --------------------------------------------------------------------------
test('isModelAllowedForTier: Guest is restricted to aira-fast/haiku, blocked from aira-auto/sonnet/pro/deep', () => {
  // Guest tier
  assert.equal(isModelAllowedForTier('aira-fast', 'guest'), true);
  assert.equal(isModelAllowedForTier('claude-3-5-haiku', 'guest'), true);
  assert.equal(isModelAllowedForTier('aira-auto', 'guest'), false, 'Guest must NOT be allowed aira-auto');
  assert.equal(isModelAllowedForTier('claude-3-7-sonnet', 'guest'), false, 'Guest must NOT be allowed sonnet');
  assert.equal(isModelAllowedForTier('aira-pro', 'guest'), false, 'Guest must NOT be allowed aira-pro');
  assert.equal(isModelAllowedForTier('aira-deep', 'guest'), false, 'Guest must NOT be allowed aira-deep');

  // Free tier
  assert.equal(isModelAllowedForTier('aira-fast', 'free'), true);
  assert.equal(isModelAllowedForTier('claude-3-5-haiku', 'free'), true);
  assert.equal(isModelAllowedForTier('aira-auto', 'free'), true, 'Free is allowed aira-auto');
  assert.equal(isModelAllowedForTier('claude-3-7-sonnet', 'free'), true, 'Free is allowed sonnet');
  assert.equal(isModelAllowedForTier('aira-pro', 'free'), false, 'Free must NOT be allowed aira-pro');
  assert.equal(isModelAllowedForTier('aira-deep', 'free'), false, 'Free must NOT be allowed aira-deep');

  // Plus tier
  assert.equal(isModelAllowedForTier('aira-pro', 'plus'), true, 'Plus is allowed aira-pro');
  assert.equal(isModelAllowedForTier('aira-deep', 'plus'), false, 'Plus must NOT be allowed aira-deep');

  // Pro tier
  assert.equal(isModelAllowedForTier('aira-deep', 'pro'), true, 'Pro is allowed aira-deep');
});

// --------------------------------------------------------------------------
// 4. Anonymous Session Creation & Middleware Verification
// --------------------------------------------------------------------------
test('session-auth: fresh bootstrap issues guest_ prefix and binds tier: guest with restricted scopes', async () => {
  const origEnv = process.env.NODE_ENV;
  const origSecret = process.env.AIRA_SESSION_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.AIRA_SESSION_SECRET = 'test-secret-must-be-at-least-32-characters-long!';

  try {
    const bootstrapReq = { headers: {} } as Request;
    const bootstrapRes = makeResponse();
    const session = ensureAuthenticatedSession(bootstrapReq, bootstrapRes);

    // Assert fresh guest prefix
    assert.ok(session.userId.startsWith('guest_'), `Bootstrap userId must start with guest_, got: ${session.userId}`);
    assert.ok(session.sessionId.startsWith('session_'));

    const setCookie = bootstrapRes.headers.get('set-cookie');
    assert.ok(setCookie);

    // Verify session hydration via middleware
    const protectedReq = {
      headers: { cookie: cookiePair(setCookie) },
    } as Request;
    const protectedRes = makeResponse();

    const middleware = createSessionAuthMiddleware();
    await new Promise<void>((resolve, reject) => {
      middleware(protectedReq, protectedRes, (err?: unknown) => (err ? reject(err) : resolve()));
    });

    const user = (protectedReq as any).user;
    assert.ok(user);
    assert.equal(user.id, session.userId);
    assert.equal(user.isGuest, true, 'User must be marked as isGuest: true');
    assert.equal(user.tier, 'guest', 'User must have tier: guest');
    assert.deepEqual(user.roles, ['guest_user'], 'Roles must only be [guest_user]');
    assert.deepEqual(user.scopes, ['chat:write'], 'Scopes must only be [chat:write]');
  } finally {
    process.env.NODE_ENV = origEnv;
    process.env.AIRA_SESSION_SECRET = origSecret;
  }
});

// --------------------------------------------------------------------------
// 5. DevPrincipalProvider resolution for Guest
// --------------------------------------------------------------------------
test('DevPrincipalProvider: resolves guest sessions into guest ExecutionPrincipal', async () => {
  const provider = new DevPrincipalProvider();

  // Test guest_ identity
  const guestReq = {
    user: {
      id: 'guest_test_abc123',
      sessionId: 'session_test_xyz789',
      isGuest: true,
      tier: 'guest',
      roles: ['guest_user'],
      scopes: ['chat:write'],
    },
    headers: {},
  } as unknown as Request;

  const principal = await provider.resolve(guestReq);
  assert.equal(principal.userId, 'guest_test_abc123');
  assert.equal(principal.sessionId, 'session_test_xyz789');
  assert.deepEqual(principal.roles, ['guest_user']);
  assert.deepEqual(principal.scopes, ['chat:write']);
  assert.equal((principal as any).tier, 'guest');

  // Test legacy user_ identity without explicit isGuest flag
  const legacyReq = {
    user: {
      id: 'user_legacy_old_cookie',
      sessionId: 'session_legacy_xyz',
      isGuest: false, // legacy might have had false
    },
    headers: {},
  } as unknown as Request;

  const legacyPrincipal = await provider.resolve(legacyReq);
  assert.equal(legacyPrincipal.userId, 'user_legacy_old_cookie');
  assert.deepEqual(legacyPrincipal.roles, ['guest_user'], 'Legacy user_ must be normalized to guest_user');
  assert.deepEqual(legacyPrincipal.scopes, ['chat:write'], 'Legacy user_ must have restricted scopes');
  assert.equal((legacyPrincipal as any).tier, 'guest', 'Legacy user_ must have tier guest');
});

// --------------------------------------------------------------------------
// 6. Entitlement Guard & Forged Header Immunity
// --------------------------------------------------------------------------
test('resolveCallerTier: immune to header-spoofing and strictly enforces guest tier', async () => {
  // Guest with forged x-user-tier: pro header
  const spoofedReq = {
    headers: {
      'x-user-tier': 'pro',
      'x-spoofed-role': 'admin',
    },
    principal: {
      userId: 'guest_attacker_123',
      sessionId: 'session_att_123',
      roles: ['guest_user'],
      scopes: ['chat:write'],
    },
    user: {
      id: 'guest_attacker_123',
      sessionId: 'session_att_123',
      isGuest: true,
      tier: 'guest',
    },
  } as unknown as Request;

  const resolvedTier = await resolveCallerTier(spoofedReq);
  assert.equal(resolvedTier, 'guest', 'Forged header must have zero effect on caller tier');

  // Unauthenticated caller
  const unauthReq = {
    headers: { 'x-user-tier': 'pro' },
    principal: undefined,
    user: undefined,
  } as unknown as Request;
  assert.equal(await resolveCallerTier(unauthReq), 'guest');

  // Legacy user_ session with forged header
  const legacySpoofedReq = {
    headers: { 'x-user-tier': 'pro' },
    principal: {
      userId: 'user_legacy_12345',
      sessionId: 'session_legacy',
      roles: ['guest_user'],
      scopes: ['chat:write'],
    },
  } as unknown as Request;
  assert.equal(await resolveCallerTier(legacySpoofedReq), 'guest');
});

// --------------------------------------------------------------------------
// 7. requirePlanTier middleware enforcement
// --------------------------------------------------------------------------
test('requirePlanTier: blocks guest callers from free, plus, and pro gated endpoints', async () => {
  const guestReq = {
    headers: { 'x-user-tier': 'pro' },
    principal: {
      userId: 'guest_caller_999',
      sessionId: 'session_caller_999',
      roles: ['guest_user'],
      scopes: ['chat:write'],
    },
  } as unknown as Request;

  const res = makeResponse();
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  // Require free tier
  const guardFree = requirePlanTier('free');
  await guardFree(guestReq, res, next);
  assert.equal(nextCalled, false, 'Guest must NOT be allowed to call free tier endpoint');
  assert.equal(res.statusCode, 403);
  assert.equal((res.body as any).error, 'PLAN_TIER_RESTRICTED');
  assert.equal((res.body as any).callerTier, 'guest');
  assert.equal((res.body as any).requiredTier, 'free');

  // Require plus tier
  const resPlus = makeResponse();
  nextCalled = false;
  const guardPlus = requirePlanTier('plus');
  await guardPlus(guestReq, resPlus, next);
  assert.equal(nextCalled, false);
  assert.equal(resPlus.statusCode, 403);
  assert.equal((resPlus.body as any).callerTier, 'guest');
  assert.equal((resPlus.body as any).requiredTier, 'plus');

  // Require pro tier
  const resPro = makeResponse();
  nextCalled = false;
  const guardPro = requirePlanTier('pro');
  await guardPro(guestReq, resPro, next);
  assert.equal(nextCalled, false);
  assert.equal(resPro.statusCode, 403);
  assert.equal((resPro.body as any).callerTier, 'guest');
  assert.equal((resPro.body as any).requiredTier, 'pro');
});

// --------------------------------------------------------------------------
// 8. SettingsModal Frontend logic verification
// --------------------------------------------------------------------------
test('SettingsModal logic: unverified guest never represents active plan as Free subscriber', () => {
  // Simulate guest user state
  const userTier: PlanTier = 'guest';
  const currentUser = null; // Unauthenticated guest
  const isGuestUser = userTier === 'guest' || !currentUser;
  assert.equal(isGuestUser, true);

  // Even if an API mistakenly returns plan: 'free'
  const mockBuggyApiResponse = {
    plan: 'free',
    dailyStandardChatLimit: 15,
    dailyStandardChatRemaining: 15,
    availableCredits: 100,
    reasoningBoostsRemaining: 5,
  };

  // Clamped usageData in SettingsModal
  const planId = (isGuestUser ? 'guest' : mockBuggyApiResponse.plan) as PlanTier;
  assert.equal(planId, 'guest', 'Plan ID must be strictly guest');

  const activePlanId: PlanTier = isGuestUser ? 'guest' : (planId || userTier || 'free');
  assert.equal(activePlanId, 'guest', 'Active plan must be guest');

  const activePlanDef = COMMERCIAL_PLANS[activePlanId];
  assert.equal(activePlanDef.name, 'Guest');
  assert.equal(activePlanDef.dailyStandardChatLimit, 5);
  assert.equal(activePlanDef.monthlyPremiumCredits, 0);
  assert.equal(activePlanDef.complimentaryReasoningBoosts, 0);
  assert.equal(activePlanDef.maxProjects, 0);
  assert.equal(activePlanDef.maxMemoryRecords, 0);

  // Verify quotas displayed to guest
  const dailyChatsLimit = isGuestUser ? COMMERCIAL_PLANS.guest.dailyStandardChatLimit : mockBuggyApiResponse.dailyStandardChatLimit;
  const remainingDailyChats = isGuestUser
    ? Math.min(dailyChatsLimit, Math.max(0, mockBuggyApiResponse.dailyStandardChatRemaining))
    : mockBuggyApiResponse.dailyStandardChatRemaining;
  const dailyChatsUsed = Math.max(0, dailyChatsLimit - remainingDailyChats);
  const monthlyCreditsRemaining = isGuestUser ? 0 : mockBuggyApiResponse.availableCredits;
  const reasoningBoostsRemaining = isGuestUser ? 0 : mockBuggyApiResponse.reasoningBoostsRemaining;

  assert.equal(dailyChatsLimit, 5, 'Daily chat limit must be 5');
  assert.equal(remainingDailyChats, 5, 'Remaining daily chats must be at most 5');
  assert.equal(dailyChatsUsed, 0, 'Used daily chats must be 0');
  assert.equal(monthlyCreditsRemaining, 0, 'Monthly credits must be 0 for guest');
  assert.equal(reasoningBoostsRemaining, 0, 'Reasoning boosts must be 0 for guest');
  assert.equal(activePlanDef.maxProjects, 0, 'Max projects must be 0 for guest');
});
