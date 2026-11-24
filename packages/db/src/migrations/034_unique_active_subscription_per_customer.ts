import { Knex } from 'knex';

/**
 * AIRA AI 2026 — Migration 034: Enforce Single Active Subscription per Customer
 * and Provider Subscription Uniqueness
 *
 * Implements:
 * 1. Preflight duplicate check: Fails closed if multiple active subscriptions exist for any customer.
 * 2. Partial unique index: At most one 'active' subscription per customer_id.
 * 3. Composite unique index: Unique (gateway, gateway_subscription_id) where not null.
 */
export async function up(knex: Knex): Promise<void> {
  const hasSubs = await knex.schema.hasTable('subscriptions');
  if (hasSubs) {
    // Preflight check: Ensure no customer currently has multiple active subscriptions
    const activeDuplicates = await knex('subscriptions')
      .where('status', 'active')
      .groupBy('customer_id')
      .havingRaw('count(*) > 1')
      .select('customer_id')
      .count('* as count');

    if (activeDuplicates && activeDuplicates.length > 0) {
      throw new Error(
        `MIGRATION_034_PREFLIGHT_FAILED: Found ${activeDuplicates.length} customer(s) with multiple active subscriptions. Historical records must not be deleted automatically.`
      );
    }

    // 1. Create partial unique index: At most one 'active' subscription per customer
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_subscriptions_customer_active 
      ON subscriptions (customer_id) 
      WHERE status = 'active';
    `);

    // 2. Create composite unique index: (gateway, gateway_subscription_id) where gateway_subscription_id is not null
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_subscriptions_gateway_sub_id 
      ON subscriptions (gateway, gateway_subscription_id) 
      WHERE gateway_subscription_id IS NOT NULL;
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasSubs = await knex.schema.hasTable('subscriptions');
  if (hasSubs) {
    await knex.raw('DROP INDEX IF EXISTS uniq_subscriptions_customer_active;');
    await knex.raw('DROP INDEX IF EXISTS uniq_subscriptions_gateway_sub_id;');
  }
}
