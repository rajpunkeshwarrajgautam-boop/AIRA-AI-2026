import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PlanTierSchema,
  type PlanTier,
  PlanDefinitionSchema,
  COMMERCIAL_PLANS,
  PLAN_MODEL_ALLOWLIST,
  PLAN_CAPABILITY_MATRIX,
  isModelAllowedForTier,
  isFeatureAllowedForTier,
  FeatureFlagKeySchema,
  ALL_FEATURE_FLAG_KEYS,
  type FeatureFlagKey,
  FeatureFlagsSchema,
  DEFAULT_TIER_FEATURE_FLAGS,
  evaluateFeatureFlags,
  isFeatureFlagEnabled,
  AnnouncementCategorySchema,
  AnnouncementSchema,
  ANNOUNCEMENT_REGISTRY,
  getAnnouncementById,
  getLatestAnnouncement,
  getAnnouncementsForTier
} from '../packages/contracts/src/index.js';

// ==========================================
// 1. PLAN TIER SCHEMA & COMMERCIAL PLANS
// ==========================================

test('PlanTierSchema: validates all 4 canonical plan tiers and rejects invalid ones', () => {
  const validTiers: PlanTier[] = ['guest', 'free', 'plus', 'pro'];
  for (const tier of validTiers) {
    const parsed = PlanTierSchema.safeParse(tier);
    assert.equal(parsed.success, true, `Expected tier "${tier}" to be valid`);
  }

  const invalidTiers = ['enterprise', 'trial', 'admin', 'ultra', '', 'GUEST'];
  for (const tier of invalidTiers) {
    const parsed = PlanTierSchema.safeParse(tier);
    assert.equal(parsed.success, false, `Expected tier "${tier}" to be rejected`);
  }
});

test('COMMERCIAL_PLANS: defines all 4 tiers adhering to PlanDefinitionSchema', () => {
  const tiers: PlanTier[] = ['guest', 'free', 'plus', 'pro'];

  for (const tier of tiers) {
    const plan = COMMERCIAL_PLANS[tier];
    assert.ok(plan, `COMMERCIAL_PLANS must have entry for tier: ${tier}`);
    const parseResult = PlanDefinitionSchema.safeParse(plan);
    assert.equal(parseResult.success, true, `Plan ${tier} must satisfy PlanDefinitionSchema: ${JSON.stringify(parseResult)}`);
  }
});

test('COMMERCIAL_PLANS.guest: satisfies exact Guest trial specifications', () => {
  const guest = COMMERCIAL_PLANS.guest;
  assert.equal(guest.id, 'guest');
  assert.equal(guest.planTier, 'guest');
  assert.equal(guest.name, 'Guest');
  assert.equal(guest.description, 'Basic AI trial session');
  assert.deepEqual(guest.pricing, { INR: 0, USD: 0 });
  assert.equal(guest.billingInterval, 'monthly');
  assert.equal(guest.dailyStandardChatLimit, 5);
  assert.equal(guest.monthlyStandardChatUnits, 5);
  assert.equal(guest.complimentaryReasoningBoosts, 0);
  assert.equal(guest.monthlyPremiumCredits, 0);
  assert.equal(guest.builderAccess, 'none');
  assert.equal(guest.concurrentInferenceLimit, 1);
  assert.equal(guest.maxProjects, 0);
  assert.equal(guest.maxMemoryRecords, 0);
  assert.equal(guest.allowAutonomous, false);
  assert.equal(guest.allowBrowserTools, false);
  assert.equal(guest.allowPythonSandbox, false);
});

test('COMMERCIAL_PLANS.free: satisfies exact Free tier specifications', () => {
  const free = COMMERCIAL_PLANS.free;
  assert.equal(free.id, 'free');
  assert.equal(free.planTier, 'free');
  assert.equal(free.name, 'AIRA Free');
  assert.deepEqual(free.pricing, { INR: 0, USD: 0 });
  assert.equal(free.dailyStandardChatLimit, 15);
  assert.equal(free.monthlyStandardChatUnits, 150);
  assert.equal(free.complimentaryReasoningBoosts, 5);
  assert.equal(free.monthlyPremiumCredits, 100);
  assert.equal(free.builderAccess, 'none');
  assert.equal(free.concurrentInferenceLimit, 1);
  assert.equal(free.maxProjects, 3);
  assert.equal(free.maxMemoryRecords, 50);
  assert.equal(free.allowAutonomous, false);
  assert.equal(free.allowBrowserTools, false);
  assert.equal(free.allowPythonSandbox, false);
});

