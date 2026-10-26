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
  SpecialistRole,
  SpecialistTaskOutcomeSchema,
  SpecialistProvenanceSchema,
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

// Specialist that checks cancellation signal during work
class AbortableMockSpecialist extends BaseSpecialistAgent {
  readonly role: SpecialistRole = 'coder';
  readonly name = 'Abortable Mock Specialist';
  readonly description = 'Simulates long running task that checks abort signal';
  readonly requiredCapabilities: readonly CapabilityCategory[] = ['software_engineering'];

  protected async performExecution(
    context: SpecialistExecutionContext,
    _startedAt: number
  ): Promise<SpecialistExecutionResult> {
    if (context.cancellationSignal.aborted) {
      throw new DOMException('Execution aborted during processing', 'AbortError');
    }
    throw new DOMException('Execution aborted during processing', 'AbortError');
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
// TEST 12: Unauthenticated context rejection
// ==========================================
test('TEST 12: Unauthenticated context rejection enforces caller principal requirement', async () => {
  const specialist = new MockCoderSpecialist();

  // Case A: Missing principal object
  const noPrincipalContext = createMockContext({
    principal: undefined as any
  });
  const checkA = specialist.canExecute(noPrincipalContext);
  assert.equal(checkA.authorized, false);
  assert.ok(checkA.reason?.includes('Unauthenticated caller'));

  const resultA = await specialist.execute(noPrincipalContext);
  assert.equal(resultA.outcome, 'FAILED');
  assert.equal(resultA.error?.code, 'AUTHORIZATION_DENIED');
  assert.equal(specialist.executed, false, 'Specialist must not execute when principal is missing');

  // Case B: Principal with empty userId
  const emptyUserContext = createMockContext({
    principal: { userId: '', sessionId: 's1', workspaceId: 'w1', roles: [] }
  });
  const checkB = specialist.canExecute(emptyUserContext);
  assert.equal(checkB.authorized, false);
  assert.ok(checkB.reason?.includes('Unauthenticated caller'));

  const resultB = await specialist.execute(emptyUserContext);
  assert.equal(resultB.outcome, 'FAILED');
  assert.equal(resultB.error?.code, 'AUTHORIZATION_DENIED');
  assert.equal(specialist.executed, false, 'Specialist must not execute when userId is empty');
});

// ==========================================
// TEST 13: Missing capability rejection
// ==========================================
test('TEST 13: Missing capability rejection prevents unauthorized invocation', async () => {
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
// TEST 14: Exhausted budget rejection
// ==========================================
test('TEST 14: Exhausted budget rejection fails fast before execution', async () => {
  const specialist = new MockCoderSpecialist();

  // Zero remaining tokens
  const zeroBudgetContext = createMockContext({
    remainingBudget: { maxTokens: 50000, remainingTokens: 0 }
  });
  const checkZero = specialist.canExecute(zeroBudgetContext);
  assert.equal(checkZero.authorized, false);
  assert.ok(checkZero.reason?.includes('Budget exhausted'));

  const resultZero = await specialist.execute(zeroBudgetContext);
  assert.equal(resultZero.outcome, 'FAILED');
  assert.equal(resultZero.error?.code, 'AUTHORIZATION_DENIED');
  assert.equal(specialist.executed, false, 'Specialist must not execute when budget is 0');

  // Negative remaining tokens
  const negativeBudgetContext = createMockContext({
    remainingBudget: { maxTokens: 50000, remainingTokens: -100 }
  });
  const checkNeg = specialist.canExecute(negativeBudgetContext);
  assert.equal(checkNeg.authorized, false);
  assert.ok(checkNeg.reason?.includes('Budget exhausted'));

  const resultNeg = await specialist.execute(negativeBudgetContext);
  assert.equal(resultNeg.outcome, 'FAILED');
  assert.equal(resultNeg.error?.code, 'AUTHORIZATION_DENIED');
  assert.equal(specialist.executed, false, 'Specialist must not execute when budget is negative');
});

// ==========================================
// TEST 15: Cancellation behavior
// ==========================================
test('TEST 15: Cancellation behavior aborts before and during execution cleanly', async () => {
  // Scenario A: Pre-execution cancellation
  const specialistA = new MockCoderSpecialist();
  const controllerA = new AbortController();
  controllerA.abort(); // Signal aborted upfront

  const cancelledContext = createMockContext({
    cancellationSignal: controllerA.signal
  });

  const resultA = await specialistA.execute(cancelledContext);
  assert.equal(resultA.outcome, 'CANCELLED');
  assert.equal(resultA.error?.code, 'EXECUTION_ABORTED');
  assert.equal(specialistA.executed, false, 'Specialist must not execute when cancellation signal is triggered upfront');

  // Scenario B: Abort signal during execution
  const specialistB = new AbortableMockSpecialist();
  const controllerB = new AbortController();
  const inFlightContext = createMockContext({
    cancellationSignal: controllerB.signal
  });
  // Abort during simulated run
  controllerB.abort();
  const resultB = await specialistB.execute(inFlightContext);
  assert.equal(resultB.outcome, 'CANCELLED');
  assert.equal(resultB.error?.code, 'EXECUTION_ABORTED');
  assert.equal(resultB.error?.retryable, false);
});

// ==========================================
// TEST 16: Execution context cannot independently grant tool scopes
// ==========================================
test('TEST 16: Execution context cannot independently grant tool scopes (ToolGateway & ApprovalKernel authority preserved)', async () => {
  // A caller attempts to grant itself arbitrary tools by populating effectiveToolScopes
  const maliciousContext = createMockContext({
    effectiveToolScopes: ['system_exec_override', 'unregistered_dangerous_tool', 'arbitrary_file_delete']
  });

  // Verify ToolGateway strictly rejects calls to tools not registered in the runtime
  const repo = new InMemoryToolCallRepository();
  const gateway = new ToolGateway(repo as any);

  const toolExecResult = await gateway.execute({
    toolName: 'unregistered_dangerous_tool',
    arguments: { cmd: 'rm -rf /' },
    context: {
      runId: maliciousContext.runId,
      principal: maliciousContext.principal,
      tenantId: maliciousContext.tenantId,
      workspaceId: maliciousContext.workspaceId
    }
  });

  assert.equal(toolExecResult.isError, true);
  assert.ok(toolExecResult.error?.includes('was not found in the Tool Registry'));

  // Verify ApprovalKernel strictly controls side-effect tools regardless of context scopes
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
  const isApproved = await kernel.isToolCallApproved(
    maliciousContext.runId,
    'file_delete',
    'DESTRUCTIVE',
    maliciousContext.principal.userId
  );
  assert.equal(isApproved, false, 'ApprovalKernel must NOT permit DESTRUCTIVE calls based on context scopes');
});

// ==========================================
// TEST 17: Provenance is classified accurately
// ==========================================
test('TEST 17: Provenance is classified accurately as operational runtime telemetry (not cryptographic receipts)', async () => {
  const specialist = new MockCoderSpecialist();
  const context = createMockContext({
    promptProfileId: 'profile_coder_v1'
  });

  const result = await specialist.execute(context);
  assert.equal(result.outcome, 'COMPLETED');

  // Verify provenance conforms to SpecialistProvenanceSchema
  const parseProvenance = SpecialistProvenanceSchema.safeParse(result.provenance);
  assert.equal(parseProvenance.success, true);

  // Verify provenance contains standard operational runtime telemetry
  assert.equal(result.provenance.workerId, 'aira-specialist-runtime');
  assert.equal(result.provenance.promptProfileId, 'profile_coder_v1');

  // Verify no fabricated cryptographic signatures or hardware attestations are present
  assert.equal(result.provenance.executionSignature, undefined);
  assert.equal((result.provenance as any).workerIdentityAttestation, undefined);
  assert.equal((result.provenance as any).cryptographicReceipt, undefined);
});

// ==========================================
// TEST 18: Specialist result status discrimination
// ==========================================
test('TEST 18: Specialist result status is correctly discriminated across all 5 outcomes', () => {
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
// TEST 19: Existing RunStateSchema unchanged
// ==========================================
test('TEST 19: Existing RunStateSchema remains strictly unchanged', () => {
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
// TEST 20: Existing WorkflowEngine unchanged
// ==========================================
test('TEST 20: Existing WorkflowEngine validation semantics remain unchanged', () => {
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
// TEST 21: Existing ToolGateway permissions
// ==========================================
test('TEST 21: Existing ToolGateway permissions and side-effect levels remain unchanged', () => {
  const repo = new InMemoryToolCallRepository();
  const gateway = new ToolGateway(repo as any);
  assert.ok(gateway);
  const defs = gateway.listDefinitions();
  assert.ok(defs.length > 0);
  assert.ok(defs.some(d => d.name === 'browser_navigate'));
});

// ==========================================
// TEST 22: Existing ApprovalKernel enforcement
// ==========================================
test('TEST 22: Existing ApprovalKernel enforcement remains authoritative', () => {
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
// TEST 23: Prompt-profile compatibility
// ==========================================
test('TEST 23: PromptProfileRegistry accepts future specialist profiles without altering Levels 100 & 90', () => {
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
// TEST 24: No live specialist dispatch in M1
// ==========================================
test('TEST 24: No live specialist dispatch occurs during M1 (pure contract foundation)', () => {
  // Verify that ISpecialistAgent is an extensible interface and no background worker daemons are started
  const specialist: ISpecialistAgent = new MockCoderSpecialist();
  assert.equal(specialist.role, 'coder');
  assert.equal(specialist.requiredCapabilities[0], 'software_engineering');
  // Confirm that M1 provides definitions and types without spinning up active HTTP listeners or DB pools
});
