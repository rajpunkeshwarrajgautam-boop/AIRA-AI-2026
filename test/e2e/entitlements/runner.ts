import { E2ETestServer, globalTestRegistry } from './harness.js';
import { registerTier1Tests } from './tier1-feature-coverage.test.js';
import { registerTier2Tests } from './tier2-boundary-corner.test.js';
import { registerTier3Tests } from './tier3-cross-feature.test.js';
import { registerTier4Tests } from './tier4-application-scenarios.test.js';

// ============================================================================
// AIRA E2E Entitlements & Onboarding Master Test Runner
// ============================================================================

async function main() {
  const startTime = Date.now();
  console.log('====================================================================');
  console.log('  AIRA AI 2026 — E2E Entitlements & Onboarding Master Suite        ');
  console.log('  Requirement-Driven, Opaque-Box Acceptance Across Tiers 1 to 4    ');
  console.log('====================================================================\n');

  // 1. Initialize & Start Reference Test Server
  const server = new E2ETestServer();
  const serverUrl = await server.start();
  console.log(`[E2E Harness] Live test server listening on ${serverUrl}\n`);

  // 2. Register all tier suites
  registerTier1Tests();
  registerTier2Tests();
  registerTier3Tests();
  registerTier4Tests();

  // Parse optional CLI argument
  const tierArg = process.argv.find((a) => a.startsWith('--tier='));
  const tierFilter = tierArg ? (parseInt(tierArg.split('=')[1], 10) as 1 | 2 | 3 | 4) : undefined;

  console.log(`[E2E Harness] Registered ${globalTestRegistry.tests.length} test cases total.`);
  if (tierFilter) {
    console.log(`[E2E Harness] Running filtered for Tier ${tierFilter} only.\n`);
  } else {
    console.log(`[E2E Harness] Executing full suite across all 4 tiers...\n`);
  }

  // 3. Execute tests
  const results = await globalTestRegistry.run(server, tierFilter);

  // 4. Teardown server
  await server.stop();

  // 5. Aggregate Results
  const tier1Results = results.filter((r) => r.tier === 1);
  const tier2Results = results.filter((r) => r.tier === 2);
  const tier3Results = results.filter((r) => r.tier === 3);
  const tier4Results = results.filter((r) => r.tier === 4);

  const t1Passed = tier1Results.filter((r) => r.passed).length;
  const t2Passed = tier2Results.filter((r) => r.passed).length;
  const t3Passed = tier3Results.filter((r) => r.passed).length;
  const t4Passed = tier4Results.filter((r) => r.passed).length;

  const totalPassed = results.filter((r) => r.passed).length;
  const totalFailed = results.filter((r) => !r.passed).length;
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  // 6. Report Failures if any
  if (totalFailed > 0) {
    console.error('\n❌ FAILED TEST CASES:');
    for (const fail of results.filter((r) => !r.passed)) {
      console.error(`- [${fail.id}] ${fail.name}`);
      console.error(`  Error: ${fail.error}\n`);
    }
  }

  // 7. Structured Coverage Summary
  console.log('\n====================================================================');
  console.log('                      E2E COVERAGE SUMMARY TABLE                    ');
  console.log('====================================================================');
  console.log(`  Tier 1: Feature Coverage (Happy Paths)   : ${t1Passed.toString().padStart(3)} / ${tier1Results.length.toString().padEnd(3)} passed`);
  console.log(`  Tier 2: Boundary & Corner Cases          : ${t2Passed.toString().padStart(3)} / ${tier2Results.length.toString().padEnd(3)} passed`);
  console.log(`  Tier 3: Cross-Feature Interactions       : ${t3Passed.toString().padStart(3)} / ${tier3Results.length.toString().padEnd(3)} passed`);
  console.log(`  Tier 4: Real-World Application Scenarios : ${t4Passed.toString().padStart(3)} / ${tier4Results.length.toString().padEnd(3)} passed`);
  console.log('--------------------------------------------------------------------');
  console.log(`  TOTAL TEST CASES EXECUTED                : ${totalPassed.toString().padStart(3)} / ${results.length.toString().padEnd(3)} passed`);
  console.log(`  EXECUTION DURATION                       : ${durationSec}s`);
  console.log('====================================================================\n');

  if (totalFailed === 0) {
    console.log('✅ ALL TEST GATES PASSED (100% SUCCESS RATE)\n');
    process.exit(0);
  } else {
    console.error(`❌ SUITE FAILED: ${totalFailed} test(s) failed.\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
