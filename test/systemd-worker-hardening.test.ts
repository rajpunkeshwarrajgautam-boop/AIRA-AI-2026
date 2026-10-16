import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

console.log('\n=== AIRA AI 2026 — SYSTEMD HARDENING & ENVIRONMENT CONTRACT AUDIT ===\n');

const projectRoot = process.cwd();
const unitPath = path.join(projectRoot, 'systemd', 'aira-specialist-worker.service');
const envExamplePath = path.join(projectRoot, 'systemd', 'specialist-worker.env.example');

assert.ok(fs.existsSync(unitPath), 'systemd unit file must exist at systemd/aira-specialist-worker.service');
assert.ok(fs.existsSync(envExamplePath), 'environment example must exist at systemd/specialist-worker.env.example');

const unitContent = fs.readFileSync(unitPath, 'utf8');
const envContent = fs.readFileSync(envExamplePath, 'utf8');

// ---------------------------------------------------------------------------
// 1. Non-Root Execution & Identity
// ---------------------------------------------------------------------------
console.log('1. Auditing Non-Root Execution & Identity...');
assert.match(unitContent, /^User=aira$/m, 'Service must run as dedicated non-root user aira');
assert.match(unitContent, /^Group=aira$/m, 'Service must run as dedicated group aira');
assert.match(unitContent, /^UMask=0027$/m, 'Service must define restrictive UMask=0027');

// ---------------------------------------------------------------------------
// 2. Filesystem Restrictions & Explicit Writable Paths
// ---------------------------------------------------------------------------
console.log('2. Auditing Filesystem Sandboxing & Writable Directory Restrictions...');
assert.match(unitContent, /^ProtectSystem=strict$/m, 'ProtectSystem must be strict (mounts root and /opt read-only)');
assert.match(unitContent, /^ProtectHome=true$/m, 'ProtectHome must be true');
assert.match(unitContent, /^PrivateTmp=true$/m, 'PrivateTmp must provide isolated tmpfs namespace');
assert.match(unitContent, /^ReadOnlyPaths=\/opt\/aira-worker$/m, 'Application root /opt/aira-worker must be explicitly read-only');
assert.match(unitContent, /^ReadOnlyPaths=\/etc\/aira$/m, 'Configuration directory /etc/aira must be explicitly read-only');
assert.match(unitContent, /^ReadWritePaths=\/tmp$/m, 'Writable paths must be strictly restricted to /tmp');
assert.match(unitContent, /^RuntimeDirectory=aira$/m, 'Service must define isolated RuntimeDirectory');

// ---------------------------------------------------------------------------
// 3. Process, Kernel, Capability & Syscall Sandboxing
// ---------------------------------------------------------------------------
console.log('3. Auditing Kernel, Capability & Syscall Sandboxing...');
assert.match(unitContent, /^NoNewPrivileges=true$/m, 'NoNewPrivileges must be enforced');
assert.match(unitContent, /^ProtectKernelTunables=true$/m, 'ProtectKernelTunables must be enabled');
assert.match(unitContent, /^ProtectKernelModules=true$/m, 'ProtectKernelModules must be enabled');
assert.match(unitContent, /^ProtectKernelLogs=true$/m, 'ProtectKernelLogs must be enabled');
assert.match(unitContent, /^ProtectControlGroups=true$/m, 'ProtectControlGroups must be enabled');
assert.match(unitContent, /^ProtectClock=true$/m, 'ProtectClock must be enabled');
assert.match(unitContent, /^ProtectHostname=true$/m, 'ProtectHostname must be enabled');
assert.match(unitContent, /^ProtectProc=invisible$/m, 'ProtectProc must be set to invisible');
assert.match(unitContent, /^ProcSubset=pid$/m, 'ProcSubset must be set to pid');
assert.match(unitContent, /^RestrictRealtime=true$/m, 'RestrictRealtime must be true');
assert.match(unitContent, /^RestrictSUIDSGID=true$/m, 'RestrictSUIDSGID must be true');
assert.match(unitContent, /^CapabilityBoundingSet=$/m, 'CapabilityBoundingSet must drop all Linux capabilities');
assert.match(unitContent, /^SystemCallArchitectures=native$/m, 'SystemCallArchitectures must be native');
assert.match(unitContent, /^SystemCallFilter=@system-service$/m, 'SystemCallFilter must use valid @system-service allowlist');

