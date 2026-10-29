import test from 'node:test';
import assert from 'node:assert/strict';
import { DevPrincipalProvider } from '../apps/api/src/auth/principal-provider.js';
import {
  derivePersonalWorkspaceId,
  InMemoryWorkspaceAuthorityRepository
} from '../packages/agent-runtime/src/workspace-authority.js';
import { InMemoryToolCallRepository, ToolGateway } from '../packages/tool-runtime/src/index.js';
import type { ExecutionPrincipal, ToolDefinition } from '../packages/contracts/src/index.js';

test('trusted identities resolve persisted server-owned workspaces; client headers cannot select them', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousVercelEnv = process.env.VERCEL_ENV;
  const authority = new InMemoryWorkspaceAuthorityRepository();
  const provider = new DevPrincipalProvider(authority);

  try {
    assert.equal(
      await authority.isWorkspaceActive('not-provisioned', derivePersonalWorkspaceId('not-provisioned')),
      false,
      'Missing authority is not active until the server provisions a trusted principal.'
    );
    assert.equal(await authority.revokeWorkspace('revoked-before-first-login'), true);
    await assert.rejects(
      () => authority.resolveWorkspace('revoked-before-first-login'),
      /no active workspace authority/i,
      'A pre-provisioning revocation must remain a deny tombstone.'
    );

    process.env.NODE_ENV = 'test';
    delete process.env.VERCEL_ENV;
    const testPrincipal = await provider.resolve({
      headers: {
        'x-test-user-id': 'integration-test-user',
        'x-test-session-id': 'integration-test-session',
        'x-workspace-id': 'client-selected-foreign-workspace',
        'x-project-id': 'client-selected-foreign-project'
      }
    } as any);
    assert.equal(testPrincipal.userId, 'integration-test-user');
    assert.equal(testPrincipal.workspaceId, derivePersonalWorkspaceId('integration-test-user'));
    assert.notEqual(testPrincipal.workspaceId, 'client-selected-foreign-workspace');
    assert.equal(testPrincipal.projectId, undefined, 'Client project headers cannot select a project without a server-side membership record.');
    assert.equal(
      await authority.isWorkspaceActive('another-principal', testPrincipal.workspaceId!),
      false,
      'A principal cannot claim a different principal\'s personal workspace.'
    );

    process.env.NODE_ENV = 'production';
    const deployedPrincipal = await provider.resolve({
      user: { id: 'verified-user', sessionId: 'verified-session', workspaceId: 'spoofed-user-field', projectId: 'spoofed-user-project' },
      headers: { 'x-workspace-id': 'integration-foreign-workspace' }
    } as any);
    assert.equal(deployedPrincipal.userId, 'verified-user');
    assert.equal(deployedPrincipal.workspaceId, derivePersonalWorkspaceId('verified-user'));
    assert.notEqual(deployedPrincipal.workspaceId, 'integration-foreign-workspace');
    assert.equal(deployedPrincipal.projectId, undefined, 'Unverified session project fields cannot select a project.');

    const managedPrincipal = await provider.resolve({
      managedIdentity: { userId: 'managed-user', sessionId: 'managed-session' },
      headers: { 'x-workspace-id': 'integration-foreign-workspace' }
    } as any);
    assert.equal(managedPrincipal.userId, 'managed-user');
    assert.equal(managedPrincipal.workspaceId, derivePersonalWorkspaceId('managed-user'));

    assert.equal(await authority.isWorkspaceActive('verified-user', deployedPrincipal.workspaceId!), true);
    assert.equal(await authority.revokeWorkspace('verified-user'), true);
    await assert.rejects(
      () => provider.resolve({
        user: { id: 'verified-user', sessionId: 'verified-session' },
        headers: {}
      } as any),
      /no active workspace authority/i
    );
    assert.equal(await authority.isWorkspaceActive('verified-user', deployedPrincipal.workspaceId!), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercelEnv;
  }
});

test('ToolGateway requires active server-owned workspace authority even for direct read-tool dispatch', async () => {
  const authority = new InMemoryWorkspaceAuthorityRepository();
  const repository = new InMemoryToolCallRepository();
  const gateway = new ToolGateway(repository, undefined, process.cwd(), authority);
  let adapterCalls = 0;
  const definition: ToolDefinition = {
    id: 'tool_authority_read_test', name: 'authority_read_test', version: 1,
    description: 'Read tool used to verify workspace authority enforcement.',
    category: 'utility', parameters: { type: 'object', properties: {} }, source: 'native',
    permissionLevel: 'READ', sideEffectLevel: 'READ', permissionScopes: [], approvalPolicy: 'autonomous',
    executionRuntime: 'LOCAL', executionMode: 'sync', timeoutMs: 5000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, factor: 2, retryableErrorCodes: [] },
    idempotencyPolicy: { required: false }, availability: 'READY', adapter: 'native',
    provider: 'test', metadata: {}
  };
  gateway.registerTool({
    definition,
    async execute() { adapterCalls += 1; return { authorized: true }; }
  });

  const untrustedPrincipal: ExecutionPrincipal = {
    userId: 'gateway-owner', sessionId: 'gateway-session', workspaceId: 'spoofed-workspace', scopes: ['*']
  };
  const denied = await gateway.execute({
    toolName: definition.name, arguments: {}, context: { runId: 'gateway-denied-run', principal: untrustedPrincipal }
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.errorCode, 'TOOL_PERMISSION_DENIED');
  assert.equal(adapterCalls, 0);

  const authorizedWorkspaceId = await authority.resolveWorkspace(untrustedPrincipal.userId);
  const allowed = await gateway.execute({
    toolName: definition.name,
    arguments: {},
    context: {
      runId: 'gateway-authorized-run',
      principal: { ...untrustedPrincipal, workspaceId: authorizedWorkspaceId }
    }
  });
  assert.equal(allowed.isError, false);
  assert.equal(adapterCalls, 1);

  class RevokesAfterInitialCheck extends InMemoryWorkspaceAuthorityRepository {
    private checks = 0;
    override async isWorkspaceActive(principalId: string, workspaceId: string): Promise<boolean> {
      this.checks += 1;
      return this.checks === 1 && await super.isWorkspaceActive(principalId, workspaceId);
    }
  }
  const revokingAuthority = new RevokesAfterInitialCheck();
  const revokingWorkspaceId = await revokingAuthority.resolveWorkspace(untrustedPrincipal.userId);
  const revokingGateway = new ToolGateway(new InMemoryToolCallRepository(), undefined, process.cwd(), revokingAuthority);
  let revocationAdapterCalls = 0;
  revokingGateway.registerTool({
    definition,
    async execute() { revocationAdapterCalls += 1; return { shouldNotRun: true }; }
  });
  const revokedBeforeDispatch = await revokingGateway.execute({
    toolName: definition.name,
    arguments: {},
    context: {
      runId: 'gateway-revoked-before-dispatch',
      principal: { ...untrustedPrincipal, workspaceId: revokingWorkspaceId }
    }
  });
  assert.equal(revokedBeforeDispatch.isError, true);
  assert.equal(revokedBeforeDispatch.errorCode, 'TOOL_PERMISSION_DENIED');
  assert.equal(revocationAdapterCalls, 0, 'A revocation between admission and dispatch must stop the adapter.');
});
