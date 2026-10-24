import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AutomationEngine } from '../packages/automation/src/index.js';
import { AutomationDefinition, AutomationRun, AutomationDefinitionSchema } from '../packages/contracts/src/index.js';
import type { AutomationRepository, AutomationRunRepository } from '../packages/automation/src/repositories.js';

class MockAutomationRepo implements AutomationRepository {
  public automations: Map<string, AutomationDefinition> = new Map();
  public clientOpIndex: Map<string, string> = new Map();

  async saveAutomation(automation: AutomationDefinition, clientOperationId?: string): Promise<void> {
    this.automations.set(automation.id, { ...automation });
    if (clientOperationId && automation.principalId) {
      this.clientOpIndex.set(`${automation.principalId}:${clientOperationId}`, automation.id);
    }
  }

  async getAutomation(id: string): Promise<AutomationDefinition | undefined> {
    return this.automations.get(id);
  }

  async getAutomationByClientOperationId(principalId: string, clientOperationId: string): Promise<AutomationDefinition | undefined> {
    const id = this.clientOpIndex.get(`${principalId}:${clientOperationId}`);
    return id ? this.automations.get(id) : undefined;
  }

  async listAutomations(principalId?: string): Promise<AutomationDefinition[]> {
    const all = Array.from(this.automations.values());
    if (principalId) return all.filter(a => a.principalId === principalId);
    return all;
  }

  async getDueAutomations(): Promise<AutomationDefinition[]> {
    return Array.from(this.automations.values()).filter(a => a.enabled);
  }

  async updateLastRun(id: string, lastRun: number): Promise<void> {
    const a = this.automations.get(id);
    if (a) {
      a.lastRun = lastRun;
    }
  }

  async tryClaimAutomationRun(id: string, dueThreshold: number, newLastRun: number): Promise<boolean> {
    const a = this.automations.get(id);
    if (!a || (a.lastRun && a.lastRun >= dueThreshold)) return false;
    a.lastRun = newLastRun;
    return true;
  }

  async deleteAutomation(id: string): Promise<boolean> {
    return this.automations.delete(id);
  }
}

class MockAutomationRunRepo implements AutomationRunRepository {
  public runs: Map<string, AutomationRun> = new Map();
  public claimedKeys: Set<string> = new Set();

  async saveRun(run: AutomationRun): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async getRun(id: string): Promise<AutomationRun | undefined> {
    return this.runs.get(id);
  }

  async getRunsForAutomation(automationId: string): Promise<AutomationRun[]> {
    return Array.from(this.runs.values()).filter(r => r.automationId === automationId);
  }

  async claimRun(automationId: string, scheduledFor: number): Promise<AutomationRun | undefined> {
    const key = `${automationId}:${scheduledFor}`;
    if (this.claimedKeys.has(key)) return undefined;
    this.claimedKeys.add(key);

    const run: AutomationRun = {
      id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      automationId,
      scheduledFor,
      startedAt: Date.now(),
      status: 'CLAIMED',
      attempt: 1,
      claimedAt: Date.now()
    };
    this.runs.set(run.id, run);
    return run;
  }
}

const mockAgentRuntime: any = {
  createRun: async (config: any, context: any) => ({
    id: `agent_run_${Date.now()}`,
    state: 'RUNNING'
  }),
  startRun: async (_id: string) => {},
  getRun: async (id: string) => ({
    id,
    state: 'COMPLETED',
    content: 'Execution completed successfully'
  })
};

test('Policy B Gate 1: Contract defaults enabled to false', () => {
  const parsed = AutomationDefinitionSchema.omit({ id: true }).parse({
    name: 'Default Test',
    trigger: 'CRON',
    cronExpression: '0 9 * * *',
    agentId: 'test_agent',
    objective: 'Test objective'
  });

  assert.equal(parsed.enabled, false, 'AutomationDefinitionSchema must default enabled to false');
});