test('COMMERCIAL_PLANS.plus: satisfies exact Plus tier specifications', () => {
  const plus = COMMERCIAL_PLANS.plus;
  assert.equal(plus.id, 'plus');
  assert.equal(plus.planTier, 'plus');
  assert.equal(plus.name, 'AIRA Plus');
  assert.equal(plus.pricing, undefined, 'Unapproved Plus pricing must not be published');
  assert.deepEqual(plus.prices, []);
  assert.equal(plus.dailyStandardChatLimit, 50);
  assert.equal(plus.monthlyStandardChatUnits, 700);
  assert.equal(plus.complimentaryReasoningBoosts, 50);
  assert.equal(plus.monthlyPremiumCredits, 3000);
  assert.equal(plus.savedAgentsLimit, 3);
  assert.equal(plus.builderAccess, 'trial');
  assert.equal(plus.concurrentInferenceLimit, 1);
  assert.equal(plus.maxProjects, 10);
  assert.equal(plus.maxMemoryRecords, 250);
  assert.equal(plus.allowAutonomous, true);
  assert.equal(plus.allowBrowserTools, false);
  assert.equal(plus.allowPythonSandbox, false);
});

test('COMMERCIAL_PLANS.pro: satisfies exact Pro tier specifications', () => {
  const pro = COMMERCIAL_PLANS.pro;
  assert.equal(pro.id, 'pro');
  assert.equal(pro.planTier, 'pro');
  assert.equal(pro.name, 'AIRA Pro');
  assert.equal(pro.pricing, undefined, 'Unapproved Pro pricing must not be published');
  assert.deepEqual(pro.prices, []);
  assert.equal(pro.dailyStandardChatLimit, 150);
  assert.equal(pro.monthlyStandardChatUnits, 2000);
  assert.equal(pro.complimentaryReasoningBoosts, 200);
  assert.equal(pro.monthlyPremiumCredits, 7500);
  assert.equal(pro.savedAgentsLimit, 20);
  assert.equal(pro.builderAccess, 'metered');
  assert.equal(pro.concurrentInferenceLimit, 2);
  assert.equal(pro.maxProjects, -1);
  assert.equal(pro.maxMemoryRecords, -1);
  assert.equal(pro.allowAutonomous, true);
  assert.equal(pro.allowBrowserTools, true);
  assert.equal(pro.allowPythonSandbox, true);
});

// ==========================================
// 2. MODEL ALLOWLIST & ACCESS CONTROL
// ==========================================

test('PLAN_MODEL_ALLOWLIST: contains exact authoritative model lists per tier', () => {
  assert.deepEqual(
    [...PLAN_MODEL_ALLOWLIST.guest],
    ['aira-fast', 'claude-3-5-haiku']
  );

  assert.deepEqual(
    [...PLAN_MODEL_ALLOWLIST.free],
    [
      'aira-fast',
      'claude-3-5-haiku',
      'aira-auto',
      'claude-3-7-sonnet'
    ]
  );

  assert.deepEqual(
    [...PLAN_MODEL_ALLOWLIST.plus],
    [
      'aira-fast',
      'claude-3-5-haiku',
      'aira-auto',
      'claude-3-7-sonnet',
      'aira-pro',
      'claude-3-5-sonnet',
      'nvidia/llama-3.1-nemotron-70b-instruct'
    ]
  );

  assert.deepEqual(
    [...PLAN_MODEL_ALLOWLIST.pro],
    [
      'aira-fast',
      'claude-3-5-haiku',
      'aira-auto',
      'claude-3-7-sonnet',
      'aira-pro',
      'claude-3-5-sonnet',
      'aira-deep',
      'claude-3-opus',
      'nvidia/llama-3.1-nemotron-70b-instruct'
    ]
  );
});

