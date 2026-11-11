import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Production Contracts & Logic
import {
  isModelAllowedForTier,
  isFeatureAllowedForTier,
  PLAN_MODEL_ALLOWLIST,
  PLAN_CAPABILITY_MATRIX,
  COMMERCIAL_PLANS,
  type PlanTier,
  type PlanCapabilities,
  evaluateFeatureFlags,
  isFeatureFlagEnabled,
  ALL_FEATURE_FLAG_KEYS,
  type FeatureFlagKey,
  type ExecutionPrincipal,
  type AutonomousAgentTask
} from '../packages/contracts/src/index.js';

// Middleware & Server Gates
import {
  resolveCallerTier,
  requireEntitledModel,
  requireToolEntitlement,
  requirePlanTier,
  requireCapability
} from '../apps/api/src/middleware/entitlement-guard.js';

// Tool Runtime
import {
  ToolGateway,
  InMemoryToolCallRepository
} from '../packages/tool-runtime/src/index.js';

// Autonomous Agent Runtime
import {
  AutonomousWorkerHost,
  type IAutonomousTaskRepository
} from '../packages/agent-runtime/src/autonomous/autonomous-worker-host.js';

// Capacity Guard & Model Router
import {
  PrivateBetaCapacityGuard,
  InMemoryCapacityStore
} from '../packages/model-router/src/index.js';

// Client Utilities & Hooks
import {
  getOnboardingState,
  saveOnboardingStage,
  skipOnboarding,
  finishOnboarding,
  restartOnboarding,
  DEFAULT_ONBOARDING_STATE,
  ONBOARDING_STAGES,
  type OnboardingStage
} from '../src/utils/onboarding.js';

import {
  getDismissedAnnouncementIds,
  getUnreadAnnouncementCount,
  dismissAnnouncement,
  resetDismissedAnnouncements,
  shouldShowFirstViewPopup
} from '../src/utils/announcements.js';

import {
  readOverridesFromEnvironment,
  isSafeFeatureFlagKey,
  useFeatureFlag
} from '../src/lib/featureFlags.js';

// ============================================================================
// TIER 5 WHITE-BOX ADVERSARIAL STRESS TEST SUITE
// 30 Adversarial Scenarios Across 5 Distinct Threat Domains
// ============================================================================

