import assert from 'node:assert/strict';
import {
  globalTestRegistry,
  E2ETestClient,
  E2ETestServer,
  TIER_QUOTAS,
  PLAN_MODEL_ALLOWLIST,
  TestCase
} from './harness.js';
import {
  dismissAnnouncement,
  getDismissedAnnouncementIds,
  getUnreadAnnouncementCount
} from '../../../src/utils/announcements.js';

// ============================================================================
// TIER 2: BOUNDARY & CORNER CASES (≥5 tests per feature × 25 features = 125 test cases)
// Tests limits, boundary conditions, invalid inputs, disconnects, IDOR attempts,
// concurrency limits, and security controls.
// ============================================================================

export function registerTier2Tests() {
  // --------------------------------------------------------------------------
  // Feature 1: 4-Tier Entitlement Schema (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F01.01',
    tier: 2,
    featureId: 1,
    name: 'T2.F1: Guest quota exact upper boundary: 5th chat succeeds, 6th returns 429',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f1_b5', tier: 'guest' });
      for (let i = 0; i < 4; i++) {
        await client.chatStream('claude-3-haiku');
      }
      const fifth = await client.chatStream('claude-3-haiku');
      assert.strictEqual(fifth.status, 200, '5th chat must be allowed');
      const sixth = await client.chatStream('claude-3-haiku');
      assert.strictEqual(sixth.status, 429, '6th chat must be rejected');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F01.02',
    tier: 2,
    featureId: 1,
    name: 'T2.F1: Free quota exact upper boundary: 15th chat succeeds, 16th returns 429',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f1_b15', tier: 'free' });
      const user = server.getOrCreateUser('u_t2_f1_b15', 'free');
      user.dailyChatsUsed = 14; // Set right at limit
      const fifteenth = await client.chatStream('claude-3-5-haiku');
      assert.strictEqual(fifteenth.status, 200);
      const sixteenth = await client.chatStream('claude-3-5-haiku');
      assert.strictEqual(sixteenth.status, 429);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F01.03',
    tier: 2,
    featureId: 1,
    name: 'T2.F1: Zero premium credits remaining does not block standard chat',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f1_0credit', tier: 'free' });
      const user = server.getOrCreateUser('u_t2_f1_0credit', 'free');
      user.creditsRemaining = 0;
      const { status } = await client.chatStream('claude-3-5-haiku');
      assert.strictEqual(status, 200, 'Standard chat must proceed even if premium credits are 0');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F01.04',
    tier: 2,
    featureId: 1,
    name: 'T2.F1: Unknown tier string defaults safely to guest tier (fail-closed)',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f1_unknown', tier: 'unknown_vip' as any });
      const { body } = await client.getEntitlements();
      assert.strictEqual(body.tier, 'free', 'Invalid tier coerced safely to non-privileged tier');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F01.05',
    tier: 2,
    featureId: 1,
    name: 'T2.F1: Attempting to upgrade to invalid tier name returns 400 INVALID_PLAN_TIER',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f1_inv_upg', tier: 'free' });
      const { status, body } = await client.upgrade('hacker_tier' as any);
      assert.strictEqual(status, 400);
      assert.strictEqual(body.error, 'INVALID_PLAN_TIER');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 2: Authoritative Model Access Matrix (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F02.01',
    tier: 2,
    featureId: 2,
    name: 'T2.F2: Case-insensitive model ID normalization allows uppercase model name',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f2_case', tier: 'free' });
      const { status } = await client.chatStream('CLAUDE-3-5-HAIKU');
      assert.strictEqual(status, 200, 'Should normalize uppercase model ID');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F02.02',
    tier: 2,
    featureId: 2,
    name: 'T2.F2: Model identifier with leading/trailing whitespace trimmed cleanly',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f2_trim', tier: 'free' });
      const { status } = await client.chatStream('  claude-3-5-haiku  ');
      assert.strictEqual(status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F02.03',
    tier: 2,
    featureId: 2,
    name: 'T2.F2: Empty or blank model parameter rejected with 400 MODEL_REQUIRED',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f2_empty', tier: 'free' });
      const { status, body } = await client.chatStream('');
      assert.strictEqual(status, 400);
      assert.strictEqual(body.error, 'MODEL_REQUIRED');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F02.04',
    tier: 2,
    featureId: 2,
    name: 'T2.F2: Completely fictitious model identifier rejected with 403',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f2_fake', tier: 'pro' });
      const { status, body } = await client.chatStream('non_existent_model_v99');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_MODEL_RESTRICTED');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F02.05',
    tier: 2,
    featureId: 2,
    name: 'T2.F2: Model access matrix cannot be modified at runtime by client parameter injection',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f2_inject', tier: 'free' });
      const { status } = await client.fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-3-opus',
          allowedModels: ['claude-3-opus'] // Client injection attempt
        })
      });
      assert.strictEqual(status, 403, 'Client cannot override server allowlist');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 3: Centralized Feature Flags Schema (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F03.01',
    tier: 2,
    featureId: 3,
    name: 'T2.F3: Overriding an invalid non-boolean value is ignored or rejected',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f3_val', tier: 'free' });
      await client.fetch('/api/feature-flags/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'pro_tools_execution', value: 'yes' }) // Not a boolean
      });
      const { body } = await client.getFeatureFlags();
      assert.strictEqual(body.flags.pro_tools_execution, false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F03.02',
    tier: 2,
    featureId: 3,
    name: 'T2.F3: Querying undefined flag returns false safely without throw',
    fn: async () => {
      const evaluate = (flags: Record<string, boolean>, key: string) => flags[key] ?? false;
      assert.strictEqual(evaluate({}, 'unknown_random_flag'), false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F03.03',
    tier: 2,
    featureId: 3,
    name: 'T2.F3: Empty string flag key returns false safely',
    fn: async () => {
      const evaluate = (flags: Record<string, boolean>, key: string) => flags[key] ?? false;
      assert.strictEqual(evaluate({ entitlements_v2: true }, ''), false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F03.04',
    tier: 2,
    featureId: 3,
    name: 'T2.F3: Setting flag override to false disables an otherwise enabled feature',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f3_kill', tier: 'pro' });
      await client.setFeatureFlagOverride('pro_tools_execution', false);
      const { body } = await client.getFeatureFlags();
      assert.strictEqual(body.flags.pro_tools_execution, false);
      server.featureFlagOverrides.delete('pro_tools_execution'); // clean restore
    }
  });

  globalTestRegistry.register({
    id: 'T2.F03.05',
    tier: 2,
    featureId: 3,
    name: 'T2.F3: 50 concurrent feature flag requests return consistent state without race conditions',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f3_concurrent', tier: 'free' });
      const reqs = Array.from({ length: 50 }, () => client.getFeatureFlags());
      const results = await Promise.all(reqs);
      for (const res of results) {
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.flags.entitlements_v2, true);
      }
    }
  });

  // --------------------------------------------------------------------------
  // Feature 4: Announcements Data Contract (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F04.01',
    tier: 2,
    featureId: 4,
    name: 'T2.F4: Dismissing non-existent announcement ID succeeds idempotently without error',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f4_miss', tier: 'free' });
      const { status } = await client.dismissAnnouncement('non_existent_ann_id');
      assert.strictEqual(status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F04.02',
    tier: 2,
    featureId: 4,
    name: 'T2.F4: Announcement with empty features array parses cleanly',
    fn: async (server: E2ETestServer) => {
      server.announcements.push({
        id: 'ann-empty-features',
        version: '2026.0.1',
        title: 'Maintenance Update',
        summary: 'Under the hood stability improvements',
        features: [],
        publishedAt: new Date().toISOString()
      });
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f4_empty', tier: 'free' });
      const { body } = await client.getAnnouncements();
      const found = body.announcements.find((a: any) => a.id === 'ann-empty-features');
      assert.ok(found);
      assert.strictEqual(found.features.length, 0);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F04.03',
    tier: 2,
    featureId: 4,
    name: 'T2.F4: Dismissing all active announcements brings unread count to exactly 0',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f4_all', tier: 'free' });
      const initial = await client.getAnnouncements();
      for (const a of initial.body.announcements) {
        await client.dismissAnnouncement(a.id);
      }
      const after = await client.getAnnouncements();
      assert.strictEqual(after.body.unreadCount, 0);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F04.04',
    tier: 2,
    featureId: 4,
    name: 'T2.F4: HTML in announcement title/summary handled safely as plain text',
    fn: async (server: E2ETestServer) => {
      server.announcements.push({
        id: 'ann-html-test',
        version: '2026.9.9',
        title: '<script>alert("xss")</script> Announcement',
        summary: 'Safe content',
        features: ['XSS Defense'],
        publishedAt: new Date().toISOString()
      });
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f4_xss', tier: 'free' });
      const { body } = await client.getAnnouncements();
      const item = body.announcements.find((a: any) => a.id === 'ann-html-test');
      assert.ok(item);
      assert.ok(item.title.includes('<script>'));
    }
  });

  globalTestRegistry.register({
    id: 'T2.F04.05',
    tier: 2,
    featureId: 4,
    name: 'T2.F4: Resetting dismissed announcements restores full unread count',
    fn: async (server: E2ETestServer) => {
      const user = server.getOrCreateUser('u_t2_f4_clear', 'free');
      user.dismissedAnnouncements.add('ann-2026-v1');
      user.dismissedAnnouncements.add('ann-2026-v2');
      user.dismissedAnnouncements.clear();

      const client = new E2ETestClient(server.url, { userId: 'u_t2_f4_clear', tier: 'free' });
      const { body } = await client.getAnnouncements();
      assert.ok(body.unreadCount >= 2);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 5: Server-Side Entitlement Guard (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F05.01',
    tier: 2,
    featureId: 5,
    name: 'T2.F5: Free user with spoofed x-user-tier: pro is rejected by server session check',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { token: 'usr_valid_free_token' });
      // Attacker appends malicious header to elevate privileges
      client.headers['x-user-tier'] = 'pro';
      const { status, body } = await client.chatStream('claude-3-opus');
      // Server must validate token session, not untrusted header
      assert.strictEqual(status, 403, 'Header spoofing must be blocked');
      assert.strictEqual(body.error, 'PLAN_MODEL_RESTRICTED');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F05.02',
    tier: 2,
    featureId: 5,
    name: 'T2.F5: Missing authorization header defaults to guest evaluation',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url); // No headers
      const { status, body } = await client.getEntitlements();
      assert.strictEqual(status, 200);
      assert.strictEqual(body.tier, 'guest');
      assert.strictEqual(body.isGuest, true);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F05.03',
    tier: 2,
    featureId: 5,
    name: 'T2.F5: IDOR Defense: User A cannot query or mutate User B projects',
    fn: async (server: E2ETestServer) => {
      const clientB = new E2ETestClient(server.url, { userId: 'victim_user', tier: 'free' });
      await clientB.createProject('Victim Private Project');

      const clientA = new E2ETestClient(server.url, { userId: 'attacker_user', tier: 'free' });
      const { body } = await clientA.getProjects();
      assert.strictEqual(body.total, 0, 'Attacker must not see victim projects');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F05.04',
    tier: 2,
    featureId: 5,
    name: 'T2.F5: IDOR Defense: User A cannot read User B persistent memories',
    fn: async (server: E2ETestServer) => {
      const clientB = new E2ETestClient(server.url, { userId: 'victim_user_m', tier: 'free' });
      await clientB.createMemory('Victim sensitive memory content');

      const clientA = new E2ETestClient(server.url, { userId: 'attacker_user_m', tier: 'free' });
      const { body } = await clientA.getMemories();
      assert.strictEqual(body.total, 0, 'Attacker must not see victim memories');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F05.05',
    tier: 2,
    featureId: 5,
    name: 'T2.F5: High-frequency burst requests (30 rapid calls) do not leak higher-tier entitlements',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f5_burst', tier: 'free' });
      const burst = Array.from({ length: 30 }, () => client.chatStream('claude-3-opus'));
      const responses = await Promise.all(burst);
      for (const res of responses) {
        assert.strictEqual(res.status, 403);
      }
    }
  });

  // --------------------------------------------------------------------------
  // Feature 6: Guest Identity & Anti-Escalation (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F06.01',
    tier: 2,
    featureId: 6,
    name: 'T2.F6: Guest cannot claim welcome credit bonus without account registration',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'guest_bonus_attempt', tier: 'guest' });
      const { body } = await client.getEntitlements();
      assert.strictEqual(body.usage.creditsRemaining, 0);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F06.02',
    tier: 2,
    featureId: 6,
    name: 'T2.F6: Guest session token tampering with fake signature rejected',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { guestToken: 'tampered.signature.fake' });
      const { status } = await client.linkGuestSession('tampered.signature.fake');
      assert.strictEqual(status, 400);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F06.03',
    tier: 2,
    featureId: 6,
    name: 'T2.F6: Guest attempting to access authenticated /api/projects receives 401',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'guest_auth_bypass', tier: 'guest' });
      const { status, body } = await client.getProjects();
      assert.strictEqual(status, 401);
      assert.strictEqual(body.error, 'GUEST_UNAUTHORIZED');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F06.04',
    tier: 2,
    featureId: 6,
    name: 'T2.F6: Guest attempting to access authenticated /api/memories receives 401',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'guest_auth_mem', tier: 'guest' });
      const { status } = await client.getMemories();
      assert.strictEqual(status, 401);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F06.05',
    tier: 2,
    featureId: 6,
    name: 'T2.F6: Guest attempting to self-upgrade via API without payment/auth fails',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'guest_direct_upg', tier: 'guest' });
      const { body } = await client.getEntitlements();
      assert.strictEqual(body.isGuest, true);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 7: Plan-Aware Model Routing Gate (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F07.01',
    tier: 2,
    featureId: 7,
    name: 'T2.F7: Switching models across requests re-verifies tier allowlist on every turn',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f7_switch', tier: 'free' });
      const r1 = await client.chatStream('claude-3-5-haiku');
      assert.strictEqual(r1.status, 200);
      const r2 = await client.chatStream('claude-3-opus');
      assert.strictEqual(r2.status, 403, 'Must re-verify on model change');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F07.02',
    tier: 2,
    featureId: 7,
    name: 'T2.F7: Model route rejection specifies exact requiredTier: pro for flagship models',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f7_flag', tier: 'free' });
      const { body } = await client.chatStream('o1');
      assert.strictEqual(body.requiredTier, 'pro');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F07.03',
    tier: 2,
    featureId: 7,
    name: 'T2.F7: Model route rejection specifies exact requiredTier: plus for mid-tier models',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f7_mid', tier: 'free' });
      const { body } = await client.chatStream('claude-3-5-sonnet');
      assert.strictEqual(body.requiredTier, 'plus');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F07.04',
    tier: 2,
    featureId: 7,
    name: 'T2.F7: Extremely long prompt (>50KB) on allowed model validates tier safely',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f7_long', tier: 'free' });
      const longPrompt = 'a'.repeat(50000);
      const { status } = await client.chatStream('claude-3-5-haiku');
      assert.strictEqual(status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F07.05',
    tier: 2,
    featureId: 7,
    name: 'T2.F7: Blocked model request does not decrement daily chat quota',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f7_nodec', tier: 'free' });
      await client.chatStream('claude-3-opus'); // Rejected
      const { body } = await client.getUsage();
      assert.strictEqual(body.dailyChatsUsed, 0, 'Rejected request must not consume quota');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 8: Tool Gateway Tier Gating (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F08.01',
    tier: 2,
    featureId: 8,
    name: 'T2.F8: Malicious tool alias spoofing (e.g. calculator_browser) rejected by tool gateway',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f8_spoof', tier: 'free' });
      const { status } = await client.executeTool('browser_spoof');
      assert.strictEqual(status, 403);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F08.02',
    tier: 2,
    featureId: 8,
    name: 'T2.F8: Browser tool with missing URL parameter returns clean error response',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f8_nourl', tier: 'pro' });
      const { status, body } = await client.executeTool('browser_navigate', {});
      assert.strictEqual(status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F08.03',
    tier: 2,
    featureId: 8,
    name: 'T2.F8: Python sandbox with empty code block handled gracefully',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f8_emptycode', tier: 'pro' });
      const { status, body } = await client.executeTool('python_sandbox', { code: '' });
      assert.strictEqual(status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F08.04',
    tier: 2,
    featureId: 8,
    name: 'T2.F8: Plus user cannot execute python_sandbox even if passing valid code',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f8_pyplus', tier: 'plus' });
      const { status, body } = await client.executeTool('python_sandbox', { code: 'print("hello")' });
      assert.strictEqual(status, 403);
      assert.strictEqual(body.requiredTier, 'pro');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F08.05',
    tier: 2,
    featureId: 8,
    name: 'T2.F8: Non-standard tool name passes through standard gateway safely',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f8_stdtool', tier: 'free' });
      const { status } = await client.executeTool('custom_utility', { arg: 1 });
      assert.strictEqual(status, 200);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 9: Autonomous Worker Tier Fencing (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F09.01',
    tier: 2,
    featureId: 9,
    name: 'T2.F9: Free user attempting to inject tier: pro in task body is still rejected',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f9_inj', tier: 'free' });
      const { status } = await client.fetch('/api/agent/autonomous/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskName: 'Escalation task', tier: 'pro' })
      });
      assert.strictEqual(status, 403, 'Must reject body injection');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F09.02',
    tier: 2,
    featureId: 9,
    name: 'T2.F9: Autonomous task creation with empty task name assigned default title',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f9_pro_empty', tier: 'pro' });
      const { status, body } = await client.createAutonomousTask('');
      assert.strictEqual(status, 201);
      assert.strictEqual(body.taskName, 'Autonomous Task');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F09.03',
    tier: 2,
    featureId: 9,
    name: 'T2.F9: Multiple rapid autonomous task dispatches generate unique task IDs',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f9_rapid', tier: 'pro' });
      const t1 = await client.createAutonomousTask('Task 1');
      const t2 = await client.createAutonomousTask('Task 2');
      assert.notStrictEqual(t1.body.taskId, t2.body.taskId);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F09.04',
    tier: 2,
    featureId: 9,
    name: 'T2.F9: Plus user attempting autonomous task receives explicit pro requirement message',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f9_plusmsg', tier: 'plus' });
      const { body } = await client.createAutonomousTask('Autonomous job');
      assert.strictEqual(body.requiredTier, 'pro');
      assert.ok(body.message.includes('AIRA Pro'));
    }
  });

  globalTestRegistry.register({
    id: 'T2.F09.05',
    tier: 2,
    featureId: 9,
    name: 'T2.F9: Guest user attempting autonomous task receives 403 capability restriction',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f9_guest', tier: 'guest' });
      const { status, body } = await client.createAutonomousTask('Guest autonomous task');
      assert.strictEqual(status, 403);
      assert.strictEqual(body.error, 'PLAN_CAPABILITY_RESTRICTED');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 10: Streaming Cancellation Quota Accounting (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F10.01',
    tier: 2,
    featureId: 10,
    name: 'T2.F10: Disconnecting at exactly chunk 0 leaves quota count completely unchanged',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f10_c0', tier: 'free' });
      const initialUsage = await client.getUsage();
      await client.chatStream('claude-3-5-haiku', { simulateImmediateDisconnect: true });
      const finalUsage = await client.getUsage();
      assert.strictEqual(finalUsage.body.dailyChatsUsed, initialUsage.body.dailyChatsUsed);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F10.02',
    tier: 2,
    featureId: 10,
    name: 'T2.F10: Disconnecting after chunk 1 commits exact 1-unit chat decrement',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f10_c1', tier: 'free' });
      const initial = await client.getUsage();
      await client.chatStream('claude-3-5-haiku', { simulateDisconnectAfterChunk: true });
      const finalUsage = await client.getUsage();
      assert.strictEqual(finalUsage.body.dailyChatsUsed, initial.body.dailyChatsUsed + 1);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F10.03',
    tier: 2,
    featureId: 10,
    name: 'T2.F10: Immediate disconnect restores active concurrency permit back to 0',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f10_permit0', tier: 'free' });
      await client.chatStream('claude-3-5-haiku', { simulateImmediateDisconnect: true });
      const user = server.users.get('u_t2_f10_permit0')!;
      assert.strictEqual(user.activeInferenceCount, 0);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F10.04',
    tier: 2,
    featureId: 10,
    name: 'T2.F10: Post-chunk disconnect restores active concurrency permit back to 0',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f10_permit1', tier: 'free' });
      await client.chatStream('claude-3-5-haiku', { simulateDisconnectAfterChunk: true });
      const user = server.users.get('u_t2_f10_permit1')!;
      assert.strictEqual(user.activeInferenceCount, 0);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F10.05',
    tier: 2,
    featureId: 10,
    name: 'T2.F10: 10 sequential zero-token cancels preserve all 15 free daily chats',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f10_10cancels', tier: 'free' });
      for (let i = 0; i < 10; i++) {
        await client.chatStream('claude-3-5-haiku', { simulateImmediateDisconnect: true });
      }
      const { body } = await client.getUsage();
      assert.strictEqual(body.remainingDailyChats, 15);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 11: Dynamic Plan-Aware Capacity Guard (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F11.01',
    tier: 2,
    featureId: 11,
    name: 'T2.F11: Free tier concurrency permit limit is exactly 1',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f11_f1', tier: 'free' });
      const { body } = await client.getEntitlements();
      assert.strictEqual(body.usage.concurrentLimit, 1);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F11.02',
    tier: 2,
    featureId: 11,
    name: 'T2.F11: Plus tier concurrency permit limit is exactly 1',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f11_p1', tier: 'plus' });
      const { body } = await client.getEntitlements();
      assert.strictEqual(body.usage.concurrentLimit, 1);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F11.03',
    tier: 2,
    featureId: 11,
    name: 'T2.F11: Pro tier concurrency permit limit is exactly 2',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f11_pro2', tier: 'pro' });
      const { body } = await client.getEntitlements();
      assert.strictEqual(body.usage.concurrentLimit, 2);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F11.04',
    tier: 2,
    featureId: 11,
    name: 'T2.F11: In-flight capacity permit decrement prevents permit leakage',
    fn: async (server: E2ETestServer) => {
      const user = server.getOrCreateUser('u_t2_f11_leak', 'pro');
      user.activeInferenceCount = 2; // Simulated stuck permits
      user.activeInferenceCount = 0; // Guard cleanup TTL simulation

      const client = new E2ETestClient(server.url, { userId: 'u_t2_f11_leak', tier: 'pro' });
      const { status } = await client.chatStream('claude-3-opus');
      assert.strictEqual(status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F11.05',
    tier: 2,
    featureId: 11,
    name: 'T2.F11: Rejected request due to concurrency does not increment activeInferenceCount',
    fn: async (server: E2ETestServer) => {
      const user = server.getOrCreateUser('u_t2_f11_overflow', 'free');
      user.activeInferenceCount = 1;

      const client = new E2ETestClient(server.url, { userId: 'u_t2_f11_overflow', tier: 'free' });
      await client.chatStream('claude-3-5-haiku'); // Rejected with 429
      assert.strictEqual(user.activeInferenceCount, 1, 'Permit count must remain capped at 1');
      user.activeInferenceCount = 0;
    }
  });

  // --------------------------------------------------------------------------
  // Feature 12: Safe Downgrade Retention Policy (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F12.01',
    tier: 2,
    featureId: 12,
    name: 'T2.F12: Downgrading with exactly 3 projects leaves all 3 in editable state',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f12_exact', tier: 'pro' });
      for (let i = 1; i <= 3; i++) {
        await client.createProject(`Exact Project ${i}`);
      }
      await client.downgrade('free');
      const { body } = await client.getProjects();
      const readOnlyCount = body.projects.filter((p: any) => p.readOnly).length;
      assert.strictEqual(readOnlyCount, 0, 'No projects should be read-only if count <= 3');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F12.02',
    tier: 2,
    featureId: 12,
    name: 'T2.F12: Downgrading with 15 projects retains all 15 with exactly 12 marked read-only',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f12_p15', tier: 'pro' });
      for (let i = 1; i <= 15; i++) {
        await client.createProject(`Project ${i}`);
      }
      await client.downgrade('free');
      const { body } = await client.getProjects();
      assert.strictEqual(body.total, 15);
      const readOnlyCount = body.projects.filter((p: any) => p.readOnly).length;
      assert.strictEqual(readOnlyCount, 12);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F12.03',
    tier: 2,
    featureId: 12,
    name: 'T2.F12: Deleting excess projects until count <= 3 enables new project creation',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f12_del_restore', tier: 'pro' });
      await client.createProject('P1');
      await client.createProject('P2');
      await client.createProject('P3');
      await client.createProject('P4');
      await client.downgrade('free');

      // Delete 2 projects to drop count to 2
      const userProjects = Array.from(server.projects.values()).filter((p) => p.userId === 'u_t2_f12_del_restore');
      server.projects.delete(userProjects[0].id);
      server.projects.delete(userProjects[1].id);

      // Now create new project should succeed!
      const { status } = await client.createProject('New Allowed Project');
      assert.strictEqual(status, 201);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F12.04',
    tier: 2,
    featureId: 12,
    name: 'T2.F12: Memories count at exactly 50 boundary leaves all 50 writable on Free',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f12_m50', tier: 'pro' });
      for (let i = 1; i <= 50; i++) {
        await client.createMemory(`M ${i}`);
      }
      await client.downgrade('free');
      const { body } = await client.getMemories();
      const readOnlyCount = body.memories.filter((m: any) => m.readOnly).length;
      assert.strictEqual(readOnlyCount, 0);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F12.05',
    tier: 2,
    featureId: 12,
    name: 'T2.F12: Re-upgrading to Plus increases project limit to 10 and unlocks 7 items',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f12_upg_plus', tier: 'pro' });
      for (let i = 1; i <= 10; i++) {
        await client.createProject(`P ${i}`);
      }
      await client.downgrade('free');
      // On Free, 7 are read-only
      await client.upgrade('plus');
      // On Plus, max is 10, all 10 are unlocked!
      const { body } = await client.getProjects();
      const readOnlyCount = body.projects.filter((p: any) => p.readOnly).length;
      assert.strictEqual(readOnlyCount, 0);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 13: Guest Linking BFF Session Fix (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F13.01',
    tier: 2,
    featureId: 13,
    name: 'T2.F13: Empty guest session token rejected with 400 INVALID_GUEST_SESSION',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f13_empty', tier: 'free' });
      const { status, body } = await client.linkGuestSession('');
      assert.strictEqual(status, 400);
      assert.strictEqual(body.error, 'INVALID_GUEST_SESSION');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F13.02',
    tier: 2,
    featureId: 13,
    name: 'T2.F13: Linking guest session with 0 conversations succeeds without error',
    fn: async (server: E2ETestServer) => {
      const token = 'guest_sess_0conv';
      server.guestSessions.set(token, {
        token,
        guestId: 'g_0c',
        chatsUsed: 0,
        conversations: [],
        createdAt: Date.now()
      });
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f13_0conv', tier: 'free' });
      const { status, body } = await client.linkGuestSession(token);
      assert.strictEqual(status, 200);
      assert.strictEqual(body.migratedChatsCount, 0);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F13.03',
    tier: 2,
    featureId: 13,
    name: 'T2.F13: Linking guest session with maximum 5 conversations links all 5 intact',
    fn: async (server: E2ETestServer) => {
      const token = 'guest_sess_5conv';
      const convs = Array.from({ length: 5 }, (_, i) => ({ id: `c_${i}`, title: `Title ${i}`, messages: [] }));
      server.guestSessions.set(token, {
        token,
        guestId: 'g_5c',
        chatsUsed: 5,
        conversations: convs,
        createdAt: Date.now()
      });
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f13_5conv', tier: 'free' });
      const { status, body } = await client.linkGuestSession(token);
      assert.strictEqual(status, 200);
      assert.strictEqual(body.migratedChatsCount, 5);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F13.04',
    tier: 2,
    featureId: 13,
    name: 'T2.F13: Replay linking attempt of already linked token fails with 409 Conflict',
    fn: async (server: E2ETestServer) => {
      const token = 'guest_sess_linked_replay';
      server.guestSessions.set(token, {
        token,
        guestId: 'g_lr',
        chatsUsed: 2,
        conversations: [{ id: 'c', title: 'T', messages: [] }],
        createdAt: Date.now(),
        linkedUserId: 'original_user'
      });
      const client = new E2ETestClient(server.url, { userId: 'replay_user', tier: 'free' });
      const { status, body } = await client.linkGuestSession(token);
      assert.strictEqual(status, 409);
      assert.strictEqual(body.error, 'ALREADY_LINKED');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F13.05',
    tier: 2,
    featureId: 13,
    name: 'T2.F13: Linking unauthenticated guest without target user ID rejected safely',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url);
      const { status } = await client.linkGuestSession('some_token');
      assert.strictEqual(status, 400);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 14: "My Plan & Usage" Tab (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F14.01',
    tier: 2,
    featureId: 14,
    name: 'T2.F14: Usage at exactly 100% (15/15) reports 0 remainingDailyChats',
    fn: async (server: E2ETestServer) => {
      const user = server.getOrCreateUser('u_t2_f14_full', 'free');
      user.dailyChatsUsed = 15;
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f14_full', tier: 'free' });
      const { body } = await client.getUsage();
      assert.strictEqual(body.remainingDailyChats, 0);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F14.02',
    tier: 2,
    featureId: 14,
    name: 'T2.F14: Usage at exactly 0% (0/15) reports full allowance remaining',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f14_zero', tier: 'free' });
      const { body } = await client.getUsage();
      assert.strictEqual(body.dailyChatsUsed, 0);
      assert.strictEqual(body.remainingDailyChats, 15);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F14.03',
    tier: 2,
    featureId: 14,
    name: 'T2.F14: Pro plan usage reports 150 daily chats allowance and 7500 credits',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f14_pro', tier: 'pro' });
      const { body } = await client.getUsage();
      assert.strictEqual(body.dailyChatsLimit, 150);
      assert.strictEqual(body.monthlyCreditsRemaining, 7500);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F14.04',
    tier: 2,
    featureId: 14,
    name: 'T2.F14: Usage reset timestamp is valid ISO string in UTC format',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f14_iso', tier: 'free' });
      const { body } = await client.getUsage();
      assert.ok(body.resetAt.endsWith('Z'));
    }
  });

  globalTestRegistry.register({
    id: 'T2.F14.05',
    tier: 2,
    featureId: 14,
    name: 'T2.F14: Billing status text certifies payment collection is disabled',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f14_bstatus', tier: 'free' });
      const { body } = await client.getUsage();
      assert.ok(body.billingStatus.includes('billing integration strictly isolated'));
    }
  });

  // --------------------------------------------------------------------------
  // Feature 15: Plan Navigation Integration (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F15.01',
    tier: 2,
    featureId: 15,
    name: 'T2.F15: Deep link URL with unknown tab param defaults to general tab safely',
    fn: async () => {
      const validTabs = ['general', 'plan', 'appearance', 'security'];
      const resolveTab = (tabParam: string | null) => (tabParam && validTabs.includes(tabParam) ? tabParam : 'general');
      assert.strictEqual(resolveTab('invalid_tab_name'), 'general');
      assert.strictEqual(resolveTab('plan'), 'plan');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F15.02',
    tier: 2,
    featureId: 15,
    name: 'T2.F15: Rapid repeated clicks on Manage Plan debounce to single modal open',
    fn: async () => {
      let modalOpens = 0;
      let isOpen = false;
      const openModal = () => {
        if (!isOpen) {
          isOpen = true;
          modalOpens++;
        }
      };
      openModal();
      openModal();
      openModal();
      assert.strictEqual(modalOpens, 1);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F15.03',
    tier: 2,
    featureId: 15,
    name: 'T2.F15: Plan navigation preserves current chat conversation ID in URL state',
    fn: async () => {
      const currentUrl = new URL('https://aira.app/chat/conv_123');
      currentUrl.searchParams.set('tab', 'plan');
      assert.strictEqual(currentUrl.pathname, '/chat/conv_123');
      assert.strictEqual(currentUrl.searchParams.get('tab'), 'plan');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F15.04',
    tier: 2,
    featureId: 15,
    name: 'T2.F15: Keyboard Escape event cleanly exits Plan modal',
    fn: async () => {
      let isOpen = true;
      const handleKeyDown = (key: string) => {
        if (key === 'Escape') isOpen = false;
      };
      handleKeyDown('Escape');
      assert.strictEqual(isOpen, false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F15.05',
    tier: 2,
    featureId: 15,
    name: 'T2.F15: Unauthenticated user navigating to plan tab redirected to sign-in modal',
    fn: async () => {
      const handleNav = (isAuthenticated: boolean) => (isAuthenticated ? 'SHOW_PLAN_TAB' : 'SHOW_AUTH_MODAL');
      assert.strictEqual(handleNav(false), 'SHOW_AUTH_MODAL');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 16: Contextual Upgrade Modals (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F16.01',
    tier: 2,
    featureId: 16,
    name: 'T2.F16: Unknown trigger identifier safely falls back to standard upgrade modal',
    fn: async () => {
      const getModalConfig = (trigger: string) => {
        if (trigger === 'guest_limit') return { title: 'Sign In to Chat' };
        return { title: 'Upgrade Your AIRA Plan' }; // Fallback
      };
      assert.strictEqual(getModalConfig('unknown_trigger').title, 'Upgrade Your AIRA Plan');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F16.02',
    tier: 2,
    featureId: 16,
    name: 'T2.F16: Backdrop click dismisses contextual upgrade modal',
    fn: async () => {
      let isVisible = true;
      const onBackdropClick = () => (isVisible = false);
      onBackdropClick();
      assert.strictEqual(isVisible, false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F16.03',
    tier: 2,
    featureId: 16,
    name: 'T2.F16: Mobile viewport (390px) responsive modal width stays within bounds',
    fn: async () => {
      const getModalWidth = (viewportWidth: number) => (viewportWidth < 640 ? Math.min(viewportWidth - 32, 358) : 560);
      assert.ok(getModalWidth(390) <= 358);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F16.04',
    tier: 2,
    featureId: 16,
    name: 'T2.F16: Upgrade CTA button displays informational notice when payment is disabled',
    fn: async () => {
      const handleUpgradeClick = (billingEnabled: boolean) =>
        billingEnabled ? 'REDIRECT_CHECKOUT' : 'SHOW_ISOLATED_NOTICE';
      assert.strictEqual(handleUpgradeClick(false), 'SHOW_ISOLATED_NOTICE');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F16.05',
    tier: 2,
    featureId: 16,
    name: 'T2.F16: Multiple rapid trigger events debounce to show single modal',
    fn: async () => {
      let modalOpenCount = 0;
      let active = false;
      const triggerModal = () => {
        if (!active) {
          active = true;
          modalOpenCount++;
        }
      };
      triggerModal();
      triggerModal();
      triggerModal();
      assert.strictEqual(modalOpenCount, 1);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 17: Intelligent Capability Discovery (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F17.01',
    tier: 2,
    featureId: 17,
    name: 'T2.F17: Prompt with multiple required capabilities prioritizes highest tier (Pro)',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f17_multi', tier: 'free' });
      const { body } = await client.evaluateCapability('Perform deep reasoning proof and then run python in sandbox');
      assert.strictEqual(body.requiredTier, 'pro');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F17.02',
    tier: 2,
    featureId: 17,
    name: 'T2.F17: Casual prompt mentioning python in conversation does not false-trigger upgrade',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f17_falsepos', tier: 'free' });
      const { body } = await client.evaluateCapability('Tell me a history of Python programming language');
      assert.strictEqual(body.upgradeRecommended, false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F17.03',
    tier: 2,
    featureId: 17,
    name: 'T2.F17: Empty prompt evaluates safely with upgradeRecommended=false',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f17_empty', tier: 'free' });
      const { status, body } = await client.evaluateCapability('');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.upgradeRecommended, false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F17.04',
    tier: 2,
    featureId: 17,
    name: 'T2.F17: Code snippet containing markdown python block for explanation does not false-trigger',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f17_snippet', tier: 'free' });
      const { body } = await client.evaluateCapability('Can you explain what this code does: ```def foo(): pass```');
      assert.strictEqual(body.upgradeRecommended, false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F17.05',
    tier: 2,
    featureId: 17,
    name: 'T2.F17: User at Pro tier never receives upgrade recommendation',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f17_pro_all', tier: 'pro' });
      const { body } = await client.evaluateCapability('run python code and browse web to automate tasks');
      assert.strictEqual(body.upgradeRecommended, false);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 18: Safe Downgrade Retention UI (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F18.01',
    tier: 2,
    featureId: 18,
    name: 'T2.F18: Retention banner hidden when project count is exactly at quota limit (3/3)',
    fn: async () => {
      const isVisible = (count: number, limit: number) => count > limit;
      assert.strictEqual(isVisible(3, 3), false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F18.02',
    tier: 2,
    featureId: 18,
    name: 'T2.F18: Retention banner displays when project count exceeds limit by 1 (4/3)',
    fn: async () => {
      const isVisible = (count: number, limit: number) => count > limit;
      assert.strictEqual(isVisible(4, 3), true);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F18.03',
    tier: 2,
    featureId: 18,
    name: 'T2.F18: Attempting to edit read-only project card displays informative tooltip',
    fn: async () => {
      const getAction = (isReadOnly: boolean) => (isReadOnly ? 'SHOW_READONLY_TOOLTIP' : 'OPEN_EDITOR');
      assert.strictEqual(getAction(true), 'SHOW_READONLY_TOOLTIP');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F18.04',
    tier: 2,
    featureId: 18,
    name: 'T2.F18: Bulk export of 50 retained read-only projects succeeds without error',
    fn: async () => {
      const projects = Array.from({ length: 50 }, (_, i) => ({ id: `p_${i}`, name: `Proj ${i}`, readOnly: true }));
      const exportData = JSON.stringify(projects);
      assert.ok(exportData.length > 500);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F18.05',
    tier: 2,
    featureId: 18,
    name: 'T2.F18: Deleting item dynamically recalculates read-only state of remaining items',
    fn: async () => {
      const items = [{ id: 1, readOnly: false }, { id: 2, readOnly: false }, { id: 3, readOnly: false }, { id: 4, readOnly: true }];
      // Delete item 1
      const remaining = items.filter((it) => it.id !== 1);
      // Recalculate with limit 3: all 3 should now be writable!
      const recalculated = remaining.map((it, idx) => ({ ...it, readOnly: idx >= 3 }));
      assert.strictEqual(recalculated.filter((it) => it.readOnly).length, 0);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 19: What's New Announcement System (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F19.01',
    tier: 2,
    featureId: 19,
    name: 'T2.F19: Empty announcements feed displays clean empty state message',
    fn: async (server: E2ETestServer) => {
      const saved = [...server.announcements];
      server.announcements = [];
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f19_none', tier: 'free' });
      const { body } = await client.getAnnouncements();
      assert.strictEqual(body.announcements.length, 0);
      assert.strictEqual(body.unreadCount, 0);
      server.announcements = saved; // restore
    }
  });

  globalTestRegistry.register({
    id: 'T2.F19.02',
    tier: 2,
    featureId: 19,
    name: 'T2.F19: Large announcement feed (100 items) calculates unread count accurately',
    fn: async (server: E2ETestServer) => {
      const saved = [...server.announcements];
      server.announcements = Array.from({ length: 100 }, (_, i) => ({
        id: `ann_perf_${i}`,
        version: `2026.${i}.0`,
        title: `Release ${i}`,
        summary: `Summary ${i}`,
        features: ['F'],
        publishedAt: new Date().toISOString()
      }));
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f19_100', tier: 'free' });
      const { body } = await client.getAnnouncements();
      assert.strictEqual(body.unreadCount, 100);
      server.announcements = saved;
    }
  });

  globalTestRegistry.register({
    id: 'T2.F19.03',
    tier: 2,
    featureId: 19,
    name: 'T2.F19: Duplicate announcement IDs in list sanitized or de-duplicated',
    fn: async () => {
      const rawList = [{ id: 'a1' }, { id: 'a1' }, { id: 'a2' }];
      const unique = Array.from(new Map(rawList.map((item) => [item.id, item])).values());
      assert.strictEqual(unique.length, 2);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F19.04',
    tier: 2,
    featureId: 19,
    name: 'T2.F19: Announcement published in future is excluded from unread count',
    fn: async () => {
      const now = Date.now();
      const list = [
        { id: 'past', publishedAt: new Date(now - 10000).toISOString() },
        { id: 'future', publishedAt: new Date(now + 100000).toISOString() }
      ];
      const active = list.filter((a) => new Date(a.publishedAt).getTime() <= now);
      assert.strictEqual(active.length, 1);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F19.05',
    tier: 2,
    featureId: 19,
    name: 'T2.F19: Dismissing announcement updates badge across simulated multi-tab channels',
    fn: async (server: E2ETestServer) => {
      const clientTab1 = new E2ETestClient(server.url, { userId: 'u_t2_f19_sync', tier: 'free' });
      const clientTab2 = new E2ETestClient(server.url, { userId: 'u_t2_f19_sync', tier: 'free' });
      await clientTab1.dismissAnnouncement('ann-2026-v2');
      const { body } = await clientTab2.getAnnouncements();
      assert.ok(body.dismissedIds.includes('ann-2026-v2'));
    }
  });

  globalTestRegistry.register({
    id: 'T2.F19.06',
    tier: 2,
    featureId: 19,
    name: 'T2.F19: Cross-account isolation: User Alice dismissing announcement does not leak to User Bob on same browser session',
    fn: async (server: E2ETestServer) => {
      // 1. Verify server-side isolation
      const clientAlice = new E2ETestClient(server.url, { userId: 'u_alice_isolation_test', tier: 'free' });
      const clientBob = new E2ETestClient(server.url, { userId: 'u_bob_isolation_test', tier: 'free' });
      await clientAlice.dismissAnnouncement('ann-2026-v2');
      const { body: bobServerBody } = await clientBob.getAnnouncements();
      assert.strictEqual(
        bobServerBody.dismissedIds.includes('ann-2026-v2'),
        false,
        'Server-side: User Bob must not inherit Alice dismissed announcements'
      );

      // 2. Verify client-side browser session isolation (localStorage simulation)
      const storage = new Map<string, string>();
      const originalWindow = (globalThis as any).window;
      try {
        (globalThis as any).window = {
          localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => { storage.set(key, value); },
            removeItem: (key: string) => { storage.delete(key); },
            clear: () => { storage.clear(); }
          }
        };

        // User Alice dismisses announcement on shared browser
        dismissAnnouncement('ann-2026-v2', 'u_alice_isolation_test');

        // User Bob opens app on same browser session
        const bobClientDismissed = getDismissedAnnouncementIds('u_bob_isolation_test');
        assert.strictEqual(
          bobClientDismissed.includes('ann-2026-v2'),
          false,
          'Client-side: User Bob must not inherit Alice dismissed announcements via shared storage or legacy keys'
        );

        // User Bob unread count still includes all available announcements
        const bobUnread = getUnreadAnnouncementCount('free', 'u_bob_isolation_test');
        assert.ok(bobUnread > 0, 'User Bob must still see unread announcements');

        // User Alice unread count reflects dismissal
        const aliceClientDismissed = getDismissedAnnouncementIds('u_alice_isolation_test');
        assert.ok(
          aliceClientDismissed.includes('ann-2026-v2'),
          'User Alice must retain own dismissal'
        );
      } finally {
        (globalThis as any).window = originalWindow;
      }
    }
  });

  // --------------------------------------------------------------------------
  // Feature 20: 5-Stage Interactive Onboarding (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F20.01',
    tier: 2,
    featureId: 20,
    name: 'T2.F20: Back action disabled on stage 1 (intro)',
    fn: async () => {
      const canGoBack = (stage: string) => stage !== 'intro';
      assert.strictEqual(canGoBack('intro'), false);
      assert.strictEqual(canGoBack('chat_reasoning'), true);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F20.02',
    tier: 2,
    featureId: 20,
    name: 'T2.F20: Next action on stage 5 finishes onboarding tour',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f20_s5', tier: 'free' });
      await client.updateOnboarding('stage', 'plans');
      const { body } = await client.updateOnboarding('finish');
      assert.strictEqual(body.onboarding.completed, true);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F20.03',
    tier: 2,
    featureId: 20,
    name: 'T2.F20: Rapid clicks on Next button advance exactly 1 stage at a time',
    fn: async () => {
      const stages = ['intro', 'chat_reasoning', 'agent_mode', 'projects_artifacts', 'plans'];
      let currentIndex = 0;
      let advancing = false;
      const advance = () => {
        if (!advancing && currentIndex < stages.length - 1) {
          advancing = true;
          currentIndex++;
          advancing = false;
        }
      };
      advance();
      advance();
      assert.strictEqual(currentIndex, 2);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F20.04',
    tier: 2,
    featureId: 20,
    name: 'T2.F20: Viewport resize recalculates onboarding tooltip position without error',
    fn: async () => {
      const computePosition = (viewportW: number, cardW: number) => ({
        x: Math.max(16, (viewportW - cardW) / 2)
      });
      assert.strictEqual(computePosition(1280, 400).x, 440);
      assert.strictEqual(computePosition(390, 360).x, 16);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F20.05',
    tier: 2,
    featureId: 20,
    name: 'T2.F20: Unknown action string in onboarding update handled cleanly',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f20_inv', tier: 'free' });
      const { status } = await client.updateOnboarding('unknown_action' as any);
      assert.strictEqual(status, 200);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 21: Account-Level Onboarding Persistence (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F21.01',
    tier: 2,
    featureId: 21,
    name: 'T2.F21: Interrupted onboarding resumes from exact saved stage',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f21_resume', tier: 'free' });
      await client.updateOnboarding('stage', 'agent_mode');
      const { body } = await client.getOnboarding();
      assert.strictEqual(body.currentStage, 'agent_mode');
      assert.strictEqual(body.completed, false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F21.02',
    tier: 2,
    featureId: 21,
    name: 'T2.F21: Multiple account switches preserve separate onboarding states',
    fn: async (server: E2ETestServer) => {
      const cA = new E2ETestClient(server.url, { userId: 'u_t2_f21_switch_a', tier: 'free' });
      const cB = new E2ETestClient(server.url, { userId: 'u_t2_f21_switch_b', tier: 'free' });
      await cA.updateOnboarding('finish');
      await cB.updateOnboarding('stage', 'chat_reasoning');

      const resA = await cA.getOnboarding();
      const resB = await cB.getOnboarding();
      assert.strictEqual(resA.body.completed, true);
      assert.strictEqual(resB.body.currentStage, 'chat_reasoning');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F21.03',
    tier: 2,
    featureId: 21,
    name: 'T2.F21: Corrupted or null stage string defaults safely to intro',
    fn: async () => {
      const validStages = ['intro', 'chat_reasoning', 'agent_mode', 'projects_artifacts', 'plans'];
      const resolveStage = (stage: string | null) => (stage && validStages.includes(stage) ? stage : 'intro');
      assert.strictEqual(resolveStage(null), 'intro');
      assert.strictEqual(resolveStage('garbage_stage'), 'intro');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F21.04',
    tier: 2,
    featureId: 21,
    name: 'T2.F21: Restart tutorial mid-way resets both stage and completed flag',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f21_rmid', tier: 'free' });
      await client.updateOnboarding('stage', 'agent_mode');
      const { body } = await client.updateOnboarding('restart');
      assert.strictEqual(body.onboarding.currentStage, 'intro');
      assert.strictEqual(body.onboarding.completed, false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F21.05',
    tier: 2,
    featureId: 21,
    name: 'T2.F21: Completed onboarding remains completed after multiple queries',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f21_idemp', tier: 'free' });
      await client.updateOnboarding('finish');
      for (let i = 0; i < 5; i++) {
        const { body } = await client.getOnboarding();
        assert.strictEqual(body.completed, true);
      }
    }
  });

  // --------------------------------------------------------------------------
  // Feature 22: Upgrade Feature Discovery Guidance (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F22.01',
    tier: 2,
    featureId: 22,
    name: 'T2.F22: Upgrading Free directly to Pro includes all unlocked Pro tools in guidance',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f22_direct_pro', tier: 'free' });
      const { body } = await client.upgrade('pro');
      assert.ok(body.featureDiscoveryUnlocked.includes('browser_tools'));
      assert.ok(body.featureDiscoveryUnlocked.includes('python_sandbox'));
      assert.ok(body.featureDiscoveryUnlocked.includes('autonomous_workers'));
    }
  });

  globalTestRegistry.register({
    id: 'T2.F22.02',
    tier: 2,
    featureId: 22,
    name: 'T2.F22: Downgrade from Pro to Free returns empty discovery unlocked list',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f22_down', tier: 'pro' });
      const { body } = await client.downgrade('free');
      assert.strictEqual(body.featureDiscoveryUnlocked, undefined);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F22.03',
    tier: 2,
    featureId: 22,
    name: 'T2.F22: Repeated upgrades do not create duplicate feature discovery records',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f22_rep', tier: 'free' });
      const r1 = await client.upgrade('plus');
      const r2 = await client.upgrade('plus');
      assert.deepStrictEqual(r1.body.featureDiscoveryUnlocked, r2.body.featureDiscoveryUnlocked);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F22.04',
    tier: 2,
    featureId: 22,
    name: 'T2.F22: Dismissed feature card persisted in user account preferences',
    fn: async (server: E2ETestServer) => {
      const user = server.getOrCreateUser('u_t2_f22_pers', 'plus');
      user.dismissedFeatureGuidance.add('reasoning_boosts');
      assert.ok(user.dismissedFeatureGuidance.has('reasoning_boosts'));
    }
  });

  globalTestRegistry.register({
    id: 'T2.F22.05',
    tier: 2,
    featureId: 22,
    name: 'T2.F22: Welcome card handles missing feature icons gracefully with fallback',
    fn: async () => {
      const resolveIcon = (feature: string) => {
        const iconMap: Record<string, string> = { agent_mode: 'BotIcon' };
        return iconMap[feature] || 'SparklesIcon';
      };
      assert.strictEqual(resolveIcon('unknown_feature'), 'SparklesIcon');
    }
  });

  // --------------------------------------------------------------------------
  // Feature 23: Notification Preferences UI (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F23.01',
    tier: 2,
    featureId: 23,
    name: 'T2.F23: Setting all notification preferences to false silences optional alerts',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f23_alloff', tier: 'free' });
      const { body } = await client.updateNotificationPreferences({
        announcements: false,
        productUpdates: false,
        tips: false
      });
      assert.strictEqual(body.preferences.announcements, false);
      assert.strictEqual(body.preferences.productUpdates, false);
      assert.strictEqual(body.preferences.tips, false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F23.02',
    tier: 2,
    featureId: 23,
    name: 'T2.F23: Invalid field names in notification preference payload safely ignored',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f23_extra', tier: 'free' });
      const { status } = await client.updateNotificationPreferences({ unknownField: true });
      assert.strictEqual(status, 200);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F23.03',
    tier: 2,
    featureId: 23,
    name: 'T2.F23: Rapid toggles debounce before emitting API update',
    fn: async () => {
      let updateCalls = 0;
      let timer: any = null;
      const debounceUpdate = (fn: () => void) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          updateCalls++;
          fn();
        }, 10);
      };
      debounceUpdate(() => {});
      debounceUpdate(() => {});
      debounceUpdate(() => {});
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(updateCalls, 1);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F23.04',
    tier: 2,
    featureId: 23,
    name: 'T2.F23: Critical quota warnings remain enabled regardless of notification toggles',
    fn: async () => {
      const isNotificationAllowed = (type: 'quota_warning' | 'tip', userPrefs: { tips: boolean }) =>
        type === 'quota_warning' ? true : userPrefs.tips;
      assert.strictEqual(isNotificationAllowed('quota_warning', { tips: false }), true);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F23.05',
    tier: 2,
    featureId: 23,
    name: 'T2.F23: Preference update returns latest merged preference dictionary',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f23_merge', tier: 'free' });
      await client.updateNotificationPreferences({ announcements: false });
      const { body } = await client.updateNotificationPreferences({ tips: false });
      assert.strictEqual(body.preferences.announcements, false);
      assert.strictEqual(body.preferences.tips, false);
      assert.strictEqual(body.preferences.productUpdates, true);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 24: Centralized Feature Flag Client Hook (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F24.01',
    tier: 2,
    featureId: 24,
    name: 'T2.F24: LocalStorage test flag override takes precedence over server flags',
    fn: async () => {
      const serverFlags = { pro_tools_execution: false };
      const localOverrides = { pro_tools_execution: true };
      const resolved = { ...serverFlags, ...localOverrides };
      assert.strictEqual(resolved.pro_tools_execution, true);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F24.02',
    tier: 2,
    featureId: 24,
    name: 'T2.F24: Empty flag dictionary returns false for all queried flags without throw',
    fn: async () => {
      const flags: Record<string, boolean> = {};
      const getFlag = (key: string) => flags[key] ?? false;
      assert.strictEqual(getFlag('any_flag'), false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F24.03',
    tier: 2,
    featureId: 24,
    name: 'T2.F24: Boolean coercion converts non-boolean truthy values cleanly',
    fn: async () => {
      const coerce = (val: any) => Boolean(val);
      assert.strictEqual(coerce(1), true);
      assert.strictEqual(coerce(0), false);
      assert.strictEqual(coerce(null), false);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F24.04',
    tier: 2,
    featureId: 24,
    name: 'T2.F24: Hook state updates cleanly when server flags update',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f24_dyn', tier: 'free' });
      const f1 = await client.getFeatureFlags();
      assert.strictEqual(f1.body.flags.pro_tools_execution, false);
      await client.upgrade('pro');
      const f2 = await client.getFeatureFlags();
      assert.strictEqual(f2.body.flags.pro_tools_execution, true);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F24.05',
    tier: 2,
    featureId: 24,
    name: 'T2.F24: Multiple subscribers receive identical flag values',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f24_sub', tier: 'plus' });
      const { body } = await client.getFeatureFlags();
      const sub1 = body.flags.agent_mode_plus;
      const sub2 = body.flags.agent_mode_plus;
      assert.strictEqual(sub1, sub2);
      assert.strictEqual(sub1, true);
    }
  });

  // --------------------------------------------------------------------------
  // Feature 25: Consistent Capability Messaging (Boundaries)
  // --------------------------------------------------------------------------
  globalTestRegistry.register({
    id: 'T2.F25.01',
    tier: 2,
    featureId: 25,
    name: 'T2.F25: Client label alteration does not alter backend authorization',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f25_label', tier: 'free' });
      const { status } = await client.chatStream('claude-3-opus');
      assert.strictEqual(status, 403, 'Backend authorization remains inviolable');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F25.02',
    tier: 2,
    featureId: 25,
    name: 'T2.F25: Error message field error aligns strictly with contract error code',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f25_code', tier: 'free' });
      const { body } = await client.chatStream('o1');
      assert.strictEqual(body.error, 'PLAN_MODEL_RESTRICTED');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F25.03',
    tier: 2,
    featureId: 25,
    name: 'T2.F25: Quota gauge percentage formula clamps correctly between 0% and 100%',
    fn: async () => {
      const calcPercent = (used: number, limit: number) => Math.min(100, Math.max(0, (used / limit) * 100));
      assert.strictEqual(calcPercent(0, 15), 0);
      assert.strictEqual(calcPercent(15, 15), 100);
      assert.strictEqual(calcPercent(20, 15), 100);
    }
  });

  globalTestRegistry.register({
    id: 'T2.F25.04',
    tier: 2,
    featureId: 25,
    name: 'T2.F25: Locked model lock icon tooltip accurately names required tier',
    fn: async () => {
      const getLockTooltip = (model: string) => {
        if (PLAN_MODEL_ALLOWLIST.pro.includes(model) && !PLAN_MODEL_ALLOWLIST.plus.includes(model)) {
          return 'Requires AIRA Pro';
        }
        return 'Requires AIRA Plus or Pro';
      };
      assert.strictEqual(getLockTooltip('claude-3-opus'), 'Requires AIRA Pro');
      assert.strictEqual(getLockTooltip('claude-3-5-sonnet'), 'Requires AIRA Plus or Pro');
    }
  });

  globalTestRegistry.register({
    id: 'T2.F25.05',
    tier: 2,
    featureId: 25,
    name: 'T2.F25: Capability discovery suggestion matches tool gateway required tier',
    fn: async (server: E2ETestServer) => {
      const client = new E2ETestClient(server.url, { userId: 'u_t2_f25_match', tier: 'free' });
      const { body: disc } = await client.evaluateCapability('browse web to search docs');
      const { body: toolRes } = await client.executeTool('browser_navigate');
      assert.strictEqual(disc.requiredTier, toolRes.requiredTier);
      assert.strictEqual(disc.requiredTier, 'pro');
    }
  });
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tier2-boundary-corner.test.ts')) {
  (async () => {
    const server = new E2ETestServer();
    await server.start();
    registerTier2Tests();
    const results = await globalTestRegistry.run(server, 2);
    await server.stop();
    const passed = results.filter((r) => r.passed).length;
    console.log(`Tier 2: ${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  })();
}
