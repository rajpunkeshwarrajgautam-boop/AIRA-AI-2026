import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import crypto from 'crypto';
import {
  signTicket,
  type WorkspaceTicketDraft
} from '../packages/builder-runtime/src/security.js';
import { BuilderService } from '../packages/builder-runtime/src/index.js';
import { createBuilderRoutes } from '../apps/api/src/builder-routes.js';
import { InMemoryWorkflowRepository } from '../packages/agent-runtime/src/workflow-repositories.js';
import type { ExecutionPrincipal } from '../packages/contracts/src/index.js';

describe('Remediation F8 (Part 1): Real HTTP Multi-Tenant & Artifact Isolation', () => {
  let server: Server;
  let baseUrl: string;
  let activePrincipal: ExecutionPrincipal;
  const wfRepo = new InMemoryWorkflowRepository();

  const principalA: ExecutionPrincipal = {
    userId: 'usr_alpha_99',
    sessionId: 'sess_alpha_1',
    workspaceId: 'ws_alpha_corp',
    roles: ['member']
  };

  const principalB: ExecutionPrincipal = {
    userId: 'usr_beta_42',
    sessionId: 'sess_beta_2',
    workspaceId: 'ws_beta_corp',
    roles: ['member']
  };

  before(async () => {
    process.env.AIRA_BUILDER_SIGNING_SECRET = '1234567890123456789012345678901234567890';
    const app = express();
    app.use(express.json());

    // Switch principal based on header for testing distinct HTTP clients
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const headerPrincipal = req.headers['x-test-principal'];
      if (headerPrincipal === 'beta') {
        req.principal = principalB;
      } else {
        req.principal = principalA;
      }
      next();
    });

    // Mock builder service with isolated in-memory files
    const mockRouter: any = {
      resolveExecution: () => ({
        provider: 'openai',
        policy: { model: 'gpt-4o' }
      })
    };

    const fileContent = 'sensitive_alpha_source_code';
    const fileSha = crypto.createHash('sha256').update(fileContent).digest('hex');

    const mockSandbox: any = {
      id: 'ws_alpha_corp',
      provider: 'docker',
      killed: false,
      kill: async () => { mockSandbox.killed = true; },
      read: async () => Buffer.from(fileContent),
      readFile: async () => fileContent
    };

    const mockFactory: any = {
      connect: async () => mockSandbox,
      create: async () => mockSandbox
    };

    const builderService = new BuilderService(mockRouter, mockFactory);
    app.use('/api/builder', createBuilderRoutes(mockRouter, builderService));

    // Workflow HTTP isolation endpoints
    app.get('/api/workflows/runs', async (req: Request, res: Response) => {
      const runs = await wfRepo.listWorkflowRuns(req.principal!.userId);
      res.json(runs);
    });

    app.get('/api/workflows/runs/:id', async (req: Request, res: Response) => {
      const wfRun = await wfRepo.getWorkflowRun(req.params.id);
      if (!wfRun || wfRun.principalId !== req.principal!.userId) {
        return res.status(404).json({ error: `Workflow run "${req.params.id}" not found.` });
      }
      res.json(wfRun);
    });

    app.get('/api/workflows/runs/:id/artifacts', async (req: Request, res: Response) => {
      const wfRun = await wfRepo.getWorkflowRun(req.params.id);
      if (!wfRun || wfRun.principalId !== req.principal!.userId) {
        return res.status(404).json({ error: `Workflow run "${req.params.id}" not found.` });
      }
      const steps = await wfRepo.getWorkflowSteps(wfRun.id);
      const artifacts = steps.flatMap((s: any) => s.output?.artifacts || []);
      res.json({ workflowRunId: wfRun.id, artifacts });
    });

    app.post('/api/workflows/runs/:id/cancel', async (req: Request, res: Response) => {
      const wfRun = await wfRepo.getWorkflowRun(req.params.id);
      if (!wfRun || wfRun.principalId !== req.principal!.userId) {
        return res.status(404).json({ error: `Workflow run "${req.params.id}" not found.` });
      }
      res.json({ status: 'CANCELLED', workflowRunId: wfRun.id });
    });

    // Start real HTTP listener on port 0
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
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
  });

  it('denies foreign principal from downloading an artifact file over HTTP (403)', async () => {
    // Principal A generates a signed file ticket
    const fileContent = 'sensitive_alpha_source_code';
    const fileSha = crypto.createHash('sha256').update(fileContent).digest('hex');

    const fileTicketDraft: WorkspaceTicketDraft = {
      purpose: 'file',
      workspaceId: principalA.workspaceId,
      principalId: principalA.userId,
      userId: principalA.userId,
      sessionId: principalA.sessionId,
      expiresAt: Date.now() + 600000,
      path: 'internal/secrets.env',
      sha256: fileSha
    };
    const ticketA = signTicket(fileTicketDraft);

    // Principal B attempts to download Principal A's file via HTTP GET
    const responseB = await fetch(`${baseUrl}/api/builder/download?ticket=${encodeURIComponent(ticketA)}`, {
      headers: { 'x-test-principal': 'beta' }
    });

    assert.equal(responseB.status, 403, 'Foreign principal must receive HTTP 403');
    const dataB = await responseB.json();
    assert.match(dataB.error, /Workspace access denied/i);

    // Principal A can download their own file
    const responseA = await fetch(`${baseUrl}/api/builder/download?ticket=${encodeURIComponent(ticketA)}`, {
      headers: { 'x-test-principal': 'alpha' }
    });
    assert.equal(responseA.status, 200, 'Owner principal must be able to download artifact');
  });

  it('denies foreign principal from cancelling an active workspace execution (403)', async () => {
    const wsTicketDraft: WorkspaceTicketDraft = {
      purpose: 'workspace',
      workspaceId: principalA.workspaceId,
      principalId: principalA.userId,
      userId: principalA.userId,
      sessionId: principalA.sessionId,
      expiresAt: Date.now() + 600000
    };
    const ticketA = signTicket(wsTicketDraft);

    // Principal B attempts to cancel Principal A's workspace
    const resB = await fetch(`${baseUrl}/api/builder/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-principal': 'beta'
      },
      body: JSON.stringify({ ticket: ticketA })
    });

    assert.equal(resB.status, 403);
    const dataB = await resB.json();
    assert.match(dataB.error, /Workspace access denied/i);
  });

  it('denies foreign principal from accessing workflow run over HTTP (404)', async () => {
    const runIdA = 'wf_run_alpha_secure_001';
    await wfRepo.saveWorkflowRun({
      id: runIdA,
      workflowId: 'wf_def_1',
      runId: 'run_alpha_1',
      principalId: principalA.userId,
      state: 'RUNNING',
      currentStepIndex: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    // Principal B attempts to read Principal A's workflow run
    const resB = await fetch(`${baseUrl}/api/workflows/runs/${runIdA}`, {
      headers: { 'x-test-principal': 'beta' }
    });
    assert.equal(resB.status, 404, 'Must return 404 without leaking existence to foreign principal');

    // Principal A can access their own run
    const resA = await fetch(`${baseUrl}/api/workflows/runs/${runIdA}`, {
      headers: { 'x-test-principal': 'alpha' }
    });
    assert.equal(resA.status, 200);
    const dataA = await resA.json();
    assert.equal(dataA.id, runIdA);
  });

  it('denies foreign principal from reading workflow artifacts over HTTP (404)', async () => {
    const runIdA = 'wf_run_alpha_artifacts_002';
    await wfRepo.saveWorkflowRun({
      id: runIdA,
      workflowId: 'wf_def_1',
      runId: 'run_alpha_2',
      principalId: principalA.userId,
      state: 'COMPLETED',
      currentStepIndex: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await wfRepo.saveWorkflowStep({
      id: 'step_1',
      workflowRunId: runIdA,
      name: 'generate_artifact',
      agentId: 'agent_coder',
      stepIndex: 0,
      status: 'COMPLETED',
      output: {
        artifacts: [{ path: 'dist/bundle.js', content: 'secure_code' }]
      },
      createdAt: Date.now(),
      completedAt: Date.now()
    });

    const resB = await fetch(`${baseUrl}/api/workflows/runs/${runIdA}/artifacts`, {
      headers: { 'x-test-principal': 'beta' }
    });
    assert.equal(resB.status, 404);

    const resA = await fetch(`${baseUrl}/api/workflows/runs/${runIdA}/artifacts`, {
      headers: { 'x-test-principal': 'alpha' }
    });
    assert.equal(resA.status, 200);
    const dataA = await resA.json();
    assert.equal(dataA.artifacts.length, 1);
  });

  it('denies foreign principal from cancelling a foreign workflow run (404)', async () => {
    const runIdA = 'wf_run_alpha_cancel_003';
    await wfRepo.saveWorkflowRun({
      id: runIdA,
      workflowId: 'wf_def_1',
      runId: 'run_alpha_3',
      principalId: principalA.userId,
      state: 'RUNNING',
      currentStepIndex: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const resB = await fetch(`${baseUrl}/api/workflows/runs/${runIdA}/cancel`, {
      method: 'POST',
      headers: { 'x-test-principal': 'beta' }
    });
    assert.equal(resB.status, 404);
  });

  it('filters workflow run listing strictly to authenticated caller', async () => {
    const listResB = await fetch(`${baseUrl}/api/workflows/runs`, {
      headers: { 'x-test-principal': 'beta' }
    });
    assert.equal(listResB.status, 200);
    const runsB = await listResB.json();
    assert.equal(runsB.length, 0, 'Principal B must not see any of Principal A runs');

    const listResA = await fetch(`${baseUrl}/api/workflows/runs`, {
      headers: { 'x-test-principal': 'alpha' }
    });
    assert.equal(listResA.status, 200);
    const runsA = await listResA.json();
    assert.ok(runsA.length >= 3, 'Principal A must see all their own runs');
  });
});
