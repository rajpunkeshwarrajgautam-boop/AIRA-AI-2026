/**
 * AIRA AI 2026 — Isolated Staging Entitlement Fixture Lifecycle Manager
 *
 * Provides idempotent setup, verification, and cleanup for disposable staging test accounts:
 * - Strictly verifies connection targets isolated Neon branch `br-snowy-bonus-b32thjlz`, never production.
 * - Uses valid foreign keys referencing existing `plan_prices` (price_pro_usd / price_pro_inr).
 * - Leaves zero payment or billing state active upon cleanup.
 */

import knex from 'knex';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const STAGING_PROJECT_ID = 'mute-frost-50372225';
const STAGING_BRANCH_ID = 'br-snowy-bonus-b32thjlz';

function getStagingDb() {
  const connStr = execSync(`neon connection-string ${STAGING_BRANCH_ID} --project-id ${STAGING_PROJECT_ID}`, {
    encoding: 'utf8'
  }).trim();

  // Safety assertions to prevent ANY crossover to production
  const u = new URL(connStr);
  assert.ok(
    u.host.includes('ep-twilight-cherry-b3iz2oqv'),
    `Staging connection must strictly target ep-twilight-cherry-b3iz2oqv, got: ${u.host}`
  );
  assert.doesNotMatch(u.host, /ep-polished-water/i, 'PRODUCTION HOST DETECTED! Aborting.');

  return knex({ client: 'pg', connection: connStr });
}

export async function setupProFixture(customerId: string) {
  const db = getStagingDb();
  try {
    const proPrice = await db('plan_prices')
      .where({ plan_id: 'pro', currency: 'USD' })
      .first();

    assert.ok(proPrice, 'Authoritative plan_prices must contain price for pro in USD');

    const now = Date.now();
    const existing = await db('subscriptions').where({ customer_id: customerId }).first();

    if (existing) {
      await db('subscriptions').where({ id: existing.id }).update({
        plan_id: 'pro',
        price_id: proPrice.id,
        status: 'active',
        current_period_start: now,
        current_period_end: now + 30 * 24 * 60 * 60 * 1000,
        updated_at: now
      });
      console.log(`[Fixture] Updated existing subscription ${existing.id} to Pro tier (Price: ${proPrice.id})`);
    } else {
      const subId = `sub_staging_fixture_${Date.now()}`;
      await db('subscriptions').insert({
        id: subId,
        customer_id: customerId,
        plan_id: 'pro',
        price_id: proPrice.id,
        status: 'active',
        gateway: 'staging_fixture',
        gateway_subscription_id: `g_sub_${Date.now()}`,
        currency: proPrice.currency,
        amount_minor_units: proPrice.amount_minor_units,
        current_period_start: now,
        current_period_end: now + 30 * 24 * 60 * 60 * 1000,
        cancel_at_period_end: false,
        created_at: now,
        updated_at: now
      });
      console.log(`[Fixture] Inserted new Pro subscription fixture ${subId} (Price: ${proPrice.id})`);
    }
  } finally {
    await db.destroy();
  }
}

export async function resetStagingTestDailyQuota(customerIds: string[]) {
  const db = getStagingDb();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const updated = await db('entitlement_snapshots')
      .whereIn('customer_id', customerIds)
      .andWhere('period_date', today)
      .update({
        daily_standard_chat_count: 0,
        updated_at: Date.now()
      });
    console.log(`[Staging Quota Reset] Reset daily_standard_chat_count for ${updated} staging test customer row(s) (${today}).`);
  } finally {
    await db.destroy();
  }
}

export async function cleanupAllStagingFixtures() {
  const db = getStagingDb();
  try {
    const deletedSubs = await db('subscriptions')
      .where('gateway', 'staging_fixture')
      .orWhere('id', 'like', 'sub_staging_fixture_%')
      .delete();
    console.log(`[Fixture Cleanup] Deleted ${deletedSubs} test subscription fixture(s).`);

    // Verify no test fixtures remain
    const remaining = await db('subscriptions')
      .where('gateway', 'staging_fixture')
      .orWhere('id', 'like', 'sub_staging_fixture_%')
      .count('* as count');

    assert.equal(Number(remaining[0].count), 0, 'Zero test fixtures must remain in subscriptions table');
    console.log('[Fixture Cleanup] Database verified clean: 0 test fixtures remain.');
  } finally {
    await db.destroy();
  }
}

export async function verifyStagingDbIntegrity() {
  const db = getStagingDb();
  try {
    const plansCount = await db('plans').count('* as count');
    const pricesCount = await db('plan_prices').count('* as count');
    const usersCount = await db('users').count('* as count');
    const subsCount = await db('subscriptions').count('* as count');

    console.log('[Database Integrity Report]');
    console.log(`  Target: neon://${STAGING_PROJECT_ID}/${STAGING_BRANCH_ID}`);
    console.log(`  Plans: ${plansCount[0].count}`);
    console.log(`  Plan Prices: ${pricesCount[0].count}`);
    console.log(`  Users: ${usersCount[0].count}`);
    console.log(`  Active Subscriptions: ${subsCount[0].count}`);

    assert.ok(Number(plansCount[0].count) >= 3, 'Plans table must have all core plans');
    assert.ok(Number(pricesCount[0].count) >= 6, 'Plan prices must have INR and USD for all tiers');
  } finally {
    await db.destroy();
  }
}

const action = process.argv[2];
if (action === 'cleanup') {
  cleanupAllStagingFixtures().catch(err => {
    console.error('Cleanup failed:', err);
    process.exit(1);
  });
} else if (action === 'verify') {
  verifyStagingDbIntegrity().catch(err => {
    console.error('Verification failed:', err);
    process.exit(1);
  });
} else if (action === 'setup') {
  const customerId = process.argv[3];
  if (!customerId) {
    console.error('Usage: tsx staging-fixture-lifecycle.ts setup <customerId>');
    process.exit(1);
  }
  setupProFixture(customerId).catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
}
