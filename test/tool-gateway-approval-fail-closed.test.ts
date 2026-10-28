import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { InMemoryToolCallRepository, ToolGateway } from '../packages/tool-runtime/src/index.js';
import type { ApprovalRequest, ExecutionPrincipal, PermissionLevel, ToolDefinition } from '../packages/contracts/src/index.js';

const principal: ExecutionPrincipal = {
  userId: 'user_gateway_approval_test',
  sessionId: 'session_gateway_approval_test',
  role: 'user'
};

function writeDefinition(name = 'approval_test_write'): ToolDefinition {
  return {
    id: `tool_${name}`,
    name,
    description: 'Test write tool used to verify fail-closed approval behavior.',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    permissionLevel: 'WRITE',
    sideEffectLevel: 'WRITE',
    permissionScopes: [],
    approvalPolicy: 'require_approval',
    executionRuntime: 'LOCAL',
    version: 1,
    category: 'utility',
    executionMode: 'sync',
    timeoutMs: 30000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, factor: 2, retryableErrorCodes: [] },
    idempotencyPolicy: { required: false },
    availability: 'READY',
    adapter: 'native',
    provider: 'test',
    metadata: {}
  };
}

function autonomousDefinition(
  name: string,
  permissionLevel: ToolDefinition['permissionLevel'],
  sideEffectLevel: NonNullable<ToolDefinition['sideEffectLevel']>
): ToolDefinition {
  return {
    ...writeDefinition(name),
    permissionLevel,
    sideEffectLevel,
    approvalPolicy: 'autonomous'
  };
}

const contradictoryToolCases = [
  {
    name: 'write_permission_none_side_effect',
    permissionLevel: 'WRITE',
    sideEffectLevel: 'NONE'
  },
  {
    name: 'destructive_permission_read_side_effect',
    permissionLevel: 'DESTRUCTIVE',
    sideEffectLevel: 'READ'
  },
  {
    name: 'read_permission_write_side_effect',
    permissionLevel: 'READ',
    sideEffectLevel: 'WRITE'
  },
  {
    name: 'read_permission_destructive_side_effect',
    permissionLevel: 'READ',
    sideEffectLevel: 'DESTRUCTIVE'
  }
] satisfies Array<{
  name: string;
  permissionLevel: ToolDefinition['permissionLevel'];
  sideEffectLevel: NonNullable<ToolDefinition['sideEffectLevel']>;
}>;

function readDefinition(): ToolDefinition {
  return {
    id: 'tool_approval_test_read',
    name: 'approval_test_read',
    description: 'Test read-only tool.',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    permissionLevel: 'READ',
    sideEffectLevel: 'READ',
    permissionScopes: [],
    approvalPolicy: 'autonomous',
    executionRuntime: 'LOCAL',
    version: 1,
    category: 'utility',
    executionMode: 'sync',
    timeoutMs: 30000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, factor: 2, retryableErrorCodes: [] },
    idempotencyPolicy: { required: false },
    availability: 'READY',
    adapter: 'native',
    provider: 'test',
    metadata: {}
  };
}

function createGatewayWithDefinition(
  definition: ToolDefinition,
  execute: () => Promise<unknown> | unknown,
  approvalKernel?: ApprovalKernel
): ToolGateway {
  const gateway = new ToolGateway(new InMemoryToolCallRepository(), approvalKernel);
  gateway.registerTool({
    definition,
    execute: async () => execute()
  });
  return gateway;
}

function createGateway(
  execute: () => Promise<unknown> | unknown,
  approvalKernel?: ApprovalKernel
): ToolGateway {
  return createGatewayWithDefinition(writeDefinition(), execute, approvalKernel);
}

function invocation(toolName = 'approval_test_write') {
  return {
    toolName,
    arguments: {},
    context: { runId: 'run_gateway_approval_test', principal }
  };
}

async function repositoryWithCompletedCall(
  idempotencyKey: string,
  cachedPrincipalId: unknown,
  runId = 'run_gateway_approval_test'
): Promise<InMemoryToolCallRepository> {
  const repository = new InMemoryToolCallRepository();
  await repository.saveToolCall({
    id: `completed_${idempotencyKey}`,
    runId,
    principalId: cachedPrincipalId as string,
    toolId: 'tool_approval_test_read',
    toolName: 'approval_test_read',
    adapter: 'native',
    sideEffectLevel: 'READ',
    permissionScopes: [],
    lifecycleState: 'COMPLETED',
    arguments: {},
    output: { fromCache: true },
    attemptCount: 1,
    idempotencyKey,
    startedAt: Date.now()
  });
  return repository;
}

