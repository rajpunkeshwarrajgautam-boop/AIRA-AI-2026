import { Knex } from 'knex';

/**
 * AIRA AI 2026 — Migration 035: Durable Subscription Cancellation and Invoice Reconciliation Outbox
 *
 * Implements:
 * 1. subscription_cancellation_outbox: Durable transactional outbox for mandate cancellation
 *    when subscriptions are superseded or upgraded. Replaces ephemeral setImmediate.
 * 2. billing_invoice_reconciliation_outbox: Durable transactional outbox for tax invoice
 *    generation failures and delayed reconciliation. Enforces idempotency via unique
 *    (subscription_id, cycle_number).
 */
export async function up(knex: Knex): Promise<void> {
  // 1. Subscription cancellation outbox
  const hasSubCancel = await knex.schema.hasTable('subscription_cancellation_outbox');
  if (!hasSubCancel) {
    await knex.schema.createTable('subscription_cancellation_outbox', (table) => {
      table.string('id', 255).primary();
      table.string('subscription_id', 255).notNullable();
      table.string('customer_id', 255).notNullable();
      table.string('principal_id', 255).notNullable();
      table.string('gateway', 32).notNullable();
      table.string('gateway_subscription_id', 255).notNullable();
      table.string('replacement_subscription_id', 255).nullable();
      table.string('state', 32).notNullable().defaultTo('PENDING');
      table.integer('attempts').notNullable().defaultTo(0);
      table.integer('max_attempts').notNullable().defaultTo(5);
      table.bigInteger('fencing_token').notNullable().defaultTo(0);
      table.string('claimed_by', 255).nullable();
      table.bigInteger('lease_until').nullable();
      table.bigInteger('next_attempt_at').nullable();
      table.text('last_error').nullable();
      table.jsonb('payload').defaultTo('{}');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.bigInteger('completed_at').nullable();

      table.index(['state', 'lease_until', 'next_attempt_at', 'created_at'], 'idx_sub_cancel_outbox_claim');
      table.index(['subscription_id'], 'idx_sub_cancel_outbox_sub');
      table.index(['customer_id'], 'idx_sub_cancel_outbox_cust');
      table.check("state in ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'AMBIGUOUS')", [], 'sub_cancel_state_check');
    });
  }

  // 2. Billing invoice reconciliation outbox
  const hasInvRecon = await knex.schema.hasTable('billing_invoice_reconciliation_outbox');
  if (!hasInvRecon) {
    await knex.schema.createTable('billing_invoice_reconciliation_outbox', (table) => {
      table.string('id', 255).primary();
      table.string('subscription_id', 255).notNullable();
      table.integer('cycle_number').notNullable().defaultTo(1);
      table.string('customer_id', 255).notNullable();
      table.string('principal_id', 255).notNullable();
      table.string('gateway', 32).notNullable();
      table.string('plan_tier', 32).notNullable();
      table.bigInteger('amount_minor_units').notNullable().defaultTo(0);
      table.string('currency', 8).notNullable().defaultTo('INR');
      table.string('actual_payment_id', 255).nullable();
      table.string('gateway_order_id', 255).nullable();
      table.string('correlation_id', 255).notNullable();
      table.string('state', 32).notNullable().defaultTo('PENDING');
      table.integer('attempts').notNullable().defaultTo(0);
      table.integer('max_attempts').notNullable().defaultTo(5);
      table.bigInteger('fencing_token').notNullable().defaultTo(0);
      table.string('claimed_by', 255).nullable();
      table.bigInteger('lease_until').nullable();
      table.bigInteger('next_attempt_at').nullable();
      table.text('last_error').nullable();
      table.jsonb('payload').defaultTo('{}');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.bigInteger('completed_at').nullable();

      table.unique(['subscription_id', 'cycle_number'], { indexName: 'uniq_inv_recon_outbox_sub_cycle' });
      table.index(['state', 'lease_until', 'next_attempt_at', 'created_at'], 'idx_inv_recon_outbox_claim');
      table.index(['customer_id'], 'idx_inv_recon_outbox_cust');
      table.check("state in ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED')", [], 'inv_recon_state_check');
    });
  }

  // 3. Ensure idempotent_operations has distributed fencing columns (idempotent guarantee)
  if (await knex.schema.hasTable('idempotent_operations')) {
    const hasOwnerToken = await knex.schema.hasColumn('idempotent_operations', 'owner_token');
    if (!hasOwnerToken) {
      await knex.schema.alterTable('idempotent_operations', (table) => {
        table.string('owner_token', 64).nullable();
        table.bigInteger('generation').notNullable().defaultTo(0);
        table.index(['key', 'owner_token', 'generation'], 'idx_idempotent_fencing');
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // Prohibit destructive outbox drop when unresolved financial obligations exist.
  // Environment variable overrides (e.g. FORCE_DESTRUCTIVE_OUTBOX_DROP) are strictly prohibited.
  // All unresolved states (PENDING, CLAIMED, AMBIGUOUS, and FAILED requiring manual reconciliation) are enforced.

  // 1. Guard against dropping cancellation outbox with unresolved tasks
  if (await knex.schema.hasTable('subscription_cancellation_outbox')) {
    const unresolvedCancel = await knex('subscription_cancellation_outbox')
      .where('state', '!=', 'COMPLETED')
      .count({ count: '*' })
      .first();

    const count = Number(unresolvedCancel?.count || 0);
    if (count > 0) {
      throw new Error(
        `MIGRATION_035_ROLLBACK_BLOCKED: Cannot drop 'subscription_cancellation_outbox'. Found ${count} unresolved mandate cancellation tasks (including failed/ambiguous tasks requiring manual reconciliation). Pending financial obligations must be drained or reconciled before schema deletion.`
      );
    }
  }

  // 2. Guard against dropping invoice reconciliation outbox with unresolved tasks
  if (await knex.schema.hasTable('billing_invoice_reconciliation_outbox')) {
    const unresolvedInv = await knex('billing_invoice_reconciliation_outbox')
      .where('state', '!=', 'COMPLETED')
      .count({ count: '*' })
      .first();

    const count = Number(unresolvedInv?.count || 0);
    if (count > 0) {
      throw new Error(
        `MIGRATION_035_ROLLBACK_BLOCKED: Cannot drop 'billing_invoice_reconciliation_outbox'. Found ${count} unresolved invoice reconciliation tasks (including failed tasks requiring manual reconciliation). Pending financial obligations must be drained or reconciled before schema deletion.`
      );
    }
  }

  await knex.schema.dropTableIfExists('billing_invoice_reconciliation_outbox');
  await knex.schema.dropTableIfExists('subscription_cancellation_outbox');
}
