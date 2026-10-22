/**
 * AIRA AI 2026 — PR #96 Permanent Staging Cutover Orchestrator & Integrity Gate
 *
 * Implements the authoritative 9-step staging release and cutover state machine:
 * 1. Verify staging release authorization (explicit owner GO LIVE instruction).
 * 2. Verify exact approved PR commit SHA.
 * 3. Create and verify current staging database recovery checkpoint (Neon branch/point-in-time).
 * 4. Prevent concurrent staging writes during migration and import (maintenance window).
 * 5. Execute migrations 016–022 against staging (via automated Vercel deployment build guard).
 * 6. Execute controlled historical identity import from verified Commercial source database.
 * 7. Verify OAuth mappings, credits, wallets, conversations, and referential integrity.
 * 8. Certify deployed staging application and commit SHA.
 * 9. Permit real-browser acceptance only after all required gates succeed.
 */

import { execSync } from 'child_process';
import knex, { Knex } from 'knex';
import {
  classifyDatabaseUrl,
  STAGING_NEON_PROJECT_ID,
  STAGING_NEON_BRANCH_ID,
  STAGING_NEON_ENDPOINT_ID,
  PRODUCTION_NEON_PROJECT_ID,
  COMMERCIAL_PR92_BRANCH_ID,
  COMMERCIAL_PR92_ENDPOINT_ID,
  STAGING_CANONICAL_DOMAIN,
  STAGING_VERCEL_PREVIEW_HOST
} from '../packages/db/src/security/database-isolation-guard.js';
import {
  validateAuthoritativeTargetSafety,
  verifyConnectedTargetMetadata,
  importVerifiedCommercialIdentities,
  ImportSummary
} from './import-verified-commercial-identities.js';

export interface CutoverStepDefinition {
  step: number;
  id: string;
  title: string;
  executor: 'OWNER_MANUAL' | 'CI_PIPELINE' | 'VERCEL_AUTOMATION' | 'ORCHESTRATOR';
  description: string;
  prerequisites: string[];
  verificationGate: string;
  safeguard: string;
  rollbackAction: string;
}

export interface FailureRecoveryPhase {
  phase: 'BEFORE_MIGRATION' | 'DURING_MIGRATION' | 'AFTER_MIGRATION_BEFORE_MERGE' | 'AFTER_MERGE' | 'AFTER_HISTORICAL_IMPORT';
  stageRange: string;
  condition: string;
  maintenanceDeactivationPermitted: boolean;
  checkpointRestorationRequired: boolean;
  codeRevertRequired: boolean;
  recoveryProcedure: string;
}

/**
 * Authoritative 5-Phase Cutover Failure Recovery Matrix.
 * Guarantees that failures occurring after schema migrations 016–022 have begun
 * CANNOT be resolved by merely deactivating the maintenance barrier.
 */
