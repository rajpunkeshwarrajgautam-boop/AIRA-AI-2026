import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAutonomousSpecialistRegistry,
  SpecialistRegistry
} from '../packages/agent-runtime/src/specialists/index.js';
import { AutonomousAgentEngine } from '../packages/agent-runtime/src/autonomous/autonomous-engine.js';
import { InMemoryAutonomousTaskRepository } from '../packages/agent-runtime/src/autonomous/repository.js';
import { ToolGateway } from '../packages/tool-runtime/src/gateway.js';
import { InMemoryToolCallRepository } from '../packages/tool-runtime/src/repository.js';
import { ALL_SPECIALIST_ROLES, ExecutionPrincipal, AgentPlanStep } from '../packages/contracts/src/index.js';

test('Mission E — Real Specialist-Agent Orchestration, Delegation Contracts & Hand-Off Safety', async (t) => {
  const principal: ExecutionPrincipal = {
    userId: 'user_orchestration_test',
    sessionId: 'sess_orch',
    workspaceId: 'ws_orchestration',
    scopes: ['*']
  };

  const toolRepo = new InMemoryToolCallRepository();
  const toolGateway = new ToolGateway(toolRepo);

  // Register built-in helper tools for specialists
  toolGateway.registerTool({
    definition: {
      id: 'web_search',
      name: 'web_search',
      version: 1,
      description: 'Web search engine',
      category: 'utility',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      source: 'native',
      permissionLevel: 'READ',
      sideEffectLevel: 'READ',
      permissionScopes: ['research.read'],
      approvalPolicy: 'autonomous',
      executionRuntime: 'LOCAL',
      availability: 'READY',
      adapter: 'native'
    },
    execute: async (args: any) => ({
      results: [
        { title: `Evidence for ${args.query}`, url: 'https://aira.ai/intel', snippet: 'AIRA Platform 2026 Core Data' }
      ]
    })
  });

  toolGateway.registerTool({
    definition: {
      id: 'calculator',
      name: 'calculator',
      version: 1,
      description: 'Performs mathematical computations',
      category: 'utility',
      parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      source: 'native',
      permissionLevel: 'READ',
      sideEffectLevel: 'READ',
      permissionScopes: ['compute.eval'],
      approvalPolicy: 'autonomous',
      executionRuntime: 'LOCAL',
      availability: 'READY',
      adapter: 'native'
    },
    execute: async () => ({
      result: 99.98,
      status: 'computed'
    })
  });

  const specialistRegistry = createAutonomousSpecialistRegistry(toolGateway);

  await t.test('1. Verify Canonical 9 Specialist Roles Are Implemented and Registered', () => {
    assert.equal(ALL_SPECIALIST_ROLES.length, 9);
    for (const role of ALL_SPECIALIST_ROLES) {
      assert.equal(specialistRegistry.hasSpecialist(role), true, `Specialist role "${role}" must be registered`);
      const agent = specialistRegistry.getSpecialist(role);
      assert.ok(agent);
      assert.equal(agent.role, role);
      assert.ok(agent.requiredCapabilities.length > 0, `Role "${role}" must declare required capabilities`);
    }
  });

  await t.test('2. Multi-Role Collaboration Pipeline: Research -> Analysis -> Synthesis -> Verification', async () => {
    const taskRepo = new InMemoryAutonomousTaskRepository();
    const engine = new AutonomousAgentEngine({
      repository: taskRepo,
      specialistRegistry,
      toolGateway,
      maxExecutionCycles: 15
    });

    const handoffEvents: any[] = [];
    engine.on('task.handoff', (e) => handoffEvents.push(e));

    // Custom 4-role sequential pipeline
    const multiRolePlan = {
      planId: 'plan_multi_role_01',
      objective: 'Analyze and synthesize quantum encryption benchmarks',
      estimatedWaves: 4,
      maxBudgetTokens: 40000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 'step_1_research',
          title: 'Research quantum encryption benchmarks',
          description: 'Search documentation for current encryption latency numbers',
          role: 'researcher',
          assignedSpecialist: 'Researcher Specialist',
          dependencies: [],
          sideEffectLevel: 'READ',
          status: 'PENDING'
        } as AgentPlanStep,
        {
          stepId: 'step_2_analysis',
          title: 'Analyze numerical metrics',
          description: 'Compute statistical distribution and mean throughput',
          role: 'analyst',
          assignedSpecialist: 'Mathematical Specialist',
          dependencies: ['step_1_research'],
          sideEffectLevel: 'READ',
          status: 'PENDING'
        } as AgentPlanStep,
        {
          stepId: 'step_3_synthesis',
          title: 'Synthesize findings across research and analysis',
          description: 'Combine empirical evidence and computed figures into an executive report',
          role: 'synthesizer',
          assignedSpecialist: 'Synthesizer Specialist',
          dependencies: ['step_1_research', 'step_2_analysis'],
          sideEffectLevel: 'READ',
          status: 'PENDING'
        } as AgentPlanStep,
        {
          stepId: 'step_4_verify',
          title: 'Verify deliverables against strict criteria',
          description: 'Ensure synthesis was generated without errors',
          role: 'verifier',
          assignedSpecialist: 'Verification Specialist',
          dependencies: ['step_3_synthesis'],
          sideEffectLevel: 'READ',
          status: 'PENDING'
        } as AgentPlanStep
      ]
    };

    const task = await engine.createTask(
      'Analyze and synthesize quantum encryption benchmarks',
      principal,
      multiRolePlan
    );

    const startedTask = await engine.startTask(task.taskId);
    assert.equal(startedTask.state, 'RUNNING');

    // Wait for the autonomous pipeline to finish all 4 steps
    let completedTask = await engine.getTask(task.taskId);
    let attempts = 0;
    while (completedTask && completedTask.state !== 'COMPLETED' && completedTask.state !== 'FAILED' && attempts < 30) {
      await new Promise(r => setTimeout(r, 50));
      completedTask = await engine.getTask(task.taskId);
      attempts++;
    }

    assert.ok(completedTask);
    assert.equal(completedTask.state, 'COMPLETED', `Task should complete successfully: ${completedTask.error}`);
    assert.equal(completedTask.plan?.steps.length, 4);

    // Verify all 4 steps were executed and completed
    for (const step of completedTask.plan!.steps) {
      assert.equal(step.status, 'COMPLETED', `Step ${step.stepId} must be completed`);
      assert.ok(step.resultSummary, `Step ${step.stepId} must have a resultSummary`);
    }

    // Verify handoffs occurred between specialists
    assert.ok(handoffEvents.length >= 4, 'Hand-off events must be emitted for each specialist step');
    assert.equal(handoffEvents[0].specialistRole, 'researcher');
    assert.equal(handoffEvents[1].specialistRole, 'analyst');
    assert.equal(handoffEvents[2].specialistRole, 'synthesizer');
    assert.equal(handoffEvents[3].specialistRole, 'verifier');

    // Verify working memory and observations were accumulated
    assert.ok(completedTask.observations.length >= 4);
    assert.ok(completedTask.workingMemory);
    assert.ok(completedTask.workingMemory['step_3_synthesis']);
    assert.equal((completedTask.workingMemory['step_3_synthesis'] as any).status, 'SYNTHESIZED');
  });

  await t.test('3. Dynamic Plan Refinement During Execution', async () => {
    const taskRepo = new InMemoryAutonomousTaskRepository();
    const engine = new AutonomousAgentEngine({
      repository: taskRepo,
      specialistRegistry,
      toolGateway
    });

    const initialPlan = {
      planId: 'plan_refine_01',
      objective: 'Adaptive execution plan',
      estimatedWaves: 1,
      maxBudgetTokens: 20000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 'step_init',
          title: 'Initial assessment',
          description: 'Assess project structure',
          role: 'planner',
          assignedSpecialist: 'Planner Specialist',
          dependencies: [],
          sideEffectLevel: 'READ',
          status: 'PENDING'
        } as AgentPlanStep
      ]
    };

    const task = await engine.createTask('Adaptive execution plan', principal, initialPlan);

    // Refine plan by dynamically adding 2 more steps
    const refined = await engine.refinePlan(task.taskId, [
      {
        stepId: 'step_deep_search',
        title: 'Deep search on discovered APIs',
        description: 'Gather endpoint definitions',
        role: 'researcher',
        assignedSpecialist: 'Researcher Specialist',
        dependencies: ['step_init'],
        sideEffectLevel: 'READ',
        status: 'PENDING'
      } as AgentPlanStep,
      {
        stepId: 'step_doc_gen',
        title: 'Generate API reference document',
        description: 'Format Markdown output',
        role: 'document',
        assignedSpecialist: 'Document Specialist',
        dependencies: ['step_deep_search'],
        sideEffectLevel: 'READ',
        status: 'PENDING'
      } as AgentPlanStep
    ]);

    assert.equal(refined.plan?.steps.length, 3);
    assert.equal(refined.plan?.steps[1].stepId, 'step_deep_search');
    assert.equal(refined.plan?.steps[2].stepId, 'step_doc_gen');

    // Run refined task
    await engine.startTask(task.taskId);

    let finished = await engine.getTask(task.taskId);
    let attempts = 0;
    while (finished && finished.state !== 'COMPLETED' && attempts < 30) {
      await new Promise(r => setTimeout(r, 50));
      finished = await engine.getTask(task.taskId);
      attempts++;
    }

    assert.ok(finished);
    assert.equal(finished.state, 'COMPLETED');
    assert.equal(finished.plan?.steps.every(s => s.status === 'COMPLETED'), true);
  });

  await t.test('4. Loop Limit Enforcement (Infinite / Runaway Loop Prevention)', async () => {
    const taskRepo = new InMemoryAutonomousTaskRepository();
    const engine = new AutonomousAgentEngine({
      repository: taskRepo,
      specialistRegistry,
      toolGateway,
      maxExecutionCycles: 3 // Set low loop threshold to verify cutoff
    });

    // Create plan with 5 steps (exceeds maxExecutionCycles = 3)
    const longPlan = {
      planId: 'plan_loop_test',
      objective: 'Verify runaway cutoff',
      estimatedWaves: 5,
      maxBudgetTokens: 10000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [1, 2, 3, 4, 5].map(i => ({
        stepId: `step_loop_${i}`,
        title: `Loop Step ${i}`,
        description: 'Repetitive step',
        role: 'planner',
        assignedSpecialist: 'Planner Specialist',
        dependencies: [],
        sideEffectLevel: 'READ',
        status: 'PENDING'
      })) as AgentPlanStep[]
    };

    const task = await engine.createTask('Verify runaway cutoff', principal, longPlan);
    await engine.startTask(task.taskId);

    let resultTask = await engine.getTask(task.taskId);
    let attempts = 0;
    while (resultTask && resultTask.state !== 'FAILED' && attempts < 30) {
      await new Promise(r => setTimeout(r, 50));
      resultTask = await engine.getTask(task.taskId);
      attempts++;
    }

    assert.ok(resultTask);
    assert.equal(resultTask.state, 'FAILED');
    assert.ok(resultTask.error?.includes('Loop limit exceeded'));
  });

  await t.test('5. Failure Boundary Isolation: Halts Execution on Step Failure Without Corrupting State', async () => {
    // Register a failing specialist agent for this test
    const customRegistry = new SpecialistRegistry();
    customRegistry.registerSpecialist({
      role: 'coder',
      name: 'Failing Coder Specialist',
      description: 'Simulates intentional task failure',
      requiredCapabilities: ['software_engineering'],
      canExecute: () => ({ authorized: true }),
      execute: async (ctx) => ({
        taskId: ctx.taskId,
        runId: ctx.runId,
        role: 'coder',
        outcome: 'FAILED',
        output: null,
        error: { code: 'SYNTAX_ERROR', message: 'Failed to compile generated module', retryable: false },
        timing: { startedAt: Date.now(), completedAt: Date.now() }
      })
    }, 'IMPLEMENTED_LOCALLY');

    customRegistry.registerSpecialist(specialistRegistry.getSpecialist('planner')!, 'IMPLEMENTED_LOCALLY');
    customRegistry.registerSpecialist(specialistRegistry.getSpecialist('verifier')!, 'IMPLEMENTED_LOCALLY');

    const taskRepo = new InMemoryAutonomousTaskRepository();
    const engine = new AutonomousAgentEngine({
      repository: taskRepo,
      specialistRegistry: customRegistry,
      toolGateway
    });

    const planWithFailure = {
      planId: 'plan_fail_test',
      objective: 'Step Failure Isolation',
      estimatedWaves: 3,
      maxBudgetTokens: 10000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 'step_ok',
          title: 'Planning',
          role: 'planner',
          dependencies: [],
          sideEffectLevel: 'READ',
          status: 'PENDING'
        } as AgentPlanStep,
        {
          stepId: 'step_bad_coder',
          title: 'Coding (Fails)',
          role: 'coder',
          dependencies: ['step_ok'],
          sideEffectLevel: 'READ',
          status: 'PENDING'
        } as AgentPlanStep,
        {
          stepId: 'step_should_never_run',
          title: 'Downstream Verification',
          role: 'verifier',
          dependencies: ['step_bad_coder'],
          sideEffectLevel: 'READ',
          status: 'PENDING'
        } as AgentPlanStep
      ]
    };

    const task = await engine.createTask('Step Failure Isolation', principal, planWithFailure);
    await engine.startTask(task.taskId);

    let finalTask = await engine.getTask(task.taskId);
    let attempts = 0;
    while (finalTask && finalTask.state !== 'FAILED' && attempts < 30) {
      await new Promise(r => setTimeout(r, 50));
      finalTask = await engine.getTask(task.taskId);
      attempts++;
    }

    assert.ok(finalTask);
    assert.equal(finalTask.state, 'FAILED');
    assert.ok(finalTask.error?.includes('failed'));

    // Verify failure boundary: Step 1 completed, Step 2 failed, Step 3 remained PENDING (NEVER executed)
    const steps = finalTask.plan!.steps;
    assert.equal(steps[0].status, 'COMPLETED');
    assert.equal(steps[1].status, 'FAILED');
    assert.equal(steps[2].status, 'PENDING', 'Downstream step must NOT execute after upstream failure');
  });
});