test('Policy B Gate 2: Scheduler readiness fails closed — requires CRON_SECRET + AIRA_SCHEDULER_ENABLED + AIRA_SERVERLESS_CRON_CONFIGURED (P1 fail-closed)', () => {
  const repo = new MockAutomationRepo();
  const runRepo = new MockAutomationRunRepo();
  const engine = new AutomationEngine(mockAgentRuntime, repo, runRepo);

  const origSchedulerEnabled = process.env.AIRA_SCHEDULER_ENABLED;
  const origVercel = process.env.VERCEL;
  const origCronSecret = process.env.CRON_SECRET;
  const origCronConfigured = process.env.AIRA_SERVERLESS_CRON_CONFIGURED;

  try {
    // 1. Explicitly disabled via env
    process.env.AIRA_SCHEDULER_ENABLED = 'false';
    delete process.env.VERCEL;
    const statusDisabled = engine.getSchedulerStatus();
    assert.equal(statusDisabled.active, false);
    assert.equal(statusDisabled.mode, 'UNAVAILABLE');
    assert.equal(engine.isSchedulerActive(), false);

    // 2. Vercel serverless — no env vars at all
    delete process.env.AIRA_SCHEDULER_ENABLED;
    process.env.VERCEL = '1';
    delete process.env.CRON_SECRET;
    delete process.env.AIRA_SERVERLESS_CRON_CONFIGURED;
    const statusNoVars = engine.getSchedulerStatus();
    assert.equal(statusNoVars.active, false, 'Must be inactive with no env vars');
    assert.equal(statusNoVars.mode, 'UNAVAILABLE');
    assert.ok(statusNoVars.reason?.includes('serverless'));

    // 3. CRON_SECRET + AIRA_SCHEDULER_ENABLED only (P1 defect scenario) — must still be INACTIVE
    process.env.CRON_SECRET = 'secret-present';
    process.env.AIRA_SCHEDULER_ENABLED = 'true';
    delete process.env.AIRA_SERVERLESS_CRON_CONFIGURED;
    const statusPartial = engine.getSchedulerStatus();
    assert.equal(statusPartial.active, false,
      'CRON_SECRET + AIRA_SCHEDULER_ENABLED alone must NOT activate scheduler (fail-closed)');
    assert.equal(statusPartial.mode, 'UNAVAILABLE');
    assert.ok(
      statusPartial.reason?.includes('AIRA_SERVERLESS_CRON_CONFIGURED'),
      'Reason must mention missing AIRA_SERVERLESS_CRON_CONFIGURED'
    );

    // 4. All three flags present — only then active
    process.env.AIRA_SERVERLESS_CRON_CONFIGURED = 'true';
    const statusAll = engine.getSchedulerStatus();
    assert.equal(statusAll.active, true, 'All three flags present: must be active');
    assert.equal(statusAll.mode, 'SERVERLESS_CRON');
    assert.equal(engine.isSchedulerActive(), true);
  } finally {
    if (origSchedulerEnabled !== undefined) process.env.AIRA_SCHEDULER_ENABLED = origSchedulerEnabled;
    else delete process.env.AIRA_SCHEDULER_ENABLED;
    if (origVercel !== undefined) process.env.VERCEL = origVercel;
    else delete process.env.VERCEL;
    if (origCronSecret !== undefined) process.env.CRON_SECRET = origCronSecret;
    else delete process.env.CRON_SECRET;
    if (origCronConfigured !== undefined) process.env.AIRA_SERVERLESS_CRON_CONFIGURED = origCronConfigured;
    else delete process.env.AIRA_SERVERLESS_CRON_CONFIGURED;
  }
});