test('isModelAllowedForTier: evaluates model access correctly across tiers', () => {
  // Guest
  assert.equal(isModelAllowedForTier('aira-fast', 'guest'), true);
  assert.equal(isModelAllowedForTier('llama-3.1-8b-instant', 'guest'), false);
  assert.equal(isModelAllowedForTier('claude-3-5-haiku', 'guest'), true); // mapped alias to aira-fast
  assert.equal(isModelAllowedForTier('aira-auto', 'guest'), false);
  assert.equal(isModelAllowedForTier('aira-pro', 'guest'), false);
  assert.equal(isModelAllowedForTier('gpt-4o', 'guest'), false);

  // Free
  assert.equal(isModelAllowedForTier('aira-fast', 'free'), true);
  assert.equal(isModelAllowedForTier('aira-auto', 'free'), true);
  assert.equal(isModelAllowedForTier('llama-3.3-70b-versatile', 'free'), false);
  assert.equal(isModelAllowedForTier('gemini-3.5-flash-lite', 'free'), false);
  assert.equal(isModelAllowedForTier('aira-pro', 'free'), false);
  assert.equal(isModelAllowedForTier('gpt-4o', 'free'), false);
  assert.equal(isModelAllowedForTier('claude-3-5-sonnet', 'free'), false);

  // Plus
  assert.equal(isModelAllowedForTier('aira-fast', 'plus'), true);
  assert.equal(isModelAllowedForTier('aira-auto', 'plus'), true);
  assert.equal(isModelAllowedForTier('aira-pro', 'plus'), true);
  assert.equal(isModelAllowedForTier('gpt-4o-mini', 'plus'), false);
  assert.equal(isModelAllowedForTier('gemini-2-5-flash', 'plus'), false);
  assert.equal(isModelAllowedForTier('gpt-4o', 'plus'), false); // Pro only
  assert.equal(isModelAllowedForTier('claude-3-5-sonnet', 'plus'), true); // Browser alias resolves to aira-pro
  assert.equal(isModelAllowedForTier('gemini-2-5-pro', 'plus'), false); // Pro only
  assert.equal(isModelAllowedForTier('aira-deep', 'plus'), false); // Pro only

  // Pro
  assert.equal(isModelAllowedForTier('aira-fast', 'pro'), true);
  assert.equal(isModelAllowedForTier('aira-auto', 'pro'), true);
  assert.equal(isModelAllowedForTier('aira-pro', 'pro'), true);
  assert.equal(isModelAllowedForTier('aira-deep', 'pro'), true);
  assert.equal(isModelAllowedForTier('gpt-4o', 'pro'), false);
  assert.equal(isModelAllowedForTier('claude-3-5-sonnet', 'pro'), true);
  assert.equal(isModelAllowedForTier('gemini-2-5-pro', 'pro'), false);
  assert.equal(isModelAllowedForTier('meta/llama-3.1-405b-instruct', 'pro'), true);

  // Invalid / Unknown models
  assert.equal(isModelAllowedForTier('', 'pro'), false);
  assert.equal(isModelAllowedForTier('unknown-model-xyz', 'pro'), false);
  assert.equal(isModelAllowedForTier('arbitrary_malicious_string', 'guest'), false);
});

// ==========================================
// 3. CAPABILITY MATRIX & FEATURE ENTITLEMENTS
// ==========================================

test('PLAN_CAPABILITY_MATRIX: matches COMMERCIAL_PLANS quotas exactly', () => {
  const tiers: PlanTier[] = ['guest', 'free', 'plus', 'pro'];
  for (const tier of tiers) {
    const caps = PLAN_CAPABILITY_MATRIX[tier];
    const plan = COMMERCIAL_PLANS[tier];
    assert.equal(caps.maxProjects, plan.maxProjects);
    assert.equal(caps.maxMemoryRecords, plan.maxMemoryRecords);
    assert.equal(caps.allowAutonomous, plan.allowAutonomous);
    assert.equal(caps.allowBrowserTools, plan.allowBrowserTools);
    assert.equal(caps.allowPythonSandbox, plan.allowPythonSandbox);
    assert.equal(caps.concurrentInferenceLimit, plan.concurrentInferenceLimit);
    assert.equal(caps.dailyStandardChatLimit, plan.dailyStandardChatLimit);
    assert.equal(caps.monthlyStandardChatUnits, plan.monthlyStandardChatUnits);
    assert.equal(caps.monthlyPremiumCredits, plan.monthlyPremiumCredits);
    assert.equal(caps.complimentaryReasoningBoosts, plan.complimentaryReasoningBoosts);
  }
});

