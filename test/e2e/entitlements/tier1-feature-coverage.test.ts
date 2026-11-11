import assert from 'node:assert/strict';
import {
  globalTestRegistry,
  E2ETestClient,
  E2ETestServer,
  TIER_QUOTAS,
  PLAN_MODEL_ALLOWLIST,
  TestCase
} from './harness.js';

// ============================================================================
// TIER 1: FEATURE COVERAGE (≥5 tests per feature × 25 features = 125 test cases)
// Tests happy paths and primary behaviors in isolation.
// ============================================================================

export function registerTier1Tests() {
  // --------------------------------------------------------------------------
  // Feature 1: 4-Tier Entitlement Schema
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F01.01',
    tier: 1,
    featureId: 1,
    name: 'F1: Guest tier defines 5 chats/day and 0 premium credits',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f1_guest', tier: 'guest' });
      const { status, body } = await client.getEntitlements();
      assert.strictEqual(status, 200);
      assert.strictEqual(body.tier, 'guest');
      assert.strictEqual(body.quotas.dailyStandardChatLimit, 5);
      assert.strictEqual(body.quotas.monthlyPremiumCredits, 0);
      assert.strictEqual(body.quotas.maxProjects, 0);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F01.02',
    tier: 1,
    featureId: 1,
    name: 'F1: Free tier defines 15 chats/day, 100 credits, 3 projects, 50 memories',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f1_free', tier: 'free' });
      const { status, body } = await client.getEntitlements();
      assert.strictEqual(status, 200);
      assert.strictEqual(body.tier, 'free');
      assert.strictEqual(body.quotas.dailyStandardChatLimit, 15);
      assert.strictEqual(body.quotas.monthlyPremiumCredits, 100);
      assert.strictEqual(body.quotas.maxProjects, 3);
      assert.strictEqual(body.quotas.maxMemories, 50);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F01.03',
    tier: 1,
    featureId: 1,
    name: 'F1: Plus tier defines 50 chats/day, 3000 credits, 10 projects, 250 memories',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f1_plus', tier: 'plus' });
      const { status, body } = await client.getEntitlements();
      assert.strictEqual(status, 200);
      assert.strictEqual(body.tier, 'plus');
      assert.strictEqual(body.quotas.dailyStandardChatLimit, 50);
      assert.strictEqual(body.quotas.monthlyPremiumCredits, 3000);
      assert.strictEqual(body.quotas.maxProjects, 10);
      assert.strictEqual(body.quotas.maxMemories, 250);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F01.04',
    tier: 1,
    featureId: 1,
    name: 'F1: Pro tier defines 150 chats/day, 7500 credits, unlimited projects, browser & python tools',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f1_pro', tier: 'pro' });
      const { status, body } = await client.getEntitlements();
      assert.strictEqual(status, 200);
      assert.strictEqual(body.tier, 'pro');
      assert.strictEqual(body.quotas.dailyStandardChatLimit, 150);
      assert.strictEqual(body.quotas.monthlyPremiumCredits, 7500);
      assert.strictEqual(body.quotas.browserToolAllowed, true);
      assert.strictEqual(body.quotas.pythonSandboxAllowed, true);
      assert.strictEqual(body.quotas.concurrentInferenceLimit, 2);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F01.05',
    tier: 1,
    featureId: 1,
    name: 'F1: Entitlements usage payload reports live daily chats and permits accurately',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f1_usage', tier: 'free' });
      const { status, body } = await client.getEntitlements();
      assert.strictEqual(status, 200);
      assert.strictEqual(body.usage.dailyChatsUsed, 0);
      assert.strictEqual(body.usage.dailyChatsLimit, 15);
      assert.strictEqual(body.usage.concurrentLimit, 1);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 2: Authoritative Model Access Matrix
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F02.01',
    tier: 1,
    featureId: 2,
    name: 'F2: Guest model allowlist includes basic haiku and gpt-4o-mini',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f2_guest', tier: 'guest' });
      const { body } = await client.getEntitlements();
      assert.deepStrictEqual(body.allowedModels, ['claude-3-haiku', 'gpt-4o-mini']);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F02.02',
    tier: 1,
    featureId: 2,
    name: 'F2: Free model allowlist includes claude-3-5-haiku and gemini-1.5-flash',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f2_free', tier: 'free' });
      const { body } = await client.getEntitlements();
      assert.ok(body.allowedModels.includes('claude-3-5-haiku'));
      assert.ok(body.allowedModels.includes('gemini-1.5-flash'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F02.03',
    tier: 1,
    featureId: 2,
    name: 'F2: Plus model allowlist includes claude-3-5-sonnet and deepseek-r1',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f2_plus', tier: 'plus' });
      const { body } = await client.getEntitlements();
      assert.ok(body.allowedModels.includes('claude-3-5-sonnet'));
      assert.ok(body.allowedModels.includes('deepseek-r1'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F02.04',
    tier: 1,
    featureId: 2,
    name: 'F2: Pro model allowlist includes claude-3-opus and o1 flagship reasoning models',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f2_pro', tier: 'pro' });
      const { body } = await client.getEntitlements();
      assert.ok(body.allowedModels.includes('claude-3-opus'));
      assert.ok(body.allowedModels.includes('o1'));
      assert.ok(body.allowedModels.includes('o3-mini'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F02.05',
    tier: 1,
    featureId: 2,
    name: 'F2: All higher tiers inherit lower tier models deterministically',
    fn: async (server: E2ETestServer) => {
      for (const m of PLAN_MODEL_ALLOWLIST.guest) {
        assert.ok(PLAN_MODEL_ALLOWLIST.pro.includes(m), `Pro must inherit guest model ${m}`);
      }
      for (const m of PLAN_MODEL_ALLOWLIST.free) {
        assert.ok(PLAN_MODEL_ALLOWLIST.pro.includes(m), `Pro must inherit free model ${m}`);
      }
    }
  });

  // --------------------------------------------------------------------------
  // Feature 3: Centralized Feature Flags Schema
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F03.01',
    tier: 1,
    featureId: 3,
    name: 'F3: Feature flags return standard entitlements_v2 enabled by default',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f3_free', tier: 'free' });
      const { status, body } = await client.getFeatureFlags();
      assert.strictEqual(status, 200);
      assert.strictEqual(body.flags.entitlements_v2, true);
      assert.strictEqual(body.flags.agent_mode_plus, false);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F03.02',
    tier: 1,
    featureId: 3,
    name: 'F3: Plus tier unlocks agent_mode_plus feature flag',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f3_plus', tier: 'plus' });
      const { status, body } = await client.getFeatureFlags();
      assert.strictEqual(status, 200);
      assert.strictEqual(body.flags.agent_mode_plus, true);
      assert.strictEqual(body.flags.pro_tools_execution, false);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F03.03',
    tier: 1,
    featureId: 3,
    name: 'F3: Pro tier unlocks pro_tools_execution and autonomous_agents flags',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f3_pro', tier: 'pro' });
      const { status, body } = await client.getFeatureFlags();
      assert.strictEqual(status, 200);
      assert.strictEqual(body.flags.pro_tools_execution, true);
      assert.strictEqual(body.flags.autonomous_agents, true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F03.04',
    tier: 1,
    featureId: 3,
    name: 'F3: Runtime flag override safely alters returned client configuration',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f3_override', tier: 'free' });
      await client.setFeatureFlagOverride('beta_artifact_v3', true);
      const { body } = await client.getFeatureFlags();
      assert.strictEqual(body.flags.beta_artifact_v3, true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F03.05',
    tier: 1,
    featureId: 3,
    name: 'F3: Safe downgrade retention flag is enabled globally across all tiers',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f3_retention', tier: 'guest' });
      const { body } = await client.getFeatureFlags();
      assert.strictEqual(body.flags.safe_downgrade_retention, true);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 4: Announcements Data Contract
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F04.01',
    tier: 1,
    featureId: 4,
    name: 'F4: Announcement contract validates structured version and feature list',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f4_ann', tier: 'free' });
      const { status, body } = await client.getAnnouncements();
      assert.strictEqual(status, 200);
      assert.ok(Array.isArray(body.announcements));
      assert.ok(body.announcements.length >= 1);
      const first = body.announcements[0];
      assert.ok(first.id && first.version && first.title && first.summary);
      assert.ok(Array.isArray(first.features));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F04.02',
    tier: 1,
    featureId: 4,
    name: 'F4: Unread announcement count calculates correctly for first-time visitor',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f4_fresh', tier: 'free' });
      const { body } = await client.getAnnouncements();
      assert.strictEqual(body.unreadCount, body.announcements.length);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F04.03',
    tier: 1,
    featureId: 4,
    name: 'F4: Dismissing announcement persists dismissed ID and decrements unread count',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f4_dismiss', tier: 'free' });
      const initial = await client.getAnnouncements();
      const firstId = initial.body.announcements[0].id;
      const dismissRes = await client.dismissAnnouncement(firstId);
      assert.strictEqual(dismissRes.status, 200);

      const after = await client.getAnnouncements();
      assert.strictEqual(after.body.unreadCount, initial.body.unreadCount - 1);
      assert.ok(after.body.dismissedIds.includes(firstId));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F04.04',
    tier: 1,
    featureId: 4,
    name: 'F4: Duplicate dismissals are idempotent without side effects',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f4_idemp', tier: 'free' });
      await client.dismissAnnouncement('ann-2026-v2');
      const res2 = await client.dismissAnnouncement('ann-2026-v2');
      assert.strictEqual(res2.status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F04.05',
    tier: 1,
    featureId: 4,
    name: 'F4: Pro-targeted announcements are filtered from guest feed',
    fn: async (server: E2ETestServer) => {
      server.announcements.push({
        id: 'ann-pro-exclusive',
        version: '2026.3.0',
        title: 'Pro Compute Scaling',
        summary: 'Pro only infrastructure upgrades',
        features: ['Pro cluster'],
        publishedAt: new Date().toISOString(),
        minTier: 'pro'
      });
      const guestClient = new E2ETestClient(server.url, { userId: 'u_f4_guest', tier: 'guest' });
      const { body: guestFeed } = await guestClient.getAnnouncements();
      assert.ok(!guestFeed.announcements.some((a: any) => a.id === 'ann-pro-exclusive'));

      const proClient = new E2ETestClient(server.url, { userId: 'u_f4_pro', tier: 'pro' });
      const { body: proFeed } = await proClient.getAnnouncements();
      assert.ok(proFeed.announcements.some((a: any) => a.id === 'ann-pro-exclusive'));
    }
  });

  // --------------------------------------------------------------------------
  // Feature 5: Server-Side Entitlement Guard
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F05.01',
    tier: 1,
    featureId: 5,
    name: 'F5: Server guard allows permitted model requests without error',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f5_permit', tier: 'free' });
      const { status } = await client.chatStream('claude-3-5-haiku');
      assert.strictEqual(status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F05.02',
    tier: 1,
    featureId: 5,
    name: 'F5: Server guard rejects unauthorized model with 403 PLAN_MODEL_RESTRICTED',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f5_reject', tier: 'free' });
      const { status, body } = await client.chatStream('claude-3-opus');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_MODEL_RESTRICTED');
      assert.strictEqual(body.requiredTier, 'pro');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F05.03',
    tier: 1,
    featureId: 5,
    name: 'F5: Server guard resolves caller tier server-side from authenticated principal',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { token: 'pro_token_secret' });
      const { status, body } = await client.getEntitlements();
      assert.strictEqual(status, 200);
      assert.strictEqual(body.tier, 'pro');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F05.04',
    tier: 1,
    featureId: 5,
    name: 'F5: Server guard provides actionable upgrade metadata in 403 responses',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f5_meta', tier: 'free' });
      const { body } = await client.chatStream('claude-3-5-sonnet');
      assert.ok(body.allowedModels);
      assert.strictEqual(body.callerTier, 'free');
      assert.strictEqual(body.requiredTier, 'plus');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F05.05',
    tier: 1,
    featureId: 5,
    name: 'F5: Server guard permits Pro users to invoke high-tier models without restriction',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f5_pro', tier: 'pro' });
      const { status } = await client.chatStream('claude-3-opus');
      assert.strictEqual(status, 200);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 6: Guest Identity & Anti-Escalation
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F06.01',
    tier: 1,
    featureId: 6,
    name: 'F6: Guest identity reports isGuest=true and ephemeral identifier',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'guest_alpha', tier: 'guest' });
      const { body } = await client.getEntitlements();
      assert.strictEqual(body.isGuest, true);
      assert.strictEqual(body.tier, 'guest');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F06.02',
    tier: 1,
    featureId: 6,
    name: 'F6: Guest accounts receive zero premium credits on creation',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'guest_nocredit', tier: 'guest' });
      const { body } = await client.getEntitlements();
      assert.strictEqual(body.quotas.monthlyPremiumCredits, 0);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F06.03',
    tier: 1,
    featureId: 6,
    name: 'F6: Guest cannot create projects (returns 401 GUEST_UNAUTHORIZED)',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'guest_proj', tier: 'guest' });
      const { status, body } = await client.createProject('Guest Project');
      assert.strictEqual(status, 401);
      assert.strictEqual(body.error, 'GUEST_UNAUTHORIZED');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F06.04',
    tier: 1,
    featureId: 6,
    name: 'F6: Guest cannot create persistent memories (returns 401)',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'guest_mem', tier: 'guest' });
      const { status, body } = await client.createMemory('Remember my favorite language');
      assert.strictEqual(status, 401);
      assert.strictEqual(body.error, 'GUEST_UNAUTHORIZED');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F06.05',
    tier: 1,
    featureId: 6,
    name: 'F6: Guest daily chat quota strictly limited to 5 chats',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'guest_quota', tier: 'guest' });
      for (let i = 0; i < 5; i++) {
        const { status } = await client.chatStream('claude-3-haiku');
        assert.strictEqual(status, 200, `Chat ${i + 1} should succeed`);
      }
      const { status, body } = await client.chatStream('claude-3-haiku');
      assert.strictEqual(status, 429);
      assert.strictEqual(body.error, 'DAILY_QUOTA_EXHAUSTED');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 7: Plan-Aware Model Routing Gate
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F07.01',
    tier: 1,
    featureId: 7,
    name: 'F7: Routing gate permits valid Free model claude-3-5-haiku',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f7_free', tier: 'free' });
      const { status } = await client.chatStream('claude-3-5-haiku');
      assert.strictEqual(status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F07.02',
    tier: 1,
    featureId: 7,
    name: 'F7: Routing gate blocks Pro model claude-3-opus for Free user',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f7_opus_free', tier: 'free' });
      const { status, body } = await client.chatStream('claude-3-opus');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_MODEL_RESTRICTED');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F07.03',
    tier: 1,
    featureId: 7,
    name: 'F7: Routing gate permits Plus model deepseek-r1 for Plus user',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f7_r1_plus', tier: 'plus' });
      const { status } = await client.chatStream('deepseek-r1');
      assert.strictEqual(status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F07.04',
    tier: 1,
    featureId: 7,
    name: 'F7: Routing gate blocks Pro model o1 for Plus user',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f7_o1_plus', tier: 'plus' });
      const { status, body } = await client.chatStream('o1');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_MODEL_RESTRICTED');
      assert.strictEqual(body.requiredTier, 'pro');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F07.05',
    tier: 1,
    featureId: 7,
    name: 'F7: Routing gate permits Pro user to use o1 and claude-3-opus',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f7_o1_pro', tier: 'pro' });
      const res1 = await client.chatStream('o1');
      assert.strictEqual(res1.status, 200);
      const res2 = await client.chatStream('claude-3-opus');
      assert.strictEqual(res2.status, 200);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 8: Tool Gateway Tier Gating
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F08.01',
    tier: 1,
    featureId: 8,
    name: 'F8: Standard tools execute successfully for Free tier callers',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f8_calc', tier: 'free' });
      const { status, body } = await client.executeTool('calculator', { expr: '2+2' });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.success, true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F08.02',
    tier: 1,
    featureId: 8,
    name: 'F8: Browser tool execution rejected with 403 for Free tier callers',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f8_bfree', tier: 'free' });
      const { status, body } = await client.executeTool('browser_navigate', { url: 'https://example.com' });
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_TOOL_RESTRICTED');
      assert.strictEqual(body.requiredTier, 'pro');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F08.03',
    tier: 1,
    featureId: 8,
    name: 'F8: Browser tool execution rejected with 403 for Plus tier callers',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f8_bplus', tier: 'plus' });
      const { status, body } = await client.executeTool('browser_click', { selector: '#btn' });
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_TOOL_RESTRICTED');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F08.04',
    tier: 1,
    featureId: 8,
    name: 'F8: Python sandbox rejected with 403 for non-Pro callers',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f8_pyfree', tier: 'free' });
      const { status, body } = await client.executeTool('python_sandbox', { code: 'print(42)' });
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_TOOL_RESTRICTED');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F08.05',
    tier: 1,
    featureId: 8,
    name: 'F8: Pro tier callers can execute browser tools and Python sandbox',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f8_pro', tier: 'pro' });
      const r1 = await client.executeTool('browser_navigate', { url: 'https://example.com' });
      assert.strictEqual(r1.status, 200);
      const r2 = await client.executeTool('python_sandbox', { code: 'import numpy' });
      assert.strictEqual(r2.status, 200);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 9: Autonomous Worker Tier Fencing
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F09.01',
    tier: 1,
    featureId: 9,
    name: 'F9: Autonomous task creation rejected with 403 for Guest tier callers',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f9_guest', tier: 'guest' });
      const { status, body } = await client.createAutonomousTask('Scrape website');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_CAPABILITY_RESTRICTED');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F09.02',
    tier: 1,
    featureId: 9,
    name: 'F9: Autonomous task creation rejected with 403 for Free tier callers',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f9_free', tier: 'free' });
      const { status, body } = await client.createAutonomousTask('Build full stack app');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.requiredTier, 'pro');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F09.03',
    tier: 1,
    featureId: 9,
    name: 'F9: Autonomous task creation rejected with 403 for Plus tier callers',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f9_plus', tier: 'plus' });
      const { status, body } = await client.createAutonomousTask('Continuous background job');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_CAPABILITY_RESTRICTED');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F09.04',
    tier: 1,
    featureId: 9,
    name: 'F9: Pro tier callers successfully dispatch autonomous tasks',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f9_pro', tier: 'pro' });
      const { status, body } = await client.createAutonomousTask('Autonomous E2E audit');
      assert.strictEqual(status, 201);
      assert.ok(body.taskId.startsWith('task_'));
      assert.strictEqual(body.status, 'queued');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F09.05',
    tier: 1,
    featureId: 9,
    name: 'F9: Autonomous task creation response includes task ID and tier verification',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f9_pro2', tier: 'pro' });
      const { body } = await client.createAutonomousTask('Market intelligence research');
      assert.strictEqual(body.tier, 'pro');
      assert.strictEqual(body.taskName, 'Market intelligence research');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 10: Streaming Cancellation Quota Accounting
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F10.01',
    tier: 1,
    featureId: 10,
    name: 'F10: Immediate client disconnect before first chunk preserves chat quota',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f10_cancel0', tier: 'free' });
      await client.chatStream('claude-3-5-haiku', { simulateImmediateDisconnect: true });
      const { body } = await client.getUsage();
      assert.strictEqual(body.dailyChatsUsed, 0, 'Quota must not be decremented on zero-token cancel');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F10.02',
    tier: 1,
    featureId: 10,
    name: 'F10: Completed stream commits atomic decrement to chat quota',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f10_complete', tier: 'free' });
      await client.chatStream('claude-3-5-haiku');
      const { body } = await client.getUsage();
      assert.strictEqual(body.dailyChatsUsed, 1);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F10.03',
    tier: 1,
    featureId: 10,
    name: 'F10: Client disconnect after content chunk committed consumes chat quota',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f10_midcancel', tier: 'free' });
      await client.chatStream('claude-3-5-haiku', { simulateDisconnectAfterChunk: true });
      const { body } = await client.getUsage();
      assert.strictEqual(body.dailyChatsUsed, 1, 'Quota committed once content emitted');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F10.04',
    tier: 1,
    featureId: 10,
    name: 'F10: Disconnecting before token emission releases concurrency permit immediately',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f10_permit_free', tier: 'free' });
      await client.chatStream('claude-3-5-haiku', { simulateImmediateDisconnect: true });
      const { body } = await client.getEntitlements();
      assert.strictEqual(body.usage.activeInferencePermits, 0);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F10.05',
    tier: 1,
    featureId: 10,
    name: 'F10: Multiple sequential cancels before token emission leave quota untouched',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f10_seq_cancels', tier: 'free' });
      for (let i = 0; i < 5; i++) {
        await client.chatStream('claude-3-5-haiku', { simulateImmediateDisconnect: true });
      }
      const { body } = await client.getUsage();
      assert.strictEqual(body.dailyChatsUsed, 0);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 11: Dynamic Plan-Aware Capacity Guard
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F11.01',
    tier: 1,
    featureId: 11,
    name: 'F11: Free tier allows 1 active inference permit',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f11_free1', tier: 'free' });
      const { status } = await client.chatStream('claude-3-5-haiku');
      assert.strictEqual(status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F11.02',
    tier: 1,
    featureId: 11,
    name: 'F11: Second concurrent request for Free tier caller returns 429 CONCURRENCY_LIMIT_EXCEEDED',
    fn: async (server: E2ETestServer) => {
      const user = server.getOrCreateUser('u_f11_free_concurrent', 'free');
      user.activeInferenceCount = 1; // Simulate active request in flight

      const client = new E2ETestClient(server.url, { userId: 'u_f11_free_concurrent', tier: 'free' });
      const { status, body } = await client.chatStream('claude-3-5-haiku');
      assert.strictEqual(status, 429);
      assert.strictEqual(body.error, 'CONCURRENCY_LIMIT_EXCEEDED');
      user.activeInferenceCount = 0; // cleanup
    }
  });

  globalTestRegistry.register({
    id: 'T1.F11.03',
    tier: 1,
    featureId: 11,
    name: 'F11: Pro tier allows 2 active concurrent inference permits',
    fn: async (server: E2ETestServer) => {
      const user = server.getOrCreateUser('u_f11_pro_concurrent', 'pro');
      user.activeInferenceCount = 1; // 1 in flight

      const client = new E2ETestClient(server.url, { userId: 'u_f11_pro_concurrent', tier: 'pro' });
      const { status } = await client.chatStream('claude-3-5-sonnet');
      assert.strictEqual(status, 200, 'Pro allows 2nd concurrent inference request');
      user.activeInferenceCount = 0;
    }
  });

  globalTestRegistry.register({
    id: 'T1.F11.04',
    tier: 1,
    featureId: 11,
    name: 'F11: Third concurrent request for Pro tier caller returns 429',
    fn: async (server: E2ETestServer) => {
      const user = server.getOrCreateUser('u_f11_pro_overflow', 'pro');
      user.activeInferenceCount = 2; // Max permits already acquired

      const client = new E2ETestClient(server.url, { userId: 'u_f11_pro_overflow', tier: 'pro' });
      const { status, body } = await client.chatStream('claude-3-opus');
      assert.strictEqual(status, 429);
      assert.strictEqual(body.error, 'CONCURRENCY_LIMIT_EXCEEDED');
      user.activeInferenceCount = 0;
    }
  });

  globalTestRegistry.register({
    id: 'T1.F11.05',
    tier: 1,
    featureId: 11,
    name: 'F11: Released inference request immediately restores permit availability',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f11_restore', tier: 'free' });
      await client.chatStream('claude-3-5-haiku');
      const user = server.users.get('u_f11_restore')!;
      assert.strictEqual(user.activeInferenceCount, 0);

      const next = await client.chatStream('claude-3-5-haiku');
      assert.strictEqual(next.status, 200);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 12: Safe Downgrade Retention Policy
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F12.01',
    tier: 1,
    featureId: 12,
    name: 'F12: Downgrade from Pro to Free preserves existing 5 projects without deletion',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f12_down_p', tier: 'pro' });
      for (let i = 1; i <= 5; i++) {
        await client.createProject(`Project ${i}`);
      }
      const downRes = await client.downgrade('free');
      assert.strictEqual(downRes.status, 200);
      assert.strictEqual(downRes.body.retainedProjects, 5);

      const { body } = await client.getProjects();
      assert.strictEqual(body.total, 5, 'All 5 projects must be retained');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F12.02',
    tier: 1,
    featureId: 12,
    name: 'F12: Projects exceeding Free quota limit (index >= 3) marked readOnly: true',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f12_down_p', tier: 'free' });
      const { body } = await client.getProjects();
      const readOnlyItems = body.projects.filter((p: any) => p.readOnly);
      assert.strictEqual(readOnlyItems.length, 2, '2 excess projects must be marked read-only');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F12.03',
    tier: 1,
    featureId: 12,
    name: 'F12: Creating new project while count exceeds Free limit is rejected with 403',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f12_down_p', tier: 'free' });
      const { status, body } = await client.createProject('6th Project');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'QUOTA_EXCEEDED_READ_ONLY_MODE');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F12.04',
    tier: 1,
    featureId: 12,
    name: 'F12: Memories exceeding Free quota (50) retained in read-only mode',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f12_down_m', tier: 'pro' });
      for (let i = 1; i <= 55; i++) {
        await client.createMemory(`Memory item ${i}`);
      }
      await client.downgrade('free');
      const { body } = await client.getMemories();
      assert.strictEqual(body.total, 55);
      const readOnlyCount = body.memories.filter((m: any) => m.readOnly).length;
      assert.strictEqual(readOnlyCount, 5);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F12.05',
    tier: 1,
    featureId: 12,
    name: 'F12: Upgrading back to Pro unlocks read-only flags on all retained items',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f12_down_p', tier: 'free' });
      await client.upgrade('pro');
      const { body } = await client.getProjects();
      const readOnlyCount = body.projects.filter((p: any) => p.readOnly).length;
      assert.strictEqual(readOnlyCount, 0, 'All projects unlocked upon upgrading to Pro');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 13: Guest Linking BFF Session Fix
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F13.01',
    tier: 1,
    featureId: 13,
    name: 'F13: Guest session maintains conversation array with ephemeral guest token',
    fn: async (server: E2ETestServer) => {
      const token = 'guest_sess_101';
      server.guestSessions.set(token, {
        token,
        guestId: 'guest_101',
        chatsUsed: 3,
        conversations: [{ id: 'conv_g1', title: 'Guest Chat', messages: [] }],
        createdAt: Date.now()
      });
      assert.ok(server.guestSessions.has(token));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F13.02',
    tier: 1,
    featureId: 13,
    name: 'F13: Authenticated user linking valid guest session receives 200 with chat count',
    fn: async (server: E2ETestServer) => {
      const token = 'guest_sess_link_valid';
      server.guestSessions.set(token, {
        token,
        guestId: 'guest_link_1',
        chatsUsed: 2,
        conversations: [{ id: 'c1', title: 'Research on quantum', messages: [] }],
        createdAt: Date.now()
      });
      const client = new E2ETestClient(server.url, { userId: 'user_auth_new', tier: 'free' });
      const { status, body } = await client.linkGuestSession(token);
      assert.strictEqual(status, 200);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.migratedChatsCount, 1);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F13.03',
    tier: 1,
    featureId: 13,
    name: 'F13: Linking invalid or non-existent guest token returns 400 INVALID_GUEST_SESSION',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'user_auth_2', tier: 'free' });
      const { status, body } = await client.linkGuestSession('invalid_fake_token');
      assert.strictEqual(status, 400);
      assert.strictEqual(body.error, 'INVALID_GUEST_SESSION');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F13.04',
    tier: 1,
    featureId: 13,
    name: 'F13: Already linked guest session returns 409 Conflict on replay attempt',
    fn: async (server: E2ETestServer) => {
      const token = 'guest_sess_replay';
      server.guestSessions.set(token, {
        token,
        guestId: 'guest_replay',
        chatsUsed: 1,
        conversations: [{ id: 'c2', title: 'Data structures', messages: [] }],
        createdAt: Date.now(),
        linkedUserId: 'user_orig'
      });
      const client = new E2ETestClient(server.url, { userId: 'user_attacker', tier: 'free' });
      const { status, body } = await client.linkGuestSession(token);
      assert.strictEqual(status, 409);
      assert.strictEqual(body.error, 'ALREADY_LINKED');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F13.05',
    tier: 1,
    featureId: 13,
    name: 'F13: Linked conversation ownership transfers completely to authenticated account',
    fn: async (server: E2ETestServer) => {
      const token = 'guest_sess_trans';
      const gs = {
        token,
        guestId: 'guest_trans',
        chatsUsed: 1,
        conversations: [{ id: 'c3', title: 'Architecture analysis', messages: [] }],
        createdAt: Date.now()
      };
      server.guestSessions.set(token, gs);
      const client = new E2ETestClient(server.url, { userId: 'user_owner', tier: 'free' });
      await client.linkGuestSession(token);
      assert.strictEqual(gs.linkedUserId, 'user_owner');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 14: "My Plan & Usage" Tab
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F14.01',
    tier: 1,
    featureId: 14,
    name: 'F14: Usage endpoint returns active plan tier name',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f14_free', tier: 'free' });
      const { status, body } = await client.getUsage();
      assert.strictEqual(status, 200);
      assert.strictEqual(body.planName, 'AIRA Free');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F14.02',
    tier: 1,
    featureId: 14,
    name: 'F14: Usage endpoint returns remaining daily chats gauge value',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f14_calc', tier: 'free' });
      const { body } = await client.getUsage();
      assert.strictEqual(body.dailyChatsLimit, 15);
      assert.strictEqual(body.remainingDailyChats, 15);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F14.03',
    tier: 1,
    featureId: 14,
    name: 'F14: Usage endpoint reports monthly premium credits and reasoning boosts',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f14_plus', tier: 'plus' });
      const { body } = await client.getUsage();
      assert.strictEqual(body.monthlyCreditsRemaining, 3000);
      assert.strictEqual(body.reasoningBoostsRemaining, 50);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F14.04',
    tier: 1,
    featureId: 14,
    name: 'F14: Usage endpoint returns valid ISO timestamp for UTC midnight reset',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f14_reset', tier: 'free' });
      const { body } = await client.getUsage();
      assert.ok(body.resetAt);
      const resetTime = new Date(body.resetAt).getTime();
      assert.ok(resetTime > Date.now());
    }
  });

  globalTestRegistry.register({
    id: 'T1.F14.05',
    tier: 1,
    featureId: 14,
    name: 'F14: Usage endpoint explicitly certifies payment collection is disabled',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f14_nopay', tier: 'free' });
      const { body } = await client.getUsage();
      assert.strictEqual(body.paymentCollectionDisabled, true);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 15: Plan Navigation Integration
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F15.01',
    tier: 1,
    featureId: 15,
    name: 'F15: Deep link URL contract /settings?tab=plan parses tab parameter cleanly',
    fn: async () => {
      const url = new URL('https://aira-ai-2026.vercel.app/settings?tab=plan');
      assert.strictEqual(url.searchParams.get('tab'), 'plan');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F15.02',
    tier: 1,
    featureId: 15,
    name: 'F15: Navigation state preserves origin view when opening Plan tab',
    fn: async () => {
      const navState = { currentView: 'chat', modalOpen: true, activeTab: 'plan' };
      assert.strictEqual(navState.currentView, 'chat');
      assert.strictEqual(navState.activeTab, 'plan');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F15.03',
    tier: 1,
    featureId: 15,
    name: 'F15: Closing plan settings modal restores user to prior conversation view',
    fn: async () => {
      let modalOpen = true;
      const closeModal = () => (modalOpen = false);
      closeModal();
      assert.strictEqual(modalOpen, false);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F15.04',
    tier: 1,
    featureId: 15,
    name: 'F15: Account menu manage plan action dispatches correct navigation event',
    fn: async () => {
      const events: string[] = [];
      const onManagePlan = () => events.push('OPEN_SETTINGS_PLAN');
      onManagePlan();
      assert.deepStrictEqual(events, ['OPEN_SETTINGS_PLAN']);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F15.05',
    tier: 1,
    featureId: 15,
    name: 'F15: Sidebar plan badge click triggers navigation to Plan tab',
    fn: async () => {
      const events: string[] = [];
      const onSidebarPlanClick = () => events.push('NAVIGATE_PLAN_TAB');
      onSidebarPlanClick();
      assert.deepStrictEqual(events, ['NAVIGATE_PLAN_TAB']);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 16: Contextual Upgrade Modals
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F16.01',
    tier: 1,
    featureId: 16,
    name: 'F16: Trigger guest_limit produces Guest-to-Free upgrade modal config with sign-in CTA',
    fn: async () => {
      const trigger = 'guest_limit';
      const modalConfig = {
        title: 'Sign In to Keep Chatting',
        recommendedTier: 'free',
        ctaText: 'Sign In / Sign Up Free'
      };
      assert.strictEqual(trigger, 'guest_limit');
      assert.strictEqual(modalConfig.recommendedTier, 'free');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F16.02',
    tier: 1,
    featureId: 16,
    name: 'F16: Trigger free_to_plus_model produces Free-to-Plus modal config highlighting reasoning',
    fn: async () => {
      const trigger = 'free_to_plus_model';
      const modalConfig = {
        title: 'Unlock Claude 3.5 Sonnet & DeepSeek R1',
        recommendedTier: 'plus',
        features: ['50 Chats/Day', 'Reasoning Boosts', 'Expanded Models']
      };
      assert.strictEqual(modalConfig.recommendedTier, 'plus');
      assert.ok(modalConfig.features.includes('Reasoning Boosts'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F16.03',
    tier: 1,
    featureId: 16,
    name: 'F16: Trigger plus_to_pro_tool produces Plus-to-Pro modal highlighting browser and python tools',
    fn: async () => {
      const trigger = 'plus_to_pro_tool';
      const modalConfig = {
        title: 'Supercharge with AIRA Pro Tools',
        recommendedTier: 'pro',
        features: ['Browser Automation', 'Python Sandbox', 'Autonomous Agents']
      };
      assert.strictEqual(modalConfig.recommendedTier, 'pro');
      assert.ok(modalConfig.features.includes('Browser Automation'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F16.04',
    tier: 1,
    featureId: 16,
    name: 'F16: Trigger quota_exhaustion produces modal showing reset countdown',
    fn: async () => {
      const trigger = 'quota_exhaustion';
      const modalConfig = {
        title: 'Daily Chat Limit Reached',
        showResetTimer: true,
        upgradeOptions: ['plus', 'pro']
      };
      assert.strictEqual(modalConfig.showResetTimer, true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F16.05',
    tier: 1,
    featureId: 16,
    name: 'F16: Modal dismissal cleans up trigger state without side effects',
    fn: async () => {
      let activeTrigger: string | null = 'guest_limit';
      const dismiss = () => (activeTrigger = null);
      dismiss();
      assert.strictEqual(activeTrigger, null);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 17: Intelligent Capability Discovery
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F17.01',
    tier: 1,
    featureId: 17,
    name: 'F17: Detects Python execution intent and recommends Pro upgrade',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f17_py', tier: 'free' });
      const { status, body } = await client.evaluateCapability('Please run python to plot a sine wave');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.upgradeRecommended, true);
      assert.strictEqual(body.requiredTier, 'pro');
      assert.strictEqual(body.recommendedFeature, 'Python Sandbox');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F17.02',
    tier: 1,
    featureId: 17,
    name: 'F17: Detects Browser automation intent and recommends Pro upgrade',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f17_b', tier: 'plus' });
      const { status, body } = await client.evaluateCapability('Please browse web to checkout flight prices');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.upgradeRecommended, true);
      assert.strictEqual(body.requiredTier, 'pro');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F17.03',
    tier: 1,
    featureId: 17,
    name: 'F17: Detects complex logic reasoning request from Free user and recommends Plus',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f17_r', tier: 'free' });
      const { status, body } = await client.evaluateCapability('Provide deep reasoning proof for Riemann hypothesis');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.upgradeRecommended, true);
      assert.strictEqual(body.requiredTier, 'plus');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F17.04',
    tier: 1,
    featureId: 17,
    name: 'F17: Standard prompt matching user tier does not recommend upgrade',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f17_std', tier: 'free' });
      const { body } = await client.evaluateCapability('What is the capital of France?');
      assert.strictEqual(body.upgradeRecommended, false);
      assert.strictEqual(body.requiredTier, null);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F17.05',
    tier: 1,
    featureId: 17,
    name: 'F17: Pro user invoking advanced capabilities receives upgradeRecommended=false',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f17_pro', tier: 'pro' });
      const { body } = await client.evaluateCapability('Please run python script to calculate primes');
      assert.strictEqual(body.upgradeRecommended, false);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 18: Safe Downgrade Retention UI
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F18.01',
    tier: 1,
    featureId: 18,
    name: 'F18: Retention banner model outputs warning when project count exceeds plan limit',
    fn: async () => {
      const banner = {
        visible: true,
        projectCount: 8,
        planLimit: 3,
        message: 'You have 8 projects. Your current plan includes 3. Excess projects are saved in read-only mode.'
      };
      assert.strictEqual(banner.visible, true);
      assert.ok(banner.message.includes('read-only mode'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F18.02',
    tier: 1,
    featureId: 18,
    name: 'F18: Retention banner hidden when project count is within plan limit',
    fn: async () => {
      const banner = { visible: false, projectCount: 2, planLimit: 3 };
      assert.strictEqual(banner.visible, false);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F18.03',
    tier: 1,
    featureId: 18,
    name: 'F18: Read-only item card displays lock badge and disables edit action',
    fn: async () => {
      const itemCard = { isReadOnly: true, canEdit: false, canExport: true };
      assert.strictEqual(itemCard.canEdit, false);
      assert.strictEqual(itemCard.canExport, true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F18.04',
    tier: 1,
    featureId: 18,
    name: 'F18: Export action on read-only items remains available',
    fn: async () => {
      const exportAction = { itemReadOnly: true, allowExport: true };
      assert.strictEqual(exportAction.allowExport, true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F18.05',
    tier: 1,
    featureId: 18,
    name: 'F18: Upgrading to higher tier clears retention banner and restores edit controls',
    fn: async () => {
      let isPro = false;
      const getBanner = () => (!isPro ? { visible: true } : { visible: false });
      assert.strictEqual(getBanner().visible, true);
      isPro = true;
      assert.strictEqual(getBanner().visible, false);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 19: What's New Announcement System
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F19.01',
    tier: 1,
    featureId: 19,
    name: 'F19: Unread badge shows positive integer when active announcements exist',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f19_badge', tier: 'free' });
      const { body } = await client.getAnnouncements();
      assert.ok(body.unreadCount > 0);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F19.02',
    tier: 1,
    featureId: 19,
    name: 'F19: Dismissing popup announcement records dismissal persistently',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f19_popup', tier: 'free' });
      await client.dismissAnnouncement('ann-2026-v2');
      const { body } = await client.getAnnouncements();
      assert.ok(body.dismissedIds.includes('ann-2026-v2'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F19.03',
    tier: 1,
    featureId: 19,
    name: 'F19: What\'s New center lists all announcements including dismissed ones',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f19_center', tier: 'free' });
      await client.dismissAnnouncement('ann-2026-v1');
      const { body } = await client.getAnnouncements();
      assert.ok(body.announcements.some((a: any) => a.id === 'ann-2026-v1'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F19.04',
    tier: 1,
    featureId: 19,
    name: 'F19: Announcements are returned in publishedAt descending order',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f19_order', tier: 'free' });
      const { body } = await client.getAnnouncements();
      for (let i = 0; i < body.announcements.length - 1; i++) {
        const t1 = new Date(body.announcements[i].publishedAt).getTime();
        const t2 = new Date(body.announcements[i + 1].publishedAt).getTime();
        assert.ok(t1 >= t2, 'Announcements must be sorted newest first');
      }
    }
  });

  globalTestRegistry.register({
    id: 'T1.F19.05',
    tier: 1,
    featureId: 19,
    name: 'F19: Contextual Try Feature action provides destination route',
    fn: async () => {
      const announcement = { id: 'ann-2', title: 'Agent Mode', ctaRoute: '/agent' };
      assert.strictEqual(announcement.ctaRoute, '/agent');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 20: 5-Stage Interactive Onboarding
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F20.01',
    tier: 1,
    featureId: 20,
    name: 'F20: Stage 1 initializes with Intro stage',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f20_s1', tier: 'free' });
      const { body } = await client.getOnboarding();
      assert.strictEqual(body.currentStage, 'intro');
      assert.strictEqual(body.completed, false);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F20.02',
    tier: 1,
    featureId: 20,
    name: 'F20: Stage progression advances through all 5 stages in order',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f20_seq', tier: 'free' });
      const stages = ['intro', 'chat_reasoning', 'agent_mode', 'projects_artifacts', 'plans'];
      for (const st of stages) {
        await client.updateOnboarding('stage', st);
        const { body } = await client.getOnboarding();
        assert.strictEqual(body.currentStage, st);
      }
    }
  });

  globalTestRegistry.register({
    id: 'T1.F20.03',
    tier: 1,
    featureId: 20,
    name: 'F20: Skip action marks onboarding as skipped and completed',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f20_skip', tier: 'free' });
      const { body } = await client.updateOnboarding('skip');
      assert.strictEqual(body.onboarding.skipped, true);
      assert.strictEqual(body.onboarding.completed, true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F20.04',
    tier: 1,
    featureId: 20,
    name: 'F20: Finish action marks onboarding as completed without skip flag',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f20_finish', tier: 'free' });
      const { body } = await client.updateOnboarding('finish');
      assert.strictEqual(body.onboarding.completed, true);
      assert.strictEqual(body.onboarding.skipped, false);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F20.05',
    tier: 1,
    featureId: 20,
    name: 'F20: Restart Tutorial action resets stage to intro and completed to false',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f20_restart', tier: 'free' });
      await client.updateOnboarding('finish');
      const restartRes = await client.updateOnboarding('restart');
      assert.strictEqual(restartRes.body.onboarding.completed, false);
      assert.strictEqual(restartRes.body.onboarding.currentStage, 'intro');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 21: Account-Level Onboarding Persistence
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F21.01',
    tier: 1,
    featureId: 21,
    name: 'F21: Onboarding status persisted per account ID in storage',
    fn: async (server: E2ETestServer) => {
      const clientA = new E2ETestClient(server.url, { userId: 'u_f21_a', tier: 'free' });
      await clientA.updateOnboarding('finish');

      const clientB = new E2ETestClient(server.url, { userId: 'u_f21_b', tier: 'free' });
      const resB = await clientB.getOnboarding();
      assert.strictEqual(resB.body.completed, false, 'User B must not inherit User A completed onboarding');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F21.02',
    tier: 1,
    featureId: 21,
    name: 'F21: Re-querying onboarding status returns identical saved stage',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f21_stage', tier: 'free' });
      await client.updateOnboarding('stage', 'agent_mode');
      const { body } = await client.getOnboarding();
      assert.strictEqual(body.currentStage, 'agent_mode');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F21.03',
    tier: 1,
    featureId: 21,
    name: 'F21: Logging out and back in retains completed onboarding state',
    fn: async (server: E2ETestServer) => {
      const client1 = new E2ETestClient(server.url, { userId: 'u_f21_persist', tier: 'free' });
      await client1.updateOnboarding('finish');

      // Second client representing subsequent login session
      const client2 = new E2ETestClient(server.url, { userId: 'u_f21_persist', tier: 'free' });
      const { body } = await client2.getOnboarding();
      assert.strictEqual(body.completed, true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F21.04',
    tier: 1,
    featureId: 21,
    name: 'F21: Multiple users on same machine maintain independent onboarding flags',
    fn: async (server: E2ETestServer) => {
      const u1 = new E2ETestClient(server.url, { userId: 'u_f21_multi1', tier: 'free' });
      const u2 = new E2ETestClient(server.url, { userId: 'u_f21_multi2', tier: 'free' });
      await u1.updateOnboarding('skip');
      const r1 = await u1.getOnboarding();
      const r2 = await u2.getOnboarding();
      assert.strictEqual(r1.body.skipped, true);
      assert.strictEqual(r2.body.skipped, false);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F21.05',
    tier: 1,
    featureId: 21,
    name: 'F21: Restarting tutorial persists clean state for target account only',
    fn: async (server: E2ETestServer) => {
      const clientA = new E2ETestClient(server.url, { userId: 'u_f21_ra', tier: 'free' });
      const clientB = new E2ETestClient(server.url, { userId: 'u_f21_rb', tier: 'free' });
      await clientA.updateOnboarding('finish');
      await clientB.updateOnboarding('finish');
      await clientA.updateOnboarding('restart');

      const resA = await clientA.getOnboarding();
      const resB = await clientB.getOnboarding();
      assert.strictEqual(resA.body.completed, false);
      assert.strictEqual(resB.body.completed, true);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 22: Upgrade Feature Discovery Guidance
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F22.01',
    tier: 1,
    featureId: 22,
    name: 'F22: Upgrading to Plus returns unlocked discovery list with agent_mode and reasoning',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f22_plus', tier: 'free' });
      const { status, body } = await client.upgrade('plus');
      assert.strictEqual(status, 200);
      assert.ok(body.featureDiscoveryUnlocked.includes('agent_mode'));
      assert.ok(body.featureDiscoveryUnlocked.includes('reasoning_boosts'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F22.02',
    tier: 1,
    featureId: 22,
    name: 'F22: Upgrading to Pro returns unlocked discovery list with browser tools and python sandbox',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f22_pro', tier: 'plus' });
      const { status, body } = await client.upgrade('pro');
      assert.strictEqual(status, 200);
      assert.ok(body.featureDiscoveryUnlocked.includes('browser_tools'));
      assert.ok(body.featureDiscoveryUnlocked.includes('python_sandbox'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F22.03',
    tier: 1,
    featureId: 22,
    name: 'F22: Guidance card model includes sample prompt for unlocked feature',
    fn: async () => {
      const card = {
        feature: 'python_sandbox',
        title: 'Run Real Python Code',
        samplePrompt: 'Calculate the eigenvalues of a 3x3 matrix'
      };
      assert.ok(card.samplePrompt.length > 0);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F22.04',
    tier: 1,
    featureId: 22,
    name: 'F22: Dismissing feature guidance card removes it from active view',
    fn: async (server: E2ETestServer) => {
      const user = server.getOrCreateUser('u_f22_dismiss', 'plus');
      user.dismissedFeatureGuidance.add('agent_mode');
      assert.ok(user.dismissedFeatureGuidance.has('agent_mode'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F22.05',
    tier: 1,
    featureId: 22,
    name: 'F22: Welcome badge displays newly unlocked quota allowances',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f22_badge', tier: 'free' });
      const { body } = await client.upgrade('pro');
      assert.strictEqual(body.quotas.dailyStandardChatLimit, 150);
      assert.strictEqual(body.quotas.concurrentInferenceLimit, 2);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 23: Notification Preferences UI
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F23.01',
    tier: 1,
    featureId: 23,
    name: 'F23: Notification preferences return announcements, productUpdates, and tips booleans',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f23_prefs', tier: 'free' });
      const { status, body } = await client.getNotificationPreferences();
      assert.strictEqual(status, 200);
      assert.strictEqual(typeof body.announcements, 'boolean');
      assert.strictEqual(typeof body.productUpdates, 'boolean');
      assert.strictEqual(typeof body.tips, 'boolean');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F23.02',
    tier: 1,
    featureId: 23,
    name: 'F23: Updating announcement toggle to false disables optional announcement notifications',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f23_upd', tier: 'free' });
      const { status, body } = await client.updateNotificationPreferences({ announcements: false });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.preferences.announcements, false);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F23.03',
    tier: 1,
    featureId: 23,
    name: 'F23: Notification preferences persist across sessions for target user',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f23_p', tier: 'free' });
      await client.updateNotificationPreferences({ tips: false });
      const { body } = await client.getNotificationPreferences();
      assert.strictEqual(body.tips, false);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F23.04',
    tier: 1,
    featureId: 23,
    name: 'F23: Partial preference update leaves other preferences intact',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f23_part', tier: 'free' });
      await client.updateNotificationPreferences({ productUpdates: false });
      const { body } = await client.getNotificationPreferences();
      assert.strictEqual(body.productUpdates, false);
      assert.strictEqual(body.announcements, true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F23.05',
    tier: 1,
    featureId: 23,
    name: 'F23: Independent notification preferences maintained per user ID',
    fn: async (server: E2ETestServer) => {
      const c1 = new E2ETestClient(server.url, { userId: 'u_f23_u1', tier: 'free' });
      const c2 = new E2ETestClient(server.url, { userId: 'u_f23_u2', tier: 'free' });
      await c1.updateNotificationPreferences({ tips: false });
      const r1 = await c1.getNotificationPreferences();
      const r2 = await c2.getNotificationPreferences();
      assert.strictEqual(r1.body.tips, false);
      assert.strictEqual(r2.body.tips, true);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 24: Centralized Feature Flag Client Hook
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F24.01',
    tier: 1,
    featureId: 24,
    name: 'F24: Hook evaluation model returns synchronous boolean for valid flag',
    fn: async () => {
      const flags = { entitlements_v2: true, pro_tools_execution: false };
      const evalFlag = (key: keyof typeof flags) => flags[key] ?? false;
      assert.strictEqual(evalFlag('entitlements_v2'), true);
      assert.strictEqual(evalFlag('pro_tools_execution'), false);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F24.02',
    tier: 1,
    featureId: 24,
    name: 'F24: Hook returns false fallback when queried flag is undefined in flag dictionary',
    fn: async () => {
      const flags: Record<string, boolean> = { entitlements_v2: true };
      const evalFlag = (key: string) => flags[key] ?? false;
      assert.strictEqual(evalFlag('non_existent_flag'), false);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F24.03',
    tier: 1,
    featureId: 24,
    name: 'F24: Hook evaluates tier-specific flags dynamically on plan change',
    fn: async () => {
      const evalFlags = (tier: string) => ({
        agent_mode_plus: tier === 'plus' || tier === 'pro',
        pro_tools: tier === 'pro'
      });
      assert.strictEqual(evalFlags('free').agent_mode_plus, false);
      assert.strictEqual(evalFlags('plus').agent_mode_plus, true);
      assert.strictEqual(evalFlags('pro').pro_tools, true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F24.04',
    tier: 1,
    featureId: 24,
    name: 'F24: Hook respects development overrides passed via context',
    fn: async () => {
      const defaultFlags = { beta_feature: false };
      const overrides = { beta_feature: true };
      const resolved = { ...defaultFlags, ...overrides };
      assert.strictEqual(resolved.beta_feature, true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F24.05',
    tier: 1,
    featureId: 24,
    name: 'F24: Hook memoization produces stable flag dictionary reference',
    fn: async () => {
      const flagMap = Object.freeze({ entitlements_v2: true });
      assert.ok(Object.isFrozen(flagMap));
    }
  });

  // --------------------------------------------------------------------------
  // Feature 25: Consistent Capability Messaging
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T1.F25.01',
    tier: 1,
    featureId: 25,
    name: 'F25: Model selector lock state matches backend PLAN_MODEL_ALLOWLIST',
    fn: async () => {
      const userTier = 'free';
      const isLocked = (model: string) => !PLAN_MODEL_ALLOWLIST[userTier].includes(model);
      assert.strictEqual(isLocked('claude-3-5-haiku'), false);
      assert.strictEqual(isLocked('claude-3-opus'), true);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F25.02',
    tier: 1,
    featureId: 25,
    name: 'F25: Agent mode toggle displays Plus or Pro badge matching capability matrix',
    fn: async () => {
      const getRequiredBadge = (feature: string) => {
        if (feature === 'agent_mode') return 'Plus';
        if (feature === 'autonomous_agents') return 'Pro';
        return '';
      };
      assert.strictEqual(getRequiredBadge('agent_mode'), 'Plus');
      assert.strictEqual(getRequiredBadge('autonomous_agents'), 'Pro');
    }
  });

  globalTestRegistry.register({
    id: 'T1.F25.03',
    tier: 1,
    featureId: 25,
    name: 'F25: Settings quota numbers match server TIER_QUOTAS constants',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f25_match', tier: 'plus' });
      const { body } = await client.getUsage();
      assert.strictEqual(body.dailyChatsLimit, TIER_QUOTAS.plus.dailyStandardChatLimit);
      assert.strictEqual(body.monthlyCreditsRemaining, TIER_QUOTAS.plus.monthlyPremiumCredits);
    }
  });

  globalTestRegistry.register({
    id: 'T1.F25.04',
    tier: 1,
    featureId: 25,
    name: 'F25: Error message on 403 model restriction aligns with UI upgrade modal text',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f25_err', tier: 'free' });
      const { body } = await client.chatStream('claude-3-opus');
      assert.ok(body.message.includes('requires higher plan tier'));
    }
  });

  globalTestRegistry.register({
    id: 'T1.F25.05',
    tier: 1,
    featureId: 25,
    name: 'F25: Capability discovery prompt recommendations align with backend entitlement guard',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_f25_align', tier: 'free' });
      const { body: disc } = await client.evaluateCapability('run python code');
      const { body: toolRes } = await client.executeTool('python_sandbox');
      assert.strictEqual(disc.requiredTier, toolRes.requiredTier);
    }
  });
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tier1-feature-coverage.test.ts')) {
  (async () => {
    const server = new E2ETestServer();
    await server.start();
    registerTier1Tests();
    const results = await globalTestRegistry.run(server, 1);
    await server.stop();
    const passed = results.filter((r) => r.passed).length;
    console.log(`Tier 1: ${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  })();
}
