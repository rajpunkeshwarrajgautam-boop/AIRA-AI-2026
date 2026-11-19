import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMERCIAL_PLANS,
  PLAN_CAPABILITY_MATRIX,
  isFeatureAllowedForTier,
  getMinimumRequiredTierForFeature,
  type ExecutionPrincipal
} from '../packages/contracts/src/index.js';
import { builderAccess } from '../packages/builder-runtime/src/security.js';
import { BuilderService } from '../packages/builder-runtime/src/index.js';
import { ModelRouter, PlanRestrictionError, ProviderHealthTracker } from '../packages/model-router/src/index.js';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { InMemoryRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { BrainV2KnowledgeEngine, InMemoryKnowledgeRepository } from '../packages/knowledge/src/index.js';
import {
  requireCapability,
  resolveCallerTier,
  TIER_RANKS
} from '../apps/api/src/middleware/entitlement-guard.js';

function createTestRuntime() {
  const modelRouter = new ModelRouter([], new ProviderHealthTracker());
  const toolRegistry = new ToolRegistry();
  const approvalKernel = new ApprovalKernel();
  const knowledgeEngine = new BrainV2KnowledgeEngine(new InMemoryKnowledgeRepository(), { seedDefaults: false });
  const runRepo = new InMemoryRunRepository();
  return new AgentRuntime(
    modelRouter,
    toolRegistry,
    approvalKernel,
    knowledgeEngine,
    runRepo,
    process.cwd()
  );
}

describe('P0 — Server-Authoritative Entitlement and Privileged API Enforcement', () => {
  describe('Authoritative Commercial Matrix Constraints', () => {
    it('enforces exact tier capability constraints in contracts', () => {
      // Guest
      assert.equal(isFeatureAllowedForTier('autonomous', 'guest'), false);
      assert.equal(isFeatureAllowedForTier('browsertools', 'guest'), false);
      assert.equal(isFeatureAllowedForTier('pythonsandbox', 'guest'), false);
      assert.equal(isFeatureAllowedForTier('builder', 'guest'), false);
      assert.equal(isFeatureAllowedForTier('saved_agents', 'guest'), false);
      assert.equal(COMMERCIAL_PLANS.guest.savedAgentsLimit, 0);

      // Free
      assert.equal(isFeatureAllowedForTier('autonomous', 'free'), false);
      assert.equal(isFeatureAllowedForTier('browsertools', 'free'), false);
      assert.equal(isFeatureAllowedForTier('pythonsandbox', 'free'), false);
      assert.equal(isFeatureAllowedForTier('builder', 'free'), false);
      assert.equal(isFeatureAllowedForTier('saved_agents', 'free'), false);
      assert.equal(COMMERCIAL_PLANS.free.savedAgentsLimit, 0);

      // Plus
      assert.equal(isFeatureAllowedForTier('autonomous', 'plus'), true);
      assert.equal(isFeatureAllowedForTier('browsertools', 'plus'), false);
      assert.equal(isFeatureAllowedForTier('pythonsandbox', 'plus'), false);
      assert.equal(isFeatureAllowedForTier('builder', 'plus'), true);
      assert.equal(isFeatureAllowedForTier('saved_agents', 'plus'), true);
      assert.equal(COMMERCIAL_PLANS.plus.savedAgentsLimit, 3);

      // Pro
      assert.equal(isFeatureAllowedForTier('autonomous', 'pro'), true);
      assert.equal(isFeatureAllowedForTier('browsertools', 'pro'), true);
      assert.equal(isFeatureAllowedForTier('pythonsandbox', 'pro'), true);
      assert.equal(isFeatureAllowedForTier('builder', 'pro'), true);
      assert.equal(isFeatureAllowedForTier('saved_agents', 'pro'), true);
      assert.equal(COMMERCIAL_PLANS.pro.savedAgentsLimit, 20);
    });

    it('resolves correct minimum required tier per privileged capability', () => {
      assert.equal(getMinimumRequiredTierForFeature('autonomous'), 'plus');
      assert.equal(getMinimumRequiredTierForFeature('builder'), 'plus');
      assert.equal(getMinimumRequiredTierForFeature('saved_agents'), 'plus');
      assert.equal(getMinimumRequiredTierForFeature('browsertools'), 'pro');
      assert.equal(getMinimumRequiredTierForFeature('pythonsandbox'), 'pro');
    });
  });

  describe('Builder Studio Double-Key Access Gate', () => {
    const originalEnv = { ...process.env };

    it('blocks Builder access for Free tier even if user is on operator allowlist', () => {
      process.env.AIRA_BUILDER_ENABLED = 'true';
      process.env.AIRA_BUILDER_ALLOWED_USER_IDS = 'usr_privileged_dev';

      const principal: ExecutionPrincipal = {
        userId: 'usr_privileged_dev',
        sessionId: 'sess_123'
      };

      // Free tier caller
      const freeAccess = builderAccess(principal, 'free');
      assert.equal(freeAccess.allowed, false);
      assert.match(freeAccess.reason, /Builder requires an AIRA Plus or Pro subscription/i);

      // Guest tier caller
      const guestAccess = builderAccess(principal, 'guest');
      assert.equal(guestAccess.allowed, false);
      assert.match(guestAccess.reason, /Builder requires an AIRA Plus or Pro subscription/i);
    });

    it('blocks Builder access for Plus/Pro tier if user is NOT on operator allowlist', () => {
      process.env.AIRA_BUILDER_ENABLED = 'true';
      process.env.AIRA_BUILDER_ALLOWED_USER_IDS = 'usr_authorized_only';

      const unapprovedPrincipal: ExecutionPrincipal = {
        userId: 'usr_unapproved_plus_user',
        sessionId: 'sess_456'
      };

      const plusAccess = builderAccess(unapprovedPrincipal, 'plus');
      assert.equal(plusAccess.allowed, false);
      assert.match(plusAccess.reason, /limited to owner-approved users/i);

      const proAccess = builderAccess(unapprovedPrincipal, 'pro');
      assert.equal(proAccess.allowed, false);
      assert.match(proAccess.reason, /limited to owner-approved users/i);
    });

    it('permits Builder access when user satisfies BOTH operator allowlist AND Plus/Pro tier', () => {
      process.env.AIRA_BUILDER_ENABLED = 'true';
      process.env.AIRA_BUILDER_ALLOWED_USER_IDS = 'usr_authorized_dev';
      process.env.LIGHTNING_SANDBOX_API_KEY = 'test_key';
      process.env.AIRA_BUILDER_SIGNING_SECRET = 'a'.repeat(32);

      const approvedPrincipal: ExecutionPrincipal = {
        userId: 'usr_authorized_dev',
        sessionId: 'sess_789'
      };

      const plusAccess = builderAccess(approvedPrincipal, 'plus');
      assert.equal(plusAccess.allowed, true);
      assert.equal(plusAccess.enabled, true);

      const proAccess = builderAccess(approvedPrincipal, 'pro');
      assert.equal(proAccess.allowed, true);
      assert.equal(proAccess.enabled, true);

      // Restore env
      process.env = { ...originalEnv };
    });
  });

  describe('Agent Runtime Autonomous Intent Gate', () => {
    it('throws PlanRestrictionError when Free tier attempts WORKFLOW intent', async () => {
      const runtime = createTestRuntime();
      const principal: ExecutionPrincipal = {
        userId: 'usr_free_tier',
        sessionId: 'sess_123',
        roles: ['user']
      };

      await assert.rejects(
        async () => {
          await runtime.createRun(
            {
              prompt: 'Generate autonomous report',
              intent: 'WORKFLOW'
            },
            principal,
            { callerTier: 'free' }
          );
        },
        (err: any) => {
          assert.ok(err instanceof PlanRestrictionError || err.name === 'PlanRestrictionError');
          assert.match(err.message, /Autonomous execution mode requires PLUS tier or higher/i);
          return true;
        }
      );
    });

    it('throws PlanRestrictionError when Guest tier attempts AGENT_MISSION intent', async () => {
      const runtime = createTestRuntime();
      const principal: ExecutionPrincipal = {
        userId: 'guest_anonymous_123',
        sessionId: 'sess_guest',
        roles: ['guest']
      };

      await assert.rejects(
        async () => {
          await runtime.createRun(
            {
              prompt: 'Run full browser automation mission',
              intent: 'AGENT_MISSION'
            },
            principal,
            { callerTier: 'guest' }
          );
        },
        (err: any) => {
          assert.ok(err instanceof PlanRestrictionError || err.name === 'PlanRestrictionError');
          assert.match(err.message, /Autonomous execution mode requires PLUS tier or higher/i);
          return true;
        }
      );
    });

    it('permits Plus and Pro tiers to create WORKFLOW and AGENT_MISSION runs', async () => {
      const runtime = createTestRuntime();
      const principal: ExecutionPrincipal = {
        userId: 'usr_plus_tier',
        sessionId: 'sess_plus',
        roles: ['user']
      };

      const plusRun = await runtime.createRun(
        {
          prompt: 'Execute workflow wave',
          intent: 'WORKFLOW',
          modelPolicy: { model: 'mock-deterministic' }
        },
        principal,
        { callerTier: 'plus' }
      );
      assert.ok(plusRun.id.startsWith('run_'));
      assert.equal(plusRun.intent, 'WORKFLOW');

      const proRun = await runtime.createRun(
        {
          prompt: 'Execute pro agent mission',
          intent: 'AGENT_MISSION',
          modelPolicy: { model: 'mock-deterministic' }
        },
        principal,
        { callerTier: 'pro' }
      );
      assert.ok(proRun.id.startsWith('run_'));
      assert.equal(proRun.intent, 'AGENT_MISSION');
    });
  });

  describe('Express Middleware Capability Gating', () => {
    it('requireCapability middleware blocks unauthorized caller tiers with HTTP 403', async () => {
      const middleware = requireCapability('browsertools');

      let responseStatusCode = 0;
      let responseBody: any = null;

      const mockReq: any = {
        principal: { userId: 'guest_anon_1', sessionId: 'sess_1' },
        user: { isGuest: true }
      };

      const mockRes: any = {
        status: (code: number) => {
          responseStatusCode = code;
          return mockRes;
        },
        json: (data: any) => {
          responseBody = data;
          return mockRes;
        }
      };

      let nextCalled = false;
      await middleware(mockReq, mockRes, () => { nextCalled = true; });

      assert.equal(nextCalled, false);
      assert.equal(responseStatusCode, 403);
      assert.equal(responseBody?.error, 'PLAN_CAPABILITY_RESTRICTED');
      assert.equal(responseBody?.capability, 'browsertools');
      assert.equal(responseBody?.requiredTier, 'pro');
    });
  });
});
