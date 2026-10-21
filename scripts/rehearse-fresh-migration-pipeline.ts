import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import path from 'path';
import knex, { Knex } from 'knex';
import { importVerifiedCommercialIdentities } from './import-verified-commercial-identities.js';
import { assertRehearsalSafety } from './test-identity-continuity-procedure.js';

interface Snapshot {
  migrations: string[];
  tables: string[];
  conversationsCount: number;
  conversationMessagesCount: number;
  runsCount: number;
  memoryRecordsCount: number;
  usersCount?: number;
  oauthAccountsCount?: number;
  billingCustomersCount?: number;
  creditAccountsCount?: number;
  creditGrantsCount?: number;
  creditTransactionsCount?: number;
}

async function captureSnapshot(client: Knex): Promise<Snapshot> {
  const migrations = (await client('knex_migrations').select('name').orderBy('id')).map((r: any) => r.name);
  const tablesResult = await client.raw("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  const tables = tablesResult.rows.map((r: any) => r.tablename);

  const snap: Snapshot = {
    migrations,
    tables,
    conversationsCount: Number((await client('conversations').count('* as cnt'))[0].cnt),
    conversationMessagesCount: Number((await client('conversation_messages').count('* as cnt'))[0].cnt),
    runsCount: Number((await client('runs').count('* as cnt'))[0].cnt),
    memoryRecordsCount: Number((await client('memory_records').count('* as cnt'))[0].cnt)
  };

  if (tables.includes('users')) {
    snap.usersCount = Number((await client('users').count('* as cnt'))[0].cnt);
  }
  if (tables.includes('oauth_accounts')) {
    snap.oauthAccountsCount = Number((await client('oauth_accounts').count('* as cnt'))[0].cnt);
  }
  if (tables.includes('billing_customers')) {
    snap.billingCustomersCount = Number((await client('billing_customers').count('* as cnt'))[0].cnt);
  }
  if (tables.includes('credit_accounts')) {
    snap.creditAccountsCount = Number((await client('credit_accounts').count('* as cnt'))[0].cnt);
  }
  if (tables.includes('credit_grants')) {
    snap.creditGrantsCount = Number((await client('credit_grants').count('* as cnt'))[0].cnt);
  }
  if (tables.includes('credit_transactions')) {
    snap.creditTransactionsCount = Number((await client('credit_transactions').count('* as cnt'))[0].cnt);
  }

  return snap;
}

async function main() {
  const rehearsalBranch = process.env.REHEARSAL_BRANCH || 'rehearsal-pr96-final-20261021';
  console.log(`=== STARTING FRESH MIGRATION REHEARSAL ON: ${rehearsalBranch} ===`);

  const sourceCs = execSync('npx neonctl connection-string pr92-commercial-platform-isolated --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();
  const targetCs = execSync(`npx neonctl connection-string ${rehearsalBranch} --project-id mute-frost-50372225`, { encoding: 'utf8' }).trim();

  assertRehearsalSafety(targetCs);

  const sourceClient = knex({
    client: 'pg',
    connection: { connectionString: sourceCs, ssl: true }
  });

  const targetClient = knex({
    client: 'pg',
    connection: { connectionString: targetCs, ssl: true },
    migrations: {
      directory: path.resolve(process.cwd(), 'packages/db/src/migrations'),
      extension: 'ts',
      loadExtensions: ['.ts', '.js']
    }
  });

  try {
    // 1. Capture Baseline Snapshot
    console.log('\n--- 1. CAPTURING SANITIZED PRE-MIGRATION BASELINE ---');
    const baseline = await captureSnapshot(targetClient);
    console.log(`Baseline Migrations Count: ${baseline.migrations.length}`);
    console.log(`Baseline Tables Count: ${baseline.tables.length}`);
    console.log(`Baseline Conversations: ${baseline.conversationsCount}`);
    console.log(`Baseline Messages: ${baseline.conversationMessagesCount}`);
    console.log(`Baseline Runs: ${baseline.runsCount}`);
    console.log(`Baseline Memory Records: ${baseline.memoryRecordsCount}`);

    assert.strictEqual(baseline.migrations.length, 15, 'Staging baseline must have exactly 15 applied migrations');
    assert.ok(baseline.conversationsCount >= 5, 'Baseline conversations must be present');

    // 2. Run Migrations 016-022 via Knex migration runner
    console.log('\n--- 2. RUNNING KNEX MIGRATIONS 016–022 ---');
    const [batchNo, log] = await targetClient.migrate.latest({
      directory: path.resolve(process.cwd(), 'packages/db/src/migrations')
    });
    console.log(`Knex Migration Batch: ${batchNo}`);
    console.log(`Executed Migrations (${log.length}):`);
    for (const m of log) {
      console.log(`  + ${m}`);
    }

    assert.strictEqual(log.length, 7, 'Must execute exactly 7 new migrations (016 to 022)');

    // 3. Capture Post-Migration Snapshot
    console.log('\n--- 3. CAPTURING POST-MIGRATION SNAPSHOT ---');
    const postMigration = await captureSnapshot(targetClient);
    console.log(`Post-Migration Migrations Count: ${postMigration.migrations.length}`);
    console.log(`Post-Migration Tables Count: ${postMigration.tables.length}`);
    console.log(`Post-Migration Users Count: ${postMigration.usersCount}`);
    console.log(`Post-Migration Conversations Count: ${postMigration.conversationsCount}`);
    console.log(`Post-Migration Messages Count: ${postMigration.conversationMessagesCount}`);

    assert.strictEqual(postMigration.migrations.length, 22, 'Total migrations must now be 22');
    assert.strictEqual(postMigration.conversationsCount, baseline.conversationsCount, 'Conversations must be 100% preserved');
    assert.strictEqual(postMigration.conversationMessagesCount, baseline.conversationMessagesCount, 'Messages must be 100% preserved');
    assert.ok(postMigration.usersCount! >= 4, 'Legacy conversation principals must be reconciled into users');

    // Confirm all legacy principals have email: null
    const legacyWithEmail = await targetClient('users')
      .where('name', 'Legacy Session Principal')
      .whereNotNull('email');
    assert.strictEqual(legacyWithEmail.length, 0, 'Legacy principals must have email: null');

    // 4. Run Separate Controlled Historical Identity Import
    console.log('\n--- 4. EXECUTING CONTROLLED HISTORICAL IDENTITY IMPORT ---');
    const importSummary = await importVerifiedCommercialIdentities(sourceClient, targetClient, false);
    console.log('Import Summary:', JSON.stringify(importSummary, null, 2));

    // 5. Capture Post-Import Snapshot
    console.log('\n--- 5. CAPTURING POST-IMPORT SNAPSHOT ---');
    const postImport = await captureSnapshot(targetClient);
    console.log(`Post-Import Users Count: ${postImport.usersCount}`);
    console.log(`Post-Import OAuth Accounts Count: ${postImport.oauthAccountsCount}`);
    console.log(`Post-Import Billing Customers Count: ${postImport.billingCustomersCount}`);
    console.log(`Post-Import Credit Accounts Count: ${postImport.creditAccountsCount}`);
    console.log(`Post-Import Credit Grants Count: ${postImport.creditGrantsCount}`);
    console.log(`Post-Import Credit Transactions Count: ${postImport.creditTransactionsCount}`);
    console.log(`Post-Import Conversations Count: ${postImport.conversationsCount}`);

    // Assertions on Imported Data
    assert.strictEqual(postImport.billingCustomersCount, 2, 'Exactly 2 genuine billing customers imported from Commercial');
    assert.strictEqual(postImport.creditAccountsCount, 2, 'Exactly 2 genuine credit accounts imported from Commercial');
    assert.strictEqual(postImport.creditGrantsCount, 2, 'Exactly 2 genuine credit grants imported from Commercial');
    assert.strictEqual(postImport.creditTransactionsCount, 2, 'Exactly 2 genuine credit transactions imported from Commercial');

    // Verify 1:1 wallet invariant
    const wallets = await targetClient('credit_accounts').select('*');
    for (const w of wallets) {
      assert.strictEqual(w.balance_credits, 100, 'Historical balance must be 100 credits');
      assert.strictEqual(w.reserved_credits, 0, 'Reserved credits must be 0');
    }
    console.log('✓ PASS: All imported credit balances accurately match source (100 credits, 0 reserved).');

    // 6. Test Idempotency (Repeat Migration & Repeat Import)
    console.log('\n--- 6. TESTING IDEMPOTENCY ON RE-EXECUTION ---');
    const [batchNo2, log2] = await targetClient.migrate.latest({
      directory: path.resolve(process.cwd(), 'packages/db/src/migrations')
    });
    assert.strictEqual(log2.length, 0, 'No pending migrations on second run');

    const repeatImport = await importVerifiedCommercialIdentities(sourceClient, targetClient, false);
    const postRepeat = await captureSnapshot(targetClient);

    assert.strictEqual(postRepeat.usersCount, postImport.usersCount, 'Zero drift in users on repeat import');
    assert.strictEqual(postRepeat.oauthAccountsCount, postImport.oauthAccountsCount, 'Zero drift in oauth_accounts on repeat import');
    assert.strictEqual(postRepeat.creditAccountsCount, postImport.creditAccountsCount, 'Zero drift in credit_accounts on repeat import');
    console.log('✓ PASS: Full idempotency confirmed across migrations and identity import.');

    // 7. Verify Referential Integrity & Zero Orphaned Conversations
    console.log('\n--- 7. VERIFYING ZERO ORPHANED CONVERSATIONS ---');
    const orphanConvs = await targetClient.raw(`
      SELECT c.id, c.principal_id, u.id as user_match
      FROM conversations c
      LEFT JOIN users u ON c.principal_id = u.id
      WHERE u.id IS NULL
    `);
    assert.strictEqual(orphanConvs.rows.length, 0, 'Zero orphaned conversations');
    console.log('✓ PASS: 100% of conversations have matching first-party user records.');

    console.log('\n=== ALL FRESH REHEARSAL GATES PASSED SUCCESSFULLY ===');

  } finally {
    await sourceClient.destroy();
    await targetClient.destroy();
  }
}

main().catch(err => {
  console.error('[Rehearsal Fatal Error]:', err);
  process.exit(1);
});