test('isFeatureAllowedForTier: checks autonomous, browser tools, sandbox, and resources', () => {
  // Autonomous Agent mode
  assert.equal(isFeatureAllowedForTier('autonomous', 'guest'), false);
  assert.equal(isFeatureAllowedForTier('autonomous', 'free'), false);
  assert.equal(isFeatureAllowedForTier('autonomous', 'plus'), true);
  assert.equal(isFeatureAllowedForTier('autonomous', 'pro'), true);

  // Browser tools
  assert.equal(isFeatureAllowedForTier('browser_tools', 'guest'), false);
  assert.equal(isFeatureAllowedForTier('browser_tools', 'free'), false);
  assert.equal(isFeatureAllowedForTier('browser_tools', 'plus'), false);
  assert.equal(isFeatureAllowedForTier('browser_tools', 'pro'), true);

  // Python sandbox
  assert.equal(isFeatureAllowedForTier('python_sandbox', 'guest'), false);
  assert.equal(isFeatureAllowedForTier('python_sandbox', 'free'), false);
  assert.equal(isFeatureAllowedForTier('python_sandbox', 'plus'), false);
  assert.equal(isFeatureAllowedForTier('python_sandbox', 'pro'), true);

  // Projects capability
  assert.equal(isFeatureAllowedForTier('projects', 'guest'), false);
  assert.equal(isFeatureAllowedForTier('projects', 'free'), true);
  assert.equal(isFeatureAllowedForTier('projects', 'plus'), true);
  assert.equal(isFeatureAllowedForTier('projects', 'pro'), true);

  // Memory records capability
  assert.equal(isFeatureAllowedForTier('memory', 'guest'), false);
  assert.equal(isFeatureAllowedForTier('memory', 'free'), true);
  assert.equal(isFeatureAllowedForTier('memory', 'plus'), true);
  assert.equal(isFeatureAllowedForTier('memory', 'pro'), true);

  // Builder access
  assert.equal(isFeatureAllowedForTier('builder', 'guest'), false);
  assert.equal(isFeatureAllowedForTier('builder', 'free'), false);
  assert.equal(isFeatureAllowedForTier('builder', 'plus'), true);
  assert.equal(isFeatureAllowedForTier('builder', 'pro'), true);

  // Reasoning boosts
  assert.equal(isFeatureAllowedForTier('reasoning', 'guest'), false);
  assert.equal(isFeatureAllowedForTier('reasoning', 'free'), true);
  assert.equal(isFeatureAllowedForTier('reasoning', 'plus'), true);
  assert.equal(isFeatureAllowedForTier('reasoning', 'pro'), true);

  // Invalid features
  assert.equal(isFeatureAllowedForTier('invalid_feature_key', 'pro'), false);
});

// ==========================================
// 4. CENTRALIZED FEATURE FLAGS CONTRACT
// ==========================================

test('FeatureFlagKeySchema: validates all 7 canonical feature flag keys', () => {
  const expectedKeys: FeatureFlagKey[] = [
    'onboarding_walkthrough',
    'whats_new_announcements',
    'pro_sandbox_python',
    'pro_browser_tools',
    'agent_mode_autonomous',
    'dynamic_quota_gauges',
    'intelligent_capability_discovery'
  ];

  assert.equal(ALL_FEATURE_FLAG_KEYS.length, 7);
  for (const key of expectedKeys) {
    const parsed = FeatureFlagKeySchema.safeParse(key);
    assert.equal(parsed.success, true, `Key "${key}" should be valid in FeatureFlagKeySchema`);
    assert.ok(ALL_FEATURE_FLAG_KEYS.includes(key));
  }

  const invalidKeys = ['unsupported_flag', 'admin_override', 'beta_access'];
  for (const key of invalidKeys) {
    const parsed = FeatureFlagKeySchema.safeParse(key);
    assert.equal(parsed.success, false, `Key "${key}" should be invalid`);
  }
});