function inMemoryApprovalKernel(options: {
  failSaveRequest?: boolean;
  approved?: boolean;
  requestSink?: ApprovalRequest[];
} = {}): ApprovalKernel {
  const requests = new Map<string, ApprovalRequest>();
  const approvalRepository = {
    async saveRequest(request: ApprovalRequest) {
      if (options.failSaveRequest) throw new Error('simulated approval persistence failure');
      requests.set(request.id, request);
      options.requestSink?.push(request);
    },
    async getRequest(id: string) {
      return requests.get(id);
    },
    async getPendingForRun(runId: string) {
      return [...requests.values()].filter(request => request.runId === runId && !request.decision);
    },
    async resolveRequest(id: string, decision: ApprovalRequest['decision'], resolvedBy: string) {
      const request = requests.get(id);
      if (request) {
        request.decision = decision;
        request.resolvedBy = resolvedBy;
        request.resolvedAt = Date.now();
      }
    }
  };
  const grantRepository = {
    async grantSession() {},
    async grantAlways() {},
    async hasSessionGrant() { return false; },
    async hasAlwaysGrant() { return options.approved === true; },
    async clearSession() {}
  };

  return new ApprovalKernel(approvalRepository, grantRepository);
}

test('approval-required tool is denied and adapter is not called when ApprovalKernel is missing', async () => {
  let adapterCalls = 0;
  const gateway = createGateway(() => { adapterCalls++; return { ok: true }; });

  const result = await gateway.execute(invocation());

  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'TOOL_APPROVAL_DENIED');
  assert.match(result.error || '', /approval could not be verified/i);
  assert.equal(adapterCalls, 0);
});

for (const toolCase of contradictoryToolCases) {
  test(`${toolCase.name} requires approval even with autonomous policy and no kernel`, async () => {
    let adapterCalls = 0;
    const definition = autonomousDefinition(
      toolCase.name,
      toolCase.permissionLevel,
      toolCase.sideEffectLevel
    );
    const gateway = createGatewayWithDefinition(
      definition,
      () => { adapterCalls++; return { ok: true }; }
    );

    const result = await gateway.execute({
      toolName: definition.name,
      arguments: {},
      context: { runId: 'run_gateway_approval_test', principal }
    });

    assert.equal(result.isError, true);
    assert.equal(result.errorCode, 'TOOL_APPROVAL_DENIED');
    assert.equal(adapterCalls, 0);
  });
}

test('contradictory WRITE and DESTRUCTIVE classifications remain pending without valid approval', async () => {
  for (const toolCase of contradictoryToolCases) {
    let adapterCalls = 0;
    const definition = autonomousDefinition(
      toolCase.name,
      toolCase.permissionLevel,
      toolCase.sideEffectLevel
    );
    const gateway = createGatewayWithDefinition(
      definition,
      () => { adapterCalls++; return { ok: true }; },
      inMemoryApprovalKernel()
    );

    const result = await gateway.execute({
      toolName: definition.name,
      arguments: {},
      context: { runId: 'run_gateway_approval_test', principal }
    });

    assert.equal(result.isError, false, toolCase.name);
    assert.equal(result.output?.status, 'WAITING_FOR_APPROVAL', toolCase.name);
    assert.equal(adapterCalls, 0, toolCase.name);
  }
});

for (const [label, cachedPrincipalId] of [
  ['missing', undefined],
  ['null', null],
  ['empty', ''],
  ['mismatched', 'different_user_gateway_approval_test']
] as const) {
  test(`completed idempotency replay denies ${label} cached ownership without adapter dispatch`, async () => {
    const idempotencyKey = `ownership_${label}_key`;
    const repository = await repositoryWithCompletedCall(idempotencyKey, cachedPrincipalId);
    let adapterCalls = 0;
    const cachedGateway = new ToolGateway(repository);
    cachedGateway.registerTool({
      definition: readDefinition(),
      execute: async () => { adapterCalls++; return { fromAdapter: true }; }
    });

    const result = await cachedGateway.execute({
      toolName: 'approval_test_read',
      arguments: {},
      context: {
        runId: 'run_gateway_approval_test',
        principal,
        idempotencyKey
      }
    });

    assert.equal(result.isError, true);
    assert.equal(result.errorCode, 'TOOL_PERMISSION_DENIED');
    assert.equal(result.output, null);
    assert.match(result.error || '', /ownership could not be verified/i);
    assert.equal(adapterCalls, 0);
  });
}