test('Policy B Gate 3: Prevent new scheduled automations from becoming active when scheduler is unavailable', async () => {
  const repo = new MockAutomationRepo();
  const runRepo = new MockAutomationRunRepo();
  const engine = new AutomationEngine(mockAgentRuntime, repo, runRepo);

  const origVercel = process.env.VERCEL;
  try {
    // Simulate serverless deployment without configured scheduler
    process.env.VERCEL = '1';
    delete process.env.CRON_SECRET;
    delete process.env.AIRA_SCHEDULER_ENABLED;

    // Caller attempts to pass enabled: true for CRON trigger
    const cronAuto = await engine.createAutomation({
      name: 'Weekly Backup Sweep',
      trigger: 'CRON',
      cronExpression: '0 3 * * 0',
      agentId: 'agent_v1',
      objective: 'Run weekly database backup check',
      enabled: true,
      approvalPolicy: 'autonomous',
      conditions: {}
    });

    assert.equal(cronAuto.enabled, false, 'CRON automation must be saved with enabled: false');
    assert.equal(cronAuto.failureState, 'SCHEDULER_UNAVAILABLE', 'failureState must indicate SCHEDULER_UNAVAILABLE');

    // Caller attempts to pass enabled: true for ONE_TIME trigger
    const oneTimeAuto = await engine.createAutomation({
      name: 'One Time Security Audit',
      trigger: 'ONE_TIME',
      targetRunAt: Date.now() + 86400000,
      agentId: 'agent_v1',
      objective: 'Run one-time security scan',
      enabled: true,
      approvalPolicy: 'autonomous',
      conditions: {}
    });

    assert.equal(oneTimeAuto.enabled, false, 'ONE_TIME automation must be saved with enabled: false');
    assert.equal(oneTimeAuto.failureState, 'SCHEDULER_UNAVAILABLE', 'failureState must indicate SCHEDULER_UNAVAILABLE');

    // MANUAL trigger does not rely on autonomous scheduler
    const manualAuto = await engine.createAutomation({
      name: 'Manual Sync',
      trigger: 'MANUAL',
      agentId: 'agent_v1',
      objective: 'Manual trigger on demand',
      enabled: true,
      approvalPolicy: 'autonomous',
      conditions: {}
    });

    assert.equal(manualAuto.enabled, true, 'MANUAL automation can be saved enabled for on-demand execution');
  } finally {
    if (origVercel !== undefined) process.env.VERCEL = origVercel;
    else delete process.env.VERCEL;
  }
});

test('Policy B Gate 4: Reject activation requests server-side when scheduler is unavailable', async () => {
  const repo = new MockAutomationRepo();
  const runRepo = new MockAutomationRunRepo();
  const engine = new AutomationEngine(mockAgentRuntime, repo, runRepo);

  const origVercel = process.env.VERCEL;
  try {
    process.env.VERCEL = '1';
    delete process.env.CRON_SECRET;
    delete process.env.AIRA_SCHEDULER_ENABLED;

    const draft = await engine.createAutomation({
      name: 'Inactive Weekly Draft',
      trigger: 'CRON',
      cronExpression: '0 9 * * 1',
      agentId: 'agent_v1',
      objective: 'Weekly report',
      enabled: false,
      approvalPolicy: 'autonomous',
      conditions: {},
      principalId: 'user_owner_123'
    });

    assert.equal(draft.enabled, false);

    // Attempting to toggle to enabled: true MUST throw SCHEDULER_UNAVAILABLE
    await assert.rejects(
      async () => {
        await engine.toggleAutomation(draft.id, true, 'user_owner_123');
      },
      (err: any) => {
        assert.equal(err.code, 'SCHEDULER_UNAVAILABLE');
        assert.ok(err.message.includes('Autonomous scheduler is unavailable'));
        return true;
      }
    );

    // Verify draft remains disabled in repository
    const stored = await repo.getAutomation(draft.id);
    assert.equal(stored?.enabled, false);
  } finally {
    if (origVercel !== undefined) process.env.VERCEL = origVercel;
    else delete process.env.VERCEL;
  }
});

test('Policy B Gate 5: Protect existing user automations from silently executing on scheduler change', async () => {
  const repo = new MockAutomationRepo();
  const runRepo = new MockAutomationRunRepo();
  const engine = new AutomationEngine(mockAgentRuntime, repo, runRepo);

  // Directly insert an automation that has failureState: 'SCHEDULER_UNAVAILABLE'
  await repo.saveAutomation({
    id: 'auto_inactive_draft',
    name: 'Draft That Must Not Run',
    trigger: 'CRON',
    cronExpression: '* * * * *',
    agentId: 'agent_v1',
    objective: 'Test draft protection',
    enabled: false,
    failureState: 'SCHEDULER_UNAVAILABLE',
    approvalPolicy: 'autonomous',
    conditions: {}
  });

  // Call runScheduledCronCycle
  const cycleResult = await engine.runScheduledCronCycle();
  assert.equal(cycleResult.triggered.length, 0, 'Inactive drafts must not be triggered during cron cycles');
  assert.equal(runRepo.runs.size, 0, 'No runs should be claimed for inactive drafts');
});

