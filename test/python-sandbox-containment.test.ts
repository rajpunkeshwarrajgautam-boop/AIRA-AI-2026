import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalIsolatedSandboxProvider,
  DockerIsolatedSandboxProvider,
  MultiProviderSandboxFactory
} from '../packages/builder-runtime/src/sandbox.js';

test('Mission B — Python Sandbox Containment, Adversarial Hardening, and Fail-Closed Security', async (t) => {
  const prevEnv = process.env.AIRA_TRUSTED_LOCAL_EXECUTION;
  process.env.AIRA_TRUSTED_LOCAL_EXECUTION = 'true';

  t.after(() => {
    if (prevEnv !== undefined) {
      process.env.AIRA_TRUSTED_LOCAL_EXECUTION = prevEnv;
    } else {
      delete process.env.AIRA_TRUSTED_LOCAL_EXECUTION;
    }
  });

  const provider = new LocalIsolatedSandboxProvider();

  await t.test('0. Reject Untrusted Workload Without Explicit Trust Authorization', async () => {
    const unauthProvider = new LocalIsolatedSandboxProvider();
    const prev = process.env.AIRA_TRUSTED_LOCAL_EXECUTION;
    delete process.env.AIRA_TRUSTED_LOCAL_EXECUTION;
    delete process.env.AIRA_TRUSTED_HOST_EXECUTION;
    try {
      await assert.rejects(
        async () => {
          await unauthProvider.createWorkspace({
            allowInternet: false,
            allowPreview: false,
            timeoutMs: 15000
          });
        },
        /HOST_EXECUTION_FORBIDDEN/,
        'Must reject untrusted workload creation without explicit authorization'
      );
    } finally {
      process.env.AIRA_TRUSTED_LOCAL_EXECUTION = prev;
    }
  });

  await t.test('1. Adversarial Path Traversal Attempt Blocked at File Level', async () => {
    const ws = await provider.createWorkspace({
      allowInternet: false,
      allowPreview: false,
      timeoutMs: 15000,
      trustedLocalExecution: true
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
      timeoutMs: 15000,
      trustedLocalExecution: true
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
      timeoutMs: 15000,
      trustedLocalExecution: true
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
      timeoutMs: 15000,
      trustedLocalExecution: true
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
      timeoutMs: 15000,
      trustedLocalExecution: true
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

    // 7a. Verify configured isolation flags contracts (defense-in-depth security invariants)
    const defaultFlags = dockerProvider.getIsolationFlags(false);
    assert.ok(defaultFlags.includes('--network=none'), 'Default network isolation must be enforced (--network=none)');
    assert.ok(defaultFlags.includes('--read-only'), 'Container rootfs must be mounted read-only');
    assert.ok(defaultFlags.includes('--tmpfs'), 'tmpfs scratch space must be configured');
    assert.ok(defaultFlags.includes('/tmp:rw,noexec,nosuid,size=64m'), 'tmpfs must enforce noexec, nosuid, size=64m bounds');
    assert.ok(defaultFlags.includes('--memory=256m'), 'Memory ceiling must be strictly bounded at 256m');
    assert.ok(defaultFlags.includes('--cpus=1.0'), 'CPU quota must be strictly capped at 1.0 OCPU');
    assert.ok(defaultFlags.includes('--pids-limit=64'), 'PID ceiling must prevent fork bomb attacks at 64 pids');
    assert.ok(defaultFlags.includes('--user=1000:1000'), 'Non-root execution must be enforced');
    assert.ok(defaultFlags.includes('--security-opt=no-new-privileges:true'), 'no-new-privileges must be strictly set');
    assert.ok(defaultFlags.includes('--cap-drop=ALL'), 'Linux capabilities must be completely dropped (--cap-drop=ALL)');
    assert.ok(!defaultFlags.includes('--privileged'), 'Privileged mode must NEVER be enabled');

    const internetFlags = dockerProvider.getIsolationFlags(true);
    assert.ok(internetFlags.includes('--network=bridge'), 'When internet is explicitly allowed, bridge network must be configured');
    assert.ok(internetFlags.includes('--read-only'), 'Read-only rootfs must be retained even when internet is allowed');
    assert.ok(internetFlags.includes('--cap-drop=ALL'), 'Capabilities must remain dropped even when internet is allowed');

    // 7b. Verify deterministic fail-closed rejection when Docker runtime is unconfigured/disabled via environment
    const prevDisable = process.env.AIRA_DISABLE_LOCAL_DOCKER;
    try {
      process.env.AIRA_DISABLE_LOCAL_DOCKER = 'true';
      const disabledProvider = new DockerIsolatedSandboxProvider();
      assert.equal(disabledProvider.isConfigured(), false, 'Provider must report unconfigured when AIRA_DISABLE_LOCAL_DOCKER=true');

      await assert.rejects(
        async () => {
          await disabledProvider.createWorkspace({
            allowInternet: false,
            allowPreview: false,
            timeoutMs: 15000
          });
        },
        /DOCKER_RUNTIME_UNAVAILABLE/,
        'Unconfigured/disabled Docker daemon must fail closed with DOCKER_RUNTIME_UNAVAILABLE'
      );
    } finally {
      if (prevDisable !== undefined) {
        process.env.AIRA_DISABLE_LOCAL_DOCKER = prevDisable;
      } else {
        delete process.env.AIRA_DISABLE_LOCAL_DOCKER;
      }
    }

    // 7c. Verify deterministic fail-closed rejection when Docker runtime is explicitly disabled via options
    const explicitlyDisabledProvider = new DockerIsolatedSandboxProvider({ enabled: false });
    assert.equal(explicitlyDisabledProvider.isConfigured(), false, 'Explicitly disabled provider must return false from isConfigured');
    await assert.rejects(
      async () => {
        await explicitlyDisabledProvider.createWorkspace({
          allowInternet: false,
          allowPreview: false,
          timeoutMs: 15000
        });
      },
      /DOCKER_RUNTIME_UNAVAILABLE/,
      'Explicitly disabled provider must fail closed with DOCKER_RUNTIME_UNAVAILABLE'
    );

    // 7d. Verify probe memoization and cached readiness consistency
    const initialProbe = dockerProvider.isConfigured();
    // Subsequent calls must return identical cached result without flapping or throwing
    assert.equal(dockerProvider.isConfigured(), initialProbe, 'Subsequent isConfigured call must return stable cached value');

    // If host environment has an active Docker daemon, verify workspace lifecycle consistency
    if (initialProbe) {
      const ws = await dockerProvider.createWorkspace({
        allowInternet: false,
        allowPreview: false,
        timeoutMs: 15000
      });
      assert.equal(ws.provider, 'docker');
      assert.equal(ws.status, 'READY');
      await dockerProvider.terminateWorkspace(ws);
    }
  });

  await t.test('8. Untrusted Host Command Execution Blocked (No Host Shell Escape)', async () => {
    const ws = await provider.createWorkspace({
      allowInternet: false,
      allowPreview: false,
      timeoutMs: 15000,
      trustedLocalExecution: true
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
