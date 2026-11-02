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

  await t.test('1. resolveIsolatedSandboxProvider Enforces Isolated Backend by Default (Fails Closed)', () => {
    const docker = new DockerIsolatedSandboxProvider();

    if (!docker.isConfigured()) {
      // 1a. Default call without options MUST fail closed for untrusted workloads
      assert.throws(
        () => {
          resolveIsolatedSandboxProvider();
        },
        /CONTAINER_ISOLATION_UNAVAILABLE/,
        'Default call must fail closed when container runtime is unavailable'
      );

      // 1b. Explicit requireContainer also fails closed
      assert.throws(
        () => {
          resolveIsolatedSandboxProvider({ requireContainer: true });
        },
        /CONTAINER_ISOLATION_UNAVAILABLE/,
        'Must fail closed when requireContainer is explicitly true'
      );

      // 1c. Attempting trustedLocalExecution without environment toggle fails closed
      const prevEnv = process.env.AIRA_TRUSTED_LOCAL_EXECUTION;
      delete process.env.AIRA_TRUSTED_LOCAL_EXECUTION;
      delete process.env.AIRA_TRUSTED_HOST_EXECUTION;
      try {
        assert.throws(
          () => {
            resolveIsolatedSandboxProvider({ trustedLocalExecution: true });
          },
          /CONTAINER_ISOLATION_UNAVAILABLE/,
          'trustedLocalExecution must fail closed without explicit environment authorization'
        );
      } finally {
        if (prevEnv) process.env.AIRA_TRUSTED_LOCAL_EXECUTION = prevEnv;
      }
    } else {
      const provider = resolveIsolatedSandboxProvider();
      assert.equal(provider.name, 'docker');
    }

    // 1d. When explicitly authorized via trustedLocalExecution AND environment toggle:
    process.env.AIRA_TRUSTED_LOCAL_EXECUTION = 'true';
    try {
      const local = resolveIsolatedSandboxProvider({ trustedLocalExecution: true });
      assert.equal(local.name, 'local');
    } finally {
      delete process.env.AIRA_TRUSTED_LOCAL_EXECUTION;
    }
  });

  await t.test('2. MultiProviderSandboxFactory Prevents Unrestricted Host Fallbacks', async () => {
    const abortCtrl = new AbortController();

    // 2a. MultiProviderSandboxFactory excludes 'local' for untrusted workloads by default
    delete process.env.AIRA_TRUSTED_LOCAL_EXECUTION;
    const factory = new MultiProviderSandboxFactory();
    assert.throws(
      () => {
        factory.getProvider('local');
      },
      /Unknown sandbox provider: 'local'/,
      'MultiProviderSandboxFactory must not register local provider by default'
    );

    // 2b. If local provider is invoked directly for an untrusted workload, it must reject
    const localProvider = new LocalIsolatedSandboxProvider();
    await assert.rejects(
      async () => {
        await localProvider.createWorkspace({
          allowInternet: false,
          allowPreview: false,
          timeoutMs: 10000,
          signal: abortCtrl.signal
        });
      },
      /HOST_EXECUTION_FORBIDDEN/,
      'Local host provider must reject untrusted workload creation'
    );
  });

  await t.test('3. ToolGateway python_sandbox Requires Container Isolation by Default', async () => {
    const approvalKernel = {
      isToolCallApproved: async () => true,
      claimOnceAuthorization: async () => true,
      createRequest: async () => ({ id: 'req_1' }),
    } as any;
    const gateway = new ToolGateway(new InMemoryToolCallRepository(), approvalKernel);

    const docker = new DockerIsolatedSandboxProvider();
    if (!docker.isConfigured()) {
      // Default invocation MUST fail closed because no container runtime is active
      const res = await gateway.executeTool('python_sandbox', {
        code: 'print("EXECUTION_SHOULD_FAIL_CLOSED")'
      }, {
        runId: 'run_test_audit_failclosed',
        principal,
        effectiveToolScopes: ['*']
      });

      assert.equal(res.isError, true);
      assert.match(res.error || '', /CONTAINER_ISOLATION_UNAVAILABLE/);
    }
  });

  await t.test('4. Deliberate Attempts to Bypass Python-Level Restrictions Are Blocked', async () => {
    // Under authorized local test execution, verify defense-in-depth layers block bypass attempts
    process.env.AIRA_TRUSTED_LOCAL_EXECUTION = 'true';
    const localProvider = new LocalIsolatedSandboxProvider();

    try {
      const ws = await localProvider.createWorkspace({
        allowInternet: false,
        allowPreview: false,
        timeoutMs: 30000,
        trustedLocalExecution: true
      });

      // 4a. Bypass attempt via sys.modules reflection
      await localProvider.writeFile(ws, 'bypass_reflection.py', `
import sys
try:
    sub = sys.modules.get('subprocess')
    if sub:
        sub.Popen(["calc.exe"])
        print("POpen_BYPASS_SUCCEEDED")
    else:
        print("BLOCKED_NO_SUBPROCESS")
except Exception as e:
    print(f"BLOCKED_EXCEPTION: {e}")
`);
      const res1 = await localProvider.runCommand(ws, 'python bypass_reflection.py');
      assert.ok(res1.stdout.includes('BLOCKED_EXCEPTION: AIRA_SANDBOX_POLICY_VIOLATION') || res1.stdout.includes('BLOCKED_NO_SUBPROCESS'));
      assert.ok(!res1.stdout.includes('POpen_BYPASS_SUCCEEDED'));

      // 4b. Bypass attempt via importlib dynamic module reloading
      await localProvider.writeFile(ws, 'bypass_reload.py', `
import importlib
try:
    sub = importlib.import_module('subprocess')
    sub.Popen(["calc.exe"])
    print("RELOAD_BYPASS_SUCCEEDED")
except Exception as e:
    print(f"BLOCKED_BY_POLICY: {e}")
`);
      const res2 = await localProvider.runCommand(ws, 'python bypass_reload.py');
      assert.ok(res2.stdout.includes('BLOCKED_BY_POLICY: AIRA_SANDBOX_POLICY_VIOLATION'));
      assert.ok(!res2.stdout.includes('RELOAD_BYPASS_SUCCEEDED'));

      await localProvider.terminateWorkspace(ws);
    } finally {
      delete process.env.AIRA_TRUSTED_LOCAL_EXECUTION;
    }
  });
});