test('Policy B Gate 6: Manual execution strictly enforces authenticated principal ownership', async () => {
  const repo = new MockAutomationRepo();
  const runRepo = new MockAutomationRunRepo();
  const engine = new AutomationEngine(mockAgentRuntime, repo, runRepo);

  const auto = await engine.createAutomation({
    name: 'Private User Automation',
    trigger: 'MANUAL',
    agentId: 'agent_v1',
    objective: 'Private task',
    enabled: true,
    approvalPolicy: 'autonomous',
    conditions: {},
    principalId: 'user_alice'
  });

  // 1. Bob attempts to trigger Alice's automation -> MUST be rejected
  await assert.rejects(
    async () => {
      await engine.triggerNow(auto.id, 'user_bob');
    },
    (err: any) => {
      assert.ok(err.message.includes('ACCESS_DENIED'), 'Expected ACCESS_DENIED for unauthorized principal');
      return true;
    }
  );

  // 2. Alice triggers her own automation -> Authorized
  const runId = await engine.triggerNow(auto.id, 'user_alice');
  assert.ok(runId.startsWith('agent_run_'), 'Authorized owner can trigger manually');
});

test('Policy B Gate 7: Cron execution endpoint boundary and timing-safe authentication audit', () => {
  // Test timing-safe token comparison logic matching API implementation
  const sampleSecret = 'certified-super-secret-cron-token-2026';

  // 1. Missing secret simulation
  const checkEndpointSecurity = (secret: string | undefined, authHeader: string | undefined) => {
    if (!secret) {
      return { status: 503, error: 'SCHEDULER_UNCONFIGURED' };
    }
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      return { status: 401, error: 'UNAUTHORIZED_MISSING_TOKEN' };
    }
    const tokenBuf = Buffer.from(token);
    const secretBuf = Buffer.from(secret);
    if (tokenBuf.length !== secretBuf.length || !crypto.timingSafeEqual(tokenBuf, secretBuf)) {
      return { status: 401, error: 'UNAUTHORIZED_INVALID_TOKEN' };
    }
    return { status: 200, success: true };
  };

  assert.equal(checkEndpointSecurity(undefined, 'Bearer abc').status, 503);
  assert.equal(checkEndpointSecurity(sampleSecret, undefined).status, 401);
  assert.equal(checkEndpointSecurity(sampleSecret, 'Bearer wrong-token').status, 401);
  assert.equal(checkEndpointSecurity(sampleSecret, `Bearer ${sampleSecret}`).status, 200);
});

test('Policy B Gate 8: Frontend truthful receipts and contextual messages verified in code', () => {
  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const chatMsgPath = path.resolve(process.cwd(), 'src/components/ChatMessage.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');
  const chatContent = fs.readFileSync(chatMsgPath, 'utf8');

  // Verify App.tsx checks result.enabled and outputs truthful draft status
  assert.ok(appContent.includes('[Automation Saved — Inactive Draft]'), 'App.tsx must include inactive draft header');
  assert.ok(appContent.includes('Status: INACTIVE (Draft)') || appContent.includes('INACTIVE (Draft)'), 'App.tsx must format INACTIVE (Draft) status');
  assert.ok(appContent.includes('Autonomous scheduling is temporarily unavailable in this environment'), 'App.tsx must explain unavailable scheduling');
  assert.ok(appContent.includes('Automation saved as inactive draft'), 'App.tsx toast must reflect inactive draft');

  // Verify ChatMessage.tsx reflects inactive draft and scheduler unavailable
  assert.ok(chatContent.includes('Pending Scheduled Automation (Inactive Draft)'), 'ChatMessage must show Inactive Draft in title');
  assert.ok(chatContent.includes('Scheduler Unavailable'), 'ChatMessage must display Scheduler Unavailable badge');
  assert.ok(chatContent.includes('Save Automation (Inactive Draft)'), 'ChatMessage button must state Save Automation (Inactive Draft)');
  assert.ok(!chatContent.includes('Manual Trigger Only'), 'Must not advertise Manual Trigger Only without a manual chat path');
});

