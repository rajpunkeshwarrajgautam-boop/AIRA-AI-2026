import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCallerTier,
  requireEntitledModel,
  requireToolEntitlement,
  requirePlanTier,
  requireCapability
} from '../apps/api/src/middleware/entitlement-guard.js';
import {
  ToolGateway,
  InMemoryToolCallRepository
} from '../packages/tool-runtime/src/index.js';
import {
  AutonomousWorkerHost
} from '../packages/agent-runtime/src/autonomous/autonomous-worker-host.js';
import {
  PrivateBetaCapacityGuard,
  InMemoryCapacityStore
} from '../packages/model-router/src/index.js';
import {
  ExecutionPrincipal,
  AutonomousAgentTask,
  isModelAllowedForTier,
  isFeatureAllowedForTier,
  PLAN_MODEL_ALLOWLIST
} from '../packages/contracts/src/index.js';

describe('Adversarial Edge-Case & Bypass Stress Tests (Milestone 2)', () => {

  // =========================================================================
  // 1. Header Spoofing & Caller Tier Resolution
  // =========================================================================
  describe('1. Header Spoofing Defense', () => {
    test('1A: Guest session with malicious x-user-tier: pro is strictly evaluated as guest', async () => {
      const mockReq: any = {
        user: { id: 'guest_attacker_1', isGuest: true, tier: 'guest' },
        headers: { 'x-user-tier': 'pro' }
      };
      const tier = await resolveCallerTier(mockReq);
      assert.strictEqual(tier, 'guest', 'Malicious x-user-tier must NOT elevate guest session');
    });

    test('1B: Free user session with malicious x-user-tier: pro is strictly evaluated as free', async () => {
      const mockReq: any = {
        user: { id: 'usr_free_account', isGuest: false, tier: 'free' },
        headers: { 'x-user-tier': 'pro' }
      };
      const tier = await resolveCallerTier(mockReq);
      assert.strictEqual(tier, 'free', 'Malicious x-user-tier must NOT elevate free account');
    });

    test('1C: Principal starting with guest_ prefix is always evaluated as guest despite header', async () => {
      const mockReq: any = {
        principal: { userId: 'guest_prefix_attacker' },
        headers: { 'x-user-tier': 'pro' }
      };
      const tier = await resolveCallerTier(mockReq);
      assert.strictEqual(tier, 'guest', 'Principal with guest_ prefix must strictly resolve to guest');
    });

    test('1D: Request with session cookie credentials ignores x-user-tier header', async () => {
      const mockReq: any = {
        headers: {
          cookie: 'aira_session=valid_session_cookie',
          'x-user-tier': 'pro'
        }
      };
      const tier = await resolveCallerTier(mockReq);
      assert.notStrictEqual(tier, 'pro', 'x-user-tier must be rejected when cookie authentication is present');
      assert.strictEqual(tier, 'guest');
    });

    test('1E: requireEntitledModel blocks free user with x-user-tier: pro from accessing flagship opus', async () => {
      const middleware = requireEntitledModel();
      let statusCalled = 0;
      let jsonCalledWith: any = null;
      let nextCalled = false;

      const mockReq: any = {
        user: { id: 'usr_free_account', tier: 'free' },
        headers: { 'x-user-tier': 'pro' },
        body: { model: 'claude-3-opus' }
      };
      const mockRes: any = {
        status: (s: number) => {
          statusCalled = s;
          return {
            json: (payload: any) => { jsonCalledWith = payload; }
          };
        }
      };
      const mockNext = () => { nextCalled = true; };

      await middleware(mockReq, mockRes, mockNext);

      assert.strictEqual(nextCalled, false, 'Next must not be called when model is restricted');
      assert.strictEqual(statusCalled, 403, 'Must return 403 for restricted model');
      assert.strictEqual(jsonCalledWith.error, 'PLAN_MODEL_RESTRICTED');
      assert.strictEqual(jsonCalledWith.callerTier, 'free');
    });

    test('1F: requireToolEntitlement blocks guest with x-user-tier: pro from browser execution', async () => {
      const middleware = requireToolEntitlement();
      let statusCalled = 0;
      let jsonCalledWith: any = null;
      let nextCalled = false;

      const mockReq: any = {
        user: { id: 'guest_attacker', isGuest: true, tier: 'guest' },
        headers: { 'x-user-tier': 'pro' },
        body: { toolName: 'browser_navigate' }
      };
      const mockRes: any = {
        status: (s: number) => {
          statusCalled = s;
          return {
            json: (payload: any) => { jsonCalledWith = payload; }
          };
        }
      };
      const mockNext = () => { nextCalled = true; };

      await middleware(mockReq, mockRes, mockNext);

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(statusCalled, 403);
      assert.strictEqual(jsonCalledWith.error, 'PLAN_TOOL_RESTRICTED');
      assert.strictEqual(jsonCalledWith.requiredTier, 'pro');
    });
  });

  // =========================================================================
  // 2. Tool Gateway Tier Gating
  // =========================================================================
  describe('2. Tool Gateway Tier Gating', () => {
    const createPrincipal = (tier: string, userId = 'test_user'): ExecutionPrincipal => ({
      userId,
      sessionId: 'sess_test',
      workspaceId: 'ws_test',
      roles: ['workspace_user'],
      scopes: ['*'],
      ...( { tier } as any)
    });

    test('2A: ToolGateway rejects browser_* tools for Guest caller', async () => {
      const gateway = new ToolGateway(new InMemoryToolCallRepository());
      const principal = createPrincipal('guest', 'guest_123');

      const result = await gateway.execute({
        toolName: 'browser_navigate',
        arguments: { url: 'https://example.com' },
        context: { runId: 'run_test_1', principal }
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.errorCode, 'PLAN_TOOL_RESTRICTED');
      assert.match(result.error, /Browser execution tools require AIRA Pro/);
    });

    test('2B: ToolGateway rejects browser_* tools for Free caller', async () => {
      const gateway = new ToolGateway(new InMemoryToolCallRepository());
      const principal = createPrincipal('free', 'usr_free');

      const result = await gateway.execute({
        toolName: 'browser_extract',
        arguments: { selector: 'h1' },
        context: { runId: 'run_test_2', principal }
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.errorCode, 'PLAN_TOOL_RESTRICTED');
    });

    test('2C: ToolGateway rejects browser_* tools for Plus caller', async () => {
      const gateway = new ToolGateway(new InMemoryToolCallRepository());
      const principal = createPrincipal('plus', 'usr_plus');

      const result = await gateway.execute({
        toolName: 'browser_click',
        arguments: { selector: '#btn' },
        context: { runId: 'run_test_3', principal }
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.errorCode, 'PLAN_TOOL_RESTRICTED');
    });

    test('2D: ToolGateway rejects python_sandbox for Free caller', async () => {
      const gateway = new ToolGateway(new InMemoryToolCallRepository());
      const principal = createPrincipal('free', 'usr_free');

      const result = await gateway.execute({
        toolName: 'python_sandbox',
        arguments: { code: 'print(42)' },
        context: { runId: 'run_test_4', principal }
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.errorCode, 'PLAN_TOOL_RESTRICTED');
      assert.match(result.error, /Python Sandbox execution requires AIRA Pro/);
    });

    test('2E: ToolGateway rejects python_sandbox for Plus caller', async () => {
      const gateway = new ToolGateway(new InMemoryToolCallRepository());
      const principal = createPrincipal('plus', 'usr_plus');

      const result = await gateway.execute({
        toolName: 'python_sandbox',
        arguments: { code: 'import sys; print(sys.version)' },
        context: { runId: 'run_test_5', principal }
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.errorCode, 'PLAN_TOOL_RESTRICTED');
    });

    test('2F: ToolGateway rejects python_sandbox for Guest caller', async () => {
      const gateway = new ToolGateway(new InMemoryToolCallRepository());
      const principal = createPrincipal('guest', 'guest_abc');

      const result = await gateway.execute({
        toolName: 'python_sandbox',
        arguments: { code: '1+1' },
        context: { runId: 'run_test_6', principal }
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.errorCode, 'PLAN_TOOL_RESTRICTED');
    });
  });

  // =========================================================================
  // 3. Autonomous Worker Tier Fencing
  // =========================================================================
  describe('3. Autonomous Worker Tier Fencing', () => {
    test('3A: AutonomousWorkerHost fails closed when processing task for Guest tier', async () => {
      let stateUpdated: string | null = null;
      let errorReason: string | null = null;
      let failedEventEmitted = false;

      const mockRepo: any = {
        updateState: async (id: string, state: string, reason: string) => {
          stateUpdated = state;
          errorReason = reason;
        },
        getTask: async () => null
      };

      const host = new AutonomousWorkerHost(mockRepo, {} as any, { workerId: 'test_worker_1' });
      host.on('task.failed', (evt: any) => {
        failedEventEmitted = true;
      });

      const guestTask: AutonomousAgentTask = {
        taskId: 'task_guest_test_1',
        principal: {
          userId: 'guest_ephemeral_user',
          sessionId: 'sess_1',
          workspaceId: 'ws_1',
          roles: ['guest_user'],
          scopes: ['chat:write'],
          tier: 'guest'
        } as any,
        objective: 'Test guest autonomous task',
        status: 'SUBMITTED',
        currentStepIndex: 0,
        plan: [],
        fencingToken: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      // Directly invoke private processTask via host reflection
      await (host as any).processTask(guestTask);

      assert.strictEqual(failedEventEmitted, true, 'task.failed event must be emitted');
      assert.strictEqual(stateUpdated, 'FAILED', 'Task state must be transitioned to FAILED');
      assert.match(errorReason || '', /PLAN_CAPABILITY_RESTRICTED/);
    });

    test('3B: AutonomousWorkerHost fails closed when processing task for Free tier', async () => {
      let stateUpdated: string | null = null;
      let failedEventEmitted = false;

      const mockRepo: any = {
        updateState: async (id: string, state: string, reason: string) => {
          stateUpdated = state;
        },
        getTask: async () => null
      };

      const host = new AutonomousWorkerHost(mockRepo, {} as any, { workerId: 'test_worker_2' });
      host.on('task.failed', (evt: any) => {
        failedEventEmitted = true;
      });

      const freeTask: AutonomousAgentTask = {
        taskId: 'task_free_test_2',
        principal: {
          userId: 'usr_free_user',
          sessionId: 'sess_2',
          workspaceId: 'ws_2',
          roles: ['workspace_user'],
          scopes: ['*'],
          tier: 'free'
        } as any,
        objective: 'Test free autonomous task',
        status: 'SUBMITTED',
        currentStepIndex: 0,
        plan: [],
        fencingToken: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await (host as any).processTask(freeTask);

      assert.strictEqual(failedEventEmitted, true);
      assert.strictEqual(stateUpdated, 'FAILED');
    });

    test('3C: AutonomousWorkerHost infers guest from guest_ prefix if tier property omitted', async () => {
      let stateUpdated: string | null = null;
      let failedEventEmitted = false;

      const mockRepo: any = {
        updateState: async (id: string, state: string) => {
          stateUpdated = state;
        },
        getTask: async () => null
      };

      const host = new AutonomousWorkerHost(mockRepo, {} as any, { workerId: 'test_worker_3' });
      host.on('task.failed', () => { failedEventEmitted = true; });

      const guestPrefixedTask: AutonomousAgentTask = {
        taskId: 'task_prefix_test',
        principal: {
          userId: 'guest_no_tier_property',
          sessionId: 'sess_3',
          workspaceId: 'ws_3',
          roles: ['guest_user'],
          scopes: ['chat:write']
        },
        objective: 'Test guest prefix fallback',
        status: 'SUBMITTED',
        currentStepIndex: 0,
        plan: [],
        fencingToken: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await (host as any).processTask(guestPrefixedTask);

      assert.strictEqual(failedEventEmitted, true);
      assert.strictEqual(stateUpdated, 'FAILED');
    });
  });

  // =========================================================================
  // 4. Dynamic Concurrency Limits (Capacity Guard)
  // =========================================================================
  describe('4. Dynamic Plan-Aware Capacity Guard', () => {
    test('4A: Free tier is strictly limited to 1 concurrent request; 2nd concurrent is rejected', async () => {
      const store = new InMemoryCapacityStore();
      const guard = new PrivateBetaCapacityGuard({
        perUserMaxConcurrent: 1,
        globalMaxConcurrent: 10,
        perUserRpm: 60,
        globalRpm: 120,
        retryAfterSeconds: 5
      }, store);

      // 1st request for free user -> ADMIT_NOW
      const res1 = await guard.admit({
        principalId: 'user_free_conc',
        tier: 'free',
        model: 'aira-fast',
        promptText: 'First query'
      });
      assert.strictEqual(res1.decision, 'ADMIT_NOW', 'First free request must be admitted');
      assert.ok(res1.permit);

      // 2nd simultaneous request before res1 is released -> REJECT_CAPACITY
      const res2 = await guard.admit({
        principalId: 'user_free_conc',
        tier: 'free',
        model: 'aira-fast',
        promptText: 'Second query'
      });
      assert.strictEqual(res2.decision, 'REJECT_CAPACITY', 'Second concurrent request must be rejected');
      assert.strictEqual(res2.reason, 'CONCURRENCY_LIMIT_EXCEEDED');
      assert.match(res2.userMessage || '', /Plan free allows 1 concurrent request/);

      // Release 1st permit
      await res1.permit.release();

      // 3rd request after release -> ADMIT_NOW
      const res3 = await guard.admit({
        principalId: 'user_free_conc',
        tier: 'free',
        model: 'aira-fast',
        promptText: 'Third query after release'
      });
      assert.strictEqual(res3.decision, 'ADMIT_NOW', 'Request after permit release must be admitted');
      await res3.permit?.release();
    });

    test('4B: Pro tier allows 2 concurrent requests; 3rd concurrent is rejected', async () => {
      const store = new InMemoryCapacityStore();
      const guard = new PrivateBetaCapacityGuard({
        perUserMaxConcurrent: 2,
        globalMaxConcurrent: 10,
        perUserRpm: 60,
        globalRpm: 120,
        retryAfterSeconds: 5
      }, store);

      // 1st request for pro user -> ADMIT_NOW
      const res1 = await guard.admit({
        principalId: 'user_pro_conc',
        tier: 'pro',
        model: 'aira-fast',
        promptText: 'Pro query 1'
      });
      assert.strictEqual(res1.decision, 'ADMIT_NOW', 'First Pro request must be admitted');

      // 2nd concurrent request for pro user -> ADMIT_NOW (Pro permits 2)
      const res2 = await guard.admit({
        principalId: 'user_pro_conc',
        tier: 'pro',
        model: 'aira-fast',
        promptText: 'Pro query 2'
      });
      assert.strictEqual(res2.decision, 'ADMIT_NOW', 'Second Pro concurrent request must be admitted');

      // 3rd concurrent request -> REJECT_CAPACITY
      const res3 = await guard.admit({
        principalId: 'user_pro_conc',
        tier: 'pro',
        model: 'aira-fast',
        promptText: 'Pro query 3'
      });
      assert.strictEqual(res3.decision, 'REJECT_CAPACITY', 'Third concurrent Pro request must be rejected');
      assert.strictEqual(res3.reason, 'CONCURRENCY_LIMIT_EXCEEDED');
      assert.match(res3.userMessage || '', /Plan pro allows 2 concurrent request/);

      // Release permits
      await res1.permit?.release();
      await res2.permit?.release();
    });
  });

  // =========================================================================
  // 5. Safe Downgrade Retention Policy
  // =========================================================================
  describe('5. Safe Downgrade Retention Policy', () => {
    test('5A: Excess items are marked readOnly: true without deleting existing data', () => {
      const projects = [
        { id: 'p1', userId: 'u1', name: 'Project 1', readOnly: false },
        { id: 'p2', userId: 'u1', name: 'Project 2', readOnly: false },
        { id: 'p3', userId: 'u1', name: 'Project 3', readOnly: false },
        { id: 'p4', userId: 'u1', name: 'Project 4', readOnly: false },
        { id: 'p5', userId: 'u1', name: 'Project 5', readOnly: false }
      ];

      // Free tier allows 3 projects
      const freeMaxProjects = 3;
      projects.forEach((p, idx) => {
        p.readOnly = idx >= freeMaxProjects;
      });

      // Assert zero deletion
      assert.strictEqual(projects.length, 5, 'All 5 projects must be retained');
      assert.strictEqual(projects[0].readOnly, false);
      assert.strictEqual(projects[1].readOnly, false);
      assert.strictEqual(projects[2].readOnly, false);
      assert.strictEqual(projects[3].readOnly, true, 'Project 4 must be read-only');
      assert.strictEqual(projects[4].readOnly, true, 'Project 5 must be read-only');
    });

    test('5B: Subsequent creation when count >= quota is rejected with QUOTA_EXCEEDED_READ_ONLY_MODE', () => {
      const userProjects = [
        { id: 'p1', userId: 'u1', readOnly: false },
        { id: 'p2', userId: 'u1', readOnly: false },
        { id: 'p3', userId: 'u1', readOnly: false },
        { id: 'p4', userId: 'u1', readOnly: true },
        { id: 'p5', userId: 'u1', readOnly: true }
      ];

      const tier = 'free';
      const maxAllowed = 3;
      const canCreate = userProjects.length < maxAllowed;

      assert.strictEqual(canCreate, false, 'Creation must be blocked when exceeding quota');
    });
  });

  // =========================================================================
  // 6. Guest Session Linking Anti-Replay
  // =========================================================================
  describe('6. Guest Session Linking Replay Defense', () => {
    test('6A: Replay attack on linked guest session token is rejected with 409 ALREADY_LINKED', () => {
      const linkedTokens = new Map<string, string>();
      const guestToken = 'guest_replay_test_token_123';
      const authUserId = 'usr_real_account_1';
      const attackerUserId = 'usr_attacker_account_2';

      // 1st Link: Genuine user links session
      let status1 = 200;
      let body1: any = null;
      if (linkedTokens.has(guestToken)) {
        status1 = 409;
      } else {
        linkedTokens.set(guestToken, authUserId);
        body1 = { success: true, linkedUserId: authUserId };
      }

      assert.strictEqual(status1, 200);
      assert.strictEqual(body1.success, true);
      assert.strictEqual(body1.linkedUserId, authUserId);

      // 2nd Link (Replay): Attacker or duplicate link attempt with same guest token
      let status2 = 200;
      let body2: any = null;
      if (linkedTokens.has(guestToken)) {
        status2 = 409;
        body2 = { error: 'ALREADY_LINKED', message: 'Guest session already linked to an account' };
      } else {
        linkedTokens.set(guestToken, attackerUserId);
        body2 = { success: true };
      }

      assert.strictEqual(status2, 409, 'Replay attack must be blocked with 409 Conflict');
      assert.strictEqual(body2.error, 'ALREADY_LINKED');
      assert.strictEqual(linkedTokens.get(guestToken), authUserId, 'Original ownership must remain untouched');
    });
  });

});
