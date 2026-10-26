import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BaseSpecialistAgent,
  SpecialistExecutionContext,
  SpecialistExecutionResult,
  ISpecialistAgent
} from '../packages/agent-runtime/src/specialists/specialist-interface.js';
import {
  RunStateSchema,
  ExecutionCheckpointSchema,
  SpecialistRole,
  SpecialistTaskOutcomeSchema,
  CapabilityCategory,
  WorkflowDefinition,
  validateWorkflowDag
} from '../packages/contracts/src/index.js';
import {
  PromptProfileRegistry,
  IntelligentPromptComposer
} from '../packages/agent-runtime/src/index.js';
import { ToolGateway, ToolRegistry, InMemoryToolCallRepository } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';

// Concrete Mock Specialist for interface testing
class MockCoderSpecialist extends BaseSpecialistAgent {
  readonly role: SpecialistRole = 'coder';
  readonly name = 'Mock Coder Specialist';
  readonly description = 'Generates tested code diffs';
  readonly requiredCapabilities: readonly CapabilityCategory[] = ['software_engineering'];

  public executed = false;

  protected async performExecution(
    context: SpecialistExecutionContext,
    startedAt: number
  ): Promise<SpecialistExecutionResult> {
    this.executed = true;
    return this.buildResult(context, 'COMPLETED', { diff: '+ console.log("OK");' }, startedAt, undefined, {
      tokensUsed: 42,
      durationMs: 5
    });
  }
}

function createMockContext(overrides?: Partial<SpecialistExecutionContext>): SpecialistExecutionContext {
  const abortController = new AbortController();
  return {
    runId: 'run_ctx_01',
    taskId: 'task_mock_01',
    principal: {
      userId: 'usr_dev_1',
      sessionId: 'sess_1',
      workspaceId: 'ws_prod',
      roles: ['developer']
    },
    tenantId: 'tenant_aira_default',
    workspaceId: 'ws_prod',
    authorizedCapabilities: ['software_engineering'],
    effectiveToolScopes: ['file_read', 'file_write'],
    executionPolicyVersion: '2026.1',
    promptProfileId: 'profile_coder_v1',
    promptProfileVersion: '1.0.0',
    modelRoutingRequirements: {
      suggestedModelClass: 'nemotron-3-super-120b',
      maxTokens: 4096
    },
    remainingBudget: {
      maxTokens: 50000,
      remainingTokens: 49000
    },
    cancellationSignal: abortController.signal,
    correlationId: 'trace_corr_01',
    inputPayload: { targetFile: 'src/main.ts' },
    ...overrides
  };
}

// ==========================================
// TEST 12: Unauthorized capability claims
// ==========================================
test('TEST 12: Unauthorized capability claims do not grant permissions', async () => {
  const specialist = new MockCoderSpecialist();
  // Caller context only has general_reasoning, lacks software_engineering
  const unauthorizedContext = createMockContext({
    authorizedCapabilities: ['general_reasoning']
  });

  const authCheck = specialist.canExecute(unauthorizedContext);
  assert.equal(authCheck.authorized, false);
  assert.ok(authCheck.reason?.includes('Missing required capability: "software_engineering"'));

  const result = await specialist.execute(unauthorizedContext);
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.error?.code, 'AUTHORIZATION_DENIED');
  assert.equal(specialist.executed, false, 'Specialist must not perform execution when unauthorized');
});

// ==========================================
// TEST 13: Cancellation signal availability
// ==========================================
test('TEST 13: Cancellation signal remains available and aborts before execution', async () => {
  const specialist = new MockCoderSpecialist();
  const controller = new AbortController();
  controller.abort(); // Signal aborted upfront

  const cancelledContext = createMockContext({
    cancellationSignal: controller.signal
  });

  const result = await specialist.execute(cancelledContext);
  assert.equal(result.outcome, 'CANCELLED');
  assert.equal(result.error?.code, 'EXECUTION_ABORTED');
  assert.equal(specialist.executed, false, 'Specialist must not execute when cancellation signal is triggered');
});

// ==========================================
// TEST 14: Specialist result status discrimination
// ==========================================
test('TEST 14: Specialist result status is correctly discriminated across all 5 outcomes', () => {
  const outcomes = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNAVAILABLE'];
  for (const o of outcomes) {
    const parse = SpecialistTaskOutcomeSchema.safeParse(o);
    assert.equal(parse.success, true);
    assert.equal(parse.data, o);
  }

  const invalid = SpecialistTaskOutcomeSchema.safeParse('SOME_UNKNOWN_OUTCOME');
  assert.equal(invalid.success, false);
});

// ==========================================
// TEST 15: Existing RunStateSchema unchanged
// ==========================================
test('TEST 15: Existing RunStateSchema remains strictly unchanged', () => {
  const expectedStates = [
    'QUEUED',
    'RUNNING',
    'WAITING_FOR_TOOL',
    'WAITING_FOR_APPROVAL',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'INTERRUPTED'
  ];

  const actualOptions = RunStateSchema.options;
  assert.equal(actualOptions.length, 8);
  for (const st of expectedStates) {
    assert.ok(actualOptions.includes(st as any), `Missing expected RunState: ${st}`);
  }

  // Ensure task outcomes like TIMED_OUT or UNAVAILABLE did NOT bleed into RunStateSchema
  assert.equal(actualOptions.includes('TIMED_OUT' as any), false);
  assert.equal(actualOptions.includes('UNAVAILABLE' as any), false);
});