export const CUTOVER_FAILURE_RECOVERY_MATRIX: FailureRecoveryPhase[] = [
  {
    phase: 'BEFORE_MIGRATION',
    stageRange: 'Stages 1–3 (Preflight, Checkpoint, Barrier Activation, Write Isolation Probe)',
    condition: 'Failure occurs before schema migrations 016–022 are initiated. Staging database schema is intact at migration 015.',
    maintenanceDeactivationPermitted: true,
    checkpointRestorationRequired: false,
    codeRevertRequired: false,
    recoveryProcedure: 'Safe to deactivate maintenance barrier immediately (npx tsx scripts/staging-maintenance-control.ts --deactivate). Database schema has not been modified.'
  },
  {
    phase: 'DURING_MIGRATION',
    stageRange: 'Stage 4 (Applying Migrations 016–022)',
    condition: 'Failure occurs mid-migration. Migrations 016–022 are partially applied, leaving schema in an inconsistent intermediate state.',
    maintenanceDeactivationPermitted: false,
    checkpointRestorationRequired: true,
    codeRevertRequired: false,
    recoveryProcedure: 'DO NOT DEACTIVATE MAINTENANCE BARRIER. Keep barrier active fail-closed. Restore permanent staging database (br-autumn-star-b36dfu5w) from the Step 3 Neon recovery checkpoint (staging-backup-pre-commercial-cutover) via Neon Console/CLI point-in-time restore. Verify restored database is at clean schema 015 before any barrier deactivation.'
  },
  {
    phase: 'AFTER_MIGRATION_BEFORE_MERGE',
    stageRange: 'Stage 4 (Migrations 016–022 complete, but PR #96 NOT yet merged into staging)',
    condition: 'Migrations 016–022 succeeded, but Vercel preview build failed, or operator aborts before merging PR #96 into staging. Database is at schema 022 while staging branch code is at 015.',
    maintenanceDeactivationPermitted: false,
    checkpointRestorationRequired: true,
    codeRevertRequired: false,
    recoveryProcedure: 'DO NOT DEACTIVATE MAINTENANCE BARRIER. Merely deactivating maintenance would expose older staging code (schema 015) to incompatible schema 022 tables. Mandatory restoration of permanent staging database from Step 3 Neon recovery checkpoint (staging-backup-pre-commercial-cutover). Deactivate maintenance only after clean checkpoint restoration is verified.'
  },
  {
    phase: 'AFTER_MERGE',
    stageRange: 'Stage 4 post-merge through Stage 8 (Vercel staging deployment built/live, but app health check or smoke test fails)',
    condition: 'PR #96 was merged into staging and Vercel deployed, but runtime error, health check failure, or regression detected before certification.',
    maintenanceDeactivationPermitted: false,
    checkpointRestorationRequired: true,
    codeRevertRequired: true,
    recoveryProcedure: '1. Revert merge commit on staging branch: git revert -m 1 <merge_sha> && git push origin staging.\n2. Vercel automatically deploys reverted commit or promote previous stable staging deployment.\n3. Keep maintenance barrier active.\n4. Restore permanent staging database from Step 3 Neon recovery checkpoint (staging-backup-pre-commercial-cutover).\n5. Deactivate maintenance barrier ONLY after both code revert and database restore are confirmed complete.'
  },
  {
    phase: 'AFTER_HISTORICAL_IMPORT',
    stageRange: 'Stage 5–6 (Historical identity import completed, but integrity audit fails or data corruption detected)',
    condition: 'Stage 5 import executed and committed, but Stage 6 integrity check, wallet invariant, or browser acceptance reveals corruption or data drift.',
    maintenanceDeactivationPermitted: false,
    checkpointRestorationRequired: true,
    codeRevertRequired: true,
    recoveryProcedure: '1. Revert staging branch if PR #96 was merged.\n2. DO NOT deactivate maintenance barrier.\n3. Restore permanent staging database from Step 3 Neon recovery checkpoint (staging-backup-pre-commercial-cutover) to erase all imported data safely.\n4. Re-verify restored database integrity (assert 0 corrupted accounts, clean baseline).\n5. Deactivate maintenance barrier only after clean restoration is verified.'
  }
];

export function getFailureRecoveryPhase(phase: FailureRecoveryPhase['phase']): FailureRecoveryPhase {
  const match = CUTOVER_FAILURE_RECOVERY_MATRIX.find(p => p.phase === phase);
  if (!match) throw new Error(`Unknown failure recovery phase: ${phase}`);
  return match;
}

