import { Knex } from 'knex';

/**
 * AIRA AI 2026 — Migration 020: Commercial Billing, Plans, Entitlements and Credit Ledger
 * 
 * Sets up production-ready, financially auditable tables for:
 * - billing_customers
 * - plans & plan_prices (seeded with Free, Plus, Pro in INR and USD)
 * - subscriptions
 * - credit_accounts (with CHECK balance >= 0, reserved >= 0)
 * - credit_grants
 * - credit_reservations
 * - credit_transactions (with idempotency_key uniqueness)
 * - usage_events
 * - entitlement_snapshots
 * - billing_audit_events
 * - payment_gateway_events (for webhook deduplication)
 */
export async function up(knex: Knex): Promise<void> {
  // 1. billing_customers
  if (!(await knex.schema.hasTable('billing_customers'))) {
    await knex.schema.createTable('billing_customers', (table) => {
      table.string('id', 64).primary();
      table.string('principal_id', 128).notNullable().unique();
      table.string('email', 255);
      table.string('name', 255);
      table.string('default_currency', 8).notNullable().defaultTo('INR');
      table.string('country_code', 8).defaultTo('IN');
      table.string('razorpay_customer_id', 128);
      table.string('cashfree_customer_id', 128);
      table.jsonb('tax_info').defaultTo('{}');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.index(['principal_id'], 'idx_billing_customers_principal');
      table.index(['email'], 'idx_billing_customers_email');
    });
  }

  // 2. plans
  if (!(await knex.schema.hasTable('plans'))) {
    await knex.schema.createTable('plans', (table) => {
      table.string('id', 32).primary(); // 'free', 'plus', 'pro'
      table.string('name', 128).notNullable();
      table.text('description');
      table.integer('daily_standard_chat_limit').notNullable();
      table.integer('monthly_standard_chat_units').notNullable();
      table.integer('monthly_premium_credits').notNullable();
      table.integer('complimentary_reasoning_boosts').notNullable();
      table.integer('saved_agents_limit').notNullable().defaultTo(0);
      table.string('builder_access', 32).notNullable().defaultTo('none');
      table.integer('concurrent_inference_limit').notNullable().defaultTo(1);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
    });
  }

  // 3. plan_prices
  if (!(await knex.schema.hasTable('plan_prices'))) {
    await knex.schema.createTable('plan_prices', (table) => {
      table.string('id', 64).primary();
      table.string('plan_id', 32).notNullable().references('id').inTable('plans').onDelete('CASCADE');
      table.string('currency', 8).notNullable(); // 'INR', 'USD'
      table.string('interval', 32).notNullable().defaultTo('monthly');
      table.integer('amount_minor_units').notNullable(); // paise or cents
      table.decimal('display_amount', 10, 2).notNullable();
      table.boolean('is_tax_inclusive').notNullable().defaultTo(true);
      table.decimal('tax_rate_percent', 5, 2).notNullable().defaultTo(18.00);
      table.string('gateway_price_id', 128);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.unique(['plan_id', 'currency', 'interval'], 'uniq_plan_price_currency');
    });
  }

  // 4. subscriptions
  if (!(await knex.schema.hasTable('subscriptions'))) {
    await knex.schema.createTable('subscriptions', (table) => {
      table.string('id', 64).primary();
      table.string('customer_id', 64).notNullable().references('id').inTable('billing_customers').onDelete('CASCADE');
      table.string('plan_id', 32).notNullable().references('id').inTable('plans');
      table.string('price_id', 64).notNullable().references('id').inTable('plan_prices');
      table.string('status', 32).notNullable(); // 'active', 'pending', etc.
      table.string('gateway', 32).notNullable(); // 'razorpay', 'cashfree', 'manual_grant'
      table.string('gateway_subscription_id', 128);
      table.string('currency', 8).notNullable();
      table.integer('amount_minor_units').notNullable();
      table.bigInteger('current_period_start').notNullable();
      table.bigInteger('current_period_end').notNullable();
      table.boolean('cancel_at_period_end').notNullable().defaultTo(false);
      table.bigInteger('cancelled_at');
      table.jsonb('metadata').defaultTo('{}');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.index(['customer_id', 'status'], 'idx_subscriptions_customer_status');
      table.index(['gateway_subscription_id'], 'idx_subscriptions_gateway_sub');
    });
  }

  // 5. credit_accounts (Strict anti-overdraft CHECK constraints)
  if (!(await knex.schema.hasTable('credit_accounts'))) {
    await knex.schema.createTable('credit_accounts', (table) => {
      table.string('id', 64).primary();
      table.string('customer_id', 64).notNullable().unique().references('id').inTable('billing_customers').onDelete('CASCADE');
      table.integer('balance_credits').notNullable().defaultTo(0);
      table.integer('reserved_credits').notNullable().defaultTo(0);
      table.integer('lifetime_granted_credits').notNullable().defaultTo(0);
      table.integer('lifetime_spent_credits').notNullable().defaultTo(0);
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.check('balance_credits >= 0', [], 'chk_credit_accounts_balance_positive');
      table.check('reserved_credits >= 0', [], 'chk_credit_accounts_reserved_positive');
    });
  }

  // 6. credit_grants
  if (!(await knex.schema.hasTable('credit_grants'))) {
    await knex.schema.createTable('credit_grants', (table) => {
      table.string('id', 64).primary();
      table.string('account_id', 64).notNullable().references('id').inTable('credit_accounts').onDelete('CASCADE');
      table.integer('amount_credits').notNullable();
      table.integer('remaining_credits').notNullable();
      table.string('grant_type', 32).notNullable();
      table.bigInteger('expires_at');
      table.boolean('rollover_capped').notNullable().defaultTo(false);
      table.jsonb('metadata').defaultTo('{}');
      table.bigInteger('created_at').notNullable();

      table.index(['account_id', 'expires_at'], 'idx_credit_grants_account_exp');
    });
  }

  // 7. credit_reservations
  if (!(await knex.schema.hasTable('credit_reservations'))) {
    await knex.schema.createTable('credit_reservations', (table) => {
      table.string('id', 64).primary();
      table.string('account_id', 64).notNullable().references('id').inTable('credit_accounts').onDelete('CASCADE');
      table.integer('amount_credits').notNullable();
      table.string('status', 32).notNullable().defaultTo('HELD');
      table.string('task_type', 64).notNullable();
      table.string('reference_id', 128);
      table.bigInteger('expires_at').notNullable();
      table.integer('settled_amount_credits');
      table.jsonb('metadata').defaultTo('{}');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.index(['account_id', 'status'], 'idx_credit_reservations_account_status');
      table.index(['expires_at'], 'idx_credit_reservations_expires');
    });
  }

  // 8. credit_transactions (Idempotent immutable ledger)
  if (!(await knex.schema.hasTable('credit_transactions'))) {
    await knex.schema.createTable('credit_transactions', (table) => {
      table.string('id', 64).primary();
      table.string('account_id', 64).notNullable().references('id').inTable('credit_accounts').onDelete('CASCADE');
      table.string('reservation_id', 64);
      table.string('transaction_type', 32).notNullable();
      table.integer('amount_credits').notNullable();
      table.integer('balance_before').notNullable();
      table.integer('balance_after').notNullable();
      table.string('idempotency_key', 128).notNullable().unique();
      table.text('description').notNullable();
      table.jsonb('metadata').defaultTo('{}');
      table.bigInteger('created_at').notNullable();

      table.index(['account_id', 'created_at'], 'idx_credit_transactions_account_date');
      table.index(['idempotency_key'], 'idx_credit_transactions_idempotency');
    });
  }

  // 9. usage_events
  if (!(await knex.schema.hasTable('usage_events'))) {
    await knex.schema.createTable('usage_events', (table) => {
      table.string('id', 64).primary();
      table.string('customer_id', 64).notNullable().references('id').inTable('billing_customers').onDelete('CASCADE');
      table.string('run_id', 64);
      table.string('task_type', 64).notNullable();
      table.string('provider', 64).notNullable();
      table.string('model', 64);
      table.integer('input_tokens').notNullable().defaultTo(0);
      table.integer('output_tokens').notNullable().defaultTo(0);
      table.integer('reasoning_tokens').notNullable().defaultTo(0);
      table.integer('cached_tokens').notNullable().defaultTo(0);
      table.integer('images_count').notNullable().defaultTo(0);
      table.integer('search_queries_count').notNullable().defaultTo(0);
      table.decimal('sandbox_duration_seconds', 10, 2).notNullable().defaultTo(0.00);
      table.integer('charged_credits').notNullable().defaultTo(0);
      table.decimal('estimated_direct_cost_usd', 10, 6).notNullable().defaultTo(0.000000);
      table.jsonb('metadata').defaultTo('{}');
      table.bigInteger('created_at').notNullable();

      table.index(['customer_id', 'created_at'], 'idx_usage_events_customer_date');
      table.index(['run_id'], 'idx_usage_events_run');
    });
  }

  // 10. entitlement_snapshots
  if (!(await knex.schema.hasTable('entitlement_snapshots'))) {
    await knex.schema.createTable('entitlement_snapshots', (table) => {
      table.string('id', 64).primary();
      table.string('customer_id', 64).notNullable().references('id').inTable('billing_customers').onDelete('CASCADE');
      table.string('period_date', 16).notNullable(); // 'YYYY-MM-DD'
      table.integer('daily_standard_chat_count').notNullable().defaultTo(0);
      table.integer('monthly_standard_chat_count').notNullable().defaultTo(0);
      table.integer('monthly_reasoning_boost_count').notNullable().defaultTo(0);
      table.bigInteger('last_reset_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.unique(['customer_id', 'period_date'], 'uniq_entitlement_customer_period');
    });
  }

  // 11. billing_audit_events
  if (!(await knex.schema.hasTable('billing_audit_events'))) {
    await knex.schema.createTable('billing_audit_events', (table) => {
      table.string('id', 64).primary();
      table.string('customer_id', 64);
      table.string('event_type', 64).notNullable();
      table.string('actor_type', 32).notNullable();
      table.string('actor_id', 128);
      table.jsonb('payload').defaultTo('{}');
      table.string('ip_address', 64);
      table.bigInteger('created_at').notNullable();

      table.index(['customer_id', 'created_at'], 'idx_billing_audit_customer_date');
      table.index(['event_type'], 'idx_billing_audit_event_type');
    });
  }

  // 12. payment_gateway_events
  if (!(await knex.schema.hasTable('payment_gateway_events'))) {
    await knex.schema.createTable('payment_gateway_events', (table) => {
      table.string('id', 64).primary();
      table.string('gateway', 32).notNullable();
      table.string('event_id', 128).notNullable().unique();
      table.string('event_type', 64).notNullable();
      table.boolean('signature_valid').notNullable();
      table.boolean('processed').notNullable().defaultTo(false);
      table.text('error');
      table.jsonb('payload').defaultTo('{}');
      table.bigInteger('created_at').notNullable();

      table.index(['gateway', 'event_type'], 'idx_gateway_events_type');
      table.index(['event_id'], 'idx_gateway_events_event_id');
    });
  }

  // Seed Default Plans and Prices if not already present
  const now = Date.now();
  const existingPlans = await knex('plans').select('id');
  if (existingPlans.length === 0) {
    await knex('plans').insert([
      {
        id: 'free',
        name: 'AIRA Free',
        description: 'Essential intelligence for everyday exploration',
        daily_standard_chat_limit: 15,
        monthly_standard_chat_units: 150,
        monthly_premium_credits: 100,
        complimentary_reasoning_boosts: 5,
        saved_agents_limit: 0,
        builder_access: 'none',
        concurrent_inference_limit: 1,
        is_active: true,
        created_at: now,
        updated_at: now
      },
      {
        id: 'plus',
        name: 'AIRA Plus',
        description: 'Power-user productivity with everyday value',
        daily_standard_chat_limit: 50,
        monthly_standard_chat_units: 700,
        monthly_premium_credits: 3000,
        complimentary_reasoning_boosts: 50,
        saved_agents_limit: 3,
        builder_access: 'trial',
        concurrent_inference_limit: 1,
        is_active: true,
        created_at: now,
        updated_at: now
      },
      {
        id: 'pro',
        name: 'AIRA Pro',
        description: 'Higher limits, deep research, vision, builder and agent workflows',
        daily_standard_chat_limit: 150,
        monthly_standard_chat_units: 2000,
        monthly_premium_credits: 7500,
        complimentary_reasoning_boosts: 200,
        saved_agents_limit: 20,
        builder_access: 'metered',
        concurrent_inference_limit: 2,
        is_active: true,
        created_at: now,
        updated_at: now
      }
    ]);

    await knex('plan_prices').insert([
      {
        id: 'price_free_inr',
        plan_id: 'free',
        currency: 'INR',
        interval: 'monthly',
        amount_minor_units: 0,
        display_amount: 0.00,
        is_tax_inclusive: true,
        tax_rate_percent: 18.00,
        is_active: true,
        created_at: now,
        updated_at: now
      },
      {
        id: 'price_free_usd',
        plan_id: 'free',
        currency: 'USD',
        interval: 'monthly',
        amount_minor_units: 0,
        display_amount: 0.00,
        is_tax_inclusive: false,
        tax_rate_percent: 0.00,
        is_active: true,
        created_at: now,
        updated_at: now
      },
      {
        id: 'price_plus_inr',
        plan_id: 'plus',
        currency: 'INR',
        interval: 'monthly',
        amount_minor_units: 39900,
        display_amount: 399.00,
        is_tax_inclusive: true,
        tax_rate_percent: 18.00,
        is_active: true,
        created_at: now,
        updated_at: now
      },
      {
        id: 'price_plus_usd',
        plan_id: 'plus',
        currency: 'USD',
        interval: 'monthly',
        amount_minor_units: 799,
        display_amount: 7.99,
        is_tax_inclusive: false,
        tax_rate_percent: 0.00,
        is_active: true,
        created_at: now,
        updated_at: now
      },
      {
        id: 'price_pro_inr',
        plan_id: 'pro',
        currency: 'INR',
        interval: 'monthly',
        amount_minor_units: 99900,
        display_amount: 999.00,
        is_tax_inclusive: true,
        tax_rate_percent: 18.00,
        is_active: true,
        created_at: now,
        updated_at: now
      },
      {
        id: 'price_pro_usd',
        plan_id: 'pro',
        currency: 'USD',
        interval: 'monthly',
        amount_minor_units: 1999,
        display_amount: 19.99,
        is_tax_inclusive: false,
        tax_rate_percent: 0.00,
        is_active: true,
        created_at: now,
        updated_at: now
      }
    ]);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payment_gateway_events');
  await knex.schema.dropTableIfExists('billing_audit_events');
  await knex.schema.dropTableIfExists('entitlement_snapshots');
  await knex.schema.dropTableIfExists('usage_events');
  await knex.schema.dropTableIfExists('credit_transactions');
  await knex.schema.dropTableIfExists('credit_reservations');
  await knex.schema.dropTableIfExists('credit_grants');
  await knex.schema.dropTableIfExists('credit_accounts');
  await knex.schema.dropTableIfExists('subscriptions');
  await knex.schema.dropTableIfExists('plan_prices');
  await knex.schema.dropTableIfExists('plans');
  await knex.schema.dropTableIfExists('billing_customers');
}
