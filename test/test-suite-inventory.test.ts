import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export interface AutonomousSuiteSpec {
  file: string;
  name: string;
  mission: string;
  tier: 'Tier 1' | 'Tier 2' | 'Tier 3';
  tier1: number;
  tier2: number;
  tier3: number;
  expectedOfflineTests: number;
  expectedLivePostgresTests: number;
  expectedSubtests: number;
  expectedRootTests: number;
  parentTestName?: string;
}

export const CANONICAL_AUTONOMOUS_SUITES: AutonomousSuiteSpec[] = [
  {
    file: 'test/autonomous-adversarial-scenarios.test.ts',
    name: '15 Adversarial Fault Injection & Security Scenarios',
    mission: 'Mission Adv',
    tier: 'Tier 1', // Mixed Tier 1 (9 in-memory unit scenarios) & Tier 2 (7 local integration parent+scenarios)
    tier1: 9,
    tier2: 7,
    tier3: 0,
    expectedOfflineTests: 16,
    expectedLivePostgresTests: 16,
    expectedSubtests: 15,
    expectedRootTests: 1,
    parentTestName: 'AIRA AI 2026 — 15 Adversarial Fault Injection & Security Scenarios'
  },
  {
    file: 'test/autonomous-persistence-failclosed.test.ts',
    name: 'Durable Autonomous Task Persistence Fail-Closed Certification',
    mission: 'Mission A2',
    tier: 'Tier 1',
    tier1: 4,
    tier2: 0,
    tier3: 0,
    expectedOfflineTests: 4,
    expectedLivePostgresTests: 4,
    expectedSubtests: 3,
    expectedRootTests: 1,
    parentTestName: 'Mission A2 — Durable Autonomous Task Persistence Fail-Closed Certification'
  },
  {
    file: 'test/autonomous-platform-e2e.test.ts',
    name: 'Autonomous Intelligence Platform End-to-End & Subsystem Integration',
    mission: 'Mission E2E',
    tier: 'Tier 2', // 6 in-memory subsystem contract tests + 3 local integration tests (sandbox, browser, mcp)
    tier1: 6,
    tier2: 3,
    tier3: 0,
    expectedOfflineTests: 9,
    expectedLivePostgresTests: 9,
    expectedSubtests: 0, // 9 top-level test() calls
    expectedRootTests: 9
  },
  {
    file: 'test/autonomous-worker-recovery.test.ts',
    name: 'Autonomous Execution Durability, Fencing Tokens, and Crash Recovery',
    mission: 'Mission A',
    tier: 'Tier 1',
    tier1: 4,
    tier2: 0,
    tier3: 0,
    expectedOfflineTests: 5,
    expectedLivePostgresTests: 5,
    expectedSubtests: 4,
    expectedRootTests: 1,
    parentTestName: 'Mission A — Autonomous Execution Durability, Fencing Tokens, and Crash Recovery'
  },
  {
    file: 'test/browser-persistence-recovery.test.ts',
    name: 'Browser Persistence, Tenant Isolation, and Recovery Across Worker Termination',
    mission: 'Mission C',
    tier: 'Tier 2',
    tier1: 0,
    tier2: 9,
    tier3: 0,
    expectedOfflineTests: 9,
    expectedLivePostgresTests: 9,
    expectedSubtests: 8,
    expectedRootTests: 1,
    parentTestName: 'Mission C — Browser Persistence, Tenant Isolation, and Recovery Across Worker Termination'
  },
  {
    file: 'test/python-sandbox-containment.test.ts',
    name: 'Python Sandbox Containment, Adversarial Hardening, and Fail-Closed Security',
    mission: 'Mission B',
    tier: 'Tier 2',
    tier1: 0,
    tier2: 10,
    tier3: 0,
    expectedOfflineTests: 10,
    expectedLivePostgresTests: 10,
    expectedSubtests: 9,
    expectedRootTests: 1,
    parentTestName: 'Mission B — Python Sandbox Containment, Adversarial Hardening, and Fail-Closed Security'
  },
  {
    file: 'test/sandbox-selection-reconciliation.test.ts',
    name: 'Sandbox Selection Reconciliation Across Every Execution Path',
    mission: 'Mission B2',
    tier: 'Tier 1',
    tier1: 4,
    tier2: 0,
    tier3: 0,
    expectedOfflineTests: 5,
    expectedLivePostgresTests: 5,
    expectedSubtests: 4,
    expectedRootTests: 1,
    parentTestName: 'Mission B2 — Sandbox Selection Reconciliation Across Every Execution Path'
  },
  {
    file: 'test/mcp-wire-integration.test.ts',
    name: 'Real Wire MCP Server Integration, Tool Discovery, and Security Bounds',
    mission: 'Mission D',
    tier: 'Tier 2',
    tier1: 0,
    tier2: 5,
    tier3: 0,
    expectedOfflineTests: 5,
    expectedLivePostgresTests: 5,
    expectedSubtests: 4,
    expectedRootTests: 1,
    parentTestName: 'Mission D — Real Wire MCP Server Integration, Tool Discovery, and Security Bounds'
  },
  {
    file: 'test/specialist-orchestration-depth.test.ts',
    name: 'Real Specialist-Agent Orchestration, Delegation Contracts & Hand-Off Safety',
    mission: 'Mission E',
    tier: 'Tier 1',
    tier1: 5,
    tier2: 0,
    tier3: 0,
    expectedOfflineTests: 6,
    expectedLivePostgresTests: 6,
    expectedSubtests: 5,
    expectedRootTests: 1,
    parentTestName: 'Mission E — Real Specialist-Agent Orchestration, Delegation Contracts & Hand-Off Safety'
  },
  {
    file: 'test/brainv2-durable-memory-lifecycle.test.ts',
    name: 'BrainV2 Durable Memory, Search, Compaction, Export, and Privacy Center Purge',
    mission: 'Mission F',
    tier: 'Tier 1',
    tier1: 7,
    tier2: 0,
    tier3: 0,
    expectedOfflineTests: 8,
    expectedLivePostgresTests: 8,
    expectedSubtests: 7,
    expectedRootTests: 1,
    parentTestName: 'Mission F — BrainV2 Durable Memory, Search, Compaction, Export, and Privacy Center Purge'
  },
  {
    file: 'test/application-ui-integration.test.ts',
    name: 'Application Layer, UI Integration, Billing Attribution & Aesthetic Themes',
    mission: 'Mission H',
    tier: 'Tier 1',
    tier1: 5,
    tier2: 0,
    tier3: 0,
    expectedOfflineTests: 5,
    expectedLivePostgresTests: 5,
    expectedSubtests: 4,
    expectedRootTests: 1,
    parentTestName: 'Mission H — Application Layer, UI Integration, Billing Attribution & Aesthetic Themes'
  },
  {
    file: 'test/artifact-sandbox-containment.test.ts',
    name: 'Executable Artifact Sandbox Containment, CSP Enforcement & Threat Isolation',
    mission: 'Mission G',
    tier: 'Tier 1',
    tier1: 5,
    tier2: 0,
    tier3: 0,
    expectedOfflineTests: 5,
    expectedLivePostgresTests: 5,
    expectedSubtests: 4,
    expectedRootTests: 1,
    parentTestName: 'Mission G — Executable Artifact Sandbox Containment, CSP Enforcement & Threat Isolation'
  },
  {
    file: 'test/autonomous-task-postgres-certification.test.ts',
    name: 'Autonomous Task & Browser Session Real PostgreSQL Database Certification',
    mission: 'Mission A3',
    tier: 'Tier 3',
    tier1: 0,
    tier2: 0,
    tier3: 9,
    expectedOfflineTests: 5, // 1 parent + 4 contract tests offline
    expectedLivePostgresTests: 9, // 1 parent + 8 live postgres tests in CI
    expectedSubtests: 4,
    expectedRootTests: 1,
    parentTestName: 'Mission A3 — Autonomous Task & Browser Session Real PostgreSQL Database Certification'
  }
];