test('evaluateFeatureFlags: evaluates default flags per tier correctly', () => {
  const guestFlags = evaluateFeatureFlags('guest');
  assert.equal(guestFlags.onboarding_walkthrough, true);
  assert.equal(guestFlags.whats_new_announcements, true);
  assert.equal(guestFlags.dynamic_quota_gauges, true);
  assert.equal(guestFlags.intelligent_capability_discovery, true);
  assert.equal(guestFlags.agent_mode_autonomous, false);
  assert.equal(guestFlags.pro_browser_tools, false);
  assert.equal(guestFlags.pro_sandbox_python, false);

  const freeFlags = evaluateFeatureFlags('free');
  assert.equal(freeFlags.onboarding_walkthrough, true);
  assert.equal(freeFlags.agent_mode_autonomous, false);
  assert.equal(freeFlags.pro_browser_tools, false);
  assert.equal(freeFlags.pro_sandbox_python, false);

  const plusFlags = evaluateFeatureFlags('plus');
  assert.equal(plusFlags.onboarding_walkthrough, true);
  assert.equal(plusFlags.agent_mode_autonomous, true);
  assert.equal(plusFlags.pro_browser_tools, false);
  assert.equal(plusFlags.pro_sandbox_python, false);

  const proFlags = evaluateFeatureFlags('pro');
  assert.equal(proFlags.onboarding_walkthrough, true);
  assert.equal(proFlags.agent_mode_autonomous, true);
  assert.equal(proFlags.pro_browser_tools, true);
  assert.equal(proFlags.pro_sandbox_python, true);

  const schemaValidation = FeatureFlagsSchema.safeParse(proFlags);
  assert.equal(schemaValidation.success, true);
});

test('evaluateFeatureFlags: applies overrides without corrupting defaults', () => {
  // Test granting pro_sandbox_python override to a Free user (e.g. experimental beta)
  const overriddenFree = evaluateFeatureFlags('free', {
    pro_sandbox_python: true,
    agent_mode_autonomous: true
  });
  assert.equal(overriddenFree.pro_sandbox_python, true);
  assert.equal(overriddenFree.agent_mode_autonomous, true);
  assert.equal(overriddenFree.pro_browser_tools, false); // untouched

  // Test disabling onboarding walkthrough for a Pro user
  const overriddenPro = evaluateFeatureFlags('pro', {
    onboarding_walkthrough: false
  });
  assert.equal(overriddenPro.onboarding_walkthrough, false);
  assert.equal(overriddenPro.pro_sandbox_python, true); // untouched

  // Helper isFeatureFlagEnabled
  assert.equal(isFeatureFlagEnabled('agent_mode_autonomous', 'free'), false);
  assert.equal(isFeatureFlagEnabled('agent_mode_autonomous', 'plus'), true);
  assert.equal(isFeatureFlagEnabled('pro_browser_tools', 'free', { pro_browser_tools: true }), true);
});

// ==========================================
// 5. ANNOUNCEMENTS DATA CONTRACT & REGISTRY
// ==========================================

test('AnnouncementSchema: validates all announcements in ANNOUNCEMENT_REGISTRY', () => {
  assert.ok(ANNOUNCEMENT_REGISTRY.length >= 3, 'Must have at least 3 initial announcements');

  for (const ann of ANNOUNCEMENT_REGISTRY) {
    const parseRes = AnnouncementSchema.safeParse(ann);
    assert.equal(parseRes.success, true, `Announcement ${ann.id} failed schema validation: ${JSON.stringify(parseRes)}`);
    assert.ok(ann.id.length > 0);
    assert.ok(ann.version.length > 0);
    assert.ok(ann.title.length > 0);
    assert.ok(ann.summary.length > 0);
    assert.ok(ann.features.length > 0);
    assert.ok(ann.publishedAt.length > 0);
    assert.ok(AnnouncementCategorySchema.safeParse(ann.category).success);
  }
});

test('getAnnouncementById: finds existing announcements and returns undefined for unknown', () => {
  const found = getAnnouncementById('ann_entitlements_v2');
  assert.ok(found);
  assert.equal(found?.title, 'Introducing 4-Tier Entitlements & Pro Subscriptions');

  const notFound = getAnnouncementById('non_existent_id');
  assert.equal(notFound, undefined);
});

test('getLatestAnnouncement: returns the most recent announcement in the registry', () => {
  const latest = getLatestAnnouncement();
  assert.ok(latest);
  assert.equal(latest?.id, 'ann_model_routing_v3');
});

test('getAnnouncementsForTier: returns tier-appropriate announcements', () => {
  const guestAnnouncements = getAnnouncementsForTier('guest');
  assert.ok(guestAnnouncements.length > 0);

  const proAnnouncements = getAnnouncementsForTier('pro');
  assert.ok(proAnnouncements.length >= guestAnnouncements.length);
});

// ==========================================
// 6. PROTOTYPE POLLUTION & ADVERSARIAL RESISTANCE
// ==========================================