export const CUTOVER_PROTOCOL_STEPS: CutoverStepDefinition[] = [
  {
    step: 1,
    id: '1_STAGING_RELEASE_AUTH',
    title: 'Verify Staging Release Authorization',
    executor: 'OWNER_MANUAL',
    description: 'Require fresh, explicit GO LIVE instruction from repository owner (rajpunkeshwarrajgautam-boop) targeting staging for the exact approved commit SHA.',
    prerequisites: ['PR #96 Draft review complete', 'CI passing on candidate commit', 'Rehearsal on isolated Neon branch passed'],
    verificationGate: 'Owner authorization recorded with exact PR #96 candidate SHA. No simulated approvals permitted.',
    safeguard: 'Release procedure halts immediately if explicit owner authorization is absent.',
    rollbackAction: 'Abort cutover preparation; retain current permanent staging without modification.'
  },
  {
    step: 2,
    id: '2_EXACT_COMMIT_VERIFICATION',
    title: 'Verify Exact Approved PR Commit SHA',
    executor: 'CI_PIPELINE',
    description: 'Compare explicitly approved 40-character SHA with local HEAD and remote PR #96 HEAD (feat/commercial-staging-integration). Fail closed on any mismatch or uncommitted change.',
    prerequisites: ['Step 1 complete', 'Clean working tree on PR #96 branch'],
    verificationGate: 'approved_sha === local_head === remote_head; 40-character hex validated; GitHub check runs clean.',
    safeguard: 'Fail closed on commit SHA drift or transcription errors.',
    rollbackAction: 'Refuse merge; require recheck of remote PR HEAD and exact commit status.'
  },
  {
    step: 3,
    id: '3_RECOVERY_CHECKPOINT',
    title: 'Create and Verify Staging Database Recovery Checkpoint',
    executor: 'OWNER_MANUAL',
    description: 'Create and machine-verify an isolated point-in-time recovery branch in Neon project mute-frost-50372225 (parent: br-autumn-star-b36dfu5w) before running migrations on permanent staging.',
    prerequisites: ['Step 2 complete', 'Access to Neon CLI / Console on project mute-frost-50372225'],
    verificationGate: 'Machine verification via neonctl branches list confirms branch active in project mute-frost-50372225 with parent br-autumn-star-b36dfu5w.',
    safeguard: 'Never execute destructive schema operations without an authoritative instant rollback branch.',
    rollbackAction: 'Abort cutover; investigate checkpoint creation failure.'
  },
  {
    step: 4,
    id: '4_PREVENT_CONCURRENT_WRITES',
    title: 'Activate Staging Maintenance Barrier & Verify Write Isolation',
    executor: 'OWNER_MANUAL',
    description: 'Activate reversible database maintenance barrier on mute-frost-50372225 (read-only default, sentinel table, write triggers), drain in-flight transactions, and machine-verify all 5 write-isolation gates before merge.',
    prerequisites: ['Step 3 complete'],
    verificationGate: 'verifyStagingWriteIsolation confirms all 5 gates PASS: STAGING_DATABASE_IDENTITY, MAINTENANCE_BARRIER_ACTIVE, RUNTIME_WRITE_RESTRICTION, IN_FLIGHT_WRITES_DRAINED, PRIVILEGED_MIGRATION_PATH.',
    safeguard: 'Prevents race conditions, background writers, or older Vercel deployments from mutating database during cutover.',
    rollbackAction: 'Before migrations begin: Deactivate maintenance barrier via scripts/staging-maintenance-control.ts --deactivate. (NOTE: If migrations have commenced, follow CUTOVER_FAILURE_RECOVERY_MATRIX; barrier deactivation alone is prohibited).'
  },
  {
    step: 5,
    id: '5_EXECUTE_MIGRATIONS_016_022',
    title: 'Execute Schema Migrations 016–022 & Vercel Build Verification',
    executor: 'VERCEL_AUTOMATION',
    description: 'Operator applies migrations 016–022 using privileged migration credential & bypass token. Upon merge to staging, Vercel staging build executes scripts/staging-db-guard.ts && npm run db:migrate (verifying zero pending migrations without needing bypass token) && npm run db:verify:deploy.',
    prerequisites: ['Step 4 complete', 'Owner merge to staging authorized', 'Staging DB guard verified'],
    verificationGate: 'knex_migrations table has exactly 22 applied migrations; db:verify:deploy exits with code 0.',
    safeguard: 'runMigrations skips Knex lock acquisition under maintenance mode when all migrations are already applied; fails closed if unapplied migrations remain without token; staging-db-guard.ts verifies target.',
    rollbackAction: 'DO NOT merely deactivate maintenance. If migration fails mid-run, keep barrier active and restore database from Step 3 recovery checkpoint. If aborted before merge, restore database from checkpoint. If merged, revert staging git commit and restore database.'
  },
  {
    step: 6,
    id: '6_EXECUTE_HISTORICAL_IMPORT',
    title: 'Execute Controlled Historical Identity Import',
    executor: 'OWNER_MANUAL',
    description: 'Execute scripts/import-verified-commercial-identities.ts with authenticated source (PR #92 isolated branch) and destination (permanent staging) using AIRA_ALLOW_STAGING_LIVE_IMPORT=true.',
    prerequisites: ['Step 5 complete', 'Migrations 016–022 applied', 'Source DB credentials available strictly to owner session'],
    verificationGate: 'Import completes within an atomic transaction. Reconciles exactly 3 OAuth mappings, 2 billing customers, 2 credit accounts (100 credits each).',
    safeguard: 'Authoritative Neon metadata check confirms project mute-frost-50372225; source is read-only; target writes run in an atomic Knex transaction.',
    rollbackAction: 'In-flight transaction aborts automatically on error. If committed import fails subsequent integrity checks, DO NOT deactivate maintenance: revert staging code if merged, and restore database from Step 3 Neon recovery checkpoint.'
  },
  {
    step: 7,
    id: '7_MAINTENANCE_ACTIVE_VERIFICATION',
    title: 'Maintenance-Active Verification & Write Restriction Probe',
    executor: 'ORCHESTRATOR',
    description: 'Verify deployment identity, database integrity, schema version 022, and read-only health checks. Actively prove mutating endpoints return HTTP 503 [STAGING_MAINTENANCE_BLOCKED] and database unprivileged writes are blocked with SQLSTATE 55P03.',
    prerequisites: ['Step 6 complete', 'Migrations 016–022 applied', 'Historical identity import complete'],
    verificationGate: 'All 11 data integrity assertions pass with zero errors (verifyStagingCutoverIntegrity returns certified=true); read-only health checks return HTTP 200; mutating endpoints return HTTP 503; unprivileged writes blocked.',
    safeguard: 'Authentication and chat writes are intentionally blocked; no mutating user traffic permitted while barrier is active.',
    rollbackAction: 'Stop cutover immediately. Do not certify staging. Revert staging git merge if applied, and restore database to Step 3 recovery checkpoint before any barrier deactivation.'
  },
  {
    step: 8,
    id: '8_CONTROLLED_MAINTENANCE_DEACTIVATION',
    title: 'Controlled Maintenance Deactivation & Write Restoration Gate',
    executor: 'OWNER_MANUAL',
    description: 'Deactivate maintenance barrier ONLY after all required database integrity, schema version, and deployment identity checks pass. Explicitly verify database writes are restored and retire maintenance bypass token.',
    prerequisites: ['Step 7 complete and certified', 'All 11 integrity gates PASS', 'Vercel staging deployment READY'],
    verificationGate: 'Maintenance barrier cleanly deactivated; default_transaction_read_only reset to off; write triggers dropped; write restoration probe verified.',
    safeguard: 'Deactivation is strictly prohibited if Step 7 integrity checks have not passed.',
    rollbackAction: 'If deactivation fails or database remains locked, investigate locks; if schema inconsistent, restore from Step 3 checkpoint.'
  },
  {
    step: 9,
    id: '9_POST_DEACTIVATION_BROWSER_ACCEPTANCE',
    title: 'Post-Deactivation Live Real-Browser Acceptance & Certification',
    executor: 'OWNER_MANUAL',
    description: 'Perform live owner real-browser acceptance on staging.virexaaiventures.com with writes restored: Google/GitHub OAuth login, credit wallet 100 balance continuity, and real chat streaming with persistence.',
    prerequisites: ['Step 8 complete', 'Maintenance barrier cleanly deactivated', 'Writes verified restored'],
    verificationGate: 'Real browser login succeeds with historical accounts; credit balance displays 100 credits; real chat streams and persists; never claim PASS from a simulated browser test.',
    safeguard: 'If browser acceptance fails: re-activate maintenance barrier immediately if safe, stop certification, and execute recovery checkpoint rollback.',
    rollbackAction: 'If browser acceptance fails: Re-activate maintenance barrier immediately. Restore database from Step 3 Neon checkpoint and revert staging code. Do not certify release.'
  }
];

