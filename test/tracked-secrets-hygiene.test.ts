import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

console.log('\n=== AIRA AI 2026 — TRACKED SECRETS & CREDENTIAL HYGIENE AUDIT ===\n');

// Comprehensive secret and high-risk credential patterns:
// Includes Anthropic, OpenAI, NVIDIA, GitHub, AWS, and Neon PostgreSQL connection credentials with passwords.
const SECRET_PATTERNS = [
  { name: 'NVIDIA API Key', regex: /nvapi-[A-Za-z0-9_-]{20,}/ },
  { name: 'Anthropic API Key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'Stripe Live Key', regex: /sk_live_[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub Personal Token', regex: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'Neon Postgres Password', regex: /npg_[A-Za-z0-9_-]{10,}/ },
  { name: 'Password-Bearing Postgres Connection URL', regex: /postgres(?:ql)?:\/\/[a-zA-Z0-9_.-]+:[^@\s"']+@[a-zA-Z0-9_.-]+/ }
];

const EXCLUDED_FILES = new Set([
  'package-lock.json',
  'test/tracked-secrets-hygiene.test.ts' // Exclude this test file definition itself
]);

const trackedFiles = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .map(f => f.trim())
  .filter(f => f && !EXCLUDED_FILES.has(f) && fs.existsSync(f));

console.log(`Scanning ${trackedFiles.length} tracked files in repository...`);

const violations: Array<{ file: string; rule: string; line: number }> = [];

for (const file of trackedFiles) {
  // Skip binary files
  try {
    const buffer = fs.readFileSync(file);
    const isBinary = buffer.includes(0);
    if (isBinary) continue;

    const content = buffer.toString('utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Allow local dummy test containers on localhost/127.0.0.1
      if (line.includes('aira:aira@localhost') || line.includes('aira:aira@127.0.0.1')) {
        continue;
      }
      for (const rule of SECRET_PATTERNS) {
        if (rule.regex.test(line)) {
          violations.push({ file, rule: rule.name, line: i + 1 });
        }
      }
    }
  } catch (err) {
    // Ignore unreadable files
  }
}

if (violations.length > 0) {
  console.error('\n❌ SECURITY AUDIT FAILED: Exposed credentials detected in tracked files:');
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line} matches [${v.rule}]`);
  }
  process.exit(1);
} else {
  console.log('\n✓ ZERO EXPOSED CREDENTIALS FOUND ACROSS ALL TRACKED FILES.');
  process.exit(0);
}
