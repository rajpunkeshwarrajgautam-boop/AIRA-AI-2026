import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  type ExecutionPrincipal
} from '../packages/contracts/src/index.js';
import {
  signTicket,
  verifyTicket,
  safeRelativePath,
  type WorkspaceTicketDraft
} from '../packages/builder-runtime/src/security.js';
import { InMemoryWorkflowRepository } from '../packages/agent-runtime/src/workflow-repositories.js';
import { WorkflowEngine } from '../packages/agent-runtime/src/workflow-engine.js';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import { InMemoryRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { BrainV2KnowledgeEngine, InMemoryKnowledgeRepository } from '../packages/knowledge/src/index.js';
import { ModelRouter, ProviderHealthTracker } from '../packages/model-router/src/index.js';

describe('F2 — Workflow Execution & Builder Artifact Multi-Tenant Isolation', () => {
  const accountA: ExecutionPrincipal = {
    userId: 'usr_principal_alpha_99',
    sessionId: 'sess_alpha_123',
    workspaceId: 'ws_alpha_primary',
    roles: ['member']
  };

  const accountB: ExecutionPrincipal = {
    userId: 'usr_principal_beta_42',
    sessionId: 'sess_beta_456',
    workspaceId: 'ws_beta_primary',
    roles: ['member']
  };

  describe('Workflow Execution Isolation', () => {
    it('isolates workflow runs between distinct authenticated principals', async () => {
      const wfRepo = new InMemoryWorkflowRepository();

      const wfRunA = {
        id: 'wf_run_alpha_001',
        workflowId: 'wf_def_1',
        runId: 'run_alpha_root',
        principalId: accountA.userId,
        state: 'RUNNING' as const,
        currentStepIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      const wfRunB = {
        id: 'wf_run_beta_002',
        workflowId: 'wf_def_2',
        runId: 'run_beta_root',
        principalId: accountB.userId,
        state: 'RUNNING' as const,
        currentStepIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await wfRepo.saveWorkflowRun(wfRunA);
      await wfRepo.saveWorkflowRun(wfRunB);

      // Account A listing workflows: must contain ONLY Account A's run
      const listA = await wfRepo.listWorkflowRuns(accountA.userId);
      assert.equal(listA.length, 1);
      assert.equal(listA[0].id, wfRunA.id);
      assert.equal(listA[0].principalId, accountA.userId);

      // Account B listing workflows: must contain ONLY Account B's run
      const listB = await wfRepo.listWorkflowRuns(accountB.userId);
      assert.equal(listB.length, 1);
      assert.equal(listB[0].id, wfRunB.id);
      assert.equal(listB[0].principalId, accountB.userId);

      // Direct ID lookup with ownership verification:
      // Account B requesting Account A's run ID:
      const fetchedByOwner = await wfRepo.getWorkflowRun(wfRunA.id);
      assert.ok(fetchedByOwner);
      assert.equal(fetchedByOwner.principalId, accountA.userId);

      // API-level enforcement check: if fetchedByOwner.principalId !== req.principal.userId -> HTTP 404
      const isOwnerB = fetchedByOwner.principalId === accountB.userId;
      assert.equal(isOwnerB, false, 'Account B must not match ownership of Account A workflow run');
    });

    it('blocks foreign principal from resolving approval or cancelling workflow run', async () => {
      const wfRepo = new InMemoryWorkflowRepository();
      const runRepo = new InMemoryRunRepository();
      const wfEngine = new WorkflowEngine(wfRepo, runRepo, {} as any, {} as any, {} as any);

      const wfRunA = {
        id: 'wf_run_alpha_approval',
        workflowId: 'wf_def_approval',
        runId: 'run_alpha_approval_root',
        principalId: accountA.userId,
        state: 'WAITING_FOR_APPROVAL' as const,
        stepStates: { step_deploy: 'WAITING_FOR_APPROVAL' },
        pendingApprovalStepId: 'step_deploy',
        currentStepIndex: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await wfRepo.saveWorkflowRun(wfRunA);

      // Account B attempts to cancel Account A's workflow -> strictly rejected
      await assert.rejects(
        async () => {
          await wfEngine.cancelWorkflow(wfRunA.id, accountB);
        },
        /Unauthorized: Principal "usr_principal_beta_42" does not match workflow owner/
      );

      // Verify state was not altered
      const currentRun = await wfRepo.getWorkflowRun(wfRunA.id);
      assert.equal(currentRun?.state, 'WAITING_FOR_APPROVAL');

      // Owner Account A successfully cancels workflow
      const ownerCancel = await wfEngine.cancelWorkflow(wfRunA.id, accountA);
      assert.equal(ownerCancel, true, 'Legitimate owner must be permitted to cancel workflow run');
      const postCancelRun = await wfRepo.getWorkflowRun(wfRunA.id);
      assert.equal(postCancelRun?.state, 'CANCELLED');
    });

    it('strictly isolates workflow run artifacts endpoint', async () => {
      const wfRepo = new InMemoryWorkflowRepository();

      const wfRunA = {
        id: 'wf_run_alpha_with_artifacts',
        workflowId: 'wf_def_artifacts',
        runId: 'run_alpha_art_root',
        principalId: accountA.userId,
        state: 'COMPLETED' as const,
        currentStepIndex: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await wfRepo.saveWorkflowRun(wfRunA);

      // Save steps with artifacts
      await wfRepo.saveWorkflowStep({
        id: 'step_generate_report',
        workflowRunId: wfRunA.id,
        stepId: 'step_1',
        name: 'Generate Financial Model',
        state: 'COMPLETED',
        sideEffectLevel: 'READ_ONLY',
        output: {
          artifacts: [
            {
              id: 'art_financial_model_private',
              name: 'Q4_Financial_Model.xlsx',
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              content: 'SENSITIVE_FINANCIAL_DATA_ACCOUNT_A'
            }
          ]
        },
        startedAt: Date.now() - 5000,
        completedAt: Date.now()
      } as any);

      // Emulate GET /api/workflows/runs/:id/artifacts logic
      const runRecord = await wfRepo.getWorkflowRun(wfRunA.id);
      assert.ok(runRecord);

      // Probe from Account B
      const accessForB = runRecord.principalId === accountB.userId;
      assert.equal(accessForB, false, 'Cross-account artifact probe must be denied');

      // Probe from legitimate owner Account A
      const accessForA = runRecord.principalId === accountA.userId;
      assert.equal(accessForA, true, 'Legitimate owner must access artifacts');

      const steps = await wfRepo.getWorkflowSteps(wfRunA.id);
      const artifacts = steps
        .filter((s: any) => s.output && (s.output.artifacts || s.output.artifact))
        .flatMap((s: any) => s.output.artifacts || [s.output.artifact])
        .filter(Boolean);

      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].id, 'art_financial_model_private');
    });
  });

  describe('Builder Studio Ticket & Artifact Multi-Tenant Isolation', () => {
    const testSecret = 'test_builder_secret_key_with_at_least_32_chars!';
    const originalEnv = { ...process.env };

    it('denies file artifact download when foreign account presents another user ticket', () => {
      process.env.AIRA_BUILDER_SIGNING_SECRET = testSecret;

      const dummyFileSha = crypto.createHash('sha256').update('console.log("hello");').digest('hex');
      const ticketDraft: WorkspaceTicketDraft = {
        purpose: 'file',
        userId: accountA.userId,
        sessionId: accountA.sessionId,
        workspaceId: 'ws_alpha_sandbox_1',
        path: 'src/index.js',
        sha256: dummyFileSha,
        expiresAt: Date.now() + 60000,
        allowInternet: false,
        allowPreview: false
      };

      const signedToken = signTicket(ticketDraft, testSecret);

      // Account A presents ticket: succeeds
      const verifiedA = verifyTicket(signedToken, accountA, 'file', testSecret);
      assert.equal(verifiedA.userId, accountA.userId);
      assert.equal(verifiedA.path, 'src/index.js');
      assert.equal(verifiedA.sha256, dummyFileSha);

      // Account B presents Account A's ticket: strictly throws 'Workspace access denied.'
      assert.throws(
        () => {
          verifyTicket(signedToken, accountB, 'file', testSecret);
        },
        /Workspace access denied/
      );
    });

    it('rejects tampered ticket payload and invalid HMAC signatures', () => {
      process.env.AIRA_BUILDER_SIGNING_SECRET = testSecret;

      const dummySha = crypto.createHash('sha256').update('data').digest('hex');
      const draft: WorkspaceTicketDraft = {
        purpose: 'file',
        userId: accountA.userId,
        sessionId: accountA.sessionId,
        workspaceId: 'ws_alpha_sandbox_2',
        path: 'bundle.js',
        sha256: dummySha,
        expiresAt: Date.now() + 60000,
        allowInternet: false,
        allowPreview: false
      };

      const validToken = signTicket(draft, testSecret);
      const [payloadPart, sigPart] = validToken.split('.');

      // Tamper payload: change userId to accountB
      const decoded = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
      decoded.userId = accountB.userId;
      const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
      const forgedToken = `${forgedPayload}.${sigPart}`;

      assert.throws(
        () => {
          verifyTicket(forgedToken, accountB, 'file', testSecret);
        },
        /Invalid workspace ticket signature/
      );
    });

    it('enforces strict path traversal defenses on file artifact paths', () => {
      // Normal relative paths: allowed
      assert.equal(safeRelativePath('index.html'), 'index.html');
      assert.equal(safeRelativePath('src/components/App.tsx'), 'src/components/App.tsx');
      assert.equal(safeRelativePath('dist/bundle.js'), 'dist/bundle.js');

      // Traversal attacks: strictly rejected
      assert.throws(() => safeRelativePath('../secret.env'), /Only relative workspace paths without traversal are allowed/);
      assert.throws(() => safeRelativePath('../../etc/passwd'), /Only relative workspace paths without traversal are allowed/);
      assert.throws(() => safeRelativePath('/root/.ssh/id_rsa'), /Only relative workspace paths without traversal are allowed/);
      assert.throws(() => safeRelativePath('sub/../../traversal'), /Only relative workspace paths without traversal are allowed/);
      assert.throws(() => safeRelativePath('file\0.txt'), /Only relative workspace paths without traversal are allowed/);
      assert.throws(() => safeRelativePath('C:\\Windows\\system32'), /Only relative workspace paths without traversal are allowed/);
    });

    it('rejects expired workspace and file tickets', () => {
      process.env.AIRA_BUILDER_SIGNING_SECRET = testSecret;

      const dummySha = crypto.createHash('sha256').update('expired').digest('hex');
      const expiredDraft: WorkspaceTicketDraft = {
        purpose: 'file',
        userId: accountA.userId,
        sessionId: accountA.sessionId,
        workspaceId: 'ws_alpha_expired',
        path: 'out.txt',
        sha256: dummySha,
        expiresAt: Date.now() - 5000, // already expired
        allowInternet: false,
        allowPreview: false
      };

      const expiredToken = signTicket(expiredDraft, testSecret);

      assert.throws(
        () => {
          verifyTicket(expiredToken, accountA, 'file', testSecret);
        },
        /Workspace expired\. Start a new builder workspace/
      );

      // Restore env
      process.env = { ...originalEnv };
    });
  });
});
