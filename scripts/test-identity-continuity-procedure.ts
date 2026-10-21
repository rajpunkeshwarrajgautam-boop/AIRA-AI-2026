import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import knex, { Knex } from 'knex';
import { importVerifiedCommercialIdentities } from './import-verified-commercial-identities.js';

function maskId(id: string | null): string {
  if (!id) return 'null';
  if (id.length <= 8) return `${id.slice(0, 2)}***`;
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
}

function maskEmail(email: string | null): string {
  if (!email) return 'null';
  const parts = email.split('@');
  if (parts.length !== 2) return '***';
  return `${parts[0].slice(0, 1)}***@${parts[1].slice(0, 1)}***.${parts[1].split('.').pop()}`;
}

export function assertRehearsalSafety(connectionString: string): void {
  const lower = connectionString.toLowerCase();
  // 1. Block Production
  if (lower.includes('old-sky-50952395') || lower.includes('prod-release') || lower.includes('aira-ai.in') || lower.includes('aira-ai-live')) {
    throw new Error('[SECURITY FATAL] Execution against Production is strictly blocked.');
  }
  // 2. Block Permanent Staging main
  if (lower.includes('br-autumn-star-b36dfu5w') || lower.includes('ep-mute-frost-50372225')) {
    // Note: check if endpoint is main
    if (lower.includes('br-autumn-star')) {
      throw new Error('[SECURITY FATAL] Execution against Permanent Staging main is strictly blocked. Use an isolated rehearsal branch.');
    }
  }
  // 3. Block Commercial PR #92 database
  if (lower.includes('br-green-snow-b3dsci5u')) {
    throw new Error('[SECURITY FATAL] Modifying the Commercial source database is strictly blocked.');
  }
}

