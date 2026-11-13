import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  getMinimumRequiredTierForFeature,
  getMinimumRequiredTierForModel,
  isFeatureAllowedForTier,
  isModelAllowedForTier
} from '../packages/contracts/src/commercial.js';
import { resolveModelUpgradeTrigger } from '../src/components/ModelSelector.js';

// Configure test environment
process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.AIRA_SESSION_SECRET = process.env.AIRA_SESSION_SECRET || 'test-secret-at-least-32-chars-long-for-testing';
process.env.ALLOWED_ORIGINS = 'https://aira-ai-2026.vercel.app,http://localhost:5173';

const { default: app } = await import('../apps/api/src/index.js');

let server: http.Server;
let baseUrl: string;

test.before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

test('API-01: Commercial contracts define accurate minimum tiers per capability and model', () => {
  // Autonomous missions start at Plus
  assert.equal(getMinimumRequiredTierForFeature('autonomous'), 'plus');
  assert.equal(isFeatureAllowedForTier('autonomous', 'guest'), false);
  assert.equal(isFeatureAllowedForTier('autonomous', 'free'), false);
  assert.equal(isFeatureAllowedForTier('autonomous', 'plus'), true);
  assert.equal(isFeatureAllowedForTier('autonomous', 'pro'), true);

  // Python sandbox requires Pro
  assert.equal(getMinimumRequiredTierForFeature('python_sandbox'), 'pro');
  assert.equal(isFeatureAllowedForTier('python_sandbox', 'plus'), false);
  assert.equal(isFeatureAllowedForTier('python_sandbox', 'pro'), true);

  // Models minimum tiers
  assert.equal(getMinimumRequiredTierForModel('aira-auto'), 'free');
  assert.equal(getMinimumRequiredTierForModel('aira-pro'), 'plus');
  assert.equal(getMinimumRequiredTierForModel('aira-deep'), 'pro');
});

test('API-01: Autonomous task endpoints enforce fail-closed Plus minimum tier with accurate error message', async () => {
  // 1. Unauthenticated / anonymous caller fails closed with 401
  const anonRes = await fetch(`${baseUrl}/api/agent/autonomous/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://aira-ai-2026.vercel.app',
      'x-aira-csrf-protection': '1',
    },
    body: JSON.stringify({ objective: 'Autonomous task probe' }),
  });
  assert.equal(anonRes.status, 401);

  // 2. Authenticated Free caller fails closed with 403 and accurate minimum tier (plus)
  const authRes = await fetch(`${baseUrl}/api/agent/autonomous/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://aira-ai-2026.vercel.app',
      'x-aira-csrf-protection': '1',
      'x-test-user-id': 'usr_free_account_1',
      'x-test-session-id': 'sess_free_account_1',
    },
    body: JSON.stringify({ objective: 'Autonomous task probe' }),
  });

  const authText = await authRes.clone().text();
  if (authRes.status !== 403) {
    console.error('DEBUG authRes:', authRes.status, authText);
  }
  assert.equal(authRes.status, 403);
  const authData = await authRes.json() as any;
  assert.equal(authData.error, 'PLAN_CAPABILITY_RESTRICTED');
  assert.equal(authData.requiredTier, 'plus');
  assert.ok(authData.message.includes('AIRA Plus or higher'));
  // Ensure it does NOT demand hardcoded Pro when Plus suffices
  assert.ok(!authData.message.includes('requires AIRA Pro only'));
});

test('UX-01 & UX-02: resolveModelUpgradeTrigger correctly maps tier boundaries and locks', () => {
  // Guest attempting to select AIRA Auto (requires account, free tier)
  assert.equal(resolveModelUpgradeTrigger('aira-auto', 'guest'), 'model_requires_account');

  // Guest attempting to select AIRA Pro
  assert.equal(resolveModelUpgradeTrigger('aira-pro', 'guest'), 'free_to_plus_model');

  // Free tier selecting AIRA Pro -> routes to Plus upgrade
  assert.equal(resolveModelUpgradeTrigger('aira-pro', 'free'), 'free_to_plus_model');

  // Free tier selecting AIRA Deep -> routes to Pro upgrade
  assert.ok(['pro_model', 'free_to_pro_model'].includes(resolveModelUpgradeTrigger('aira-deep', 'free')!));

  // Plus tier selecting AIRA Deep -> routes to Pro upgrade
  assert.equal(resolveModelUpgradeTrigger('aira-deep', 'plus'), 'plus_to_pro_model');

  // Authorized tiers return null (no upgrade modal triggered)
  assert.equal(resolveModelUpgradeTrigger('aira-auto', 'free'), null);
  assert.equal(resolveModelUpgradeTrigger('aira-pro', 'plus'), null);
  assert.equal(resolveModelUpgradeTrigger('aira-deep', 'pro'), null);
});

test('OPS-01: /api/health reports truthful provider status without false ONLINE claims', async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    headers: {
      Origin: 'https://aira-ai-2026.vercel.app',
    },
  });

  assert.equal(res.status, 200);
  const data = await res.json() as any;
  
  // Verify provider map exists and is truthful
  assert.ok(data.providers && typeof data.providers === 'object');
  for (const [provider, status] of Object.entries(data.providers)) {
    // Status must be registered / not_registered / unexercised, NEVER a fake 'ONLINE'
    assert.ok(
      ['registered', 'not_configured', 'initialized'].includes(status as string),
      `Provider ${provider} had unexpected status: ${status}`
    );
    assert.notEqual(status, 'ONLINE', `Provider ${provider} must not falsely claim ONLINE`);
  }
});

test('OPS-01: /api/health/diagnostics is protected and rejects non-operator callers', async () => {
  // Anonymous caller
  const res = await fetch(`${baseUrl}/api/health/diagnostics`, {
    headers: {
      Origin: 'https://aira-ai-2026.vercel.app',
    },
  });

  assert.equal(res.status, 403);
  const data = await res.json() as any;
  assert.equal(data.error, 'OPERATOR_ACCESS_REQUIRED');
});

test('HARDEN-01: API responses include required defensive HTTP security headers', async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    headers: {
      Origin: 'https://aira-ai-2026.vercel.app',
    },
  });

  assert.equal(res.status, 200);
  // Verify Cache-Control no-store on sensitive API routes
  const cacheControl = res.headers.get('cache-control');
  assert.ok(cacheControl && cacheControl.includes('no-store'), 'Expected cache-control no-store');

  // Verify X-Content-Type-Options
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  // Verify X-Frame-Options
  assert.equal(res.headers.get('x-frame-options'), 'DENY');

  // Verify absence of X-Powered-By
  assert.equal(res.headers.get('x-powered-by'), null);
});