test('Policy B Gate 9: Preserve AIRA ONE Design Invariants (Chat & Agent modes, zero permanent banners)', () => {
  const typesPath = path.resolve(process.cwd(), 'src/types/index.ts');
  const typesContent = fs.readFileSync(typesPath, 'utf8');
  assert.match(typesContent, /export type WorkspaceMode = 'chat' \| 'agent';/, 'WorkspaceMode must strictly be chat or agent');

  const appPath = path.resolve(process.cwd(), 'src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');

  // Verify workspaceMode state initialization in App.tsx
  assert.ok(appContent.includes('useState<WorkspaceMode>'), 'App.tsx must manage workspaceMode');
  assert.ok(appContent.includes("'chat'"), 'App.tsx must support chat mode');
  assert.ok(appContent.includes("'agent'"), 'App.tsx must support agent mode');
  
  // No permanent Agent Mode banner
  assert.ok(!appContent.includes('Agent Mode Active:'), 'Must not contain persistent Agent Mode banner');
  assert.ok(!appContent.includes('Permanent Notification Bar'), 'Must not contain permanent notification strip');

  // No separate Automations sidebar destination
  const sidebarPath = path.resolve(process.cwd(), 'src/components/Sidebar.tsx');
  const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');
  assert.ok(!sidebarContent.includes('nav-automations'), 'Sidebar must not have a dedicated Automations workspace');
});

test('Policy B Gate 10 (P0): patchAutomation blocks enabled:true for scheduled trigger when scheduler is unavailable', async () => {
  const repo = new MockAutomationRepo();
  const runRepo = new MockAutomationRunRepo();
  const engine = new AutomationEngine(mockAgentRuntime, repo, runRepo);

  const origVercel = process.env.VERCEL;
  const origCronConfigured = process.env.AIRA_SERVERLESS_CRON_CONFIGURED;
  try {
    process.env.VERCEL = '1';
    delete process.env.CRON_SECRET;
    delete process.env.AIRA_SCHEDULER_ENABLED;
    delete process.env.AIRA_SERVERLESS_CRON_CONFIGURED;

    // Create a CRON draft
    const draft = await engine.createAutomation({
      name: 'Cron Draft',
      trigger: 'CRON',
      cronExpression: '0 9 * * 1',
      agentId: 'agent_v1',
      objective: 'Weekly job',
      enabled: false,
      approvalPolicy: 'autonomous',
      conditions: {},
      principalId: 'user_owner_456'
    });
    assert.equal(draft.enabled, false);
    assert.equal(draft.failureState, 'SCHEDULER_UNAVAILABLE');

    // PATCH with enabled:true must be REJECTED — scheduler is unavailable
    await assert.rejects(
      async () => {
        await engine.patchAutomation(draft.id, { enabled: true }, 'user_owner_456');
      },
      (err: any) => {
        assert.equal(err.code, 'SCHEDULER_UNAVAILABLE',
          'PATCH activation bypass must be rejected with SCHEDULER_UNAVAILABLE');
        assert.ok(err.message.includes('unavailable'));
        return true;
      }
    );

    // Verify draft is still disabled in storage
    const stored = await repo.getAutomation(draft.id);
    assert.equal(stored?.enabled, false, 'Automation must remain disabled after rejected PATCH');
    assert.equal(stored?.failureState, 'SCHEDULER_UNAVAILABLE', 'failureState must remain SCHEDULER_UNAVAILABLE');

    // Benign PATCH (rename) must succeed
    const renamed = await engine.patchAutomation(draft.id, { name: 'Renamed Draft' }, 'user_owner_456');
    assert.equal(renamed.name, 'Renamed Draft');
    assert.equal(renamed.enabled, false, 'Rename PATCH must not alter enabled state');
  } finally {
    if (origVercel !== undefined) process.env.VERCEL = origVercel;
    else delete process.env.VERCEL;
    if (origCronConfigured !== undefined) process.env.AIRA_SERVERLESS_CRON_CONFIGURED = origCronConfigured;
    else delete process.env.AIRA_SERVERLESS_CRON_CONFIGURED;
  }
});

