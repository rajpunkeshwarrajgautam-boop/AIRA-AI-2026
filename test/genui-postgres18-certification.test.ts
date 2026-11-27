import './setup-disposable-db.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../packages/db/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import {
  PostgresApprovalRepository,
  PostgresSessionGrantRepository,
} from '../packages/approvals/src/repositories.js';
import { PostgresToolCallRepository, ToolGateway } from '../packages/tool-runtime/src/index.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import {
  PostgresRunRepository,
} from '../packages/agent-runtime/src/repositories.js';
import { PostgresWorkflowRepository } from '../packages/agent-runtime/src/workflow-repositories.js';
import { WorkflowEngine } from '../packages/agent-runtime/src/workflow-engine.js';
import { PostgresWorkspaceAuthorityRepository } from '../packages/agent-runtime/src/workspace-authority.js';
import { ModelRouter, ProviderHealthTracker } from '../packages/model-router/src/index.js';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { BrainV2KnowledgeEngine, InMemoryKnowledgeRepository } from '../packages/knowledge/src/index.js';
import { RunSchema, type ExecutionPrincipal, type Run, type WorkflowDefinition } from '../packages/contracts/src/index.js';

describe('PostgreSQL 18 Certification: Tool Gateway, Authorization, Workflows & Cancellation', () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const ownerPrincipalId = `usr_pg18_owner_${suffix}`;
  const foreignPrincipalId = `usr_pg18_foreign_${suffix}`;

  after(async () => {
    try {
      await db('approval_resumption_outbox').where('run_id', 'like', `run_pg18_%_${suffix}`).del();
      await db('approvals').where('run_id', 'like', `run_pg18_%_${suffix}`).del();
      await db('tool_calls').where('run_id', 'like', `run_pg18_%_${suffix}`).del();
      await db('workflow_steps').where('workflow_run_id', 'like', `wfrun_run_pg18_%_${suffix}`).del();
      await db('workflow_runs').where('run_id', 'like', `run_pg18_%_${suffix}`).del();
      await db('workflow_definitions').where('id', 'like', `wf_pg18_%_${suffix}`).del();
      await db('session_grants').where('principal_id', ownerPrincipalId).del();
      await db('runs').where('id', 'like', `run_pg18_%_${suffix}`).del();
      await db('principal_workspace_authorities')
        .whereIn('principal_id', [ownerPrincipalId, foreignPrincipalId])
        .del();
    } catch {
      // Best-effort cleanup of test records
    } finally {
      await db.destroy();
    }
  });

  it('GATE 1: verifies disposable PostgreSQL 18.x target on aira_test_db (non-production)', async () => {
    const dbUrl = process.env.DATABASE_URL || '';
    assert.ok(dbUrl.includes('127.0.0.1:5432/aira_test_db'), 'Must target disposable local aira_test_db');
    assert.equal(dbUrl.includes('neon.tech'), false, 'Must NEVER target Neon');

    const res = await db.raw(
      "SELECT current_database() AS db_name, current_setting('server_version_num')::int / 10000 AS major_ver"
    );
    const row = res.rows[0];
    assert.equal(row.db_name, 'aira_test_db');
    assert.equal(Number(row.major_ver), 18, 'Target must be PostgreSQL 18.x');
  });

  it('GATE 2: enforces ToolGateway + PostgresApprovalRepository fail-closed authorization & workspace isolation on PG 18', async () => {
    const workspaceRepo = new PostgresWorkspaceAuthorityRepository();
    const ownerWorkspaceId = await workspaceRepo.resolveWorkspace(ownerPrincipalId);
    const foreignWorkspaceId = await workspaceRepo.resolveWorkspace(foreignPrincipalId);

    const ownerPrincipal: ExecutionPrincipal = {
      userId: ownerPrincipalId,
      sessionId: `sess_pg18_${suffix}`,
      workspaceId: ownerWorkspaceId,
      roles: ['member'],
    };

    const runRepo = new PostgresRunRepository();
    const toolRepo = new PostgresToolCallRepository();
    const approvalRepo = new PostgresApprovalRepository();
    const grantRepo = new PostgresSessionGrantRepository();
    const approvalKernel = new ApprovalKernel(approvalRepo, grantRepo);

    const runId = `run_pg18_gw_${suffix}`;
    const parentRun: Run = RunSchema.parse({
      id: runId,
      principalId: ownerPrincipalId,
      sessionId: ownerPrincipal.sessionId,
      workspaceId: ownerWorkspaceId,
      intent: 'TOOL_ACTION',
      state: 'RUNNING',
      modelPolicy: { model: 'mock-deterministic' },
      prompt: 'Execute PG 18 gateway certification',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await runRepo.saveRun(parentRun);

    const gateway = new ToolGateway(toolRepo, approvalKernel, process.cwd(), workspaceRepo);
    let writeDispatchCount = 0;

    gateway.registerTool({
      definition: {
        id: 'tool_pg18_read',
        name: 'pg18_read_tool',
        description: 'PG 18 read certification tool',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        source: 'native',
        permissionLevel: 'READ',
        sideEffectLevel: 'READ',
        approvalPolicy: 'autonomous',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'native',
        provider: 'pg18-cert',
      },
      execute: async (args) => ({ echoed: args.q || 'ok' }),
    });

    gateway.registerTool({
      definition: {
        id: 'tool_pg18_write',
        name: 'pg18_write_tool',
        description: 'PG 18 write certification tool requiring approval',
        parameters: { type: 'object', properties: { target: { type: 'string' } } },
        source: 'native',
        permissionLevel: 'WRITE',
        sideEffectLevel: 'WRITE',
        approvalPolicy: 'require_approval',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'native',
        provider: 'pg18-cert',
      },
      execute: async (args) => {
        writeDispatchCount += 1;
        return { written: args.target };
      },
    });

    // 1. Fail-closed deny when effectiveToolScopes is empty
    const deniedEmptyScope = await gateway.executeTool(
      'pg18_read_tool',
      { q: 'blocked' },
      { runId, principal: ownerPrincipal, effectiveToolScopes: [] }
    );
    assert.equal(deniedEmptyScope.isError, true, 'Empty effectiveToolScopes must deny fail-closed');

    // 2. Forged/wrong workspace authority must deny fail-closed
    const deniedWrongWorkspace = await gateway.executeTool(
      'pg18_read_tool',
      { q: 'blocked' },
      {
        runId,
        principal: { ...ownerPrincipal, workspaceId: foreignWorkspaceId },
        effectiveToolScopes: ['pg18_read_tool'],
      }
    );
    assert.equal(deniedWrongWorkspace.isError, true, 'Mismatched principal workspace must be denied');

    // 3. Valid READ tool execution persists to PostgreSQL 18 tool_calls
    const readRes = await gateway.executeTool(
      'pg18_read_tool',
      { q: 'pg18-ok' },
      { runId, principal: ownerPrincipal, effectiveToolScopes: ['pg18_read_tool'] },
      `call_pg18_read_${suffix}`
    );
    assert.equal(readRes.isError, false);
    assert.deepEqual(readRes.output, { echoed: 'pg18-ok' });

    const persistedRead = await toolRepo.getToolCall(`call_pg18_read_${suffix}`);
    assert.equal(persistedRead?.lifecycleState, 'COMPLETED');
    assert.equal(persistedRead?.principalId, ownerPrincipalId);

    // 4. WRITE tool halts with WAITING_FOR_APPROVAL in PG 18 before dispatching
    const callId = `call_pg18_write_${suffix}`;
    const writeBlocked = await gateway.executeTool(
      'pg18_write_tool',
      { target: 'config.json' },
      { runId, principal: ownerPrincipal, effectiveToolScopes: ['pg18_write_tool'] },
      callId
    );
    assert.equal(writeBlocked.isError, false);
    assert.equal((writeBlocked.output as any)?.approvalRequired, true);
    assert.equal(writeDispatchCount, 0, 'Write adapter must NOT dispatch before approval');

    const requestId = (writeBlocked.output as any).requestId;
    assert.ok(requestId);

    // Sync parent run state + authoritative pendingApproval (as AgentRuntime does before surfacing approval)
    const pendingReq = await approvalKernel.getPendingRequest(requestId);
    assert.ok(pendingReq);
    await runRepo.saveRun({
      ...parentRun,
      state: 'WAITING_FOR_APPROVAL',
      pendingApproval: pendingReq,
      updatedAt: Date.now(),
    });

    // 5. Foreign principal cannot resolve owner's approval request in PG 18
    await assert.rejects(
      () => approvalKernel.decide(requestId, 'ALLOW_ONCE', foreignPrincipalId),
      /denied|unauthorized|owner|authority|principal|mismatch/i
    );

    // 6. Owner approves once -> outbox claim & apply -> write executes -> replay fails closed (once-consumption)
    const approved = await approvalKernel.decide(requestId, 'ALLOW_ONCE', ownerPrincipalId);
    assert.equal(approved.approved, true);

    const workerId = `worker_pg18_${suffix}`;
    const resumptionEvent = await approvalRepo.claimApprovalResumption(workerId, 30_000, requestId);
    assert.ok(resumptionEvent, 'PG 18 approval_resumption_outbox must enqueue durable event');
    const applied = await approvalRepo.applyApprovalResumption(resumptionEvent, workerId);
    assert.equal(applied, true, 'Outbox apply must transition run to RUNNING for one-time dispatch');

    const writeAllowed = await gateway.executeTool(
      'pg18_write_tool',
      { target: 'config.json' },
      {
        runId,
        principal: ownerPrincipal,
        effectiveToolScopes: ['pg18_write_tool'],
        approvalRequestId: requestId,
        approvalDecision: 'ALLOW_ONCE',
      },
      callId
    );
    assert.equal(writeAllowed.isError, false);
    assert.equal(writeDispatchCount, 1);

    const replayBlocked = await gateway.executeTool(
      'pg18_write_tool',
      { target: 'config.json' },
      {
        runId,
        principal: ownerPrincipal,
        effectiveToolScopes: ['pg18_write_tool'],
        approvalRequestId: requestId,
        approvalDecision: 'ALLOW_ONCE',
      },
      callId
    );
    assert.equal(writeDispatchCount, 1, 'One-time approval must NOT permit second dispatch');
    assert.equal((replayBlocked.output as any)?.approvalRequired || replayBlocked.isError, true);
  });

  it('GATE 3: certifies PostgresWorkflowRepository, WorkflowEngine approval pause, and AgentRuntime cancellation on PG 18', async () => {
    const workspaceRepo = new PostgresWorkspaceAuthorityRepository();
    const ownerWorkspaceId = await workspaceRepo.resolveWorkspace(ownerPrincipalId);
    const ownerPrincipal: ExecutionPrincipal = {
      userId: ownerPrincipalId,
      sessionId: `sess_pg18_wf_${suffix}`,
      workspaceId: ownerWorkspaceId,
      roles: ['member'],
    };

    const runRepo = new PostgresRunRepository();
    const workflowRepo = new PostgresWorkflowRepository();
    const approvalKernel = new ApprovalKernel(
      new PostgresApprovalRepository(),
      new PostgresSessionGrantRepository()
    );
    const toolRegistry = new ToolRegistry(process.cwd());
    let workflowToolExecutions = 0;
    toolRegistry.register({
      definition: {
        id: 'tool_wf_pg18_step',
        name: 'wf_pg18_protected_step',
        description: 'Workflow protected action for PG 18 certification',
        parameters: { type: 'object', properties: {} },
        source: 'native',
        permissionLevel: 'WRITE',
        sideEffectLevel: 'WRITE',
        approvalPolicy: 'require_approval',
        executionRuntime: 'LOCAL',
        availability: 'READY',
        adapter: 'native',
        provider: 'pg18-cert',
      },
      execute: async () => {
        workflowToolExecutions += 1;
        return {
          toolCallId: `wf_tc_${suffix}`,
          output: { done: true },
          isError: false,
          durationMs: 1,
          timestamp: Date.now(),
          artifacts: [],
        };
      },
    });

    const modelRouter = new ModelRouter(new ProviderHealthTracker());
    const wfEngine = new WorkflowEngine(workflowRepo, runRepo, approvalKernel, toolRegistry, modelRouter);

    const wfRunParentId = `run_pg18_wf_${suffix}`;
    const run = RunSchema.parse({
      id: wfRunParentId,
      principalId: ownerPrincipalId,
      sessionId: ownerPrincipal.sessionId,
      workspaceId: ownerWorkspaceId,
      intent: 'WORKFLOW',
      state: 'RUNNING',
      modelPolicy: { model: 'mock-deterministic' },
      prompt: 'Run PG 18 workflow certification',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await runRepo.saveRun(run);

    const def: WorkflowDefinition = {
      workflowId: `wf_pg18_${suffix}`,
      version: 1,
      name: 'PG 18 Workflow Approval Test',
      principalId: ownerPrincipalId,
      inputSchema: {},
      steps: [
        {
          stepId: `step_protected_${suffix}`,
          name: 'Protected step',
          type: 'TOOL',
          toolName: 'wf_pg18_protected_step',
          capability: 'TOOL_ACTION',
          dependsOn: [],
          input: {},
          sideEffectLevel: 'WRITE',
          approvalRequired: true,
          timeoutMs: 2000,
          retry: { maxAttempts: 1, backoffMs: 1, factor: 1 },
        },
      ],
      executionPolicy: { maxConcurrentSteps: 1, timeoutMs: 5000 },
      outputSchema: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const wfRun = await wfEngine.createWorkflowRun(def, run, ownerPrincipal);
    await wfEngine.executeWorkflowRun(wfRun.id);

    const paused = await workflowRepo.getWorkflowRun(wfRun.id);
    assert.equal(paused?.state, 'WAITING_FOR_APPROVAL');
    assert.equal(workflowToolExecutions, 0);

    // Test run + workflow cancellation persistence directly on PostgreSQL 18
    const runtime = new AgentRuntime(
      modelRouter,
      toolRegistry,
      approvalKernel,
      new BrainV2KnowledgeEngine(new InMemoryKnowledgeRepository(), { seedDefaults: false }),
      runRepo,
      process.cwd(),
      undefined,
      undefined,
      workflowRepo,
      wfEngine
    );

    const cancelled = await runtime.cancelRun(wfRunParentId);
    assert.equal(cancelled, true);

    const persistedRun = await runRepo.getRun(wfRunParentId);
    assert.equal(persistedRun?.state, 'CANCELLED');
    const persistedWf = await workflowRepo.getWorkflowRun(wfRun.id);
    assert.equal(persistedWf?.state, 'CANCELLED');
  });
});