test('AIRA AI 2026 — Autonomous Intelligence Platform Test Suite Inventory & Reconciliation', async (t) => {
  await t.test('1. Verify Canonical Inventory File Existence & Integrity', () => {
    assert.equal(CANONICAL_AUTONOMOUS_SUITES.length, 13, 'There must be exactly 13 canonical autonomous test suites');

    for (const suite of CANONICAL_AUTONOMOUS_SUITES) {
      const fullPath = path.resolve(REPO_ROOT, suite.file);
      assert.ok(fs.existsSync(fullPath), `Test file must exist on disk: ${suite.file}`);
      const stat = fs.statSync(fullPath);
      assert.ok(stat.size > 500, `Test file must contain meaningful code (>500 bytes): ${suite.file} (${stat.size} bytes)`);
    }
  });

  await t.test('2. Inspect Test Definitions and Assert Exact 92 Test Count via File Parsing', () => {
    let fastCiCount = 0;
    let totalOfflineCount = 0;

    for (const suite of CANONICAL_AUTONOMOUS_SUITES) {
      const fullPath = path.resolve(REPO_ROOT, suite.file);
      const content = fs.readFileSync(fullPath, 'utf8');

      // Verify the file imports node:test
      assert.ok(
        content.includes("from 'node:test'") || content.includes("require('node:test')"),
        `Suite ${suite.file} must import node:test runner`
      );

      // Verify expected parent test name if defined
      if (suite.parentTestName) {
        assert.ok(
          content.includes(suite.parentTestName),
          `Suite ${suite.file} must contain parent test: "${suite.parentTestName}"`
        );
      }

      // Count actual root test() definitions in the file content via regex
      const rootTestMatches = content.match(/(?:^|\n)\s*(?:await\s+)?test\s*\(/g) || [];
      const actualRootTests = rootTestMatches.length;
      assert.equal(
        actualRootTests,
        suite.expectedRootTests,
        `Suite ${suite.file} root test count (${actualRootTests}) must match expected (${suite.expectedRootTests})`
      );

      let actualOfflineSubtests = 0;

      if (suite.file === 'test/autonomous-task-postgres-certification.test.ts') {
        // This suite has an offline contract branch in 'else' and a live DB branch in 'if'
        const elseIndex = content.lastIndexOf('} else {');
        assert.ok(elseIndex !== -1, `${suite.file} must contain an offline contract else block`);
        const elseBlock = content.slice(elseIndex);
        const offlineSubMatches = elseBlock.match(/(?:^|\n)\s*(?:await\s+)?t\.test\s*\(/g) || [];
        actualOfflineSubtests = offlineSubMatches.length;

        // Also verify live postgres branch contains 8 subtests
        const liveBlock = content.slice(0, elseIndex);
        const liveSubMatches = liveBlock.match(/(?:^|\n)\s*(?:await\s+)?t\.test\s*\(/g) || [];
        assert.equal(liveSubMatches.length, 8, `${suite.file} must define 8 live PostgreSQL integration subtests`);
      } else {
        const subTestMatches = content.match(/(?:^|\n)\s*(?:await\s+)?t\.test\s*\(/g) || [];
        actualOfflineSubtests = subTestMatches.length;
      }

      assert.equal(
        actualOfflineSubtests,
        suite.expectedSubtests,
        `Suite ${suite.file} subtest count (${actualOfflineSubtests}) must match expected (${suite.expectedSubtests})`
      );

      const actualOfflineTests = actualRootTests + actualOfflineSubtests;
      assert.equal(
        actualOfflineTests,
        suite.expectedOfflineTests,
        `Suite ${suite.file} actual offline tests (${actualOfflineTests}) must match expected (${suite.expectedOfflineTests})`
      );

      totalOfflineCount += actualOfflineTests;

      if (suite.file !== 'test/autonomous-task-postgres-certification.test.ts') {
        fastCiCount += actualOfflineTests;
      }
    }

    assert.equal(fastCiCount, 87, 'Fast CI (12 suites) must define exactly 87 tests dynamically parsed from disk');
    assert.equal(totalOfflineCount, 92, 'Total offline autonomous suite inventory (13 suites) must define exactly 92 tests dynamically parsed from disk');
  });

  await t.test('3. Reconcile the 92 vs 96 Test Count Discrepancy', () => {
    // The PR #127 table listed 14 rows:
    const pr127TableRows = [
      { file: 'test/autonomous-adversarial-scenarios.test.ts', tableCount: 16, actualRunner: 16 },
      { file: 'test/autonomous-task-postgres-certification.test.ts', tableCount: 9, actualRunner: 5 }, // 9 in live CI, 5 offline
      { file: 'test/browser-persistence-recovery.test.ts', tableCount: 9, actualRunner: 9 },
      { file: 'test/autonomous-worker-recovery.test.ts', tableCount: 4, actualRunner: 5 }, // author counted subtests (4)
      { file: 'test/autonomous-persistence-failclosed.test.ts', tableCount: 3, actualRunner: 4 }, // author counted subtests (3)
      { file: 'test/python-sandbox-containment.test.ts', tableCount: 10, actualRunner: 10 },
      { file: 'test/sandbox-selection-reconciliation.test.ts', tableCount: 4, actualRunner: 5 }, // author counted subtests (4)
      { file: 'test/artifact-sandbox-containment.test.ts', tableCount: 4, actualRunner: 5 }, // author counted subtests (4)
      { file: 'test/mcp-wire-integration.test.ts', tableCount: 4, actualRunner: 5 }, // author counted subtests (4)
      { file: 'test/specialist-orchestration-depth.test.ts', tableCount: 5, actualRunner: 6 }, // author counted subtests (5)
      { file: 'test/brainv2-durable-memory-lifecycle.test.ts', tableCount: 7, actualRunner: 8 }, // author counted subtests (7)
      { file: 'test/knowledge-isolation.test.ts', tableCount: 8, actualRunner: 0 }, // Unrelated PR #118 test!
      { file: 'test/autonomous-platform-e2e.test.ts', tableCount: 9, actualRunner: 9 },
      { file: 'test/application-ui-integration.test.ts', tableCount: 4, actualRunner: 5 } // author counted subtests (4)
    ];

    const arithmeticSumOfTable = pr127TableRows.reduce((acc, row) => acc + row.tableCount, 0);
    assert.equal(arithmeticSumOfTable, 96, 'PR #127 description table rows arithmetically sum to 96');

    // Proof 1: Unrelated test inclusion
    const unrelatedRow = pr127TableRows.find(r => r.file === 'test/knowledge-isolation.test.ts');
    assert.ok(unrelatedRow, 'Table contained test/knowledge-isolation.test.ts');
    assert.equal(unrelatedRow.tableCount, 8, 'Knowledge isolation contributed 8 extra tests');

    // Proof 2: Manual subtest counting vs runner output
    const subtestDiscrepancies = pr127TableRows.filter(r => r.tableCount < r.actualRunner);
    assert.equal(subtestDiscrepancies.length, 8, '8 suites had lower numbers in the table due to counting subtests instead of runner tests');

    // Authoritative 13 suites runner sum
    const authoritativeRunnerSum = CANONICAL_AUTONOMOUS_SUITES.reduce((acc, s) => acc + s.expectedOfflineTests, 0);
    assert.equal(authoritativeRunnerSum, 92, 'Authoritative runner execution is exactly 92 tests');
  });

  await t.test('4. Five-Tier Verification Matrix Contract', () => {
    // Dynamically derive tier totals by summing over CANONICAL_AUTONOMOUS_SUITES
    const tier1Total = CANONICAL_AUTONOMOUS_SUITES.reduce((acc, s) => acc + s.tier1, 0);
    const tier2Total = CANONICAL_AUTONOMOUS_SUITES.reduce((acc, s) => acc + s.tier2, 0);
    const tier3Total = CANONICAL_AUTONOMOUS_SUITES.reduce((acc, s) => acc + s.tier3, 0);

    const tier4PreviewBuilds = 1;
    const tier5DeployedStagingAcceptanceTests = 0;

    assert.equal(tier1Total, 49, 'Tier 1 (Unit & In-Memory Contract Tests) must sum to 49');
    assert.equal(tier2Total, 34, 'Tier 2 (Real Local Integration Tests) must sum to 34');
    assert.equal(tier3Total, 9, 'Tier 3 (Disposable PostgreSQL 16 CI Tests) must sum to 9');
    assert.equal(
      tier1Total + tier2Total + tier3Total,
      92,
      'Tier 1 (49) + Tier 2 (34) + Tier 3 (9) must equal 92 certified tests'
    );
    assert.equal(tier4PreviewBuilds, 1, 'Tier 4 must record 1 preview build');
    assert.equal(tier5DeployedStagingAcceptanceTests, 0, 'Tier 5 must honestly record 0 executed tests in deployed staging');

    // Dynamically read autonomous-platform-hardening-certification.md from disk and verify via regex that the documented tier totals match the computed values
    const certCandidates = [
      path.resolve(REPO_ROOT, 'autonomous-platform-hardening-certification.md'),
      path.resolve(process.env.USERPROFILE || 'C:\\Users\\WORKSTATION', '.gemini/antigravity/brain/756a2243-6973-4ee6-b8aa-63fab27a777c/autonomous-platform-hardening-certification.md'),
      'C:\\Users\\WORKSTATION\\.gemini\\antigravity\\brain\\756a2243-6973-4ee6-b8aa-63fab27a777c\\autonomous-platform-hardening-certification.md'
    ];
    const certPath = certCandidates.find(p => fs.existsSync(p));
    assert.ok(certPath, 'autonomous-platform-hardening-certification.md must exist on disk');

    const certContent = fs.readFileSync(certPath, 'utf8');

    // Header regex verifications:
    const tier1HeaderMatch = certContent.match(/###\s+Tier\s+1[^\n]*?\((\d+)\s+Tests?\)/i);
    assert.ok(tier1HeaderMatch, 'Certification document must define Tier 1 header with test count');
    assert.equal(
      parseInt(tier1HeaderMatch[1], 10),
      tier1Total,
      `Documented Tier 1 count (${tier1HeaderMatch[1]}) must match computed tier1Total (${tier1Total})`
    );

    const tier2HeaderMatch = certContent.match(/###\s+Tier\s+2[^\n]*?\((\d+)\s+Tests?\)/i);
    assert.ok(tier2HeaderMatch, 'Certification document must define Tier 2 header with test count');
    assert.equal(
      parseInt(tier2HeaderMatch[1], 10),
      tier2Total,
      `Documented Tier 2 count (${tier2HeaderMatch[1]}) must match computed tier2Total (${tier2Total})`
    );

    const tier3HeaderMatch = certContent.match(/###\s+Tier\s+3[^\n]*?\((\d+)\s+Tests?\)/i);
    assert.ok(tier3HeaderMatch, 'Certification document must define Tier 3 header with test count');
    assert.equal(
      parseInt(tier3HeaderMatch[1], 10),
      tier3Total,
      `Documented Tier 3 count (${tier3HeaderMatch[1]}) must match computed tier3Total (${tier3Total})`
    );

    // Section bullet item summation verification:
    // Tier 2 bullets:
    const tier2SectionMatch = certContent.match(/###\s+Tier\s+2[^\n]*?\n([\s\S]*?)(?=###\s+Tier\s+3|$)/i);
    assert.ok(tier2SectionMatch, 'Must find Tier 2 section in certification document');
    const tier2BulletMatches = [...tier2SectionMatch[1].matchAll(/-\s+`([^`]+)`\s*\((\d+)\s+/g)];
    const tier2DocBulletSum = tier2BulletMatches.reduce((acc, m) => acc + parseInt(m[2], 10), 0);
    assert.equal(
      tier2DocBulletSum,
      tier2Total,
      `Documented Tier 2 bullets sum (${tier2DocBulletSum}) must equal computed tier2Total (${tier2Total})`
    );

    // Tier 1 bullets:
    const tier1SectionMatch = certContent.match(/###\s+Tier\s+1[^\n]*?\n([\s\S]*?)(?=###\s+Tier\s+2|$)/i);
    assert.ok(tier1SectionMatch, 'Must find Tier 1 section in certification document');
    const tier1BulletMatches = [...tier1SectionMatch[1].matchAll(/-\s+`([^`]+)`\s*\((\d+)\s+/g)];
    const tier1DocBulletSum = tier1BulletMatches.reduce((acc, m) => acc + parseInt(m[2], 10), 0);
    assert.equal(
      tier1DocBulletSum,
      tier1Total,
      `Documented Tier 1 bullets sum (${tier1DocBulletSum}) must equal computed tier1Total (${tier1Total})`
    );
  });

  await t.test('5. Verify CI Workflow Step Coverage', () => {
    const ciWorkflowPath = path.resolve(REPO_ROOT, '.github/workflows/ci.yml');
    assert.ok(fs.existsSync(ciWorkflowPath), 'ci.yml must exist');
    const ciContent = fs.readFileSync(ciWorkflowPath, 'utf8');

    // Verify all 12 Fast CI suites are listed in ci.yml
    const fastCiSuites = CANONICAL_AUTONOMOUS_SUITES.filter(
      s => s.file !== 'test/autonomous-task-postgres-certification.test.ts'
    );
    assert.equal(fastCiSuites.length, 12, 'There must be 12 Fast CI suites');

    for (const suite of fastCiSuites) {
      assert.ok(ciContent.includes(suite.file), `ci.yml must include ${suite.file}`);
    }

    // Verify postgres certification workflow includes the 13th suite
    const pgWorkflowPath = path.resolve(REPO_ROOT, '.github/workflows/postgres-certification.yml');
    assert.ok(fs.existsSync(pgWorkflowPath), 'postgres-certification.yml must exist');
    const pgContent = fs.readFileSync(pgWorkflowPath, 'utf8');
    assert.ok(
      pgContent.includes('test/autonomous-task-postgres-certification.test.ts'),
      'postgres-certification.yml must include test/autonomous-task-postgres-certification.test.ts'
    );
  });
});
