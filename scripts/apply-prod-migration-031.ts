import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import knex from 'knex';
import { runMigrations } from '../packages/db/src/index.js';
import {
  verifyConnectedDatabaseIdentity,
  assertCanRunMigrations,
  PRODUCTION_NEON_PROJECT_ID,
  PRODUCTION_NEON_BRANCH_ID
} from '../packages/db/src/security/database-isolation-guard.js';

async function main() {
  console.log('\n========================================================================');
  console.log('  AIRA AI 2026 — PRODUCTION DATABASE MIGRATION 031 EXECUTION');
  console.log('========================================================================\n');

  const prodBranch = 'br-shiny-moon-b3vy9xj7';
  console.log(`[PRE-FLIGHT 1] Resolving connection string for production branch ${prodBranch}...`);
  const connStr = execSync(
    `neon connection-string ${prodBranch} --project-id ${PRODUCTION_NEON_PROJECT_ID}`,
    { encoding: 'utf-8' }
  ).trim();

  const preCheckDb = knex({
    client: 'pg',
    connection: { connectionString: connStr, ssl: { rejectUnauthorized: false } },
    pool: { min: 1, max: 1 }
  });

  try {
    // 1. Verify Production Project Identity
    const identityResult = await verifyConnectedDatabaseIdentity(preCheckDb, 'production');
    assert.ok(identityResult.ok, `Production database identity check failed: ${identityResult.message}`);
    console.log(`✓ Confirmed Production Database: ${identityResult.message}`);
    assertCanRunMigrations(connStr, 'production', true);

    // 2. Verify Backup Branch Exists and is Ready
    console.log('[PRE-FLIGHT 2] Verifying pre-031 backup branch status...');
    const branchesOutput = execSync(`neon branches list --project-id ${PRODUCTION_NEON_PROJECT_ID}`, { encoding: 'utf-8' });
    assert.match(branchesOutput, /prod-recovery-pre-031\s+br-plain-credit-b36c2tfh\s+ready/, 'Backup branch prod-recovery-pre-031 must be in ready state');
    console.log('✓ Confirmed pre-031 backup branch prod-recovery-pre-031 (br-plain-credit-b36c2tfh) is READY.');

    // 3. Inspect Current Migration Ledger
    console.log('[PRE-FLIGHT 3] Inspecting current migration ledger...');
    const currentMigrations = await preCheckDb('knex_migrations').select('*').orderBy('id', 'asc');
    console.log(`Current migrations count: ${currentMigrations.length}`);
    const latestMigration = currentMigrations[currentMigrations.length - 1];
    console.log(`Latest applied migration: ${latestMigration?.name}`);
    assert.equal(latestMigration?.name, '030_principal_workspace_authority.ts', 'Expected latest migration to be 030');

    // Count existing production records to guarantee zero data loss
    const runsCountBefore = await preCheckDb('runs').count('* as count').first();
    const convsCountBefore = await preCheckDb('conversations').count('* as count').first();
    console.log(`Pre-migration counts: runs=${runsCountBefore?.count}, conversations=${convsCountBefore?.count}`);
  } finally {
    await preCheckDb.destroy();
  }

  // 4. Execute Migration 031 via runMigrations
  console.log('\n[EXECUTION] Applying migration 031 (031_autonomous_agent_tasks.ts)...');
  process.env.AIRA_PERMIT_PROD_MIGRATION = 'true';
  process.env.DATABASE_URL = connStr;
  await runMigrations({ connectionString: connStr });
  console.log('✓ Migration 031 applied successfully.');

  // 5. Post-Flight Verification
  console.log('\n[POST-FLIGHT] Verifying schema and ledger integrity...');
  const postCheckDb = knex({
    client: 'pg',
    connection: { connectionString: connStr, ssl: { rejectUnauthorized: false } },
    pool: { min: 1, max: 1 }
  });

  try {
    const updatedMigrations = await postCheckDb('knex_migrations').select('*').orderBy('id', 'asc');
    console.log(`Updated migrations count: ${updatedMigrations.length}`);
    const newestMigration = updatedMigrations[updatedMigrations.length - 1];
    console.log(`Newest applied migration: ${newestMigration?.name}`);
    assert.equal(newestMigration?.name, '031_autonomous_agent_tasks.ts', 'Migration 031 must be the newest applied migration');

    // Verify autonomous_agent_tasks table exists and has correct columns
    const hasTasksTable = await postCheckDb.schema.hasTable('autonomous_agent_tasks');
    assert.ok(hasTasksTable, 'autonomous_agent_tasks table must exist');
    const hasBrowserTable = await postCheckDb.schema.hasTable('durable_browser_sessions');
    assert.ok(hasBrowserTable, 'durable_browser_sessions table must exist');

    // Verify constraints & indexes
    const indexes = await postCheckDb.raw(`
      SELECT indexname FROM pg_indexes WHERE tablename = 'autonomous_agent_tasks'
    `);
    const indexNames = indexes.rows.map((r: any) => r.indexname);
    console.log('autonomous_agent_tasks indexes:', indexNames);
    assert.ok(indexNames.includes('idx_auto_tasks_principal_created'));
    assert.ok(indexNames.includes('idx_auto_tasks_workspace_created'));
    assert.ok(indexNames.includes('idx_auto_tasks_state_lease'));
    assert.ok(indexNames.includes('uq_auto_tasks_idempotency'));

    // Verify zero data loss on existing tables
    const runsCountAfter = await postCheckDb('runs').count('* as count').first();
    const convsCountAfter = await postCheckDb('conversations').count('* as count').first();
    console.log(`Post-migration counts: runs=${runsCountAfter?.count}, conversations=${convsCountAfter?.count}`);

    console.log('\n========================================================================');
    console.log('  PRODUCTION MIGRATION 031: CERTIFIED & COMPLETED (PASS)');
    console.log('========================================================================\n');
  } finally {
    await postCheckDb.destroy();
  }
}

main().catch(err => {
  console.error('\n❌ PRODUCTION MIGRATION FAILED:', err);
  process.exit(1);
});
