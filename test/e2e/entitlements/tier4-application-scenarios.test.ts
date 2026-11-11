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
// TIER 4: REAL-WORLD APPLICATION SCENARIOS (≥8 Complete E2E User Journeys)
// High-complexity, multi-step real-world workloads exercising end-to-end behavior.
// ============================================================================

export function registerTier4Tests() {
  // --------------------------------------------------------------------------
  // Scenario 1: Guest Journey
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T4.S01',
    tier: 4,
    name: 'Scenario 1: Full Guest Journey (5 chats, quota limit, upgrade prompt, sign-in, linking)',
    fn: async (server: E2ETestServer) => {
      // 1. Guest arrives with ephemeral session token
      const guestToken = 'guest_journey_sess_01';
      server.guestSessions.set(guestToken, {
        token: guestToken,
        guestId: 'guest_user_s01',
        chatsUsed: 0,
        conversations: [{ id: 'c_guest_s1', title: 'Exploring AIRA capabilities', messages: [] }],
        createdAt: Date.now()
      });

      const guestClient = new E2ETestClient(server.url, { guestToken, userId: 'guest_user_s01', tier: 'guest' });

      // 2. Check initial guest entitlements
      const entRes = await guestClient.getEntitlements();
      assert.strictEqual(entRes.status, 200);
      assert.strictEqual(entRes.body.tier, 'guest');
      assert.strictEqual(entRes.body.quotas.dailyStandardChatLimit, 5);
      assert.strictEqual(entRes.body.quotas.maxProjects, 0);

      // 3. Guest exercises all 5 allowed daily chats
      for (let i = 1; i <= 5; i++) {
        const chatRes = await guestClient.chatStream('claude-3-haiku');
        assert.strictEqual(chatRes.status, 200, `Guest chat ${i} must succeed`);
      }

      // 4. Guest attempts 6th chat -> receives 429 DAILY_QUOTA_EXHAUSTED
      const limitRes = await guestClient.chatStream('claude-3-haiku');
      assert.strictEqual(limitRes.status, 429);
      assert.strictEqual(limitRes.body.error, 'DAILY_QUOTA_EXHAUSTED');
      assert.strictEqual(limitRes.body.upgradeRequired, true);

      // 5. Guest registers an authenticated Free account
      const authUser = 'user_registered_s01';
      const authClient = new E2ETestClient(server.url, { userId: authUser, tier: 'free' });

      // 6. Link guest session to the authenticated user account
      const linkRes = await authClient.linkGuestSession(guestToken);
      assert.strictEqual(linkRes.status, 200);
      assert.strictEqual(linkRes.body.success, true);
      assert.strictEqual(linkRes.body.migratedChatsCount, 1);

      // 7. Verify newly authenticated account now has full Free tier allowances
      const authUsage = await authClient.getUsage();
      assert.strictEqual(authUsage.body.planName, 'AIRA Free');
      assert.strictEqual(authUsage.body.dailyChatsLimit, 15);
      assert.strictEqual(authUsage.body.remainingDailyChats, 15);
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Free User Journey
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T4.S02',
    tier: 4,
    name: 'Scenario 2: Free User Journey (chats, model upgrade prompt, project limits)',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_s02_free', tier: 'free' });

      // 1. Verify Free entitlements
      const ent = await client.getEntitlements();
      assert.strictEqual(ent.body.tier, 'free');
      assert.strictEqual(ent.body.quotas.dailyStandardChatLimit, 15);
      assert.strictEqual(ent.body.quotas.maxProjects, 3);

      // 2. Chat with allowed Free model
      const chatOk = await client.chatStream('claude-3-5-haiku');
      assert.strictEqual(chatOk.status, 200);

      // 3. Attempt locked flagship model -> 403 PLAN_MODEL_RESTRICTED with contextual trigger
      const lockRes = await client.chatStream('claude-3-opus');
      assert.strictEqual(lockRes.status, 403);
      assert.strictEqual(lockRes.body.error, 'PLAN_MODEL_RESTRICTED');
      assert.strictEqual(lockRes.body.requiredTier, 'pro');

      // 4. Create projects up to quota limit (3 projects)
      const p1 = await client.createProject('Customer CRM');
      const p2 = await client.createProject('Analytics Pipeline');
      const p3 = await client.createProject('Brand Strategy');
      assert.strictEqual(p1.status, 201);
      assert.strictEqual(p2.status, 201);
      assert.strictEqual(p3.status, 201);

      // 5. Attempt 4th project creation -> blocked with 403 QUOTA_EXCEEDED_READ_ONLY_MODE
      const p4 = await client.createProject('4th Project Overflow');
      assert.strictEqual(p4.status, 403);
      assert.strictEqual(p4.body.error, 'QUOTA_EXCEEDED_READ_ONLY_MODE');

      // 6. Verify My Plan & Usage view reports 1 chat used and 14 remaining
      const usage = await client.getUsage();
      assert.strictEqual(usage.body.dailyChatsUsed, 1);
      assert.strictEqual(usage.body.remainingDailyChats, 14);
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Plus Upgrade Journey
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T4.S03',
    tier: 4,
    name: 'Scenario 3: Plus Upgrade Journey (Upgrade, discovery guidance, agent mode, reasoning models)',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_s03_plus', tier: 'free' });

      // 1. Initial Free user checks flags
      const flagsFree = await client.getFeatureFlags();
      assert.strictEqual(flagsFree.body.flags.agent_mode_plus, false);

      // 2. User upgrades to Plus
      const upgRes = await client.upgrade('plus');
      assert.strictEqual(upgRes.status, 200);
      assert.strictEqual(upgRes.body.tier, 'plus');
      assert.ok(upgRes.body.featureDiscoveryUnlocked.includes('agent_mode'));
      assert.ok(upgRes.body.featureDiscoveryUnlocked.includes('reasoning_boosts'));

      // 3. Verify expanded quotas: 50 chats/day, 3000 credits, 50 reasoning boosts, 10 projects
      const ent = await client.getEntitlements();
      assert.strictEqual(ent.body.quotas.dailyStandardChatLimit, 50);
      assert.strictEqual(ent.body.quotas.monthlyPremiumCredits, 3000);
      assert.strictEqual(ent.body.quotas.maxProjects, 10);

      // 4. Feature flags now enable agent_mode_plus
      const flagsPlus = await client.getFeatureFlags();
      assert.strictEqual(flagsPlus.body.flags.agent_mode_plus, true);

      // 5. Successfully stream reasoning model deepseek-r1
      const chatR1 = await client.chatStream('deepseek-r1');
      assert.strictEqual(chatR1.status, 200);

      // 6. Successfully stream claude-3-5-sonnet
      const chatSonnet = await client.chatStream('claude-3-5-sonnet');
      assert.strictEqual(chatSonnet.status, 200);

      // 7. Verify Pro-only tool remains restricted on Plus
      const toolRes = await client.executeTool('python_sandbox', { code: 'import sys' });
      assert.strictEqual(toolRes.status, 403);
      assert.strictEqual(toolRes.body.requiredTier, 'pro');
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Pro Power User Journey
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T4.S04',
    tier: 4,
    name: 'Scenario 4: Pro Power User Journey (autonomous worker, Python sandbox, browser tools, concurrency)',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_s04_pro', tier: 'pro' });

      // 1. Verify Pro tier limits: 150 chats/day, 7500 credits, 2 concurrent inference permits
      const ent = await client.getEntitlements();
      assert.strictEqual(ent.body.tier, 'pro');
      assert.strictEqual(ent.body.quotas.dailyStandardChatLimit, 150);
      assert.strictEqual(ent.body.quotas.concurrentInferenceLimit, 2);

      // 2. Dispatch multi-step autonomous task
      const taskRes = await client.createAutonomousTask('Full architecture code review');
      assert.strictEqual(taskRes.status, 201);
      assert.ok(taskRes.body.taskId.startsWith('task_'));
      assert.strictEqual(taskRes.body.status, 'queued');

      // 3. Execute Python sandbox code
      const pyRes = await client.executeTool('python_sandbox', { code: 'print([x**2 for x in range(5)])' });
      assert.strictEqual(pyRes.status, 200);
      assert.strictEqual(pyRes.body.success, true);

      // 4. Execute Browser automation navigation
      const browserRes = await client.executeTool('browser_navigate', { url: 'https://docs.aira.ai' });
      assert.strictEqual(browserRes.status, 200);

      // 5. Test 2 concurrent requests successfully
      const [r1, r2] = await Promise.all([
        client.chatStream('claude-3-opus'),
        client.chatStream('o1')
      ]);
      assert.strictEqual(r1.status, 200);
      assert.strictEqual(r2.status, 200);
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Downgrade & Data Retention Journey
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T4.S05',
    tier: 4,
    name: 'Scenario 5: Downgrade & Data Retention (Pro to Free, 10 projects kept, read-only status, mutations blocked)',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_s05_down', tier: 'pro' });

      // 1. Pro user creates 10 projects
      for (let i = 1; i <= 10; i++) {
        await client.createProject(`Production Project ${i}`);
      }
      // 2. Pro user creates 60 memories
      for (let i = 1; i <= 60; i++) {
        await client.createMemory(`Context item ${i}`);
      }

      // 3. User downgrades to Free
      const downRes = await client.downgrade('free');
      assert.strictEqual(downRes.status, 200);
      assert.strictEqual(downRes.body.retainedProjects, 10);
      assert.strictEqual(downRes.body.readOnlyProjectsCount, 7); // 10 total - 3 free limit = 7 read-only

      // 4. Query projects: all 10 exist, exactly 7 marked read-only
      const projRes = await client.getProjects();
      assert.strictEqual(projRes.body.total, 10);
      const readOnlyProjects = projRes.body.projects.filter((p: any) => p.readOnly);
      assert.strictEqual(readOnlyProjects.length, 7);

      // 5. Query memories: all 60 exist, exactly 10 marked read-only (60 - 50 = 10)
      const memRes = await client.getMemories();
      assert.strictEqual(memRes.body.total, 60);
      const readOnlyMemories = memRes.body.memories.filter((m: any) => m.readOnly);
      assert.strictEqual(readOnlyMemories.length, 10);

      // 6. Attempting to create 11th project is blocked with 403
      const newProj = await client.createProject('11th Project Attempt');
      assert.strictEqual(newProj.status, 403);
      assert.strictEqual(newProj.body.error, 'QUOTA_EXCEEDED_READ_ONLY_MODE');

      // 7. User upgrades back to Pro -> all projects immediately unlocked!
      await client.upgrade('pro');
      const unlockedProjs = await client.getProjects();
      assert.strictEqual(unlockedProjs.body.projects.every((p: any) => !p.readOnly), true);
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Announcement Lifecycle
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T4.S06',
    tier: 4,
    name: 'Scenario 6: Announcement Lifecycle (Deploy new version, popup, unread badge, dismissal, center)',
    fn: async (server: E2ETestServer) => {
      // 1. Deploy new announcement to registry
      const newAnnId = 'ann-2026-v3-launch';
      server.announcements.unshift({
        id: newAnnId,
        version: '2026.3.0',
        title: 'AIRA 2026 Spring Release',
        summary: 'Massive upgrade to multi-agent orchestration and contextual memory.',
        features: ['Multi-agent pipelines', 'Dynamic Capacity Guard', 'Fast Routing'],
        publishedAt: new Date().toISOString()
      });

      const client = new E2ETestClient(server.url, { userId: 'u_s06_ann_user', tier: 'free' });

      // 2. Client queries announcements -> unread badge reflects new announcement
      const feed1 = await client.getAnnouncements();
      assert.ok(feed1.body.unreadCount >= 1);
      assert.strictEqual(feed1.body.announcements[0].id, newAnnId);

      // 3. User views and dismisses popup
      const dismissRes = await client.dismissAnnouncement(newAnnId);
      assert.strictEqual(dismissRes.status, 200);

      // 4. Unread badge count decrements by 1
      const feed2 = await client.getAnnouncements();
      assert.strictEqual(feed2.body.unreadCount, feed1.body.unreadCount - 1);
      assert.ok(feed2.body.dismissedIds.includes(newAnnId));

      // 5. Open What's New center -> announcement is still viewable
      const foundInCenter = feed2.body.announcements.find((a: any) => a.id === newAnnId);
      assert.ok(foundInCenter);
      assert.strictEqual(foundInCenter.title, 'AIRA 2026 Spring Release');
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Onboarding Lifecycle
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T4.S07',
    tier: 4,
    name: 'Scenario 7: Onboarding Walkthrough Lifecycle (Intro -> Chat -> Agent -> Artifacts -> Plans, Skip, Resume, Restart)',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_s07_onboarding', tier: 'free' });

      // 1. New user first login -> onboarding is not completed, starts at intro
      const initial = await client.getOnboarding();
      assert.strictEqual(initial.body.completed, false);
      assert.strictEqual(initial.body.currentStage, 'intro');

      // 2. Step 1 (Intro) -> Next -> Step 2 (Chat & Reasoning)
      await client.updateOnboarding('stage', 'chat_reasoning');
      const step2 = await client.getOnboarding();
      assert.strictEqual(step2.body.currentStage, 'chat_reasoning');

      // 3. Step 2 -> Back -> Step 1 (Intro)
      await client.updateOnboarding('stage', 'intro');
      const stepBack = await client.getOnboarding();
      assert.strictEqual(stepBack.body.currentStage, 'intro');

      // 4. Step 1 -> Next to Step 3 (Agent mode)
      await client.updateOnboarding('stage', 'agent_mode');

      // 5. Simulate session refresh mid-tour -> resumes at agent_mode!
      const resumeClient = new E2ETestClient(server.url, { userId: 'u_s07_onboarding', tier: 'free' });
      const resumed = await resumeClient.getOnboarding();
      assert.strictEqual(resumed.body.currentStage, 'agent_mode');
      assert.strictEqual(resumed.body.completed, false);

      // 6. Complete remaining stages to Plans and finish
      await resumeClient.updateOnboarding('stage', 'projects_artifacts');
      await resumeClient.updateOnboarding('stage', 'plans');
      const finished = await resumeClient.updateOnboarding('finish');
      assert.strictEqual(finished.body.onboarding.completed, true);

      // 7. User clicks Restart Tutorial from Help Menu -> tour resets to intro!
      const restarted = await resumeClient.updateOnboarding('restart');
      assert.strictEqual(restarted.body.onboarding.completed, false);
      assert.strictEqual(restarted.body.onboarding.currentStage, 'intro');
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Feature Flag Toggles
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T4.S08',
    tier: 4,
    name: 'Scenario 8: Dynamic Feature Flag Rollout (Runtime toggles reflect instantly client/server)',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_s08_flags', tier: 'free' });

      // 1. Check initial defaults
      const f1 = await client.getFeatureFlags();
      assert.strictEqual(f1.body.flags.entitlements_v2, true);
      assert.strictEqual(f1.body.flags.pro_tools_execution, false);

      // 2. Administrator enables pro_tools_execution override
      await client.setFeatureFlagOverride('pro_tools_execution', true);

      // 3. Client immediately receives updated flag value
      const f2 = await client.getFeatureFlags();
      assert.strictEqual(f2.body.flags.pro_tools_execution, true);

      // 4. Administrator disables whats_new_announcements killswitch
      await client.setFeatureFlagOverride('whats_new_announcements', false);
      const f3 = await client.getFeatureFlags();
      assert.strictEqual(f3.body.flags.whats_new_announcements, false);

      // 5. Cleanup overrides
      server.featureFlagOverrides.clear();
    }
  });
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tier4-application-scenarios.test.ts')) {
  (async () => {
    const server = new E2ETestServer();
    await server.start();
    registerTier4Tests();
    const results = await globalTestRegistry.run(server, 4);
    await server.stop();
    const passed = results.filter((r) => r.passed).length;
    console.log(`Tier 4: ${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  })();
}