test('isModelAllowedForTier: rejects prototype properties and malformed inputs without crashing', () => {
  const prototypeProps = [
    'constructor',
    '__proto__',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__'
  ];

  for (const prop of prototypeProps) {
    // Prototype property as tier must return false without throwing
    assert.equal(isModelAllowedForTier('aira-fast', prop as any), false);
    assert.equal(isModelAllowedForTier('claude-3-5-sonnet', prop as any), false);

    // Prototype property as model must return false
    assert.equal(isModelAllowedForTier(prop, 'guest'), false);
    assert.equal(isModelAllowedForTier(prop, 'free'), false);
    assert.equal(isModelAllowedForTier(prop, 'plus'), false);
    assert.equal(isModelAllowedForTier(prop, 'pro'), false);
  }

  // Malformed / Non-string inputs
  const invalidInputs = [null, undefined, 123, true, false, {}, [], NaN];
  for (const inv of invalidInputs) {
    assert.equal(isModelAllowedForTier('aira-fast', inv as any), false);
    assert.equal(isModelAllowedForTier(inv as any, 'pro'), false);
  }
});

test('isFeatureAllowedForTier: strictly rejects prototype properties and unknown tiers', () => {
  const prototypeProps = [
    'constructor',
    '__proto__',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__'
  ];

  const sensitiveFeatures = [
    'projects',
    'memory',
    'builder',
    'autonomous',
    'browsertools',
    'pythonsandbox',
    'reasoning',
    'credits'
  ];

  for (const prop of prototypeProps) {
    // Prototype tier must not grant any sensitive capability
    for (const feat of sensitiveFeatures) {
      assert.equal(
        isFeatureAllowedForTier(feat, prop as any),
        false,
        `Feature "${feat}" must be false for prototype tier "${prop}"`
      );
    }

    // Prototype feature must not be granted for any tier
    assert.equal(isFeatureAllowedForTier(prop, 'guest'), false);
    assert.equal(isFeatureAllowedForTier(prop, 'free'), false);
    assert.equal(isFeatureAllowedForTier(prop, 'plus'), false);
    assert.equal(isFeatureAllowedForTier(prop, 'pro'), false);
  }

  // Malformed / Non-string inputs
  const invalidInputs = [null, undefined, 123, true, false, {}, [], NaN];
  for (const inv of invalidInputs) {
    assert.equal(isFeatureAllowedForTier('projects', inv as any), false);
    assert.equal(isFeatureAllowedForTier(inv as any, 'pro'), false);
  }
});

test('evaluateFeatureFlags & isFeatureFlagEnabled: prototype safety and override isolation', () => {
  const prototypeProps = [
    'constructor',
    '__proto__',
    'toString',
    'valueOf',
    'hasOwnProperty'
  ];

  for (const prop of prototypeProps) {
    const flags = evaluateFeatureFlags(prop as any);
    assert.equal(typeof flags, 'object');
    // Ensure all 7 canonical keys are present and booleans
    assert.equal(typeof flags.onboarding_walkthrough, 'boolean');
    assert.equal(typeof flags.pro_sandbox_python, 'boolean');
    assert.equal(flags.pro_sandbox_python, false);
    assert.equal(flags.pro_browser_tools, false);
    assert.equal(flags.agent_mode_autonomous, false);

    // Prototype key checked as a flag must evaluate to false
    assert.equal(isFeatureFlagEnabled(prop as any, 'guest'), false);
    assert.equal(isFeatureFlagEnabled(prop as any, 'pro'), false);
  }

  // Prototype pollution attempt on overrides
  const maliciousOverrides = {
    pro_browser_tools: true,
    __proto__: { pro_sandbox_python: true }
  };
  const guestFlags = evaluateFeatureFlags('guest', maliciousOverrides as any);
  assert.equal(guestFlags.pro_browser_tools, true); // own property override
  assert.equal(guestFlags.pro_sandbox_python, false); // prototype property ignored
});

test('getAnnouncementsForTier: prototype safety and rank boundary enforcement', () => {
  const prototypeProps = ['constructor', '__proto__', 'toString', 'valueOf'];

  for (const prop of prototypeProps) {
    const anns = getAnnouncementsForTier(prop as any);
    assert.ok(Array.isArray(anns));
    // Must return public announcements without crashing
    assert.ok(anns.length > 0);
  }

  // Invalid IDs for getAnnouncementById
  assert.equal(getAnnouncementById('constructor'), undefined);
  assert.equal(getAnnouncementById(null as any), undefined);
});