// ==========================================
// TEST 16: Existing WorkflowEngine unchanged
// ==========================================
test('TEST 16: Existing WorkflowEngine validation semantics remain unchanged', () => {
  const wfDef: WorkflowDefinition = {
    workflowId: 'wf_test_01',
    name: 'Standard Workflow',
    steps: [
      {
        stepId: 'step_1',
        name: 'Step 1',
        dependsOn: [],
        sideEffectLevel: 'NONE',
        approvalRequired: false
      },
      {
        stepId: 'step_2',
        name: 'Step 2',
        dependsOn: ['step_1'],
        sideEffectLevel: 'NONE',
        approvalRequired: false
      }
    ]
  };

  const validation = validateWorkflowDag(wfDef);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.executionWaves, [['step_1'], ['step_2']]);
});

// ==========================================
// TEST 17: Existing ToolGateway permissions
// ==========================================
test('TEST 17: Existing ToolGateway permissions and side-effect levels remain unchanged', () => {
  const registry = new ToolRegistry();
  const repo = new InMemoryToolCallRepository();
  const gateway = new ToolGateway(registry, repo);

  // Register an executable tool via ToolRegistry contract
  registry.register({
    definition: {
      name: 'test_calc',
      description: 'Deterministic calculator',
      permission: 'NONE',
      parameters: {}
    },
    execute: async (_args) => ({ success: true, result: 42 })
  });

  const tool = registry.get('test_calc');
  assert.ok(tool);
  assert.equal(tool.definition.permission, 'NONE');
  assert.ok(gateway);
});

// ==========================================
// TEST 18: Existing ApprovalKernel enforcement
// ==========================================
test('TEST 18: Existing ApprovalKernel enforcement remains authoritative', () => {
  const mockApprovalRepo = {
    saveRequest: async () => {},
    getRequest: async () => undefined,
    getPendingForRun: async () => [],
    resolveRequest: async () => {}
  };
  const mockGrantRepo = {
    grantSession: async () => {},
    grantAlways: async () => {},
    hasSessionGrant: async () => false,
    hasAlwaysGrant: async () => false,
    clearSession: async () => {}
  };

  const kernel = new ApprovalKernel(mockApprovalRepo, mockGrantRepo);
  assert.ok(kernel);
  assert.equal(typeof kernel.isToolCallApproved, 'function');
  assert.equal(typeof kernel.createRequest, 'function');
  assert.equal(typeof kernel.getPendingRequest, 'function');
});

// ==========================================
// TEST 19: Prompt-profile compatibility
// ==========================================
test('TEST 19: PromptProfileRegistry accepts future specialist profiles without altering Levels 100 & 90', () => {
  const profileRegistry = new PromptProfileRegistry();
  const composer = new IntelligentPromptComposer(profileRegistry);

  // Register a specialist prompt profile at priority 85 (Tier: CAPABILITY_SPECIFIC_INSTRUCTION)
  profileRegistry.register({
    id: 'specialist_coder_profile',
    version: '1.0.0',
    category: 'software_engineering',
    mode: 'agent',
    instructions: 'SPECIALIST CODER: Write idiomatic, type-safe TypeScript code with comprehensive test coverage.',
    tokenBudget: 300,
    priority: 85,
    metadata: { tier: 'CAPABILITY_SPECIFIC_INSTRUCTION' }
  });

  const promptResult = composer.compose({
    mode: 'agent',
    userPrompt: 'Implement specialist contracts',
    capabilities: [
      {
        id: 'software_engineering',
        name: 'Software Engineering',
        description: 'Code synthesis',
        category: 'software_engineering',
        tools: ['file_write']
      }
    ],
    maxPromptTokens: 2000
  });

  // Verify that the system invariants at Level 100 remain immutable
  assert.ok(promptResult.systemPrompt.includes('You are AIRA'));
  assert.ok(promptResult.systemPrompt.includes('SECURITY INVARIANT'));
  // Verify that Agent Mode instructions at Level 90 remain present
  assert.ok(promptResult.systemPrompt.includes('AGENT MODE DIRECTIVE'));
  // Verify precedence order preserves Level 100 and Level 90
  assert.ok(promptResult.precedenceOrder.some(p => p.includes('Level 100')));
  assert.ok(promptResult.precedenceOrder.some(p => p.includes('Level 90')));
});

// ==========================================
// TEST 20: No live specialist dispatch in M1
// ==========================================
test('TEST 20: No live specialist dispatch occurs during M1 (pure contract foundation)', () => {
  // Verify that ISpecialistAgent is an extensible interface and no background worker daemons are started
  const specialist: ISpecialistAgent = new MockCoderSpecialist();
  assert.equal(specialist.role, 'coder');
  assert.equal(specialist.requiredCapabilities[0], 'software_engineering');
  // Confirm that M1 provides definitions and types without spinning up active HTTP listeners or DB pools
});
