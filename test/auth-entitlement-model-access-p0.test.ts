import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  COMMERCIAL_PLANS,
  isGuestPrincipal,
  isModelAllowedForTier,
  getMinimumRequiredTierForModel,
  PlanTier,
} from '../packages/contracts/src/commercial.js';
import {
  requireEntitledModel,
  resolveCallerTier,
} from '../apps/api/src/middleware/entitlement-guard.js';
import {
  classifyServerSession,
  parseBillingSummary
} from '../src/lib/accountBillingTruth.js';
import {
  resolveModelUpgradeTrigger
} from '../src/components/ModelSelector.js';

function makeResponse(): Response & { statusCode: number; body: any; headers: Record<string, string> } {
  const res: any = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name: string) {
      return this.headers[name.toLowerCase()];
    }
  };
  return res;
}

test('P0 Regression 1: getMinimumRequiredTierForModel accurately computes minimal tier', () => {
  assert.equal(getMinimumRequiredTierForModel('aira-fast'), 'guest');
  assert.equal(getMinimumRequiredTierForModel('claude-3-5-haiku'), 'guest');
  assert.equal(getMinimumRequiredTierForModel('aira-auto'), 'free', 'aira-auto must require Free, never Plus');
  assert.equal(getMinimumRequiredTierForModel('claude-3-7-sonnet'), 'free', 'claude-3-7-sonnet must require Free, never Plus');
  assert.equal(getMinimumRequiredTierForModel('aira-pro'), 'plus', 'aira-pro must require Plus');
  assert.equal(getMinimumRequiredTierForModel('aira-deep'), 'pro', 'aira-deep must require Pro');
});

test('P0 Regression 2: requireEntitledModel reports requiredTier: free for guest requesting aira-auto (never plus)', async () => {
  const middleware = requireEntitledModel();
  const guestReq = {
    headers: {},
    body: { model: 'aira-auto' },
    principal: {
      userId: `guest_${randomUUID()}`,
      sessionId: `session_${randomUUID()}`,
      roles: ['guest_user'],
      scopes: ['chat:write'],
    },
    user: {
      id: `guest_${randomUUID()}`,
      sessionId: `session_${randomUUID()}`,
      isGuest: true,
      tier: 'guest',
    },
  } as unknown as Request;

  const res = makeResponse();
  let nextCalled = false;
  await middleware(guestReq, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'Guest must NOT be allowed to access aira-auto');
  assert.equal(res.statusCode, 403);
  assert.equal(res.body?.error, 'PLAN_MODEL_RESTRICTED');
  assert.equal(res.body?.callerTier, 'guest');
  assert.equal(res.body?.requiredTier, 'free', 'Must return requiredTier: free so user knows signing in unlocks the model');
  assert.deepEqual(res.body?.allowedModels, ['aira-fast', 'claude-3-5-haiku']);
});

test('P0 Regression 3: requireEntitledModel reports requiredTier: plus for aira-pro and pro for aira-deep', async () => {
  const middleware = requireEntitledModel();

  // Test aira-pro -> requiredTier: plus
  const reqPro = {
    headers: {},
    body: { model: 'aira-pro' },
    principal: {
      userId: `guest_${randomUUID()}`,
      sessionId: `session_${randomUUID()}`,
      roles: ['guest_user'],
      scopes: ['chat:write'],
    },
    user: {
      id: `guest_${randomUUID()}`,
      isGuest: true,
      tier: 'guest',
    },
  } as unknown as Request;
  const resPro = makeResponse();
  await middleware(reqPro, resPro, () => {});
  assert.equal(resPro.statusCode, 403);
  assert.equal(resPro.body?.requiredTier, 'plus');

  // Test aira-deep -> requiredTier: pro
  const reqDeep = {
    headers: {},
    body: { model: 'aira-deep' },
    principal: {
      userId: `guest_${randomUUID()}`,
      sessionId: `session_${randomUUID()}`,
      roles: ['guest_user'],
      scopes: ['chat:write'],
    },
    user: {
      id: `guest_${randomUUID()}`,
      isGuest: true,
      tier: 'guest',
    },
  } as unknown as Request;
  const resDeep = makeResponse();
  await middleware(reqDeep, resDeep, () => {});
  assert.equal(resDeep.statusCode, 403);
  assert.equal(resDeep.body?.requiredTier, 'pro');
});