// Negative assertions: reject invalid mixed negation syntax like ~@privileged in directive lines
const directiveLines = unitContent.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
assert.equal(
  /SystemCallFilter=.*~@privileged/m.test(directiveLines),
  false,
  'SystemCallFilter directive must not contain invalid mixed negation ~@privileged (ignored by systemd 255)'
);
assert.equal(
  /SystemCallFilter=.*~@resources/m.test(directiveLines),
  false,
  'SystemCallFilter directive must not contain invalid mixed negation ~@resources'
);
assert.match(
  unitContent,
  /SystemCallFilter Policy Rationale:/i,
  'Unit must document SystemCallFilter policy rationale'
);

// ---------------------------------------------------------------------------
// 4. Memory Sandboxing & Node.js 24 V8 JIT Compatibility Rationale
// ---------------------------------------------------------------------------
console.log('4. Auditing Memory Sandboxing & V8 JIT Compatibility...');
assert.match(unitContent, /^MemoryDenyWriteExecute=false$/m, 'MemoryDenyWriteExecute must be false for Node.js V8 dynamic JIT');
assert.match(unitContent, /Security Trade-off Rationale/i, 'Unit must document security trade-off rationale');
assert.match(unitContent, /V8 engine dynamic JIT compilation/i, 'Unit must document V8 JIT requirements');

// ---------------------------------------------------------------------------
// 5. Resource Constraints for 1-OCPU Ampere A1 Host
// ---------------------------------------------------------------------------
console.log('5. Auditing 1-OCPU Resource Limits...');
assert.match(unitContent, /^CPUQuota=95%$/m, 'CPUQuota must be set to safe 95% starting limit for 1-OCPU host');
assert.match(unitContent, /^MemoryMax=1536M$/m, 'MemoryMax must be capped at 1536M (~25% of 6GB RAM)');
assert.match(unitContent, /^MemoryHigh=1280M$/m, 'MemoryHigh throttling must be configured at 1280M');
assert.match(unitContent, /^TasksMax=256$/m, 'TasksMax must prevent unbounded process spawning');

// ---------------------------------------------------------------------------
// 6. Signal Handling & Lifecycle
// ---------------------------------------------------------------------------
console.log('6. Auditing Lifecycle & Signal Handling...');
assert.match(unitContent, /^KillSignal=SIGTERM$/m, 'KillSignal must be SIGTERM');
assert.match(unitContent, /^TimeoutStopSec=30$/m, 'TimeoutStopSec must match 30s lease grace period');

// ---------------------------------------------------------------------------
// 7. Environment & Secrets Handling Contract
// ---------------------------------------------------------------------------
console.log('7. Auditing Environment Contract & Secrets Hygiene...');
assert.match(envContent, /AIRA_SPECIALIST_WORKER_PROCESS=true/, 'Dedicated worker process flag required');
assert.match(envContent, /AIRA_SPECIALIST_WORKER_ENABLED=true/, 'Specialist worker enabled flag required');
assert.match(envContent, /AIRA_SPECIALIST_DELEGATION_ENABLED=true/, 'Specialist delegation enabled flag required');
assert.match(envContent, /AIRA_ENVIRONMENT=staging/, 'Staging environment flag required');
assert.match(envContent, /WORKER_HEALTH_HOST=127\.0\.0\.1/, 'Health host must be set to 127.0.0.1');

// Verify template does not contain real exposed credentials
assert.equal(/nvapi-[A-Za-z0-9_-]{20,}/.test(envContent), false, 'No real NVIDIA API keys in template');
assert.equal(/sk-ant-[A-Za-z0-9_-]{20,}/.test(envContent), false, 'No real Anthropic API keys in template');
assert.equal(/npg_[A-Za-z0-9_-]{10,}/.test(envContent), false, 'No real Neon passwords in template');

console.log('✓ Systemd unit hardening and environment-variable contract verified 100% compliant.');
console.log('\n=== ALL SYSTEMD HARDENING AUDIT CHECKS PASSED ===\n');
