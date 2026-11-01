import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalIsolatedSandboxProvider,
  DockerIsolatedSandboxProvider,
  MultiProviderSandboxFactory
} from '../packages/builder-runtime/src/sandbox.js';

test('Mission B — Python Sandbox Containment, Adversarial Hardening, and Fail-Closed Security', async (t) => {
  const provider = new LocalIsolatedSandboxProvider();

  await t.test('1. Adversarial Path Traversal Attempt Blocked at File Level', async () => {
    const ws = await provider.createWorkspace({
      allowInternet: false,
      allowPreview: false,
      timeoutMs: 15000
    });

    try {
      // Relative path escaping workspace
      await assert.rejects(
        async () => {
          await provider.writeFile(ws, '../../etc/passwd', 'malicious');
        },
        /SECURITY_VIOLATION: Path traversal attempt blocked/,
        'Writing outside workspace via path traversal must be rejected'
      );

      // Absolute path escaping workspace
      await assert.rejects(
        async () => {
          await provider.writeFile(ws, '/etc/shadow', 'malicious');
        },
        /SECURITY_VIOLATION: Path traversal attempt blocked/,
        'Absolute path write must be rejected'
      );
    } finally {
      await provider.terminateWorkspace(ws);
    }
  });

  await t.test('2. Adversarial Python Network Connection Blocked by Sandbox Policy', async () => {
    const ws = await provider.createWorkspace({
      allowInternet: false,
      allowPreview: false,
      timeoutMs: 15000
    });

    try {
      const maliciousSocketScript = `
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.connect(("1.1.1.1", 80))
    print("NETWORK_ACCESSIBLE")
except Exception as e:
    print(f"CAUGHT_SECURITY_EXCEPTION: {type(e).__name__} - {e}")
`;
      await provider.writeFile(ws, 'socket_attack.py', maliciousSocketScript);
      const res = await provider.runCommand(ws, 'python socket_attack.py');
      assert.ok(
        res.stdout.includes('CAUGHT_SECURITY_EXCEPTION: PermissionError') ||
        res.stdout.includes('AIRA_SANDBOX_POLICY_VIOLATION') ||
        res.stderr.includes('AIRA_SANDBOX_POLICY_VIOLATION'),
        'Raw socket creation must be blocked by sandbox containment harness'
      );
      assert.ok(!res.stdout.includes('NETWORK_ACCESSIBLE'), 'Network must not be reachable');
      assert.equal(res.isolationTier, 'LOCAL_RESTRICTED_GUARDED');
    } finally {
      await provider.terminateWorkspace(ws);
    }
  });

  await t.test('3. Adversarial Subprocess / Shell Execution Blocked inside Python', async () => {
    const ws = await provider.createWorkspace({
      allowInternet: false,
      allowPreview: false,
      timeoutMs: 15000
    });

    try {
      const maliciousSubprocessScript = `
import subprocess
try:
    subprocess.Popen(["calc.exe"])
    print("SUBPROCESS_SPAWNED")
except Exception as e:
    print(f"CAUGHT_SUBPROCESS_SECURITY: {type(e).__name__} - {e}")
`;
      await provider.writeFile(ws, 'subprocess_attack.py', maliciousSubprocessScript);
      const res = await provider.runCommand(ws, 'python subprocess_attack.py');
      assert.ok(
        res.stdout.includes('CAUGHT_SUBPROCESS_SECURITY: PermissionError') ||
        res.stdout.includes('AIRA_SANDBOX_POLICY_VIOLATION'),
        'Subprocess spawning from python must be blocked'
      );
      assert.ok(!res.stdout.includes('SUBPROCESS_SPAWNED'));
    } finally {
      await provider.terminateWorkspace(ws);
    }
  });

  await t.test('4. Adversarial Infinite Loop and Timeout Ceiling Enforced', async () => {
    const ws = await provider.createWorkspace({
      allowInternet: false,
      allowPreview: false,
      timeoutMs: 15000
    });

    try {
      const infiniteLoop = `
import time
start = time.time()
while True:
    time.sleep(0.1)
`;
      await provider.writeFile(ws, 'infinite.py', infiniteLoop);
      const start = Date.now();
      const res = await provider.runCommand(ws, 'python infinite.py', { timeoutMs: 1500 });
      const elapsed = Date.now() - start;

      assert.equal(res.exitCode, 124, 'Exit code must indicate timeout 124');
      assert.ok(res.stderr.includes('timed out'), 'Stderr must explain timeout');
      assert.ok(elapsed < 4000, `Execution should be killed promptly around 1500ms, took ${elapsed}ms`);
    } finally {
      await provider.terminateWorkspace(ws);
    }
  });

  await t.test('5. Output Quota Ceiling Enforced (Truncation at 500KB)', async () => {
    const ws = await provider.createWorkspace({
      allowInternet: false,
      allowPreview: false,
      timeoutMs: 15000
    });

    try {
      const floodOutput = `
for i in range(15000):
    print("A" * 100)
`;
      await provider.writeFile(ws, 'flood.py', floodOutput);
      const res = await provider.runCommand(ws, 'python flood.py');
      assert.ok(res.stdout.length <= 505000, 'Stdout must not exceed 500KB quota');
      assert.ok(res.stdout.includes('[TRUNCATED_STDOUT]'), 'Must include truncation marker');
    } finally {
      await provider.terminateWorkspace(ws);
    }
  });

  await t.test('6. Fail-Closed When Container Isolation is Explicitly Demanded', async () => {
    // When workload mandates OCI container isolation, local host execution MUST NOT silently succeed
    await assert.rejects(
      async () => {
        await provider.createWorkspace({
          allowInternet: false,
          allowPreview: false,
          timeoutMs: 15000,
          requireContainer: true
        });
      },
      /CONTAINER_ISOLATION_REQUIRED/,
      'Demanding container isolation on host-only provider must fail closed'
    );
  });

  await t.test('7. DockerIsolatedSandboxProvider Contract & Isolation Flags Verification', async () => {
    const dockerProvider = new DockerIsolatedSandboxProvider();
    assert.equal(dockerProvider.name, 'docker');

    // If Docker daemon is unavailable, createWorkspace must reject deterministically
    if (!dockerProvider.isConfigured()) {
      await assert.rejects(
        async () => {
          await dockerProvider.createWorkspace({
            allowInternet: false,
            allowPreview: false,
            timeoutMs: 15000
          });
        },
        /DOCKER_RUNTIME_UNAVAILABLE/,
        'Unconfigured Docker daemon must fail closed'
      );
    }
  });

  await t.test('8. Untrusted Host Command Execution Blocked (No Host Shell Escape)', async () => {
    const ws = await provider.createWorkspace({
      allowInternet: false,
      allowPreview: false,
      timeoutMs: 15000
    });

    try {
      // 8a. Arbitrary shell command (whoami)
      await assert.rejects(
        async () => {
          await provider.runCommand(ws, 'whoami');
        },
        /HOST_EXECUTION_BLOCKED: Arbitrary host shell execution/,
        'Untrusted whoami command must be rejected'
      );

      // 8b. Network tool command (curl)
      await assert.rejects(
        async () => {
          await provider.runCommand(ws, 'curl http://example.com');
        },
        /HOST_EXECUTION_BLOCKED: Arbitrary host shell execution/,
        'Untrusted curl command must be rejected'
      );

      // 8c. Windows powershell execution
      await assert.rejects(
        async () => {
          await provider.runCommand(ws, 'powershell -Command Get-Process');
        },
        /HOST_EXECUTION_BLOCKED/,
        'Untrusted powershell execution must be rejected'
      );

      // 8d. Shell operator chaining attempt (python test.py && whoami)
      await assert.rejects(
        async () => {
          await provider.runCommand(ws, 'python test.py && whoami');
        },
        /HOST_EXECUTION_BLOCKED: Shell operators and command chaining are prohibited/,
        'Command chaining operator (&&) must be rejected'
      );

      // 8e. Semicolon chaining attempt
      await assert.rejects(
        async () => {
          await provider.runCommand(ws, 'python test.py; cat /etc/passwd');
        },
        /HOST_EXECUTION_BLOCKED: Shell operators and command chaining are prohibited/,
        'Semicolon chaining operator (;) must be rejected'
      );

      // 8f. Pipe chaining attempt
      await assert.rejects(
        async () => {
          await provider.runCommand(ws, 'python test.py | sh');
        },
        /HOST_EXECUTION_BLOCKED: Shell operators and command chaining are prohibited/,
        'Pipe operator (|) must be rejected'
      );
    } finally {
      await provider.terminateWorkspace(ws);
    }
  });
});
