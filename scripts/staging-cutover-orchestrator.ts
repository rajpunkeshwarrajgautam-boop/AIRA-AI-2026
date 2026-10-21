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
    title: 'Verify Effective Staging Write Isolation',
    executor: 'OWNER_MANUAL',
    description: 'Announce staging maintenance window and machine-verify zero active client write transactions (pg_stat_activity) and zero conflicting table locks (pg_locks).',
    prerequisites: ['Step 3 complete'],
    verificationGate: 'pg_stat_activity confirms zero active write transactions and pg_locks confirms zero conflicting exclusive locks.',
    safeguard: 'Prevents race conditions or session collisions during account reconciliation.',
    rollbackAction: 'Clear maintenance mode flag and restore normal staging routing.'
  },
  {
    step: 5,
    id: '5_EXECUTE_MIGRATIONS_016_022',
    title: 'Execute Schema Migrations 016–022 Against Staging',
    executor: 'VERCEL_AUTOMATION',
    description: 'Upon authorized merge of PR #96 into staging, Vercel build executes scripts/staging-db-guard.ts && npm run db:migrate && npm run db:verify:deploy.',
    prerequisites: ['Step 4 complete', 'Owner merge to staging authorized', 'Staging DB guard verified'],
    verificationGate: 'knex_migrations table has exactly 22 applied migrations; db:verify:deploy exits with code 0.',
    safeguard: 'staging-db-guard.ts rejects any non-staging database host before executing knex migrate.',
    rollbackAction: 'Revert staging branch commit or restore database to Step 3 recovery checkpoint.'
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
    rollbackAction: 'Transaction automatically aborts on error (zero partial data loss); restore from Step 3 checkpoint if post-import corruption occurs.'
  },
  {
    step: 7,
    id: '7_VERIFY_DATA_INTEGRITY',
    title: 'Verify OAuth Mappings, Credits, Wallets, and Referential Integrity',
    executor: 'ORCHESTRATOR',
    description: 'Run comprehensive post-import verification asserting 1:1 wallet invariant, non-negative credit balances, provider account uniqueness, and zero orphaned conversations.',
    prerequisites: ['Step 6 complete'],
    verificationGate: 'All 11 data integrity assertions pass with zero errors (verifyStagingCutoverIntegrity returns certified=true).',
    safeguard: 'Fails closed if any wallet drift, orphan conversation, or duplicate OAuth identity is discovered.',
    rollbackAction: 'Stop cutover immediately. Do not certify staging. Revert to Step 3 recovery branch.'
  },
  {
    step: 8,
    id: '8_CERTIFY_DEPLOYED_APP',
    title: 'Certify Deployed Staging Application and Commit SHA',
    executor: 'CI_PIPELINE',
    description: 'Permanent staging pipeline attestation verifies deployed Vercel deployment URL matches approved commit SHA, health checks return 200, and records staging-certification.json artifact.',
    prerequisites: ['Step 7 complete', 'Vercel staging deployment READY'],
    verificationGate: 'HTTP smoke test against staging.virexaaiventures.com succeeds; certification artifact uploaded.',
    safeguard: 'Certification cannot be awarded if Step 6 or Step 7 integrity checks have not passed.',
    rollbackAction: 'Vercel instant rollback to previous stable staging deployment.'
  },
  {
    step: 9,
    id: '9_PERMIT_REAL_BROWSER_ACCEPTANCE',
    title: 'Permit Real-Browser Acceptance Testing',
    executor: 'OWNER_MANUAL',
    description: 'Unlock staging application for owner real-browser acceptance: direct Google/GitHub login, conversation continuation, credit display, and chat completions.',
    prerequisites: ['Steps 1 through 8 all verified and certified'],
    verificationGate: 'Real browser login succeeds with historical accounts; credit balance displays 100 credits; conversations stream.',
    safeguard: 'Zero Production mutation; Production Neon and domains remain completely isolated.',
    rollbackAction: 'Revoke staging session; report defect; isolate affected component.'
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