test('completed idempotency replay returns cached result for exact non-empty owner without adapter dispatch', async () => {
  const idempotencyKey = 'ownership_authorized_key';
  const repository = await repositoryWithCompletedCall(idempotencyKey, principal.userId);
  let adapterCalls = 0;
  const gateway = new ToolGateway(repository);
  gateway.registerTool({
    definition: readDefinition(),
    execute: async () => { adapterCalls++; return { fromAdapter: true }; }
  });

  const result = await gateway.execute({
    toolName: 'approval_test_read',
    arguments: {},
    context: {
      runId: 'run_gateway_approval_test',
      principal,
      idempotencyKey
    }
  });

  assert.equal(result.isError, false);
  assert.deepEqual(result.output, { fromCache: true });
  assert.equal(result.toolCallId, `completed_${idempotencyKey}`);
  assert.equal(adapterCalls, 0);
});

test('foreign run cache collision does not return the foreign cached result', async () => {
  const idempotencyKey = 'idem_run_source_token';
  const repository = await repositoryWithCompletedCall(idempotencyKey, principal.userId, 'run_source');
  let adapterCalls = 0;
  const gateway = new ToolGateway(repository);
  gateway.registerTool({
    definition: readDefinition(),
    execute: async () => { adapterCalls++; return { fromAdapter: true }; }
  });

  const result = await gateway.execute({
    toolName: 'approval_test_read',
    arguments: {},
    context: { runId: 'run_target', principal, idempotencyKey }
  });

  assert.equal(result.isError, false);
  assert.deepEqual(result.output, { fromAdapter: true });
  assert.equal(adapterCalls, 1);
});

test('approval-required idempotency replay is denied when ApprovalKernel is missing', async () => {
  let adapterCalls = 0;
  const repository = new InMemoryToolCallRepository();
  await repository.saveToolCall({
    id: 'completed_approval_test_call',
    runId: 'run_gateway_approval_test',
    principalId: principal.userId,
    toolId: 'tool_approval_test_write',
    toolName: 'approval_test_write',
    adapter: 'native',
    sideEffectLevel: 'WRITE',
    permissionScopes: [],
    lifecycleState: 'COMPLETED',
    arguments: {},
    output: { priorResult: true },
    attemptCount: 1,
    idempotencyKey: 'approval_test_idempotency_key',
    startedAt: Date.now()
  });
  const gateway = new ToolGateway(repository);
  gateway.registerTool({
    definition: writeDefinition(),
    execute: async () => { adapterCalls++; return { ok: true }; }
  });

  const result = await gateway.execute({
    ...invocation(),
    context: {
      ...invocation().context,
      idempotencyKey: 'approval_test_idempotency_key'
    }
  });

  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'TOOL_APPROVAL_DENIED');
  assert.equal(adapterCalls, 0);
});

test('approval lookup failure is denied and adapter is not called', async () => {
  let adapterCalls = 0;
  const failingLookupKernel = new ApprovalKernel(
    {
      async saveRequest() {},
      async getRequest() { return undefined; },
      async getPendingForRun() { return []; },
      async resolveRequest() {}
    },
    {
      async grantSession() {},
      async grantAlways() {},
      async hasSessionGrant() { return false; },
      async hasAlwaysGrant() { throw new Error('simulated grant-store outage'); },
      async clearSession() {}
    }
  );
  const gateway = createGateway(() => { adapterCalls++; return { ok: true }; }, failingLookupKernel);

  const result = await gateway.execute(invocation());

  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'TOOL_APPROVAL_DENIED');
  assert.match(result.error || '', /approval could not be verified/i);
  assert.equal(adapterCalls, 0);
});

