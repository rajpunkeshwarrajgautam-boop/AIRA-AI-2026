import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveIsolatedSandboxProvider,
  LocalIsolatedSandboxProvider,
  DockerIsolatedSandboxProvider,
  MultiProviderSandboxFactory
} from '../packages/builder-runtime/src/sandbox.js';
import { ToolGateway } from '../packages/tool-runtime/src/gateway.js';
import { InMemoryToolCallRepository } from '../packages/tool-runtime/src/repository.js';
import type { ExecutionPrincipal } from '../packages/contracts/src/index.js';

test('Mission B2 — Sandbox Selection Reconciliation Across Every Execution Path', async (t) => {
  const principal: ExecutionPrincipal = {
    userId: 'user_sandbox_audit',
    sessionId: 'session_sandbox_audit',
    workspaceId: 'ws_audit',
    scopes: ['*']
  };

  await t.test('1. resolveIsolatedSandboxProvider Fails Closed When Container Required but Unavailable', () => {
    const docker = new DockerIsolatedSandboxProvider();

    if (!docker.isConfigured()) {
      assert.throws(
        () => {
          resolveIsolatedSandboxProvider({ requireContainer: true });
        },
        /CONTAINER_ISOLATION_UNAVAILABLE/,
        'Must fail closed when container runtime is required but unavailable'
      );
    } else {
      const provider = resolveIsolatedSandboxProvider({ requireContainer: true });
      assert.equal(provider.name, 'docker');
    }
  });

  await t.test('2. MultiProviderSandboxFactory Prevents Unrestricted Host Fallbacks', async () => {
    const factory = new MultiProviderSandboxFactory();
    const abortCtrl = new AbortController();

    // If container is required, creating a workspace on a host-only provider must reject
    const localProvider = new LocalIsolatedSandboxProvider();
    await assert.rejects(
      async () => {
        await localProvider.createWorkspace({
          allowInternet: false,
          allowPreview: false,
          timeoutMs: 10000,
          requireContainer: true,
          signal: abortCtrl.signal
        });
      },
      /CONTAINER_ISOLATION_REQUIRED/,
      'Local host provider must fail closed if container is required'
    );
  });

  await t.test('3. ToolGateway python_sandbox Uses Isolated Sandbox and Fails Closed', async () => {
    const approvalKernel = {
      isToolCallApproved: async () => true,
      claimOnceAuthorization: async () => true,
      createRequest: async () => ({ id: 'req_1' }),
    } as any;
    const gateway = new ToolGateway(new InMemoryToolCallRepository(), approvalKernel);

    // 3a. Normal safe python code execution
    const res = await gateway.executeTool('python_sandbox', {
      code: 'print("EXECUTION_SUCCEEDED_SAFELY")'
    }, {
      runId: 'run_test_audit_01',
      principal,
      effectiveToolScopes: ['*']
    });

    assert.equal(res.isError, false);
    assert.ok(res.output.stdout.includes('EXECUTION_SUCCEEDED_SAFELY'));

    // 3b. When requireContainer is demanded and Docker is unavailable, fails closed
    const docker = new DockerIsolatedSandboxProvider();
    if (!docker.isConfigured()) {
      const failedRes = await gateway.executeTool('python_sandbox', {
        code: 'print("SHOULD_NOT_RUN")',
        requireContainer: true
      }, {
        runId: 'run_test_audit_02',
        principal,
        effectiveToolScopes: ['*']
      });

      assert.equal(failedRes.isError, true);
      assert.match(failedRes.error || '', /CONTAINER_ISOLATION_UNAVAILABLE/);
    }

    // 3c. Adversarial arbitrary command injection attempt inside Python tool
    const exploitRes = await gateway.executeTool('python_sandbox', {
      code: `
import subprocess
try:
    subprocess.Popen(["calc.exe"])
    print("SUBPROCESS_EXECUTED")
except Exception as e:
    print(f"BLOCKED: {e}")
`
    }, {
      runId: 'run_test_audit_03',
      principal,
      effectiveToolScopes: ['*']
    });

    assert.equal(exploitRes.isError, false);
    assert.ok(exploitRes.output.stdout.includes('BLOCKED: AIRA_SANDBOX_POLICY_VIOLATION'));
    assert.ok(!exploitRes.output.stdout.includes('SUBPROCESS_EXECUTED'));
  });
});
