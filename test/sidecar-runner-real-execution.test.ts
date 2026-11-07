import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarSandboxProvider } from '../packages/builder-runtime/src/sandbox.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER_SCRIPT = path.join(REPO_ROOT, 'apps', 'sandbox-runner', 'runner.py');

test('AIRA AI 2026 — Real Isolated Sidecar Sandbox Execution & Containment Verification', async (t) => {
  const testPort = 8912;
  const runnerUrl = `http://127.0.0.1:${testPort}`;
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  // Spawn runner.py on testPort
  let runnerProcess: ChildProcess | null = null;
  try {
    runnerProcess = spawn(pythonCmd, [RUNNER_SCRIPT], {
      env: {
        ...process.env,
        PORT: String(testPort),
        WORKSPACE_BASE: path.join(REPO_ROOT, 'tmp', 'test-workspaces')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Wait for health endpoint to report HEALTHY
    let healthy = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${runnerUrl}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          const json = await res.json() as any;
          if (json.status === 'HEALTHY') {
            healthy = true;
            break;
          }
        }
      } catch {
        // Retry
      }
      await new Promise(r => setTimeout(r, 200));
    }

    assert.equal(healthy, true, 'Sidecar runner must boot and report HEALTHY on /health probe');

    const provider = new SidecarSandboxProvider();
    const savedUrl = process.env.AIRA_SANDBOX_RUNNER_URL;
    process.env.AIRA_SANDBOX_RUNNER_URL = runnerUrl;

    try {
      await t.test('1. Real Python Execution: math calculation and bidirectional file generation', async () => {
        const ws = await provider.createWorkspace({
          allowInternet: false,
          allowPreview: false,
          timeoutMs: 15000
        });

        assert.equal(ws.provider, 'sidecar');

        const scriptContent = `
import math
radius = 5
area = math.pi * (radius ** 2)
with open('output_area.txt', 'w') as f:
    f.write(f"AREA:{area:.2f}")
print(f"Calculated area: {area:.2f}")
`;
        await provider.writeFile(ws, 'calculate.py', scriptContent);

        const runCmd = `${pythonCmd} calculate.py`;
        const res = await provider.runCommand(ws, runCmd);

        assert.equal(res.exitCode, 0, `Command should succeed. Stderr: ${res.stderr}`);
        assert.ok(res.stdout.includes('Calculated area: 78.54'), `Stdout must contain calculated area: ${res.stdout}`);
        assert.equal(res.isolationTier, 'container-sidecar');

        // Verify output file was generated and synced back
        const resultBytes = await provider.readFile(ws, 'output_area.txt');
        const resultText = Buffer.from(resultBytes).toString('utf8');
        assert.equal(resultText, 'AREA:78.54');

        await provider.terminateWorkspace(ws);
      });

      await t.test('2. Error Containment: Python syntax and runtime exceptions captured safely', async () => {
        const ws = await provider.createWorkspace({
          allowInternet: false,
          allowPreview: false,
          timeoutMs: 10000
        });

        await provider.writeFile(ws, 'error_script.py', 'raise RuntimeError("DELIBERATE_RUNTIME_EXCEPTION")');

        const res = await provider.runCommand(ws, `${pythonCmd} error_script.py`);
        assert.notEqual(res.exitCode, 0);
        assert.ok(res.stderr.includes('RuntimeError: DELIBERATE_RUNTIME_EXCEPTION'));

        await provider.terminateWorkspace(ws);
      });

      await t.test('3. Timeout Enforcement: Long-running or infinite loops terminated cleanly', async () => {
        const ws = await provider.createWorkspace({
          allowInternet: false,
          allowPreview: false,
          timeoutMs: 1000
        });

        await provider.writeFile(ws, 'infinite.py', 'import time\ntime.sleep(10)\n');

        const res = await provider.runCommand(ws, `${pythonCmd} infinite.py`, { timeoutMs: 1000 });
        assert.equal(res.exitCode, 124, 'Must return standard UNIX timeout exit code 124');
        assert.ok(res.stderr.includes('timed out'));

        await provider.terminateWorkspace(ws);
      });

      await t.test('4. Security Gate: Path traversal and directory escape attempts rejected', async () => {
        const ws = await provider.createWorkspace({
          allowInternet: false,
          allowPreview: false,
          timeoutMs: 10000
        });

        // Attempting to write escaping path
        const escapeRes = await fetch(`${runnerUrl}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: ws.id,
            command: `${pythonCmd} -c "print('hello')"`,
            files: {
              '../../etc/passwd': 'malicious_content'
            }
          })
        });

        assert.equal(escapeRes.status, 400, 'Runner must reject directory traversal attempts with HTTP 400');
        const errJson = await escapeRes.json() as any;
        assert.ok(errJson.error.includes('Path traversal detected') || errJson.error.includes('escapes workspace root'));

        await provider.terminateWorkspace(ws);
      });
    } finally {
      if (savedUrl) process.env.AIRA_SANDBOX_RUNNER_URL = savedUrl;
      else delete process.env.AIRA_SANDBOX_RUNNER_URL;
    }
  } finally {
    if (runnerProcess) {
      runnerProcess.kill('SIGTERM');
      // On Windows kill tree if needed
      try { process.kill(runnerProcess.pid!, 'SIGKILL'); } catch {}
    }
  }
});
