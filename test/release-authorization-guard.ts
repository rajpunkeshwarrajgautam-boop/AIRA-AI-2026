/**
 * AIRA AI 2026 — Release Authorization Guard (Deterministic Unit Tests)
 *
 * NOTE: This file runs isolated unit tests on the validation engine.
 * Passing this test does NOT mean a release has been authorized.
 * Live human GO LIVE authorization requires verified owner dispatch
 * and commit status "release/go-live-authorized" via GitHub Actions.
 */

export * from '../src/security/release-authorization-validator.js';
import { runSecurityRegressionTests } from './release-authorization-guard.test.js';

export async function runIsolatedSecurityTests() {
  console.log('[RELEASE_AUTH_GUARD] Running deterministic unit tests of authorization rules...');
  await runSecurityRegressionTests();
}

async function main() {
  await runIsolatedSecurityTests();
}

if (process.argv[1]?.includes('release-authorization-guard')) {
  main().catch(err => {
    console.error('[RELEASE_AUTH_GUARD] FAILED:', err);
    process.exit(1);
  });
}