export interface StagingIntegrityAuditResult {
  certified: boolean;
  timestamp: string;
  database: {
    sanitizedTarget: string;
    neonProjectId?: string;
    neonBranchId?: string;
    neonEndpointId?: string;
  };
  metrics: {
    migrationsCount: number;
    usersCount: number;
    oauthAccountsCount: number;
    billingCustomersCount: number;
    creditAccountsCount: number;
    creditGrantsCount: number;
    creditTransactionsCount: number;
    conversationsCount: number;
    conversationMessagesCount: number;
    orphanedConversationsCount: number;
    duplicateOAuthAccountsCount: number;
    multiWalletCustomersCount: number;
  };
  checks: Record<string, boolean>;
  details: string[];
}

/**
 * Validates that a target database has completed both migrations 016–022
 * and the controlled historical identity import, fulfilling all 11 integrity assertions.
 */
export async function verifyStagingCutoverIntegrity(
  targetClient: Knex,
  options: { allowPermanentStaging?: boolean } = {}
): Promise<StagingIntegrityAuditResult> {
  const details: string[] = [];
  const checks: Record<string, boolean> = {};

  // 1. Query Database Identity
  let dbInfo: any = {};
  try {
    const rawRes = await targetClient.raw(`
      SELECT 
        current_database() as db_name,
        current_user as db_user,
        current_setting('neon.project_id', true) as neon_project_id,
        current_setting('neon.branch_id', true) as neon_branch_id,
        current_setting('neon.endpoint_id', true) as neon_endpoint_id
    `);
    dbInfo = rawRes.rows?.[0] || {};
  } catch (err: any) {
    details.push(`Notice querying Neon GUCs: ${err.message}`);
  }

  // 2. Migration Count Check
  let migrationsCount = 0;
  try {
    const migRows = await targetClient('knex_migrations').select('name');
    migrationsCount = migRows.length;
  } catch {
    migrationsCount = 0;
  }
  checks['MIGRATIONS_016_022_APPLIED'] = migrationsCount === 22;
  details.push(`Migrations Applied: ${migrationsCount}/22 (${checks['MIGRATIONS_016_022_APPLIED'] ? 'PASS' : 'FAIL'})`);

  // 3. Table Presence Check
  const tablesRes = await targetClient.raw("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  const tables: string[] = tablesRes.rows.map((r: any) => r.tablename);
  const requiredTables = [
    'users',
    'oauth_accounts',
    'billing_customers',
    'credit_accounts',
    'credit_grants',
    'credit_transactions',
    'conversations',
    'conversation_messages'
  ];
  const missingTables = requiredTables.filter(t => !tables.includes(t));
  checks['REQUIRED_TABLES_PRESENT'] = missingTables.length === 0;
  details.push(`Required Tables: ${checks['REQUIRED_TABLES_PRESENT'] ? 'ALL PRESENT' : 'MISSING: ' + missingTables.join(', ')}`);

  if (!checks['REQUIRED_TABLES_PRESENT']) {
    return {
      certified: false,
      timestamp: new Date().toISOString(),
      database: {
        sanitizedTarget: dbInfo.db_name || 'unknown',
        neonProjectId: dbInfo.neon_project_id,
        neonBranchId: dbInfo.neon_branch_id,
        neonEndpointId: dbInfo.neon_endpoint_id
      },
      metrics: {
        migrationsCount,
        usersCount: 0,
        oauthAccountsCount: 0,
        billingCustomersCount: 0,
        creditAccountsCount: 0,
        creditGrantsCount: 0,
        creditTransactionsCount: 0,
        conversationsCount: 0,
        conversationMessagesCount: 0,
        orphanedConversationsCount: -1,
        duplicateOAuthAccountsCount: -1,
        multiWalletCustomersCount: -1
      },
      checks,
      details
    };
  }

  // 4. Metric Counts
  const usersCount = Number((await targetClient('users').count('* as cnt'))[0].cnt);
  const oauthAccountsCount = Number((await targetClient('oauth_accounts').count('* as cnt'))[0].cnt);
  const billingCustomersCount = Number((await targetClient('billing_customers').count('* as cnt'))[0].cnt);
  const creditAccountsCount = Number((await targetClient('credit_accounts').count('* as cnt'))[0].cnt);
  const creditGrantsCount = Number((await targetClient('credit_grants').count('* as cnt'))[0].cnt);
  const creditTransactionsCount = Number((await targetClient('credit_transactions').count('* as cnt'))[0].cnt);
  const conversationsCount = Number((await targetClient('conversations').count('* as cnt'))[0].cnt);
  const conversationMessagesCount = Number((await targetClient('conversation_messages').count('* as cnt'))[0].cnt);

  // 5. Invariant: User Preservation (Legacy principals reconciled into users with email: null)
  const legacyWithEmail = await targetClient('users')
    .where('name', 'Legacy Session Principal')
    .whereNotNull('email');
  checks['LEGACY_PRINCIPALS_SAFE'] = legacyWithEmail.length === 0;
  details.push(`Legacy Anonymous Principals email:null: ${checks['LEGACY_PRINCIPALS_SAFE'] ? 'PASS' : 'FAIL'}`);

  // 6. Invariant: Historical Social Users & OAuth Accounts
  checks['HISTORICAL_USERS_PRESENT'] = usersCount >= 8;
  checks['OAUTH_ACCOUNTS_PRESENT'] = oauthAccountsCount >= 3;
  details.push(`Users Count: ${usersCount} (expected >= 8) -> ${checks['HISTORICAL_USERS_PRESENT'] ? 'PASS' : 'FAIL'}`);
  details.push(`OAuth Accounts Count: ${oauthAccountsCount} (expected >= 3) -> ${checks['OAUTH_ACCOUNTS_PRESENT'] ? 'PASS' : 'FAIL'}`);

  // 7. Invariant: Provider Account Uniqueness
  const dupOARes = await targetClient.raw(`
    SELECT provider, provider_account_id, count(*) as cnt
    FROM oauth_accounts
    GROUP BY provider, provider_account_id
    HAVING count(*) > 1
  `);
  const duplicateOAuthAccountsCount = dupOARes.rows.length;
  checks['PROVIDER_ACCOUNT_UNIQUENESS'] = duplicateOAuthAccountsCount === 0;
  details.push(`Duplicate OAuth Accounts: ${duplicateOAuthAccountsCount} -> ${checks['PROVIDER_ACCOUNT_UNIQUENESS'] ? 'PASS' : 'FAIL'}`);

  // 8. Invariant: Billing Customers & 1:1 Wallet Constraint
  checks['BILLING_CUSTOMERS_PRESENT'] = billingCustomersCount >= 2;
  checks['CREDIT_ACCOUNTS_PRESENT'] = creditAccountsCount >= 2;
  
  const multiWalletRes = await targetClient.raw(`
    SELECT customer_id, count(*) as cnt
    FROM credit_accounts
    GROUP BY customer_id
    HAVING count(*) > 1
  `);
  const multiWalletCustomersCount = multiWalletRes.rows.length;
  checks['ONE_WALLET_PER_CUSTOMER'] = multiWalletCustomersCount === 0;
  details.push(`Multi-Wallet Customers: ${multiWalletCustomersCount} -> ${checks['ONE_WALLET_PER_CUSTOMER'] ? 'PASS' : 'FAIL'}`);

  // 9. Invariant: Credit Balance Integrity (exact 100 credits, 0 reserved)
  const wallets = await targetClient('credit_accounts').select('*');
  let walletsValid = wallets.length >= 2;
  for (const w of wallets) {
    if (w.balance_credits !== 100 || w.reserved_credits !== 0) {
      walletsValid = false;
      details.push(`Wallet ${w.id} balance invalid: balance=${w.balance_credits}, reserved=${w.reserved_credits}`);
    }
  }
  checks['WALLET_BALANCES_PRESERVED'] = walletsValid;
  details.push(`Wallet Balances Intact (100 credits, 0 reserved): ${checks['WALLET_BALANCES_PRESERVED'] ? 'PASS' : 'FAIL'}`);

  // 10. Invariant: Financial Ledger Preservation (Grants & Transactions)
  checks['FINANCIAL_LEDGER_PRESERVED'] = creditGrantsCount >= 2 && creditTransactionsCount >= 2;
  details.push(`Financial Ledger: grants=${creditGrantsCount}, transactions=${creditTransactionsCount} -> ${checks['FINANCIAL_LEDGER_PRESERVED'] ? 'PASS' : 'FAIL'}`);

  // 11. Invariant: Conversation Ownership & Zero Orphans
  checks['CONVERSATIONS_PRESERVED'] = conversationsCount >= 7 && conversationMessagesCount >= 102;
  details.push(`Conversations Preserved: convs=${conversationsCount}, msgs=${conversationMessagesCount} -> ${checks['CONVERSATIONS_PRESERVED'] ? 'PASS' : 'FAIL'}`);

  const orphanRes = await targetClient.raw(`
    SELECT c.id, c.principal_id
    FROM conversations c
    LEFT JOIN users u ON c.principal_id = u.id
    WHERE u.id IS NULL
  `);
  const orphanedConversationsCount = orphanRes.rows.length;
  checks['ZERO_ORPHANED_CONVERSATIONS'] = orphanedConversationsCount === 0;
  details.push(`Orphaned Conversations: ${orphanedConversationsCount} -> ${checks['ZERO_ORPHANED_CONVERSATIONS'] ? 'PASS' : 'FAIL'}`);

  // Overall certification
  const certified = Object.values(checks).every(Boolean);

  return {
    certified,
    timestamp: new Date().toISOString(),
    database: {
      sanitizedTarget: dbInfo.db_name || 'neondb',
      neonProjectId: dbInfo.neon_project_id,
      neonBranchId: dbInfo.neon_branch_id,
      neonEndpointId: dbInfo.neon_endpoint_id
    },
    metrics: {
      migrationsCount,
      usersCount,
      oauthAccountsCount,
      billingCustomersCount,
      creditAccountsCount,
      creditGrantsCount,
      creditTransactionsCount,
      conversationsCount,
      conversationMessagesCount,
      orphanedConversationsCount,
      duplicateOAuthAccountsCount,
      multiWalletCustomersCount
    },
    checks,
    details
  };
}

export function printCutoverProtocol(): void {
  console.log('\n================================================================================');
  console.log('       AIRA AI 2026 — PR #96 CONTROLLED STAGING CUTOVER PROTOCOL (9 STEPS)       ');
  console.log('================================================================================\n');

  for (const step of CUTOVER_PROTOCOL_STEPS) {
    console.log(`[STEP ${step.step}] ${step.title.toUpperCase()} (${step.id})`);
    console.log(`  Executor:        ${step.executor}`);
    console.log(`  Description:     ${step.description}`);
    console.log(`  Prerequisites:   ${step.prerequisites.join('; ')}`);
    console.log(`  Gate:            ${step.verificationGate}`);
    console.log(`  Safety Guard:    ${step.safeguard}`);
    console.log(`  Rollback Action: ${step.rollbackAction}`);
    console.log('--------------------------------------------------------------------------------');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--plan';

  if (mode === '--plan' || mode === 'plan') {
    printCutoverProtocol();
    console.log('\nCutover protocol ready. Stop before permanent staging mutation.\n');
    process.exit(0);
  }

  if (mode === '--verify-integrity' || mode === 'verify-integrity') {
    const targetCs = args[1] || process.env.TARGET_DB_URL || process.env.DATABASE_URL;
    if (!targetCs) {
      console.error('Error: Target database connection string required for integrity audit.');
      process.exit(1);
    }

    validateAuthoritativeTargetSafety(targetCs, {
      allowPermanentStaging: process.env.AIRA_ALLOW_STAGING_LIVE_IMPORT === 'true'
    });

    const client = knex({
      client: 'pg',
      connection: { connectionString: targetCs, ssl: true }
    });

    try {
      console.log('Running staging cutover integrity audit...');
      const audit = await verifyStagingCutoverIntegrity(client);
      console.log('\nIntegrity Audit Result:', JSON.stringify(audit, null, 2));

      if (!audit.certified) {
        console.error('\n❌ STAGING CUTOVER INTEGRITY FAILED');
        process.exit(1);
      }
      console.log('\n✅ STAGING CUTOVER INTEGRITY FULLY CERTIFIED');
      process.exit(0);
    } finally {
      await client.destroy();
    }
  }

  if (mode === '--rehearsal-audit' || mode === 'rehearsal-audit') {
    const rehearsalBranch = process.env.REHEARSAL_BRANCH || 'rehearsal-pr96-final-20261021';
    console.log(`Auditing fresh rehearsal branch: ${rehearsalBranch}...`);

    const targetCs = execSync(`npx neonctl connection-string ${rehearsalBranch} --project-id mute-frost-50372225`, { encoding: 'utf8' }).trim();
    validateAuthoritativeTargetSafety(targetCs, { allowPermanentStaging: false });

    const client = knex({
      client: 'pg',
      connection: { connectionString: targetCs, ssl: true }
    });

    try {
      const audit = await verifyStagingCutoverIntegrity(client);
      console.log('\nRehearsal Branch Integrity Audit Result:');
      for (const d of audit.details) {
        console.log(`  ${d}`);
      }
      console.log(`\nOverall Rehearsal Status: ${audit.certified ? 'CERTIFIED' : 'PENDING'}`);
      if (!audit.certified) {
        process.exit(1);
      }
      process.exit(0);
    } finally {
      await client.destroy();
    }
  }
}

if (process.argv[1]?.includes('staging-cutover-orchestrator')) {
  main().catch(err => {
    console.error('Orchestrator error:', err);
    process.exit(1);
  });
}