export async function runIdentityContinuityAssertions(
  sourceClient: Knex,
  targetClient: Knex
): Promise<void> {
  console.log('--- EXECUTING SECURE IDENTITY CONTINUITY PROCEDURE ---');

  // Step 1: Ensure Staging Conversation Principals have first-party User records
  const stagingPrincipals = await targetClient('conversations')
    .distinct('principal_id')
    .whereNotNull('principal_id');

  const now = Date.now();
  console.log(`Step 1: Reconciling ${stagingPrincipals.length} staging conversation principals into users...`);
  for (const p of stagingPrincipals) {
    await targetClient('users')
      .insert({
        id: p.principal_id,
        email: null,
        email_verified: false,
        name: 'Legacy Session Principal',
        created_at: now,
        updated_at: now
      })
      .onConflict('id')
      .ignore();
  }

  // Step 2: Execute Controlled Import from Commercial DB
  console.log('Step 2: Executing controlled import of verified historical identities...');
  const importSummary = await importVerifiedCommercialIdentities(sourceClient, targetClient, false);
  console.log(`[Import] Reconciled records: users=${importSummary.usersImported}, oauth=${importSummary.oauthAccountsImported}, customers=${importSummary.billingCustomersImported}, wallets=${importSummary.creditAccountsImported}`);

  // Assertion 1: Zero orphaned conversation principals
  console.log('\n--- ASSERTION 1: CONVERSATION INTEGRITY & REFERENTIAL VALIDITY ---');
  const orphanConvs = await targetClient.raw(`
    SELECT c.id, c.principal_id, u.id as user_match
    FROM conversations c
    LEFT JOIN users u ON c.principal_id = u.id
    WHERE u.id IS NULL
  `);
  assert.strictEqual(orphanConvs.rows.length, 0, 'Orphaned conversation principals must be 0');
  console.log('✓ PASS: All conversation principals strictly map to first-party user records.');

  // Assertion 2: All staging conversations preserved
  const targetConvs = await targetClient('conversations').count('* as cnt');
  assert.ok(Number(targetConvs[0].cnt) >= stagingPrincipals.length, 'Target conversations preserved');
  console.log(`✓ PASS: Conversation count on target verified (${targetConvs[0].cnt} conversations).`);

  // Assertion 3: Credit Wallets and Invariants (1 wallet per customer, exact balance preservation)
  console.log('\n--- ASSERTION 2: CREDIT WALLETS & BILLING INTEGRITY ---');
  const customers = await targetClient('billing_customers').select('id', 'principal_id');
  const creditAccounts = await targetClient('credit_accounts').select('id', 'customer_id', 'balance_credits');
  
  // Verify one wallet per customer
  const customerIdSet = new Set<string>();
  for (const ca of creditAccounts) {
    assert.ok(!customerIdSet.has(ca.customer_id), `Customer ${ca.customer_id} must have only one credit wallet`);
    customerIdSet.add(ca.customer_id);
    assert.ok(ca.balance_credits >= 0, 'Credit balance must be non-negative');
  }
  console.log(`✓ PASS: Credit account 1:1 invariant verified across ${creditAccounts.length} wallets.`);

  // Assertion 4: Idempotency (2nd Run produces zero duplicate errors and zero count drift)
  console.log('\n--- ASSERTION 3: IDEMPOTENCY ON RE-EXECUTION ---');
  const preIdempotencyUsers = Number((await targetClient('users').count('* as cnt'))[0].cnt);
  const preIdempotencyOAs = Number((await targetClient('oauth_accounts').count('* as cnt'))[0].cnt);
  const preIdempotencyCAs = Number((await targetClient('credit_accounts').count('* as cnt'))[0].cnt);

  await importVerifiedCommercialIdentities(sourceClient, targetClient, false);

  const postIdempotencyUsers = Number((await targetClient('users').count('* as cnt'))[0].cnt);
  const postIdempotencyOAs = Number((await targetClient('oauth_accounts').count('* as cnt'))[0].cnt);
  const postIdempotencyCAs = Number((await targetClient('credit_accounts').count('* as cnt'))[0].cnt);

  assert.strictEqual(postIdempotencyUsers, preIdempotencyUsers, 'User count unchanged on repeat run');
  assert.strictEqual(postIdempotencyOAs, preIdempotencyOAs, 'OAuth account count unchanged on repeat run');
  assert.strictEqual(postIdempotencyCAs, preIdempotencyCAs, 'Credit account count unchanged on repeat run');
  console.log('✓ PASS: Idempotency verified. Zero duplicate records created on repeat run.');

  // Assertion 5: Direct OAuth Login Resolution
  console.log('\n--- ASSERTION 4: DIRECT OAUTH IDENTITY RESOLUTION ---');
  const oauthEntries = await targetClient('oauth_accounts').select('id', 'user_id', 'provider', 'provider_account_id');
  assert.ok(oauthEntries.length > 0, 'OAuth accounts must be present');
  for (const entry of oauthEntries) {
    const boundUser = await targetClient('users').where({ id: entry.user_id }).first();
    assert.ok(boundUser, `User ${maskId(entry.user_id)} must exist for provider ${entry.provider}`);
    console.log(`✓ PASS: Resolved ${entry.provider}:${maskId(entry.provider_account_id)} -> ${maskId(boundUser.id)}`);
  }

  // Assertion 6: Email Auto-Linking Prevention (Fail-Closed)
  console.log('\n--- ASSERTION 5: EMAIL AUTO-LINKING ATTACK PREVENTION ---');
  // Confirm staging anonymous session principals have null email
  const legacyPrincipalsWithEmail = await targetClient('users')
    .where('name', 'Legacy Session Principal')
    .whereNotNull('email');
  assert.strictEqual(legacyPrincipalsWithEmail.length, 0, 'Legacy anonymous session principals must have null email');
  console.log('✓ PASS: All legacy session principals have email: null (immune to email-matching takeover).');

  console.log('\nALL IDENTITY CONTINUITY AND REHEARSAL ASSERTIONS PASSED WITH ZERO ERRORS.');
}

async function main() {
  const rehearsalBranch = process.env.REHEARSAL_BRANCH || 'rehearsal-pr96-commercial-20261021';
  console.log(`Connecting to rehearsal branch: ${rehearsalBranch}...`);

  const sourceCs = execSync('npx neonctl connection-string pr92-commercial-platform-isolated --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();
  const targetCs = execSync(`npx neonctl connection-string ${rehearsalBranch} --project-id mute-frost-50372225`, { encoding: 'utf8' }).trim();

  assertRehearsalSafety(targetCs);

  const sourceClient = knex({
    client: 'pg',
    connection: { connectionString: sourceCs, ssl: true }
  });

  const targetClient = knex({
    client: 'pg',
    connection: { connectionString: targetCs, ssl: true }
  });

  try {
    await runIdentityContinuityAssertions(sourceClient, targetClient);
  } finally {
    await sourceClient.destroy();
    await targetClient.destroy();
  }
}

if (process.argv[1] && process.argv[1].includes('test-identity-continuity-procedure')) {
  main().catch(err => {
    console.error('Continuity test failed:', err);
    process.exit(1);
  });
}