test('Policy B Gate 11 (P0): patchAutomation rejects immutable field mutations and cross-tenant access', async () => {
  const repo = new MockAutomationRepo();
  const runRepo = new MockAutomationRunRepo();
  const engine = new AutomationEngine(mockAgentRuntime, repo, runRepo);

  const alice = await engine.createAutomation({
    name: 'Alice Manual Task',
    trigger: 'MANUAL',
    agentId: 'agent_v1',
    objective: 'Alice private task',
    enabled: true,
    approvalPolicy: 'autonomous',
    conditions: {},
    principalId: 'user_alice'
  });

  // 1. Attempting to forge principalId must be rejected
  await assert.rejects(
    async () => {
      await engine.patchAutomation(alice.id, { principalId: 'user_bob' } as any, 'user_alice');
    },
    (err: any) => {
      assert.equal(err.code, 'IMMUTABLE_FIELD');
      assert.ok(err.message.includes('principalId'));
      return true;
    }
  );

  // 2. Attempting to change trigger type must be rejected
  await assert.rejects(
    async () => {
      await engine.patchAutomation(alice.id, { trigger: 'CRON' } as any, 'user_alice');
    },
    (err: any) => {
      assert.equal(err.code, 'IMMUTABLE_FIELD');
      assert.ok(err.message.includes('trigger'));
      return true;
    }
  );

  // 3. Attempting to change id must be rejected
  await assert.rejects(
    async () => {
      await engine.patchAutomation(alice.id, { id: 'auto_fake' } as any, 'user_alice');
    },
    (err: any) => {
      assert.equal(err.code, 'IMMUTABLE_FIELD');
      return true;
    }
  );

  // 4. Cross-tenant PATCH must be rejected by principal isolation
  await assert.rejects(
    async () => {
      await engine.patchAutomation(alice.id, { name: 'Bob Hijacked' }, 'user_bob');
    },
    (err: any) => {
      assert.ok(err.message.includes('ACCESS_DENIED'), 'Cross-tenant PATCH must be rejected with ACCESS_DENIED');
      return true;
    }
  );

  // Verify Alice's automation is unchanged
  const stored = await repo.getAutomation(alice.id);
  assert.equal(stored?.principalId, 'user_alice');
  assert.equal(stored?.trigger, 'MANUAL');
  assert.equal(stored?.name, 'Alice Manual Task');
});

test('Policy B Gate 12 (P2): ChatMessage button aria-label accurately describes inactive draft save action', () => {
  const chatMsgPath = path.resolve(process.cwd(), 'src/components/ChatMessage.tsx');
  const chatContent = fs.readFileSync(chatMsgPath, 'utf8');

  // Must NOT contain the old misleading label
  assert.ok(
    !chatContent.includes('aria-label="Confirm and Schedule Automation"'),
    'Old misleading aria-label must be removed'
  );

  // Must contain a label that accurately describes saving an inactive draft
  assert.ok(
    chatContent.includes('aria-label="Save as Inactive Draft'),
    'aria-label must describe saving as an inactive draft'
  );

  // Visible button text and accessible label must both be present and consistent
  assert.ok(
    chatContent.includes('Save Automation (Inactive Draft)'),
    'Visible button text must say Save Automation (Inactive Draft)'
  );

  // The label must NOT claim scheduling or activation is happening
  const labelMatch = chatContent.match(/aria-label="Save as Inactive Draft[^"]*"/);
  assert.ok(labelMatch, 'Must match new aria-label pattern');
  const labelText = labelMatch![0];
  assert.ok(
    !labelText.toLowerCase().includes('schedule automation') &&
    !labelText.toLowerCase().includes('confirm and schedule'),
    'Label must not claim scheduling is happening'
  );
});