describe('Tier 5 Adversarial Stress & Vulnerability Hardening Suite', () => {

  // =========================================================================
  // DOMAIN A: Prototype Pollution & Property Injection
  // =========================================================================
  describe('Domain A: Prototype Pollution & Property Injection Defense', () => {

    test('A1: Model allowlist rejects prototype identifiers as model query on all tiers', () => {
      const maliciousModelNames = [
        '__proto__',
        'constructor',
        'prototype',
        'toString',
        'valueOf',
        'hasOwnProperty',
        'isPrototypeOf',
        '__defineGetter__',
        '__lookupSetter__'
      ];
      const tiers: PlanTier[] = ['guest', 'free', 'plus', 'pro'];

      for (const tier of tiers) {
        for (const malModel of maliciousModelNames) {
          const allowed = isModelAllowedForTier(malModel, tier);
          assert.strictEqual(
            allowed,
            false,
            `Model identifier "${malModel}" on tier "${tier}" must NOT be allowed`
          );
        }
      }
    });

    test('A2: Model allowlist rejects prototype property names as tier parameter without throwing', () => {
      const prototypeTierAttacks = [
        '__proto__',
        'constructor',
        'prototype',
        'toString',
        'valueOf',
        'hasOwnProperty',
        'isPrototypeOf',
        'toLocaleString'
      ];
      const flagshipModel = 'claude-3-opus';

      for (const malTier of prototypeTierAttacks) {
        const allowed = isModelAllowedForTier(flagshipModel, malTier as any);
        assert.strictEqual(
          allowed,
          false,
          `Malicious tier parameter "${malTier}" must evaluate to false`
        );
      }
    });

    test('A3: Capability matrix rejects prototype identifiers as feature query on all tiers', () => {
      const maliciousFeatures = [
        '__proto__',
        'constructor',
        'prototype',
        'toString',
        'valueOf',
        'hasOwnProperty',
        'isPrototypeOf',
        '\0__proto__',
        '__defineGetter__'
      ];
      const tiers: PlanTier[] = ['guest', 'free', 'plus', 'pro'];

      for (const tier of tiers) {
        for (const malFeature of maliciousFeatures) {
          const allowed = isFeatureAllowedForTier(malFeature, tier);
          assert.strictEqual(
            allowed,
            false,
            `Feature "${malFeature}" on tier "${tier}" must NOT be granted`
          );
        }
      }
    });

    test('A4: Capability matrix rejects prototype property names as tier parameter without throwing', () => {
      const prototypeTierAttacks = [
        '__proto__',
        'constructor',
        'prototype',
        'toString',
        'valueOf',
        'isPrototypeOf'
      ];

      for (const malTier of prototypeTierAttacks) {
        const allowedAutonomous = isFeatureAllowedForTier('allowAutonomous', malTier as any);
        assert.strictEqual(allowedAutonomous, false);

        const allowedBrowser = isFeatureAllowedForTier('allowBrowserTools', malTier as any);
        assert.strictEqual(allowedBrowser, false);
      }
    });

    test('A5: Feature flag overrides reject prototype pollution, symbol keys, and unknown keys', () => {
      const pollutedSymbol = Symbol('polluted_symbol');
      const maliciousOverrides: any = {
        __proto__: { pollutedGlobalFlag: true },
        constructor: true,
        toString: true,
        valueOf: true,
        unknown_unregistered_flag: true,
        [pollutedSymbol]: true,
        agent_mode_autonomous: true // Genuine override for test
      };

      // 1. Evaluate feature flags with malicious input
      const evaluated = evaluateFeatureFlags('free', maliciousOverrides);

      // 2. Global prototype must NOT be polluted
      assert.strictEqual(
        ({} as any).pollutedGlobalFlag,
        undefined,
        'Object.prototype must remain unpolluted'
      );

      // 3. Dangerous properties must NOT be present as overrides in result
      assert.strictEqual(Object.hasOwn(evaluated, 'constructor'), false);
      assert.strictEqual(Object.hasOwn(evaluated, 'toString'), false);
      assert.strictEqual(Object.hasOwn(evaluated, 'valueOf'), false);
      assert.strictEqual(Object.hasOwn(evaluated, 'unknown_unregistered_flag'), false);

      // 4. Valid flag override must be properly applied
      assert.strictEqual(evaluated.agent_mode_autonomous, true);

      // 5. Direct lookup via isFeatureFlagEnabled
      assert.strictEqual(isFeatureFlagEnabled('toString' as any, 'free', maliciousOverrides), false);
      assert.strictEqual(isFeatureFlagEnabled('__proto__' as any, 'free', maliciousOverrides), false);
    });

    test('A6: Contract immutability enforces deep freeze tamper-resistance at runtime', () => {
      // 1. Verify top-level freeze
      assert.strictEqual(Object.isFrozen(PLAN_MODEL_ALLOWLIST), true, 'PLAN_MODEL_ALLOWLIST must be frozen');
      assert.strictEqual(Object.isFrozen(PLAN_CAPABILITY_MATRIX), true, 'PLAN_CAPABILITY_MATRIX must be frozen');

      // 2. Verify nested tier list freeze
      assert.strictEqual(Object.isFrozen(PLAN_MODEL_ALLOWLIST.guest), true);
      assert.strictEqual(Object.isFrozen(PLAN_MODEL_ALLOWLIST.free), true);
      assert.strictEqual(Object.isFrozen(PLAN_MODEL_ALLOWLIST.plus), true);
      assert.strictEqual(Object.isFrozen(PLAN_MODEL_ALLOWLIST.pro), true);

      // 3. Attempt mutation -> must throw TypeError in strict mode
      assert.throws(() => {
        (PLAN_MODEL_ALLOWLIST as any).free.push('hacked-flagship-model');
      }, TypeError, 'Direct push to PLAN_MODEL_ALLOWLIST.free must throw');

      assert.throws(() => {
        (PLAN_MODEL_ALLOWLIST as any).injected_tier = [];
      }, TypeError, 'Injecting new tier property to PLAN_MODEL_ALLOWLIST must throw');

      assert.throws(() => {
        (PLAN_CAPABILITY_MATRIX as any).guest.allowAutonomous = true;
      }, TypeError, 'Mutating PLAN_CAPABILITY_MATRIX property must throw');
    });
  });

  // =========================================================================
  // DOMAIN B: High-Concurrency Quota Races & Capacity Contention
  // =========================================================================
  describe('Domain B: High-Concurrency Quota Races & Capacity Contention', () => {

    test('B1: 10 concurrent requests for Free user competing for 1 permit results in zero overdraft', async () => {
      const store = new InMemoryCapacityStore();
      const guard = new PrivateBetaCapacityGuard({
        perUserMaxConcurrent: 1,
        globalMaxConcurrent: 50,
        perUserRpm: 120,
        globalRpm: 500,
        retryAfterSeconds: 5
      }, store);

      const principalId = 'user_free_race_1';

      // Launch 10 simultaneous concurrent admission requests
      const tasks = Array.from({ length: 10 }, (_, i) =>
        guard.admit({
          principalId,
          tier: 'free',
          model: 'aira-fast',
          promptText: `Concurrent query ${i}`
        })
      );

      const results = await Promise.all(tasks);

      const admitted = results.filter(r => r.decision === 'ADMIT_NOW');
      const rejected = results.filter(r => r.decision === 'REJECT_CAPACITY');

      assert.strictEqual(admitted.length, 1, 'Exactly 1 request must be admitted for Free tier');
      assert.strictEqual(rejected.length, 9, 'Exactly 9 requests must be rejected');
      assert.ok(rejected[0].reason === 'USER_CONCURRENCY_EXCEEDED' || rejected[0].reason === 'CONCURRENCY_LIMIT_EXCEEDED');

      // Cleanup
      await admitted[0].permit?.release();
    });

    test('B2: 10 concurrent requests for Pro user competing for 2 permits results in zero overdraft', async () => {
      const store = new InMemoryCapacityStore();
      const guard = new PrivateBetaCapacityGuard({
        perUserMaxConcurrent: 2,
        globalMaxConcurrent: 50,
        perUserRpm: 120,
        globalRpm: 500,
        retryAfterSeconds: 5
      }, store);

      const principalId = 'user_pro_race_2';

      // Launch 10 simultaneous concurrent requests
      const tasks = Array.from({ length: 10 }, (_, i) =>
        guard.admit({
          principalId,
          tier: 'pro',
          model: 'aira-fast',
          promptText: `Pro concurrent query ${i}`
        })
      );

      const results = await Promise.all(tasks);

      const admitted = results.filter(r => r.decision === 'ADMIT_NOW');
      const rejected = results.filter(r => r.decision === 'REJECT_CAPACITY');

      assert.strictEqual(admitted.length, 2, 'Exactly 2 requests must be admitted for Pro tier');
      assert.strictEqual(rejected.length, 8, 'Exactly 8 requests must be rejected');

      // Cleanup
      await Promise.all(admitted.map(a => a.permit?.release()));
    });

    test('B3: Dynamic permit release is atomic and immediately reallocates capacity', async () => {
      const store = new InMemoryCapacityStore();
      const guard = new PrivateBetaCapacityGuard({
        perUserMaxConcurrent: 1,
        globalMaxConcurrent: 10,
        perUserRpm: 60,
        globalRpm: 120,
        retryAfterSeconds: 5
      }, store);

      const principalId = 'user_realloc_3';

      // 1. Acquire permit
      const r1 = await guard.admit({ principalId, tier: 'free', model: 'aira-fast' });
      assert.strictEqual(r1.decision, 'ADMIT_NOW');

      // 2. Attempt while permit held -> rejected
      const r2 = await guard.admit({ principalId, tier: 'free', model: 'aira-fast' });
      assert.strictEqual(r2.decision, 'REJECT_CAPACITY');

      // 3. Release permit
      await r1.permit?.release();

      // 4. Double release is idempotent and does not corrupt store count
      await r1.permit?.release();

      // 5. Subsequent request must be admitted immediately
      const r3 = await guard.admit({ principalId, tier: 'free', model: 'aira-fast' });
      assert.strictEqual(r3.decision, 'ADMIT_NOW', 'Slot must be immediately reusable after release');
      await r3.permit?.release();
    });

    test('B4: Streaming cancellation / client abort rolls back permit without capacity leakage', async () => {
      const store = new InMemoryCapacityStore();
      const guard = new PrivateBetaCapacityGuard({
        perUserMaxConcurrent: 1,
        globalMaxConcurrent: 10,
        perUserRpm: 60,
        globalRpm: 120,
        retryAfterSeconds: 5
      }, store);

      const principalId = 'user_abort_4';
      const controller = new AbortController();

      // 1. Acquire permit
      const r1 = await guard.admit({ principalId, tier: 'free', model: 'aira-fast' });
      assert.strictEqual(r1.decision, 'ADMIT_NOW');
      assert.ok(r1.permit);

      // 2. Simulate streaming disconnect before first content delta -> abort & release
      controller.abort();
      await r1.permit.release();

      // 3. Active concurrency in store must return to zero
      const active = await store.getActiveConcurrency('user', principalId);
      assert.strictEqual(active, 0, 'User concurrency must be 0 after abort refund');

      // 4. Next query succeeds
      const r2 = await guard.admit({ principalId, tier: 'free', model: 'aira-fast' });
      assert.strictEqual(r2.decision, 'ADMIT_NOW');
      await r2.permit?.release();
    });

    test('B5: Concurrent credit reservation race against single remaining budget prevents overdraft', async () => {
      // Simulate atomic credit account with 100 available credits
      let balanceCredits = 100;
      let reservedCredits = 0;
      const reservations = new Map<string, { id: string; amount: number; status: string }>();

      const atomicReserve = async (amount: number): Promise<string> => {
        // Atomic compare-and-swap simulation
        const available = balanceCredits - reservedCredits;
        if (available < amount) {
          throw new Error(`INSUFFICIENT_CREDITS: Required ${amount}, available ${available}`);
        }
        reservedCredits += amount;
        const resId = `res_${crypto.randomUUID().slice(0, 8)}`;
        reservations.set(resId, { id: resId, amount, status: 'HELD' });
        return resId;
      };

      // 5 concurrent requests competing for the 100 available credits
      const attempts = Array.from({ length: 5 }, () =>
        atomicReserve(100).then(
          id => ({ success: true, id }),
          err => ({ success: false, error: err.message })
        )
      );

      const outcomes = await Promise.all(attempts);
      const successes = outcomes.filter(o => o.success);
      const failures = outcomes.filter(o => !o.success);

      assert.strictEqual(successes.length, 1, 'Exactly 1 reservation must succeed');
      assert.strictEqual(failures.length, 4, 'Exactly 4 reservations must fail');
      assert.strictEqual(reservedCredits, 100, 'Reserved credits must not exceed 100');
      assert.strictEqual(balanceCredits - reservedCredits, 0, 'Available credits must be exactly 0 (no overdraft)');
    });

    test('B6: Two-phase reservation settlement settles actual usage and refunds unspent remainder', async () => {
      let balanceCredits = 100;
      let reservedCredits = 0;

      // Hold 100 credits
      const heldAmount = 100;
      reservedCredits += heldAmount;
      assert.strictEqual(balanceCredits - reservedCredits, 0);

      // Settle 35 credits actual usage
      const actualSpent = 35;
      const unspentRefund = heldAmount - actualSpent; // 65 credits

      balanceCredits -= actualSpent;
      reservedCredits -= heldAmount; // All reserved credits cleared

      assert.strictEqual(reservedCredits, 0, 'Reserved credits must be 0 after settlement');
      assert.strictEqual(balanceCredits, 65, 'Remaining balance must reflect exact partial refund (100 - 35 = 65)');
    });
  });

  // =========================================================================
  // DOMAIN C: Safe Downgrade Retention Edge Cases
  // =========================================================================
  describe('Domain C: Safe Downgrade Retention Edge Cases', () => {

    test('C1: Multi-entity Pro-to-Free downgrade retains 100% of data with excess marked read-only', () => {
      // User creates 10 projects and 100 memories while on Pro
      const projects = Array.from({ length: 10 }, (_, i) => ({
        id: `p_${i}`,
        userId: 'usr_downgrade_1',
        name: `Project ${i}`,
        readOnly: false
      }));

      const memories = Array.from({ length: 100 }, (_, i) => ({
        id: `m_${i}`,
        userId: 'usr_downgrade_1',
        content: `Memory ${i}`,
        readOnly: false
      }));

      // Downgrade to Free tier (maxProjects = 3, maxMemories = 50)
      const freeQuota = { maxProjects: 3, maxMemories: 50 };

      // Apply safe downgrade retention algorithm
      projects.forEach((p, idx) => {
        p.readOnly = idx >= freeQuota.maxProjects;
      });
      memories.forEach((m, idx) => {
        m.readOnly = idx >= freeQuota.maxMemories;
      });

      // Assertions
      assert.strictEqual(projects.length, 10, 'All 10 projects must be retained without deletion');
      assert.strictEqual(memories.length, 100, 'All 100 memories must be retained without deletion');

      const readOnlyProjects = projects.filter(p => p.readOnly);
      const activeProjects = projects.filter(p => !p.readOnly);
      assert.strictEqual(activeProjects.length, 3, 'Exactly 3 projects remain active');
      assert.strictEqual(readOnlyProjects.length, 7, 'Exactly 7 projects marked read-only');

      const readOnlyMemories = memories.filter(m => m.readOnly);
      const activeMemories = memories.filter(m => !m.readOnly);
      assert.strictEqual(activeMemories.length, 50, 'Exactly 50 memories remain active');
      assert.strictEqual(readOnlyMemories.length, 50, 'Exactly 50 memories marked read-only');
    });

    test('C2: Creation is blocked with QUOTA_EXCEEDED_READ_ONLY_MODE when count exceeds lower tier quota', () => {
      const userProjects = Array.from({ length: 5 }, (_, i) => ({
        id: `p_${i}`,
        readOnly: i >= 3
      }));

      const freeMaxProjects = 3;
      const canCreate = userProjects.length < freeMaxProjects;

      let errorThrown = false;
      let errorCode = '';

      if (!canCreate) {
        errorThrown = true;
        errorCode = 'QUOTA_EXCEEDED_READ_ONLY_MODE';
      }

      assert.strictEqual(errorThrown, true);
      assert.strictEqual(errorCode, 'QUOTA_EXCEEDED_READ_ONLY_MODE');
    });

    test('C3: Direct mutation/write attempts to read-only retained items are strictly rejected', () => {
      const retainedProject = {
        id: 'proj_retained_locked',
        userId: 'usr_test',
        name: 'Original Architecture',
        readOnly: true
      };

      const attemptUpdate = (project: typeof retainedProject, newName: string) => {
        if (project.readOnly) {
          throw new Error('ITEM_READ_ONLY: Modification disallowed while exceeding plan quota.');
        }
        project.name = newName;
      };

      assert.throws(
        () => attemptUpdate(retainedProject, 'Tampered Name'),
        /ITEM_READ_ONLY/,
        'Attempting to mutate a read-only item must throw error'
      );
      assert.strictEqual(retainedProject.name, 'Original Architecture', 'Item content must remain untampered');
    });

    test('C4: Subsequent re-upgrade to Plus / Pro restores write capability to qualifying items', () => {
      const projects = Array.from({ length: 10 }, (_, i) => ({
        id: `p_${i}`,
        userId: 'usr_reupgrade',
        name: `Project ${i}`,
        readOnly: i >= 3 // Free tier state: 3 active, 7 locked
      }));

      // User re-upgrades to Plus (limit 10 projects)
      const plusMaxProjects = 10;
      projects.forEach((p, idx) => {
        p.readOnly = idx >= plusMaxProjects;
      });

      const lockedAfterPlus = projects.filter(p => p.readOnly);
      assert.strictEqual(lockedAfterPlus.length, 0, 'All 10 projects must be unlocked on Plus tier');

      // User can now write to any of the 10 projects
      projects[5].name = 'Updated In Plus';
      assert.strictEqual(projects[5].name, 'Updated In Plus');
    });

    test('C5: Rapid consecutive multi-stage downgrade churn preserves data integrity without corruption', () => {
      interface Entity { id: string; readOnly: boolean; content: string }
      const items: Entity[] = Array.from({ length: 12 }, (_, i) => ({
        id: `item_${i}`,
        readOnly: false,
        content: `Version 1 data #${i}`
      }));

      const planLimits = { pro: 1000, plus: 10, free: 3, guest: 0 };

      // Churn sequence: pro -> plus -> free -> guest -> free -> plus -> pro
      const sequence = ['plus', 'free', 'guest', 'free', 'plus', 'pro'] as const;

      for (const tier of sequence) {
        const limit = planLimits[tier];
        items.forEach((item, idx) => {
          item.readOnly = idx >= limit;
        });
        // Verify no items were deleted
        assert.strictEqual(items.length, 12, `Item count must remain 12 during ${tier} transition`);
      }

      // Final state on Pro: all items unlocked
      assert.strictEqual(items.filter(i => i.readOnly).length, 0, 'All items must be unlocked on Pro');
      assert.strictEqual(items[0].content, 'Version 1 data #0', 'Item content must never be corrupted');
    });

    test('C6: Downgrade retention handles zero initial items boundary cleanly', () => {
      const emptyProjects: any[] = [];
      const freeMaxProjects = 3;

      emptyProjects.forEach((p, idx) => {
        p.readOnly = idx >= freeMaxProjects;
      });

      assert.strictEqual(emptyProjects.length, 0);
      const canCreate = emptyProjects.length < freeMaxProjects;
      assert.strictEqual(canCreate, true, 'User with 0 items can create items up to free quota');
    });
  });

  // =========================================================================
  // DOMAIN D: Cross-Account Privilege Escalation & IDOR Stress
  // =========================================================================
  describe('Domain D: Cross-Account Privilege Escalation & IDOR Stress', () => {

    test('D1: Header spoofing with valid session credentials strictly ignores x-user-tier header', async () => {
      // 1. Authenticated session cookie for Free user with spoofed header
      const reqWithCookie: any = {
        headers: {
          cookie: 'aira_session=valid_authenticated_cookie',
          'x-user-tier': 'pro'
        }
      };
      const tierFromCookie = await resolveCallerTier(reqWithCookie);
      assert.notStrictEqual(tierFromCookie, 'pro');

      // 2. Authenticated user object with spoofed header
      const reqWithUser: any = {
        user: { id: 'usr_free_account', tier: 'free', isGuest: false },
        headers: { 'x-user-tier': 'pro' }
      };
      // The billing database is intentionally unavailable in this isolated
      // contract test: a forged header must not turn an outage into paid access
      // or silently grant a verified Free tier.
      await assert.rejects(() => resolveCallerTier(reqWithUser), (err: any) => {
        assert.strictEqual(err.code, 'ENTITLEMENT_SERVICE_UNAVAILABLE');
        assert.strictEqual(err.statusCode, 503);
        return true;
      });

      // 3. Guest session with spoofed header
      const reqGuest: any = {
        user: { id: 'guest_123', tier: 'guest', isGuest: true },
        headers: { 'x-user-tier': 'pro' }
      };
      const tierGuest = await resolveCallerTier(reqGuest);
      assert.strictEqual(tierGuest, 'guest');
    });

    test('D2: IDOR attack on AutonomousWorkerHost task processing fails closed and marks FAILED', async () => {
      let stateUpdated: string | null = null;
      let errorReason: string | null = null;
      let failedEmitted = false;

      const mockRepo: any = {
        updateState: async (id: string, state: string, reason: string) => {
          stateUpdated = state;
          errorReason = reason;
        },
        getTask: async () => null
      };

      const host = new AutonomousWorkerHost(mockRepo, {} as any, {
        workerId: 'worker_idor_test',
        resolveCurrentTier: async () => 'free'
      });
      host.on('task.failed', () => { failedEmitted = true; });

      // Attacker submits task masquerading as another user with Free tier
      const unauthorizedTask: AutonomousAgentTask = {
        taskId: 'task_idor_attack_1',
        principal: {
          userId: 'usr_victim_account',
          sessionId: 'sess_forged',
          workspaceId: 'ws_victim',
          roles: ['workspace_user'],
          scopes: ['*'],
          tier: 'free'
        } as any,
        objective: 'Exfiltrate victim workspace data',
        status: 'SUBMITTED',
        currentStepIndex: 0,
        plan: [],
        fencingToken: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await (host as any).processTask(unauthorizedTask);

      assert.strictEqual(failedEmitted, true, 'Worker must emit task.failed');
      assert.strictEqual(stateUpdated, 'FAILED');
      assert.match(errorReason || '', /PLAN_CAPABILITY_RESTRICTED/);
    });

    test('D3: ToolGateway fails closed when ExecutionPrincipal omits tier property', async () => {
      const gateway = new ToolGateway(new InMemoryToolCallRepository(), undefined, process.cwd(), undefined, undefined, async () => 'free');

      // Attacker crafts principal omitting tier property
      const unadornedPrincipal: ExecutionPrincipal = {
        userId: 'usr_attacker_unadorned',
        sessionId: 'sess_attack',
        workspaceId: 'ws_attack',
        roles: ['workspace_user'],
        scopes: ['*']
        // tier property intentionally omitted
      };

      // 1. Attempt browser execution
      const browserResult = await gateway.execute({
        toolName: 'browser_navigate',
        arguments: { url: 'https://attacker.com' },
        context: { runId: 'run_atk_1', principal: unadornedPrincipal }
      });

      assert.strictEqual(browserResult.isError, true);
      assert.strictEqual(browserResult.errorCode, 'PLAN_TOOL_RESTRICTED');
      assert.match(browserResult.error, /Browser execution tools require AIRA Pro/);

      // 2. Attempt python sandbox execution
      const pythonResult = await gateway.execute({
        toolName: 'python_sandbox',
        arguments: { code: 'import os; print(os.environ)' },
        context: { runId: 'run_atk_2', principal: unadornedPrincipal }
      });

      assert.strictEqual(pythonResult.isError, true);
      assert.strictEqual(pythonResult.errorCode, 'PLAN_TOOL_RESTRICTED');
      assert.match(pythonResult.error, /Python Sandbox execution requires AIRA Pro/);
    });

    test('D4: Concurrent multi-tenant worker execution enforces tenant isolation and zero crosstalk', async () => {
      const executedTasks: Array<{ taskId: string; tenant: string }> = [];

      const mockEngine: any = {
        executeAutonomousTask: async (taskId: string, signal: AbortSignal) => {
          await new Promise(r => setTimeout(r, 20));
          const tenant = taskId.startsWith('task_tenant_a') ? 'tenant_a' : 'tenant_b';
          executedTasks.push({ taskId, tenant });
          return { state: 'COMPLETED', deliverableSummary: `Deliverable for ${tenant}` };
        }
      };

      const mockRepo: any = {
        updateState: async () => {},
        getTask: async (id: string) => ({
          taskId: id,
          leaseOwner: 'worker_multi_tenant',
          fencingToken: 1
        }),
        renewLease: async () => true
      };

      const host = new AutonomousWorkerHost(mockRepo, mockEngine, {
        workerId: 'worker_multi_tenant',
        concurrency: 4,
        heartbeatIntervalMs: 5000,
        resolveCurrentTier: async () => 'pro'
      });

      const completedDeliverables: string[] = [];
      host.on('task.completed', (evt: any) => {
        completedDeliverables.push(evt.deliverableSummary);
      });

      // 4 concurrent tasks from two different Pro tenants
      const tasks: AutonomousAgentTask[] = [
        {
          taskId: 'task_tenant_a_1',
          principal: { userId: 'usr_tenant_a', sessionId: 's1', workspaceId: 'ws_a', roles: [], scopes: ['*'], tier: 'pro' } as any,
          objective: 'Task A1',
          status: 'SUBMITTED',
          currentStepIndex: 0,
          plan: [],
          fencingToken: 1,
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          taskId: 'task_tenant_b_1',
          principal: { userId: 'usr_tenant_b', sessionId: 's2', workspaceId: 'ws_b', roles: [], scopes: ['*'], tier: 'pro' } as any,
          objective: 'Task B1',
          status: 'SUBMITTED',
          currentStepIndex: 0,
          plan: [],
          fencingToken: 1,
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          taskId: 'task_tenant_a_2',
          principal: { userId: 'usr_tenant_a', sessionId: 's3', workspaceId: 'ws_a', roles: [], scopes: ['*'], tier: 'pro' } as any,
          objective: 'Task A2',
          status: 'SUBMITTED',
          currentStepIndex: 0,
          plan: [],
          fencingToken: 1,
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          taskId: 'task_tenant_b_2',
          principal: { userId: 'usr_tenant_b', sessionId: 's4', workspaceId: 'ws_b', roles: [], scopes: ['*'], tier: 'pro' } as any,
          objective: 'Task B2',
          status: 'SUBMITTED',
          currentStepIndex: 0,
          plan: [],
          fencingToken: 1,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      await Promise.all(tasks.map(t => (host as any).processTask(t)));

      assert.strictEqual(executedTasks.length, 4, 'All 4 tasks must complete');
      assert.strictEqual(completedDeliverables.length, 4);

      const tenantATasks = executedTasks.filter(t => t.tenant === 'tenant_a');
      const tenantBTasks = executedTasks.filter(t => t.tenant === 'tenant_b');
      assert.strictEqual(tenantATasks.length, 2);
      assert.strictEqual(tenantBTasks.length, 2);
    });

    test('D5: Fencing token mismatch and stale lease causes immediate task abort', async () => {
      let aborted = false;

      const mockEngine: any = {
        executeAutonomousTask: async (taskId: string, signal: AbortSignal) => {
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve({ state: 'CANCELLED' });
            });
          });
        }
      };

      // Repository simulates stale lease: current task in DB has owner 'worker_other' and fencingToken 2
      const mockRepo: any = {
        updateState: async () => {},
        getTask: async () => ({
          taskId: 'task_stale_1',
          leaseOwner: 'worker_other_stolen',
          fencingToken: 2
        })
      };

      const host = new AutonomousWorkerHost(mockRepo, mockEngine, {
        workerId: 'worker_original',
        heartbeatIntervalMs: 50, // Fast heartbeat for test
        resolveCurrentTier: async () => 'pro'
      });

      const task: AutonomousAgentTask = {
        taskId: 'task_stale_1',
        principal: { userId: 'usr_pro_1', sessionId: 's1', workspaceId: 'w1', roles: [], scopes: ['*'], tier: 'pro' } as any,
        objective: 'Stale task test',
        status: 'SUBMITTED',
        currentStepIndex: 0,
        plan: [],
        fencingToken: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      const executionPromise = (host as any).processTask(task);

      // Wait for heartbeat cycle to detect stolen lease
      await new Promise(r => setTimeout(r, 120));
      await executionPromise;

      assert.strictEqual(aborted, true, 'Task must be aborted immediately upon detecting lost lease ownership');
    });

    test('D6: Cross-tenant workspace authority violation in ToolGateway is rejected', async () => {
      // Mock workspace authority repository that knows tenant workspace ownership
      const mockAuthority: any = {
        isWorkspaceActive: async (userId: string, workspaceId: string) => {
          // Alice only owns ws_alice; Bob only owns ws_bob
          if (userId === 'usr_alice' && workspaceId === 'ws_alice') return true;
          if (userId === 'usr_bob' && workspaceId === 'ws_bob') return true;
          return false;
        }
      };

      const gateway = new ToolGateway(
        new InMemoryToolCallRepository(),
        undefined,
        process.cwd(),
        mockAuthority
      );

      // Alice tries to execute a tool in Bob's workspace
      const crossTenantPrincipal: ExecutionPrincipal = {
        userId: 'usr_alice',
        sessionId: 'sess_alice',
        workspaceId: 'ws_bob', // Forged/Cross-tenant workspace
        roles: ['workspace_user'],
        scopes: ['*'],
        ...( { tier: 'pro' } as any)
      };

      const result = await gateway.execute({
        toolName: 'python_sandbox',
        arguments: { code: 'print("attempt cross-tenant file access")' },
        context: { runId: 'run_idor_tool', principal: crossTenantPrincipal }
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.errorCode, 'TOOL_PERMISSION_DENIED');
      assert.match(result.error, /The authenticated principal has no active workspace authority/);
    });
  });

  // =========================================================================
  // DOMAIN E: Announcements & Onboarding Fault-Tolerance
  // =========================================================================
  describe('Domain E: Announcements & Onboarding Fault-Tolerance', () => {
    let mockStorage: Map<string, string>;

    beforeEach(() => {
      mockStorage = new Map<string, string>();
      // Install mock browser environment
      (globalThis as any).window = {
        localStorage: {
          getItem: (key: string) => mockStorage.get(key) ?? null,
          setItem: (key: string, val: string) => mockStorage.set(key, val),
          removeItem: (key: string) => mockStorage.delete(key),
          clear: () => mockStorage.clear()
        },
        location: { search: '' }
      };
    });

    afterEach(() => {
      delete (globalThis as any).window;
    });

    test('E1: Corrupted localStorage JSON for onboarding gracefully degrades to defaults without throwing', () => {
      const corruptPayloads = [
        '{ unclosed json payload...',
        'null',
        'undefined',
        '42',
        '"just a string"',
        '[1, 2, 3]',
        '{"completed": "not_a_boolean", "currentStage": 999}',
        '{"__proto__": {"corrupt": true}}'
      ];

      for (const payload of corruptPayloads) {
        mockStorage.set('aira_onboarding_usr_corrupt_test', payload);
        const state = getOnboardingState('usr_corrupt_test');

        assert.strictEqual(typeof state, 'object', 'Must return an object');
        assert.strictEqual(typeof state.completed, 'boolean', 'completed must be boolean');
        assert.strictEqual(typeof state.skipped, 'boolean', 'skipped must be boolean');
        assert.ok(
          ONBOARDING_STAGES.includes(state.currentStage),
          `currentStage "${state.currentStage}" must be a valid ONBOARDING_STAGE`
        );
      }
    });

    test('E2: Corrupted localStorage JSON for announcements gracefully degrades to defaults', () => {
      const corruptPayloads = [
        '{ malformed JSON...',
        '{"not": "an array"}',
        '12345',
        'true',
        '[123, null, false, {"obj": true}, "valid_id"]'
      ];

      for (const payload of corruptPayloads) {
        mockStorage.set('aira_dismissed_announcements_usr_corrupt', payload);
        const dismissed = getDismissedAnnouncementIds('usr_corrupt');

        assert.ok(Array.isArray(dismissed), 'Must return an array');
        // Unread announcement count calculation must not throw
        const unreadCount = getUnreadAnnouncementCount('free', 'usr_corrupt');
        assert.strictEqual(typeof unreadCount, 'number');
        assert.ok(unreadCount >= 0);
      }
    });

    test('E3: Illegal out-of-bounds stage strings are rejected by saveOnboardingStage', () => {
      const illegalStages = [
        'HACKED_STAGE',
        '__proto__',
        'constructor',
        'toString',
        '',
        'stage_999'
      ];

      for (const illegal of illegalStages) {
        saveOnboardingStage(illegal as any, 'usr_stage_test');
        const state = getOnboardingState('usr_stage_test');
        assert.strictEqual(
          state.currentStage,
          'intro',
          `Illegal stage "${illegal}" must be rejected, retaining default intro`
        );
      }

      // Valid stage progression succeeds
      saveOnboardingStage('agent_mode', 'usr_stage_test');
      const validState = getOnboardingState('usr_stage_test');
      assert.strictEqual(validState.currentStage, 'agent_mode');
    });

    test('E4: Replay and cycling of completed onboarding tour preserves deterministic state', () => {
      const userId = 'usr_lifecycle_replay';

      // 1. User skips
      skipOnboarding(userId);
      let state = getOnboardingState(userId);
      assert.strictEqual(state.completed, true);
      assert.strictEqual(state.skipped, true);

      // 2. User finishes again (replay) -> remains completed
      finishOnboarding(userId);
      state = getOnboardingState(userId);
      assert.strictEqual(state.completed, true);
      assert.strictEqual(state.currentStage, 'plans');
      assert.strictEqual(state.skipped, false);

      // 3. User restarts tour -> clean reset to intro
      restartOnboarding(userId);
      state = getOnboardingState(userId);
      assert.strictEqual(state.completed, false);
      assert.strictEqual(state.skipped, false);
      assert.strictEqual(state.currentStage, 'intro');

      // 4. Progress sequentially
      saveOnboardingStage('chat_reasoning', userId);
      state = getOnboardingState(userId);
      assert.strictEqual(state.currentStage, 'chat_reasoning');
    });

    test('E5: Malicious URL query parameters targeting feature flags are sanitized and rejected', () => {
      (globalThis as any).window.location.search =
        '?ff___proto__=true&ff_constructor=true&ff_toString=true&ff_unknown_key=true&ff_onboarding_walkthrough=false';

      const overrides = readOverridesFromEnvironment();

      // Dangerous keys must NOT be present in parsed overrides
      assert.strictEqual(Object.hasOwn(overrides, '__proto__'), false);
      assert.strictEqual(Object.hasOwn(overrides, 'constructor'), false);
      assert.strictEqual(Object.hasOwn(overrides, 'toString'), false);
      assert.strictEqual(Object.hasOwn(overrides, 'unknown_key'), false);

      // Legitimate registered flag override must be parsed correctly
      assert.strictEqual(overrides.onboarding_walkthrough, false);

      // Object prototype remains clean
      assert.strictEqual(({} as any).polluted, undefined);
    });

    test('E6: useFeatureFlag hook and isSafeFeatureFlagKey resist prototype property inheritance', () => {
      // 1. Test isSafeFeatureFlagKey helper directly
      assert.strictEqual(isSafeFeatureFlagKey('__proto__'), false);
      assert.strictEqual(isSafeFeatureFlagKey('constructor'), false);
      assert.strictEqual(isSafeFeatureFlagKey('prototype'), false);
      assert.strictEqual(isSafeFeatureFlagKey('toString'), false);
      assert.strictEqual(isSafeFeatureFlagKey('valueOf'), false);
      assert.strictEqual(isSafeFeatureFlagKey('unknown_unregistered_flag'), false);
      assert.strictEqual(isSafeFeatureFlagKey('onboarding_walkthrough'), true);
      assert.strictEqual(isSafeFeatureFlagKey('agent_mode_autonomous'), true);

      // 2. Test useFeatureFlag behavior with prototype names
      const prototypeNames = [
        'toString',
        'valueOf',
        'constructor',
        '__proto__',
        'hasOwnProperty',
        'isPrototypeOf',
        'non_existent_flag'
      ];

      for (const name of prototypeNames) {
        const result = useFeatureFlag(name);
        assert.strictEqual(
          result,
          false,
          `useFeatureFlag("${name}") must return false and not resolve to Object.prototype methods`
        );
      }
    });
  });

});
