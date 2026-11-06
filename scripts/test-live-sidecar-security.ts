import assert from 'node:assert/strict';

async function runLiveSidecarSecurityVerification() {
  console.log('================================================================');
  console.log('AIRA AI 2026 — Live Oracle Cloud ARM64 Sidecar Security Audit');
  console.log('Target: http://sandbox-runner:8000 over internal sandbox-net');
  console.log('================================================================\n');

  const runnerUrl = process.env.AIRA_SANDBOX_RUNNER_URL || 'http://sandbox-runner:8000';

  // 1. Health Probe
  console.log('--- [1. Health Probe & Container Identity] ---');
  const healthRes = await fetch(`${runnerUrl}/health`);
  assert.equal(healthRes.status, 200, 'Health endpoint must return 200');
  const healthJson = await healthRes.json() as any;
  console.log('Health JSON:', healthJson);
  assert.equal(healthJson.status, 'HEALTHY');
  assert.equal(healthJson.runner, 'aira-sandbox-sidecar');
  console.log(`✓ Sidecar is healthy. Python: ${healthJson.pythonVersion}, Workspace: ${healthJson.workspaceBase}\n`);

  // 2. Path Traversal & Escape Prevention
  console.log('--- [2. Path Traversal & Filesystem Containment] ---');
  const maliciousPaths = [
    '../../etc/shadow',
    '/etc/passwd',
    'subdir/../../../root',
    '....//....//etc/hosts',
    'test\0nullbyte.txt'
  ];

  for (const badPath of maliciousPaths) {
    const res = await fetch(`${runnerUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws_sec_audit_oracle',
        command: 'echo test',
        files: { [badPath]: 'attack' }
      })
    });
    assert.equal(res.status, 400, `Malicious path "${badPath}" must be rejected with HTTP 400`);
    const errJson = await res.json() as any;
    console.log(`✓ Rejected traversal attempt "${badPath}": ${errJson.error}`);
  }
  console.log('✓ All directory traversal and escape attempts rejected.\n');

  // 3. Information Disclosure & Environment Sanitization
  console.log('--- [3. Environment Sanitization & Secret Isolation] ---');
  const envAuditScript = [
    'import os, json',
    'env_keys = list(os.environ.keys())',
    'has_secret = any("KEY" in k or "SECRET" in k or "TOKEN" in k or "DATABASE" in k for k in env_keys)',
    'with open("env_audit.json", "w") as f:',
    '    json.dump({"keys": env_keys, "leak": has_secret}, f)',
    'print(f"KEYS_COUNT:{len(env_keys)}")'
  ].join('\n');

  const envRes = await fetch(`${runnerUrl}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: 'ws_sec_audit_oracle',
      command: 'python3 audit_env.py',
      files: { 'audit_env.py': envAuditScript }
    })
  });

  assert.equal(envRes.status, 200);
  const envData = await envRes.json() as any;
  assert.equal(envData.exitCode, 0);
  const parsedAudit = JSON.parse(envData.files['env_audit.json']);
  console.log('Sandbox Visible Env Keys:', parsedAudit.keys);
  assert.equal(parsedAudit.leak, false, 'No secret, token, key, or database URL may be visible inside sandbox');
  assert.ok(!parsedAudit.keys.includes('DATABASE_URL'));
  assert.ok(!parsedAudit.keys.includes('BROWSER_SESSION_ENCRYPTION_KEY'));
  assert.ok(!parsedAudit.keys.includes('GEMINI_API_KEY'));
  console.log('✓ Environment sanitization verified: Untrusted Python has zero access to host/worker secrets.\n');

  // 4. Network Isolation: Cloud Metadata & Internet Blocked
  console.log('--- [4. Network Isolation: Cloud Metadata & Internet Egress Denial] ---');
  const netProbeScript = [
    'import urllib.request, socket',
    'def check(url):',
    '    try:',
    '        urllib.request.urlopen(url, timeout=1)',
    '        return "ACCESSIBLE"',
    '    except Exception:',
    '        return "BLOCKED"',
    'results = {',
    '    "metadata": check("http://169.254.169.254"),',
    '    "internet": check("http://google.com"),',
    '    "worker_port": check("http://specialist-worker:8080/health")',
    '}',
    'import json',
    'with open("net_probe.json", "w") as f:',
    '    json.dump(results, f)',
    'print("NET_PROBE_DONE")'
  ].join('\n');

  const netRes = await fetch(`${runnerUrl}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: 'ws_sec_audit_oracle',
      command: 'python3 probe_net.py',
      files: { 'probe_net.py': netProbeScript }
    })
  });

  assert.equal(netRes.status, 200);
  const netData = await netRes.json() as any;
  assert.equal(netData.exitCode, 0);
  const netResults = JSON.parse(netData.files['net_probe.json']);
  console.log('Network Probe Results:', netResults);
  assert.equal(netResults.metadata, 'BLOCKED', 'Oracle metadata service must be blocked');
  assert.equal(netResults.internet, 'BLOCKED', 'Internet egress must be blocked');
  console.log('✓ Network isolation verified: Cloud metadata and internet strictly blocked.\n');

  // 5. Execution Timeout & Process Tree Termination
  console.log('--- [5. Execution Timeout & Process Group Termination] ---');
  const loopScript = [
    'import time',
    'while True:',
    '    time.sleep(0.5)'
  ].join('\n');

  const t0 = Date.now();
  const loopRes = await fetch(`${runnerUrl}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: 'ws_sec_audit_oracle',
      command: 'python3 infinite.py',
      files: { 'infinite.py': loopScript },
      timeoutMs: 2000
    })
  });
  const tElapsed = Date.now() - t0;
  assert.equal(loopRes.status, 200);
  const loopData = await loopRes.json() as any;
  assert.equal(loopData.exitCode, 124, 'Exit code must be 124 on timeout');
  console.log(`✓ Process terminated after ${tElapsed}ms. Stderr: "${loopData.stderr}"\n`);

  // 6. Workspace Lifecycle Teardown
  console.log('--- [6. Workspace Teardown & Scratchpad Purge] ---');
  const delRes = await fetch(`${runnerUrl}/workspaces/ws_sec_audit_oracle`, {
    method: 'DELETE'
  });
  assert.equal(delRes.status, 200);
  const delData = await delRes.json() as any;
  assert.equal(delData.status, 'TERMINATED');
  console.log(`✓ Workspace ${delData.workspaceId} terminated and purged.\n`);

  console.log('================================================================');
  console.log('GATE 1: LIVE ORACLE CLOUD ARM64 SIDECAR SECURITY AUDIT PASSED');
  console.log('================================================================');
}

runLiveSidecarSecurityVerification().catch(err => {
  console.error('[SECURITY AUDIT FAILED]:', err);
  process.exit(1);
});