test('approval-request persistence failure is denied and adapter is not called', async () => {
  let adapterCalls = 0;
  const gateway = createGateway(
    () => { adapterCalls++; return { ok: true }; },
    inMemoryApprovalKernel({ failSaveRequest: true })
  );

  const result = await gateway.execute(invocation());

  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'TOOL_APPROVAL_DENIED');
  assert.match(result.error || '', /approval could not be verified/i);
  assert.equal(adapterCalls, 0);
});

for (const financialCase of [
  { name: 'financial_with_write_side_effect', sideEffectLevel: 'WRITE', expectedPermission: 'FINANCIAL', expectedRisk: 'high' },
  { name: 'financial_with_destructive_side_effect', sideEffectLevel: 'DESTRUCTIVE', expectedPermission: 'DESTRUCTIVE', expectedRisk: 'critical' }
] as const) {
  test(`${financialCase.name} preserves the highest approval risk classification`, async () => {
    const requests: ApprovalRequest[] = [];
    const checkedPermissions: PermissionLevel[] = [];
    const kernel = inMemoryApprovalKernel({ requestSink: requests });
    const originalIsApproved = kernel.isToolCallApproved.bind(kernel);
    kernel.isToolCallApproved = async (runId, toolName, permission, principalId) => {
      checkedPermissions.push(permission);
      return originalIsApproved(runId, toolName, permission, principalId);
    };

    const definition = autonomousDefinition(
      financialCase.name,
      'FINANCIAL',
      financialCase.sideEffectLevel
    );
    const gateway = createGatewayWithDefinition(
      definition,
      () => ({ shouldNotRun: true }),
      kernel
    );

    const result = await gateway.execute({
      toolName: definition.name,
      arguments: {},
      context: { runId: 'run_gateway_approval_test', principal }
    });

    assert.equal(result.output?.status, 'WAITING_FOR_APPROVAL');
    assert.deepEqual(checkedPermissions, [financialCase.expectedPermission]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].risk, financialCase.expectedRisk);
  });
}

test('explicit require_approval on a READ tool is not auto-approved by the kernel', async () => {
  let adapterCalls = 0;
  const definition: ToolDefinition = {
    ...readDefinition(),
    approvalPolicy: 'require_approval'
  };
  const gateway = createGatewayWithDefinition(
    definition,
    () => { adapterCalls++; return { value: 'should-wait' }; },
    inMemoryApprovalKernel()
  );

  const result = await gateway.execute({
    toolName: definition.name,
    arguments: {},
    context: { runId: 'run_gateway_approval_test', principal }
  });

  assert.equal(result.isError, false);
  assert.equal(result.output?.status, 'WAITING_FOR_APPROVAL');
  assert.equal(adapterCalls, 0);
});

test('unapproved write remains pending and rejected write never invokes adapter', async () => {
  let adapterCalls = 0;
  const kernel = inMemoryApprovalKernel();
  const gateway = createGateway(() => { adapterCalls++; return { ok: true }; }, kernel);

  const pending = await gateway.execute(invocation());
  assert.equal(pending.isError, false);
  assert.equal(pending.output?.status, 'WAITING_FOR_APPROVAL');
  assert.ok(pending.output?.requestId);
  assert.equal(adapterCalls, 0);

  const decision = await kernel.decide(pending.output!.requestId, 'REJECT', principal.userId);
  assert.equal(decision.approved, false);
  assert.equal(adapterCalls, 0);
});

test('approved write executes exactly once', async () => {
  let adapterCalls = 0;
  const gateway = createGateway(
    () => { adapterCalls++; return { ok: true }; },
    inMemoryApprovalKernel({ approved: true })
  );

  const result = await gateway.execute(invocation());

  assert.equal(result.isError, false);
  assert.deepEqual(result.output, { ok: true });
  assert.equal(adapterCalls, 1);
});

test('read-only tool remains executable without ApprovalKernel', async () => {
  let adapterCalls = 0;
  const gateway = new ToolGateway(new InMemoryToolCallRepository());
  gateway.registerTool({
    definition: readDefinition(),
    execute: async () => { adapterCalls++; return { value: 'read-ok' }; }
  });

  const result = await gateway.execute(invocation('approval_test_read'));

  assert.equal(result.isError, false);
  assert.deepEqual(result.output, { value: 'read-ok' });
  assert.equal(adapterCalls, 1);
});