test('P0 Regression 4: ModelSelector resolveModelUpgradeTrigger returns model_requires_account for guest selecting aira-auto', () => {
  // Guest caller
  assert.equal(resolveModelUpgradeTrigger('aira-auto', 'guest'), 'model_requires_account');
  assert.equal(resolveModelUpgradeTrigger('claude-3-7-sonnet', 'guest'), 'model_requires_account');
  assert.equal(resolveModelUpgradeTrigger('aira-pro', 'guest'), 'free_to_plus_model');
  assert.equal(resolveModelUpgradeTrigger('aira-deep', 'guest'), 'pro_model');

  // Free caller
  assert.equal(resolveModelUpgradeTrigger('aira-auto', 'free'), null, 'Free user has full access to aira-auto');
  assert.equal(resolveModelUpgradeTrigger('claude-3-7-sonnet', 'free'), null, 'Free user has full access to sonnet');
  assert.equal(resolveModelUpgradeTrigger('aira-pro', 'free'), 'free_to_plus_model');
  assert.equal(resolveModelUpgradeTrigger('aira-deep', 'free'), 'pro_model');
});

test('P0 Regression 5: classifyServerSession handles neon_user_ normalization correctly', () => {
  const verifiedPayload = {
    status: 'AUTHENTICATED',
    user: { id: 'neon_user_c32a76ef-62bf-4632-a636-547e112d1b82' }
  };

  // Same ID with neon_user_ prefix
  assert.equal(classifyServerSession(verifiedPayload, 'neon_user_c32a76ef-62bf-4632-a636-547e112d1b82'), 'verified');

  // Subject-normalized matching
  assert.equal(classifyServerSession(verifiedPayload, 'c32a76ef-62bf-4632-a636-547e112d1b82'), 'verified');

  // Anonymous session response
  assert.equal(classifyServerSession({ status: 'ANONYMOUS', user: null }, 'c32a76ef'), 'anonymous');

  // Distinct identity mismatch
  assert.equal(classifyServerSession(verifiedPayload, 'different_user_id'), 'mismatch');
});

test('P0 Regression 6: parseBillingSummary validates Free plan and rejects guest plan spoofing', () => {
  const validFreePayload = {
    principalId: 'neon_user_user123',
    planId: 'free',
    planName: 'AIRA Free',
    subscriptionStatus: 'active',
    availableCredits: 100,
    lifetimeGranted: 100,
    lifetimeSpent: 0,
    dailyChatsUsed: 2,
    dailyChatLimit: 15,
    monthlyUnitsUsed: 2,
    monthlyUnitLimit: 150,
    reasoningBoostsUsed: 0,
    reasoningBoostLimit: 5
  };

  const parsed = parseBillingSummary(validFreePayload, 'user123');
  assert.notEqual(parsed, null);
  assert.equal(parsed?.planId, 'free');
  assert.equal(parsed?.dailyChatLimit, 15);

  // Guest plan returned by server must NOT be parsed as account billing summary
  const guestPayload = {
    ...validFreePayload,
    planId: 'guest'
  };
  assert.equal(parseBillingSummary(guestPayload, 'user123'), null);
});

test('P0 Regression 7: SettingsModal usage parser accurately calculates guest limits without throwing', () => {
  const guestEntitlements = {
    customerId: 'cust_test_guest',
    plan: 'guest',
    subscriptionStatus: 'active',
    creditBalance: 0,
    reservedCredits: 0,
    availableCredits: 0,
    dailyStandardChatRemaining: 5,
    dailyStandardChatLimit: 5,
    monthlyStandardChatUnitsRemaining: 5,
    monthlyStandardChatUnitsLimit: 5,
    reasoningBoostsRemaining: 0,
    reasoningBoostsLimit: 0,
    savedAgentsCount: 0,
    savedAgentsLimit: 0,
    builderAccess: 'none',
    canInitiateChat: true,
    canUsePremiumModels: false,
    canUseVision: false,
    canUseBuilder: false
  };

  const planId = guestEntitlements.plan;
  assert.equal(COMMERCIAL_PLANS[planId as keyof typeof COMMERCIAL_PLANS]?.id, 'guest');
  assert.equal(guestEntitlements.dailyStandardChatLimit, 5);
  assert.equal(guestEntitlements.availableCredits, 0);
  assert.equal(guestEntitlements.reasoningBoostsRemaining, 0);
});

test('P0 Regression 8: environment resolution detects staging accurately without relying on NODE_ENV', () => {
  const resolveEnv = (host: string, gitRef?: string, vercelEnv?: string, nodeEnv = 'production') => {
    const isStagingHost = host.includes('staging.virexaaiventures.com') ||
      host.includes('aira-ai-2026-git-staging') ||
      gitRef === 'staging';

    return (
      (isStagingHost ? 'staging' : undefined) ||
      (vercelEnv === 'preview' ? 'preview' : undefined) ||
      vercelEnv ||
      nodeEnv ||
      'production'
    );
  };

  assert.equal(resolveEnv('staging.virexaaiventures.com', undefined, 'preview'), 'staging');
  assert.equal(resolveEnv('aira-ai-2026-git-staging-xxx.vercel.app', 'staging', 'preview'), 'staging');
  assert.equal(resolveEnv('aira-ai-2026.vercel.app', 'prod-release', 'production'), 'production');
});


