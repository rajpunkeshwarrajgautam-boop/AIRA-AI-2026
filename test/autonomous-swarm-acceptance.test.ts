import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutonomousAgentEngine,
  InMemoryAutonomousTaskRepository,
  SpecialistRegistry,
  CollaborativeAgentBridge,
  ResearcherSpecialistAgent,
  DocumentSpecialistAgent,
  VerificationSpecialistAgent,
  CoderSpecialistAgent,
  AnalysisSpecialistAgent,
  SynthesizerSpecialistAgent,
  BaseSpecialistAgent,
  type SpecialistExecutionContext,
  type SpecialistExecutionResult,
} from '../packages/agent-runtime/src/index.js';
import { CollaborationSessionManager } from '../src/server/collaborationManager.js';
import type {
  ExecutionPrincipal,
  AutonomousAgentTask,
  AgentObjectivePlan,
} from '../packages/contracts/src/index.js';
import type { Artifact } from '../src/types/index.js';

test.describe('AIRA GenUI Phase 5B — Autonomous Intelligence & Swarm Collaboration Acceptance Suite', () => {
  const dummyPrincipal: ExecutionPrincipal = {
    userId: 'usr_swarm_owner',
    sessionId: 'sess_swarm_01',
    workspaceId: 'ws_swarm_primary',
    role: 'user',
  };

  const foreignPrincipal: ExecutionPrincipal = {
    userId: 'usr_attacker',
    sessionId: 'sess_foreign',
    workspaceId: 'ws_foreign_tenant',
    role: 'user',
  };

  function setupEngine() {
    const repository = new InMemoryAutonomousTaskRepository();
    const specialistRegistry = new SpecialistRegistry();

    specialistRegistry.registerSpecialist(new ResearcherSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
    specialistRegistry.registerSpecialist(new DocumentSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
    specialistRegistry.registerSpecialist(new VerificationSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
    specialistRegistry.registerSpecialist(new CoderSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
    specialistRegistry.registerSpecialist(new AnalysisSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
    specialistRegistry.registerSpecialist(new SynthesizerSpecialistAgent(), 'IMPLEMENTED_LOCALLY');

    const sessionManager = new CollaborationSessionManager();
    const bridge = new CollaborativeAgentBridge({ sessionManager });

    const engine = new AutonomousAgentEngine({
      repository,
      specialistRegistry,
      maxExecutionCycles: 25,
      requireVerification: true,
    });

    return { repository, specialistRegistry, sessionManager, bridge, engine };
  }

  // =========================================================================
  // MISSION A: Multi-Specialist Research Report
  // =========================================================================
  test('Mission A: Multi-Specialist Research Report — Decomposition, execution & artifact generation', async () => {
    const { engine } = setupEngine();

    const plan: AgentObjectivePlan = {
      planId: 'plan_mission_a',
      objective: 'Comprehensive Market Analysis for GenUI Frameworks',
      estimatedWaves: 2,
      maxBudgetTokens: 20000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 'step_research',
          title: 'Research Declarative GenUI Specs',
          description: 'Survey A2UI v1.0 and OpenGenerativeUI protocols',
          role: 'researcher',
          assignedSpecialist: 'Researcher Specialist',
          dependencies: [],
          sideEffectLevel: 'READ',
          status: 'PENDING',
        },
        {
          stepId: 'step_document',
          title: 'Synthesize Market Report',
          description: 'Create formatted markdown summary',
          role: 'document',
          assignedSpecialist: 'Document Specialist',
          dependencies: ['step_research'],
          sideEffectLevel: 'READ',
          status: 'PENDING',
        },
      ],
    };

    const task = await engine.createTask(
      'Comprehensive Market Analysis for GenUI Frameworks',
      dummyPrincipal,
      plan,
      undefined,
      false // skip verifier requirement for deterministic unit test
    );

    assert.equal(task.state, 'CREATED');
    const started = await engine.startTask(task.taskId);
    assert.equal(['RUNNING', 'COMPLETED'].includes(started.state), true);

    // Wait briefly for asynchronous execution loop
    await new Promise((r) => setTimeout(r, 120));

    const finalTask = await engine.getTask(task.taskId);
    assert.notEqual(finalTask, null);
    assert.equal(finalTask?.state, 'COMPLETED');
    assert.equal(finalTask?.observations.length! >= 2, true);
    assert.equal(finalTask?.plan?.steps.every((s) => s.status === 'COMPLETED'), true);
  });

  // =========================================================================
  // MISSION B: Data Analysis and Spreadsheet AST Recalculation
  // =========================================================================
  test('Mission B: Data Analysis and Spreadsheet — Ingest dataset, calculate formulas, check reactivity', async () => {
    const { bridge } = setupEngine();

    const task: AutonomousAgentTask = {
      taskId: 'task_data_analysis_01',
      principal: dummyPrincipal,
      objective: 'Calculate Q4 EBITDA margins and revenue growth',
      state: 'RUNNING',
      observations: [],
      artifacts: [],
      executionHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fencingToken: 1,
    };

    const initialSheet: Artifact = {
      id: 'art-sheet-ebitda',
      title: 'Q4 Financial Model',
      type: 'application/vnd.aira.sheet',
      content: JSON.stringify({
        activeSheet: 'Sheet1',
        sheets: [
          {
            name: 'Sheet1',
            rowCount: 10,
            colCount: 5,
            cells: {
              A1: { raw: '1000', computed: 1000 }, // Revenue
              A2: { raw: '600', computed: 600 },   // Expenses
              A3: { raw: '=A1-A2', computed: 400 }, // Operating Profit
            },
          },
        ],
      }),
      version: 1,
      versions: [],
    };

    bridge.getOrCreateSession('room-sheet-ebitda', initialSheet, task);
    const analystActor = bridge.createAgentActor(task, 'step_financial_analysis', 'analyst', 'Financial Analyst Specialist');

    // Agent updates revenue in cell A1 from 1000 to 1500
    const res = await bridge.submitAgentOperation(
      'room-sheet-ebitda',
      analystActor,
      'cell_update',
      { cellCoord: 'A1', cellValue: 1500 },
      task
    );
    assert.equal(res.ok, true);

    const syncedArtifact = bridge.syncArtifactToTask('room-sheet-ebitda', task);
    const sheetData = JSON.parse(syncedArtifact.content);

    assert.equal(sheetData.sheets[0].cells.A1.computed, 1500);
    // Reactive AST recalculation: =A1-A2 -> 1500 - 600 = 900
    assert.equal(sheetData.sheets[0].cells.A3.computed, 900);
    assert.equal(task.artifacts.length, 1);
  });

  // =========================================================================
  // MISSION C: Multi-Artifact Business Report (DOCX, XLSX, PPTX)
  // =========================================================================
  test('Mission C: Multi-Artifact Consistency — Generate and synchronize doc, sheet, and presentation', async () => {
    const { bridge } = setupEngine();

    const task: AutonomousAgentTask = {
      taskId: 'task_multi_artifact_corp',
      principal: dummyPrincipal,
      objective: 'Generate Enterprise Pitch Package (Doc, Sheet, Slide)',
      state: 'RUNNING',
      observations: [],
      artifacts: [],
      executionHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fencingToken: 1,
    };

    // 1. Executive Document
    const docArt: Artifact = {
      id: 'art-pitch-doc',
      title: 'Executive Brief',
      type: 'application/vnd.ant.markdown',
      content: '# 2026 Strategy\nScaling AI GenUI platforms.',
      version: 1,
      versions: [],
    };
    bridge.getOrCreateSession('room-pitch-doc', docArt, task);

    // 2. Financial Sheet
    const sheetArt: Artifact = {
      id: 'art-pitch-sheet',
      title: 'Financial Projections',
      type: 'application/vnd.aira.sheet',
      content: JSON.stringify({
        activeSheet: 'Sheet1',
        sheets: [{ name: 'Sheet1', rowCount: 10, colCount: 5, cells: { A1: { raw: '500000', computed: 500000 } } }],
      }),
      version: 1,
      versions: [],
    };
    bridge.getOrCreateSession('room-pitch-sheet', sheetArt, task);

    // 3. Pitch Deck
    const slideArt: Artifact = {
      id: 'art-pitch-slide',
      title: 'Investor Deck',
      type: 'application/vnd.aira.presentation',
      content: JSON.stringify({
        title: 'Investor Deck',
        theme: 'dark',
        slides: [{ id: 's1', layout: 'title', title: 'AIRA Platform', bullets: [] }],
      }),
      version: 1,
      versions: [],
    };
    bridge.getOrCreateSession('room-pitch-slide', slideArt, task);

    // Agent adds slide
    const docActor = bridge.createAgentActor(task, 'step_deck', 'document', 'Pitch Specialist');
    await bridge.submitAgentOperation(
      'room-pitch-slide',
      docActor,
      'slide_mutate',
      { slideAction: 'insert', slideData: { id: 's2', layout: 'content', title: 'Market Opportunity', bullets: ['10x speed'] } },
      task
    );

    bridge.syncArtifactToTask('room-pitch-doc', task);
    bridge.syncArtifactToTask('room-pitch-sheet', task);
    bridge.syncArtifactToTask('room-pitch-slide', task);

    assert.equal(task.artifacts.length, 3);
    assert.equal(task.artifacts.some((a) => a.id === 'art-pitch-doc'), true);
    assert.equal(task.artifacts.some((a) => a.id === 'art-pitch-sheet'), true);
    const syncedDeck = JSON.parse(task.artifacts.find((a) => a.id === 'art-pitch-slide')!.content);
    assert.equal(syncedDeck.slides.length, 2);
  });

  // =========================================================================
  // MISSION D: Code Development Task (Bounded Multi-File Artifact)
  // =========================================================================
  test('Mission D: Code Development Task — Multi-file code bundle with isolated scope', async () => {
    const { bridge } = setupEngine();

    const task: AutonomousAgentTask = {
      taskId: 'task_code_dev_01',
      principal: dummyPrincipal,
      objective: 'Develop Interactive Micro-Calculator Component',
      state: 'RUNNING',
      observations: [],
      artifacts: [],
      executionHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fencingToken: 1,
    };

    const bundleArt: Artifact = {
      id: 'art-calc-code',
      title: 'Micro Calculator App',
      type: 'application/vnd.ant.code',
      content: JSON.stringify({
        manifest: { entryPoint: 'index.html', title: 'Calculator' },
        files: {
          'index.html': '<html><body><input id="v1"><button id="add">+</button></body></html>',
          'style.css': 'body { background: #121212; color: #FFF; }',
          'app.js': 'document.getElementById("add").onclick = () => {};',
        },
      }),
      version: 1,
      versions: [],
    };

    bridge.getOrCreateSession('room-calc-code', bundleArt, task);
    const coderActor = bridge.createAgentActor(task, 'step_code', 'coder', 'Code Engineer Specialist');

    // Coder agent updates app.js logic
    const updatedBundle = JSON.parse(bundleArt.content);
    updatedBundle.files['app.js'] = 'document.getElementById("add").onclick = () => { alert("Result"); };';

    const res = await bridge.submitAgentOperation(
      'room-calc-code',
      coderActor,
      'artifact_replace',
      { fullContent: JSON.stringify(updatedBundle) },
      task
    );
    assert.equal(res.ok, true);

    const synced = bridge.syncArtifactToTask('room-calc-code', task);
    const parsedCode = JSON.parse(synced.content);
    assert.equal(parsedCode.files['app.js'].includes('alert("Result")'), true);
  });

  // =========================================================================
  // MISSION E: Concurrent Agent Co-Authoring
  // =========================================================================
  test('Mission E: Concurrent Agent Co-Authoring — Multiple specialist agents co-authoring shared artifact', async () => {
    const { bridge } = setupEngine();

    const task: AutonomousAgentTask = {
      taskId: 'task_coauthor_01',
      principal: dummyPrincipal,
      objective: 'Co-Author Strategic Whitepaper',
      state: 'RUNNING',
      observations: [],
      artifacts: [],
      executionHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fencingToken: 1,
    };

    const docArt: Artifact = {
      id: 'art-whitepaper',
      title: 'AI GenUI Whitepaper',
      type: 'text/markdown',
      content: '# Abstract\n\n# Architecture\n\n# Conclusion\n',
      version: 1,
      versions: [],
    };

    bridge.getOrCreateSession('room-whitepaper', docArt, task);

    // Researcher agent and Copywriter agent co-author simultaneously
    const results = await bridge.coAuthorMultiAgent(
      'room-whitepaper',
      [
        {
          role: 'researcher',
          stepId: 'step_research',
          displayName: 'Research Specialist',
          opType: 'text_insert',
          payload: { position: 11, text: 'Declarative UI reduces token consumption by 40%.\n\n' },
        },
        {
          role: 'synthesizer',
          stepId: 'step_copywrite',
          displayName: 'Copywriter Specialist',
          opType: 'text_insert',
          payload: { position: 0, text: 'AIRA AI 2026: ' },
        },
      ],
      task
    );

    assert.equal(results.length, 2);
    assert.equal(results.every((r) => r.ok), true);

    const synced = bridge.syncArtifactToTask('room-whitepaper', task);
    assert.equal(synced.content.includes('AIRA AI 2026: # Abstract'), true);
    assert.equal(synced.content.includes('reduces token consumption by 40%'), true);
  });

  // =========================================================================
  // MISSION F: Human-Agent Concurrent Editing (Positional Rebase)
  // =========================================================================
  test('Mission F: Human-Agent Concurrent Editing — Human edits preserved during concurrent AI mutation', async () => {
    const { bridge, sessionManager } = setupEngine();

    const task: AutonomousAgentTask = {
      taskId: 'task_human_agent_01',
      principal: dummyPrincipal,
      objective: 'Collaborative Document Refining',
      state: 'RUNNING',
      observations: [],
      artifacts: [],
      executionHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fencingToken: 1,
    };

    const docArt: Artifact = {
      id: 'art-collab-human-ai',
      title: 'Shared Roadmap',
      type: 'text/markdown',
      content: 'Line 1: Roadmap Core\nLine 2: Milestones\nLine 3: Budget',
      version: 1,
      versions: [],
    };

    const engine = bridge.getOrCreateSession('room-human-ai', docArt, task);

    // 1. Human inserts text at position 0
    const humanActor = {
      actorId: 'usr_human_alice',
      principalId: dummyPrincipal.userId,
      displayName: 'Alice (Human Product Lead)',
      role: 'editor' as const,
    };
    const humanOp = {
      opId: 'op_human_h1',
      sessionId: 'room-human-ai',
      artifactId: docArt.id,
      actor: humanActor,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_insert' as const,
      payload: { position: 0, text: '[HUMAN_PRIORITY] ' },
    };
    const humanRes = await sessionManager.submitOperation('room-human-ai', humanOp, {
      principalId: dummyPrincipal.userId,
      tenantId: dummyPrincipal.workspaceId,
      conversationId: task.taskId,
    });
    assert.equal(humanRes.ok, true);

    // 2. AI agent concurrently inserts at end of document based on older baseSeq: 1
    const aiActor = bridge.createAgentActor(task, 'step_ai_append', 'document', 'Documentation Specialist');
    const aiRes = await bridge.submitAgentOperation(
      'room-human-ai',
      aiActor,
      'text_insert',
      { position: docArt.content.length, text: '\nLine 4: Verified by AI Specialist' },
      task,
      { baseSeq: 1 } // Concurrent operation based on initial document sequence 1!
    );
    assert.equal(aiRes.ok, true);

    const finalContent = engine.getContent();
    // Verify both human edit and AI edit are preserved without corruption
    assert.equal(finalContent.startsWith('[HUMAN_PRIORITY] Line 1: Roadmap Core'), true);
    assert.equal(finalContent.includes('Line 4: Verified by AI Specialist'), true);
  });

  // =========================================================================
  // MISSION G: Interrupted Mission Recovery
  // =========================================================================
  test('Mission G: Interrupted Mission Recovery — Skip completed steps on crash recovery', async () => {
    const { repository, specialistRegistry } = setupEngine();

    const plan: AgentObjectivePlan = {
      planId: 'plan_recoverable',
      objective: 'Long-Horizon Multi-Wave Pipeline',
      estimatedWaves: 3,
      maxBudgetTokens: 32000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 'step_1_completed',
          title: 'Initial Discovery',
          role: 'researcher',
          sideEffectLevel: 'READ',
          status: 'COMPLETED', // Already completed prior to crash
          resultSummary: 'Cached discovery output',
        },
        {
          stepId: 'step_2_pending',
          title: 'Document Assembly',
          role: 'document',
          sideEffectLevel: 'READ',
          status: 'PENDING',
        },
      ],
    };

    const task = await repository.createTask({
      taskId: 'task_crash_recovery_01',
      principal: dummyPrincipal,
      objective: 'Long-Horizon Multi-Wave Pipeline',
      state: 'RESUMING',
      plan,
      observations: [
        {
          observationId: 'obs_cached_01',
          stepId: 'step_1_completed',
          source: 'specialist',
          sourceName: 'Researcher Specialist',
          summary: 'Cached discovery output',
          isError: false,
          timestamp: Date.now(),
        },
      ],
      artifacts: [],
      workingMemory: {},
      fencingToken: 1,
      executionHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const resumingEngine = new AutonomousAgentEngine({
      repository,
      specialistRegistry,
      requireVerification: false,
    });

    // Execute task in resume mode with fresh fencing token
    await resumingEngine.executeAutonomousTask(task.taskId, undefined, 1);

    const recovered = await repository.getTask(task.taskId);
    assert.notEqual(recovered, null);
    assert.equal(recovered?.state, 'COMPLETED');
    // Step 1 was preserved as completed without re-execution
    assert.equal(recovered?.plan?.steps[0].status, 'COMPLETED');
    assert.equal(recovered?.plan?.steps[0].resultSummary, 'Cached discovery output');
    // Step 2 was executed and completed
    assert.equal(recovered?.plan?.steps[1].status, 'COMPLETED');
  });

  // =========================================================================
  // MISSION H: Provider Failure & Safe Fallback
  // =========================================================================
  test('Mission H: Provider Failure & Error Reporting — Specialist failure halts cleanly', async () => {
    // 1. Test missing unregistered specialist role halts cleanly
    const { engine } = setupEngine();

    const planUnregistered: AgentObjectivePlan = {
      planId: 'plan_failing_provider_unregistered',
      objective: 'Execution with Unregistered Specialist',
      estimatedWaves: 1,
      maxBudgetTokens: 10000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 'step_unregistered',
          title: 'Execute Missing Specialist Task',
          role: 'browser', // valid canonical role in Zod schema, but unregistered in registry
          sideEffectLevel: 'READ',
          status: 'PENDING',
        },
      ],
    };

    const taskUnregistered = await engine.createTask(
      'Execution with Unregistered Specialist',
      dummyPrincipal,
      planUnregistered,
      undefined,
      false
    );

    await engine.startTask(taskUnregistered.taskId);
    await new Promise((r) => setTimeout(r, 120));

    const finalUnregistered = await engine.getTask(taskUnregistered.taskId);
    assert.notEqual(finalUnregistered, null);
    assert.equal(finalUnregistered?.state, 'FAILED');
    assert.equal(finalUnregistered?.plan?.steps[0].status, 'FAILED');

    // 2. Test registered specialist with isolated upstream provider fault simulation (HTTP 504 timeout)
    class FaultyProviderSpecialistAgent extends BaseSpecialistAgent {
      public readonly role = 'researcher' as const;
      public readonly name = 'Faulty Provider Researcher Specialist';
      public readonly description = 'Simulates an upstream provider timeout (HTTP 504)';
      public readonly requiredCapabilities = ['deep_research', 'tool_execution'] as const;

      protected async performExecution(
        context: SpecialistExecutionContext,
        startedAt: number
      ): Promise<SpecialistExecutionResult> {
        return this.buildResult(context, 'FAILED', undefined, startedAt, {
          code: 'PROVIDER_TIMEOUT_504',
          message: '[PROVIDER_TIMEOUT_504] Upstream LLM provider inference timed out after 30000ms. Non-retryable budget exceeded.',
          retryable: false,
        });
      }
    }

    const customRegistry = new SpecialistRegistry();
    customRegistry.registerSpecialist(new FaultyProviderSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
    customRegistry.registerSpecialist(new VerificationSpecialistAgent(), 'IMPLEMENTED_LOCALLY');
    const customRepo = new InMemoryAutonomousTaskRepository();
    const customEngine = new AutonomousAgentEngine({
      repository: customRepo,
      specialistRegistry: customRegistry,
      requireVerification: false,
    });

    const planProviderFault: AgentObjectivePlan = {
      planId: 'plan_provider_fault_sim',
      objective: 'Execution with Provider Timeout',
      estimatedWaves: 1,
      maxBudgetTokens: 10000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 'step_faulty_inference',
          title: 'Execute Upstream LLM Inference',
          role: 'researcher',
          assignedSpecialist: 'Faulty Provider Researcher Specialist',
          sideEffectLevel: 'READ',
          status: 'PENDING',
        },
      ],
    };

    const taskFault = await customEngine.createTask(
      'Execution with Provider Timeout',
      dummyPrincipal,
      planProviderFault,
      undefined,
      false
    );

    await customEngine.startTask(taskFault.taskId);
    await new Promise((r) => setTimeout(r, 120));

    const finalFault = await customEngine.getTask(taskFault.taskId);
    assert.notEqual(finalFault, null);
    assert.equal(finalFault?.state, 'FAILED');
    assert.equal(finalFault?.plan?.steps[0].status, 'FAILED');
    assert.equal(finalFault?.plan?.steps[0].resultSummary?.includes('PROVIDER_TIMEOUT_504'), true);
  });

  // =========================================================================
  // MISSION I: ApprovalKernel Human-in-the-Loop Gating
  // =========================================================================
  test('Mission I: Approval Pause — Consequential WRITE step pauses at WAITING_FOR_APPROVAL', async () => {
    const { engine } = setupEngine();

    const plan: AgentObjectivePlan = {
      planId: 'plan_approval_gate',
      objective: 'Destructive Database Reconfiguration',
      estimatedWaves: 1,
      maxBudgetTokens: 10000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 'step_privileged_write',
          title: 'Apply Critical System Configuration',
          role: 'coder',
          sideEffectLevel: 'WRITE', // Requires approval!
          status: 'PENDING',
        },
      ],
    };

    const task = await engine.createTask(
      'Destructive Database Reconfiguration',
      dummyPrincipal,
      plan,
      undefined,
      false
    );

    await engine.startTask(task.taskId);
    await new Promise((r) => setTimeout(r, 120));

    // Must pause at WAITING_FOR_APPROVAL
    const pausedTask = await engine.getTask(task.taskId);
    assert.notEqual(pausedTask, null);
    assert.equal(pausedTask?.state, 'WAITING_FOR_APPROVAL');
    assert.notEqual(pausedTask?.approvalRequestId, undefined);

    // User approves step
    const resumed = await engine.approveStep(task.taskId, pausedTask!.approvalRequestId!, true, 'Approved by SecOps');
    assert.equal(resumed.state, 'RUNNING');
  });

  // =========================================================================
  // MISSION J: Cancellation Propagation
  // =========================================================================
  test('Mission J: Cancellation Propagation — Aborts execution and sets CANCELLED state', async () => {
    const { repository, specialistRegistry } = setupEngine();
    const engine = new AutonomousAgentEngine({ repository, specialistRegistry, requireVerification: false });

    const task = await engine.createTask('Cancellable Long Running Mission', dummyPrincipal);

    // Start task
    await engine.startTask(task.taskId);

    // Cancel task
    const cancelled = await engine.cancelTask(task.taskId, 'User requested cancellation');
    assert.equal(cancelled.state, 'CANCELLED');

    const stored = await repository.getTask(task.taskId);
    assert.equal(stored?.state, 'CANCELLED');
  });

  // =========================================================================
  // MISSION K: Multi-Tenant Boundary Isolation
  // =========================================================================
  test('Mission K: Multi-Tenant Boundary Isolation — Cross-tenant session mutation rejected', async () => {
    const { bridge, sessionManager } = setupEngine();

    const task: AutonomousAgentTask = {
      taskId: 'task_tenant_owner_01',
      principal: dummyPrincipal,
      objective: 'Secure Confidential Tenant Document',
      state: 'RUNNING',
      observations: [],
      artifacts: [],
      executionHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fencingToken: 1,
    };

    const docArt: Artifact = {
      id: 'art-tenant-secret',
      title: 'Tenant Confidential',
      type: 'text/markdown',
      content: 'Confidential Internal Financials',
      version: 1,
      versions: [],
    };

    // Create session under dummyPrincipal (tenant: ws_swarm_primary)
    bridge.getOrCreateSession('room-tenant-sec', docArt, task);

    // Foreign attacker attempts to submit mutation to room-tenant-sec
    const attackerActor = {
      actorId: 'usr_attacker_01',
      principalId: foreignPrincipal.userId,
      displayName: 'Attacker',
      role: 'editor' as const,
    };
    const attackerOp = {
      opId: 'op_attack_01',
      sessionId: 'room-tenant-sec',
      artifactId: docArt.id,
      actor: attackerActor,
      baseSeq: 1,
      lamportClock: 1,
      timestamp: Date.now(),
      type: 'text_insert' as const,
      payload: { position: 0, text: 'LEAK: ' },
    };

    // Submitting under foreign principal must fail with TENANT_ISOLATION_VIOLATION
    const attackResult = await sessionManager.submitOperation('room-tenant-sec', attackerOp, {
      principalId: foreignPrincipal.userId,
      tenantId: foreignPrincipal.workspaceId,
      conversationId: 'c_attack',
    });

    assert.equal(attackResult.ok, false);
    assert.equal(attackResult.error?.includes('TENANT_ISOLATION_VIOLATION'), true);
  });

  // =========================================================================
  // MISSION L: Resource Budget Exhaustion & Loop Guard
  // =========================================================================
  test('Mission L: Resource Budget Exhaustion — Terminate cleanly on maxExecutionCycles limit', async () => {
    const { repository, specialistRegistry } = setupEngine();

    // Create engine with maxExecutionCycles = 2
    const strictEngine = new AutonomousAgentEngine({
      repository,
      specialistRegistry,
      maxExecutionCycles: 2,
      requireVerification: false,
    });

    // Plan with 5 steps (exceeds max 2 cycles)
    const steps = [1, 2, 3, 4, 5].map((i) => ({
      stepId: `step_${i}`,
      title: `Step ${i}`,
      role: 'researcher' as const,
      sideEffectLevel: 'READ' as const,
      status: 'PENDING' as const,
    }));

    const plan: AgentObjectivePlan = {
      planId: 'plan_exceeds_budget',
      objective: 'Runaway Loop Target',
      steps,
      estimatedWaves: 5,
      maxBudgetTokens: 10000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const task = await strictEngine.createTask('Runaway Loop Target', dummyPrincipal, plan, undefined, false);
    await strictEngine.startTask(task.taskId);
    await new Promise((r) => setTimeout(r, 120));

    const finalTask = await repository.getTask(task.taskId);
    assert.notEqual(finalTask, null);
    assert.equal(finalTask?.state, 'FAILED');
    assert.equal(finalTask?.executionHistory.some((h) => h.reason?.includes('Loop limit exceeded')), true);
  });

  // =========================================================================
  // MISSION M: Final Evidence-Backed Verification Gate
  // =========================================================================
  test('Mission M: Final Verification Gate — Verification Specialist certifies mission completion', async () => {
    const { engine } = setupEngine();

    const plan: AgentObjectivePlan = {
      planId: 'plan_verified_mission',
      objective: 'Verified Autonomous Pipeline Execution',
      estimatedWaves: 1,
      maxBudgetTokens: 20000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 'step_discover',
          title: 'Gather Requirements',
          role: 'researcher',
          sideEffectLevel: 'READ',
          status: 'PENDING',
        },
      ],
    };

    const task = await engine.createTask(
      'Verified Autonomous Pipeline Execution',
      dummyPrincipal,
      plan,
      undefined,
      true // requireVerification: true!
    );

    await engine.startTask(task.taskId);
    await new Promise((r) => setTimeout(r, 150));

    const finalTask = await engine.getTask(task.taskId);
    assert.notEqual(finalTask, null);
    assert.equal(finalTask?.state, 'COMPLETED');
    // Must have verification gate observation recorded
    assert.equal(finalTask?.observations.some((o) => o.stepId === 'verification_gate'), true);
    assert.equal(finalTask?.deliverableSummary?.includes('Verified: true'), true);
  });
});
