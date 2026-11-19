import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import crypto from 'crypto';

process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.AIRA_BUILDER_SIGNING_SECRET = '1234567890123456789012345678901234567890';

const { default: app, agentRuntime, setAgentRepository, getAgentRepository } = await import('../apps/api/src/index.js');
const { InMemoryAgentRepository } = await import('../packages/agent-runtime/src/repositories.js');
const { db } = await import('../packages/db/src/index.js');
const { signTicket } = await import('../packages/builder-runtime/src/security.js');
type WorkspaceTicketDraft = import('../packages/builder-runtime/src/security.js').WorkspaceTicketDraft;

describe('Remediation F8 (Part 1): Real HTTP Multi-Tenant & Artifact Isolation (Actual Routes)', () => {
  let server: Server;
  let baseUrl: string;

  const userA = {
    userId: 'usr_alpha_99',
    sessionId: 'sess_alpha_1',
    workspaceId: 'ws_alpha_corp'
  };

  const userB = {
    userId: 'usr_beta_42',
    sessionId: 'sess_beta_2',
    workspaceId: 'ws_beta_corp'
  };

  const headersA = {
    'x-test-user-id': userA.userId,
    'x-test-session-id': userA.sessionId,
    'x-test-tier': 'plus',
    'Content-Type': 'application/json'
  };

  const headersB = {
    'x-test-user-id': userB.userId,
    'x-test-session-id': userB.sessionId,
    'x-test-tier': 'plus',
    'Content-Type': 'application/json'
  };

  before(async () => {
    process.env.AIRA_BUILDER_SIGNING_SECRET = '1234567890123456789012345678901234567890';

    let hasPostgres = false;
    try {
      await db.raw('SELECT 1');
      hasPostgres = true;
    } catch {
      hasPostgres = false;
    }

    if (!hasPostgres) {
      setAgentRepository(new InMemoryAgentRepository());
    }

    // Mount actual production Express application on ephemeral local port
    await new Promise<void>((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await db.destroy().catch(() => {});
  });

  // =========================================================================
  // 1. Workflow Runs Multi-Tenant HTTP Isolation
  // =========================================================================
  it('denies foreign principal from accessing workflow run over HTTP (404)', async () => {
    const wfRepo = agentRuntime.getWorkflowRepository();
    const runIdA = `wfr_alpha_${crypto.randomUUID().slice(0, 8)}`;

    await wfRepo.saveWorkflowRun({
      id: runIdA,
      workflowId: 'wf_def_alpha_1',
      runId: `run_${crypto.randomUUID().slice(0, 8)}`,
      principalId: userA.userId,
      state: 'RUNNING',
      currentStepIndex: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    // Foreign user (User B) attempts to read User A's workflow run via actual route
    const resB = await fetch(`${baseUrl}/api/workflows/runs/${runIdA}`, {
      headers: headersB
    });
    assert.equal(resB.status, 404, 'Foreign principal must receive 404 without leaking existence of workflow run');

    // Owner (User A) reads their own workflow run successfully via actual route
    const resA = await fetch(`${baseUrl}/api/workflows/runs/${runIdA}`, {
      headers: headersA
    });
    assert.equal(resA.status, 200, 'Owner principal must be able to read their own workflow run');
    const dataA = await resA.json();
    assert.equal(dataA.id, runIdA);
  });

  it('denies foreign principal from accessing workflow artifacts over HTTP (404)', async () => {
    const wfRepo = agentRuntime.getWorkflowRepository();
    const runIdA = `wfr_artifacts_${crypto.randomUUID().slice(0, 8)}`;

    await wfRepo.saveWorkflowRun({
      id: runIdA,
      workflowId: 'wf_def_alpha_1',
      runId: `run_${crypto.randomUUID().slice(0, 8)}`,
      principalId: userA.userId,
      state: 'COMPLETED',
      currentStepIndex: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await wfRepo.saveWorkflowStep({
      id: `step_${crypto.randomUUID().slice(0, 8)}`,
      workflowRunId: runIdA,
      name: 'generate_artifact',
      agentId: 'agent_coder',
      stepIndex: 0,
      status: 'COMPLETED',
      output: {
        artifacts: [{ path: 'dist/secret.json', content: 'CONFIDENTIAL_ALPHA_DATA' }]
      },
      createdAt: Date.now(),
      completedAt: Date.now()
    });

    // Foreign user attempts to retrieve artifacts
    const resB = await fetch(`${baseUrl}/api/workflows/runs/${runIdA}/artifacts`, {
      headers: headersB
    });
    assert.equal(resB.status, 404, 'Foreign principal must receive 404 for workflow artifacts');

    // Owner retrieves their own artifacts
    const resA = await fetch(`${baseUrl}/api/workflows/runs/${runIdA}/artifacts`, {
      headers: headersA
    });
    assert.equal(resA.status, 200);
    const dataA = await resA.json();
    assert.equal(dataA.workflowRunId, runIdA);
    assert.equal(dataA.artifacts.length, 1);
  });

  it('denies foreign principal from cancelling a foreign workflow run (404)', async () => {
    const wfRepo = agentRuntime.getWorkflowRepository();
    const runIdA = `wfr_cancel_${crypto.randomUUID().slice(0, 8)}`;

    await wfRepo.saveWorkflowRun({
      id: runIdA,
      workflowId: 'wf_def_alpha_1',
      runId: `run_${crypto.randomUUID().slice(0, 8)}`,
      principalId: userA.userId,
      state: 'RUNNING',
      currentStepIndex: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    // Foreign user attempts to cancel User A's workflow
    const resB = await fetch(`${baseUrl}/api/workflows/runs/${runIdA}/cancel`, {
      method: 'POST',
      headers: headersB
    });
    assert.equal(resB.status, 404, 'Must return 404 when foreign user attempts to cancel workflow');
  });

  it('filters workflow run listing strictly to authenticated caller', async () => {
    const listResB = await fetch(`${baseUrl}/api/workflows/runs`, {
      headers: headersB
    });
    assert.equal(listResB.status, 200);
    const runsB = await listResB.json();
    // User B should not see any run belonging to User A
    assert.ok(Array.isArray(runsB));
    assert.ok(runsB.every((r: any) => r.principalId === userB.userId));

    const listResA = await fetch(`${baseUrl}/api/workflows/runs`, {
      headers: headersA
    });
    assert.equal(listResA.status, 200);
    const runsA = await listResA.json();
    assert.ok(Array.isArray(runsA));
    assert.ok(runsA.length >= 1);
    assert.ok(runsA.every((r: any) => r.principalId === userA.userId));
  });

  // =========================================================================
  // 2. Body Ownership Spoofing Protection (POST /api/workflows/runs)
  // =========================================================================
  it('rejects POST /api/workflows/runs with forged principalId body parameter (400)', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/runs`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        prompt: 'Generate documentation',
        principalId: userB.userId // Forged principalId!
      })
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Forbidden: caller may not specify or forge principalId ownership/);
  });

  it('rejects POST /api/workflows/runs with forged userId body parameter (400)', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/runs`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        prompt: 'Generate documentation',
        userId: userB.userId // Forged userId!
      })
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Forbidden: caller may not specify or forge userId ownership/);
  });

  // =========================================================================
  // 3. Saved-Agent Cross-Account Isolation (GET /api/agents/:id)
  // =========================================================================
  it('denies foreign principal from retrieving another users saved agent (404)', async () => {
    const agentIdA = `agent_alpha_${crypto.randomUUID().slice(0, 8)}`;
    await getAgentRepository().saveAgent({
      id: agentIdA,
      name: 'Confidential Alpha Agent',
      principalId: userA.userId,
      instructions: 'You are an internal corporate assistant for Alpha.',
      modelPolicy: { model: 'mock-deterministic' },
      tools: [],
      memoryScopes: ['workspace'],
      approvalPolicy: 'autonomous',
      maxSteps: 5,
      timeoutMs: 30000
    }, userA.userId);

    // Foreign user (User B) attempts to fetch User A's agent
    const resB = await fetch(`${baseUrl}/api/agents/${agentIdA}`, {
      headers: headersB
    });
    assert.equal(resB.status, 404, 'Foreign principal must receive 404 when accessing anothers agent');

    // User B listing agents does not include User A's agent
    const listResB = await fetch(`${baseUrl}/api/agents`, {
      headers: headersB
    });
    assert.equal(listResB.status, 200);
    const agentsB = await listResB.json();
    assert.ok(Array.isArray(agentsB));
    assert.ok(!agentsB.some((a: any) => a.id === agentIdA), 'User B must not see User As agent in listing');
  });

  // =========================================================================
  // 4. Builder Sandbox Ticket Isolation (GET /api/builder/download & cancel)
  // =========================================================================
  it('denies foreign principal from downloading an artifact file with a signed ticket (403)', async () => {
    const fileContent = 'sensitive_alpha_source_code';
    const fileSha = crypto.createHash('sha256').update(fileContent).digest('hex');

    const fileTicketDraft: WorkspaceTicketDraft = {
      purpose: 'file',
      workspaceId: userA.workspaceId,
      principalId: userA.userId,
      userId: userA.userId,
      sessionId: userA.sessionId,
      expiresAt: Date.now() + 600000,
      path: 'internal/secrets.env',
      sha256: fileSha
    };
    const ticketA = signTicket(fileTicketDraft);

    // Principal B attempts to download Principal A's file via actual HTTP GET
    const responseB = await fetch(`${baseUrl}/api/builder/download?ticket=${encodeURIComponent(ticketA)}`, {
      headers: headersB
    });

    assert.equal(responseB.status, 403, 'Foreign principal must receive HTTP 403');
    const dataB = await responseB.json();
    assert.match(dataB.error, /Workspace access denied/i);
  });

  it('denies foreign principal from cancelling a workspace execution with a signed ticket (403)', async () => {
    const wsTicketDraft: WorkspaceTicketDraft = {
      purpose: 'workspace',
      workspaceId: userA.workspaceId,
      principalId: userA.userId,
      userId: userA.userId,
      sessionId: userA.sessionId,
      expiresAt: Date.now() + 600000
    };
    const ticketA = signTicket(wsTicketDraft);

    // Principal B attempts to cancel Principal A's workspace
    const resB = await fetch(`${baseUrl}/api/builder/cancel`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ ticket: ticketA })
    });

    assert.equal(resB.status, 403);
    const dataB = await resB.json();
    assert.match(dataB.error, /Workspace access denied/i);
  });
});
