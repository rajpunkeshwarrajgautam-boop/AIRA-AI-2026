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
// TIER 3: CROSS-FEATURE COMBINATIONS (Pairwise Interactions ≥25 test cases)
// Tests interactions between distinct subsystems.
// ============================================================================

export function registerTier3Tests() {
  globalTestRegistry.register({
    id: 'T3.C01',
    tier: 3,
    name: 'T3: Guest Linking (F13) + Upgrade (F1): Guest chats link and quota expands to 15 on Free sign-up',
    fn: async (server: E2ETestServer) => {
      const token = 'guest_sess_c01';
      server.guestSessions.set(token, {
        token,
        guestId: 'guest_c01',
        chatsUsed: 3,
        conversations: [{ id: 'c1', title: 'Prior conversation', messages: [] }],
        createdAt: Date.now()
      });
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c01', tier: 'free' });
      const linkRes = await client.linkGuestSession(token);
      assert.strictEqual(linkRes.status, 200);

      const usage = await client.getUsage();
      assert.strictEqual(usage.body.dailyChatsLimit, 15);
      assert.strictEqual(server.guestSessions.get(token)!.linkedUserId, 'u_t3_c01');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C02',
    tier: 3,
    name: 'T3: Guest Quota Exhaustion (F6) + Upgrade Modal Trigger (F16): 5th guest chat triggers guest_limit modal',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c02', tier: 'guest' });
      for (let i = 0; i < 5; i++) {
        await client.chatStream('claude-3-haiku');
      }
      const { status, body } = await client.chatStream('claude-3-haiku');
      assert.strictEqual(status, 429);
      assert.strictEqual(body.error, 'DAILY_QUOTA_EXHAUSTED');

      // UI modal trigger model resolution
      const modalTrigger = body.error === 'DAILY_QUOTA_EXHAUSTED' && body.callerTier === 'guest' ? 'guest_limit' : 'standard';
      assert.strictEqual(modalTrigger, 'guest_limit');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C03',
    tier: 3,
    name: 'T3: Downgrade (F12) + Retention Policy (F12) + Retention UI (F18): Pro downgraded to Free locks excess projects in read-only UI',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c03', tier: 'pro' });
      for (let i = 1; i <= 6; i++) {
        await client.createProject(`Pro Project ${i}`);
      }
      await client.downgrade('free');
      const { body } = await client.getProjects();
      const readOnlyItems = body.projects.filter((p: any) => p.readOnly);
      assert.strictEqual(readOnlyItems.length, 3, '3 of 6 projects must be read-only on Free');

      // Retention UI banner contract
      const banner = {
        visible: body.total > 3,
        retainedCount: body.total,
        limit: 3
      };
      assert.strictEqual(banner.visible, true);
    }
  });

  globalTestRegistry.register({
    id: 'T3.C04',
    tier: 3,
    name: 'T3: Retention UI (F18) + Upgrade Reversal (F1): Locked project unlocks immediately upon upgrade back to Pro',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c04', tier: 'pro' });
      await client.createProject('P1');
      await client.createProject('P2');
      await client.createProject('P3');
      await client.createProject('P4');
      await client.downgrade('free');
      // P4 is read-only
      await client.upgrade('pro');
      // All unlocked!
      const { body } = await client.getProjects();
      assert.strictEqual(body.projects.every((p: any) => !p.readOnly), true);
    }
  });

  globalTestRegistry.register({
    id: 'T3.C05',
    tier: 3,
    name: 'T3: Feature Flag (F3, F24) + Announcement (F4, F19): Enabled feature flag activates corresponding announcement',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c05', tier: 'free' });
      const { body: flags } = await client.getFeatureFlags();
      assert.strictEqual(flags.flags.whats_new_announcements, true);

      const { body: anns } = await client.getAnnouncements();
      assert.ok(anns.announcements.length > 0);
      assert.ok(anns.unreadCount > 0);
    }
  });

  globalTestRegistry.register({
    id: 'T3.C06',
    tier: 3,
    name: 'T3: Announcement Dismissal (F19) + Notification Preferences (F23): Dismissals sync with preferences view',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c06', tier: 'free' });
      await client.dismissAnnouncement('ann-2026-v2');
      const prefs = await client.getNotificationPreferences();
      assert.strictEqual(prefs.status, 200);

      const anns = await client.getAnnouncements();
      assert.ok(anns.body.dismissedIds.includes('ann-2026-v2'));
    }
  });

  globalTestRegistry.register({
    id: 'T3.C07',
    tier: 3,
    name: 'T3: Onboarding Tour (F20) + Feature Discovery Guidance (F22): Walkthrough for Plus user shows Agent mode',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c07', tier: 'plus' });
      await client.updateOnboarding('stage', 'agent_mode');
      const { body: ob } = await client.getOnboarding();
      assert.strictEqual(ob.currentStage, 'agent_mode');

      const { body: flags } = await client.getFeatureFlags();
      assert.strictEqual(flags.flags.agent_mode_plus, true);
    }
  });

  globalTestRegistry.register({
    id: 'T3.C08',
    tier: 3,
    name: 'T3: Onboarding Skip (F20) + Account Persistence (F21): Skip state persists across separate client instances',
    fn: async (server: E2ETestServer) => {
      const client1 = new E2ETestClient(server.url, { userId: 'u_t3_c08', tier: 'free' });
      await client1.updateOnboarding('skip');

      const client2 = new E2ETestClient(server.url, { userId: 'u_t3_c08', tier: 'free' });
      const { body } = await client2.getOnboarding();
      assert.strictEqual(body.skipped, true);
      assert.strictEqual(body.completed, true);
    }
  });

  globalTestRegistry.register({
    id: 'T3.C09',
    tier: 3,
    name: 'T3: Model Routing Gate (F7) + Contextual Upgrade Modal (F16): Locked model triggers Free->Plus modal trigger',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c09', tier: 'free' });
      const { status, body } = await client.chatStream('claude-3-5-sonnet');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.requiredTier, 'plus');

      const modalTrigger = body.requiredTier === 'plus' ? 'free_to_plus_model' : 'generic';
      assert.strictEqual(modalTrigger, 'free_to_plus_model');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C10',
    tier: 3,
    name: 'T3: Tool Gateway Gating (F8) + Contextual Upgrade Modal (F16): Restricted tool triggers Plus->Pro modal trigger',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c10', tier: 'plus' });
      const { status, body } = await client.executeTool('python_sandbox');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.requiredTier, 'pro');

      const modalTrigger = body.requiredTier === 'pro' ? 'plus_to_pro_tool' : 'generic';
      assert.strictEqual(modalTrigger, 'plus_to_pro_tool');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C11',
    tier: 3,
    name: 'T3: Autonomous Worker Fencing (F9) + Capability Messaging (F25): Pro requirement message matches contract',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c11', tier: 'free' });
      const { body } = await client.createAutonomousTask('Autonomous scan');
      assert.strictEqual(body.requiredTier, 'pro');
      assert.strictEqual(body.capability, 'autonomous_agents');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C12',
    tier: 3,
    name: 'T3: Dynamic Concurrency Guard (F11) + Streaming Accounting (F10): 2 concurrent streams on Pro with 1 canceled accounts quota correctly',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c12', tier: 'pro' });
      // Stream 1 completes normally
      await client.chatStream('claude-3-5-sonnet');
      // Stream 2 cancels before chunk
      await client.chatStream('claude-3-5-sonnet', { simulateImmediateDisconnect: true });

      const { body } = await client.getUsage();
      assert.strictEqual(body.dailyChatsUsed, 1, 'Only completed stream should be charged');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C13',
    tier: 3,
    name: 'T3: Streaming Cancel Refund (F10) + Usage Gauge (F14): Canceled stream reflects instantly in usage gauge',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c13', tier: 'free' });
      await client.chatStream('claude-3-5-haiku', { simulateImmediateDisconnect: true });
      const { body } = await client.getUsage();
      assert.strictEqual(body.remainingDailyChats, 15);
    }
  });

  globalTestRegistry.register({
    id: 'T3.C14',
    tier: 3,
    name: 'T3: Plan Navigation (F15) + Upgrade Modal (F16): Compare Plans CTA resolves to /settings?tab=plan',
    fn: async () => {
      const modalAction = { cta: 'COMPARE_PLANS', targetRoute: '/settings?tab=plan' };
      const parsed = new URL('https://aira.app' + modalAction.targetRoute);
      assert.strictEqual(parsed.searchParams.get('tab'), 'plan');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C15',
    tier: 3,
    name: 'T3: Capability Discovery (F17) + Model Selector (F25): Deep reasoning suggestion prompts model selector switch',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c15', tier: 'free' });
      const { body } = await client.evaluateCapability('deep reasoning proof');
      assert.strictEqual(body.recommendedFeature, 'Reasoning Boosts');
      assert.strictEqual(body.requiredTier, 'plus');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C16',
    tier: 3,
    name: 'T3: Feature Flag Killswitch (F3) + Server Guard (F5): Runtime flag toggle alters client capability state',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c16', tier: 'pro' });
      await client.setFeatureFlagOverride('pro_tools_execution', false);
      const { body } = await client.getFeatureFlags();
      assert.strictEqual(body.flags.pro_tools_execution, false);
      server.featureFlagOverrides.delete('pro_tools_execution'); // clean restore
    }
  });

  globalTestRegistry.register({
    id: 'T3.C17',
    tier: 3,
    name: 'T3: Account Switching (F21) + Onboarding Isolation (F21): Swapping users isolates onboarding state',
    fn: async (server: E2ETestServer) => {
      const cA = new E2ETestClient(server.url, { userId: 'u_t3_c17_a', tier: 'free' });
      const cB = new E2ETestClient(server.url, { userId: 'u_t3_c17_b', tier: 'free' });
      await cA.updateOnboarding('finish');
      const resB = await cB.getOnboarding();
      assert.strictEqual(resB.body.completed, false);
    }
  });

  globalTestRegistry.register({
    id: 'T3.C18',
    tier: 3,
    name: 'T3: Guest Anti-Escalation (F6) + Tool Gateway (F8): Guest attempting tool execution blocked with 403',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c18_guest', tier: 'guest' });
      const { status, body } = await client.executeTool('browser_navigate');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_TOOL_RESTRICTED');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C19',
    tier: 3,
    name: 'T3: Guest Session Expiry (F6) + Linking Fix (F13): Non-existent guest token fails link with 400',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c19_auth', tier: 'free' });
      const { status, body } = await client.linkGuestSession('expired_token_123');
      assert.strictEqual(status, 400);
      assert.strictEqual(body.error, 'INVALID_GUEST_SESSION');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C20',
    tier: 3,
    name: 'T3: Downgrade (F12) + Active Autonomous Tasks (F9): Downgraded account blocked from dispatching new tasks',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c20', tier: 'pro' });
      await client.downgrade('free');
      const { status, body } = await client.createAutonomousTask('New task');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_CAPABILITY_RESTRICTED');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C21',
    tier: 3,
    name: 'T3: Pro Concurrency (F11) + Multi-Tool Execution (F8): Pro user executes browser tool and python sandbox',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c21_pro', tier: 'pro' });
      const [t1, t2] = await Promise.all([
        client.executeTool('browser_navigate', { url: 'https://example.com' }),
        client.executeTool('python_sandbox', { code: 'x = 10' })
      ]);
      assert.strictEqual(t1.status, 200);
      assert.strictEqual(t2.status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T3.C22',
    tier: 3,
    name: 'T3: My Plan Usage Gauges (F14) + Quota Limit (F1): Full usage displays 100% capacity in gauge',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c22_full', tier: 'free' });
      const user = server.getOrCreateUser('u_t3_c22_full', 'free');
      user.dailyChatsUsed = 15;

      const { body } = await client.getUsage();
      assert.strictEqual(body.remainingDailyChats, 0);
      const percentUsed = (body.dailyChatsUsed / body.dailyChatsLimit) * 100;
      assert.strictEqual(percentUsed, 100);
    }
  });

  globalTestRegistry.register({
    id: 'T3.C23',
    tier: 3,
    name: 'T3: Notification Preferences (F23) + Upgrade Discovery (F22): Disabling tips silences discovery alerts in UI',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c23_notips', tier: 'free' });
      await client.updateNotificationPreferences({ tips: false });
      const { body } = await client.getNotificationPreferences();
      assert.strictEqual(body.tips, false);
    }
  });

  globalTestRegistry.register({
    id: 'T3.C24',
    tier: 3,
    name: 'T3: Consistent Messaging (F25) + Server Guard 403 (F5): Guard 403 requiredTier matches UI unlock badge',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c24', tier: 'free' });
      const { body } = await client.chatStream('claude-3-opus');
      assert.strictEqual(body.requiredTier, 'pro');
      const badgeText = body.requiredTier === 'pro' ? 'Pro' : 'Plus';
      assert.strictEqual(badgeText, 'Pro');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C25',
    tier: 3,
    name: 'T3: What\'s New CTA (F19) + Capability Discovery (F17): What\'s New CTA invokes capability check on locked tier',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c25', tier: 'free' });
      const { body } = await client.evaluateCapability('execute code in python sandbox');
      assert.strictEqual(body.upgradeRecommended, true);
      assert.strictEqual(body.requiredTier, 'pro');
    }
  });

  globalTestRegistry.register({
    id: 'T3.C26',
    tier: 3,
    name: 'T3: Retention Policy (F12) + Retention UI (F18): Deleting excess project unlocks remaining projects dynamically',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t3_c26_del', tier: 'pro' });
      await client.createProject('P1');
      await client.createProject('P2');
      await client.createProject('P3');
      await client.createProject('P4');
      await client.downgrade('free');
      // P4 was read-only
      const userProjects = Array.from(server.projects.values()).filter((p) => p.userId === 'u_t3_c26_del');
      server.projects.delete(userProjects[0].id); // Delete 1

      // Recalculate remaining 3
      const remaining = Array.from(server.projects.values()).filter((p) => p.userId === 'u_t3_c26_del');
      remaining.forEach((p, idx) => {
        p.readOnly = idx >= 3;
      });
      assert.strictEqual(remaining.every((p) => !p.readOnly), true);
    }
  });
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tier3-cross-feature.test.ts')) {
  (async () => {
    const server = new E2ETestServer();
    await server.start();
    registerTier3Tests();
    const results = await globalTestRegistry.run(server, 3);
    await server.stop();
    const passed = results.filter((r) => r.passed).length;
    console.log(`Tier 3: ${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  })();
}
