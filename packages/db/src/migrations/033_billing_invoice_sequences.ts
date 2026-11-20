import type { Knex } from 'knex';

/**
 * AIRA AI 2026 — Migration 033: Billing Sequences, Invoices, Credit Notes & Statutory Constraints
 * 
 * Objectives:
 * 1. Creates atomic, collision-free PostgreSQL sequences:
 *    - `billing_invoice_number_seq`
 *    - `billing_credit_note_number_seq`
 * 2. Establishes dedicated relational document tables:
 *    - `billing_invoices`:
 *      - UNIQUE (invoice_number): Strictly enforces collision-free document numbering at the database layer.
 *      - UNIQUE (subscription_id, cycle_number): Prevents duplicate invoices for the same billing cycle.
 *      - UNIQUE (billing_event_id): Prevents duplicate invoices for the same payment/order event.
 *    - `billing_credit_notes`:
 *      - UNIQUE (credit_note_number): Enforces unique credit note numbering.
 *      - UNIQUE (subscription_id, refund_id): Enforces exactly one credit note per refund event.
 * 3. Enforces bounded locking (`lock_timeout = '2s'`, `statement_timeout = '5s'`) on PostgreSQL.
 * 4. Additive, backward-compatible with historical ledger and audit events.
 */
export async function up(knex: Knex): Promise<void> {
  const isPg = typeof knex.raw === 'function' && knex.client?.config?.client === 'pg';

  if (isPg) {
    try {
      await knex.raw("SET LOCAL lock_timeout = '2s'");
      await knex.raw("SET LOCAL statement_timeout = '5s'");
    } catch {}

    // 1. Create atomic non-blocking sequences
    await knex.raw('CREATE SEQUENCE IF NOT EXISTS billing_invoice_number_seq START WITH 1');
    await knex.raw('CREATE SEQUENCE IF NOT EXISTS billing_credit_note_number_seq START WITH 1');
  }

  // 2. Table: billing_invoices
  if (!(await knex.schema.hasTable('billing_invoices'))) {
    await knex.schema.createTable('billing_invoices', (table) => {
      table.string('id', 64).primary();
      table.string('invoice_number', 64).notNullable().unique('uq_billing_invoices_number');
      table.string('customer_id', 64).notNullable().references('id').inTable('billing_customers').onDelete('CASCADE');
      table.string('subscription_id', 64).notNullable().references('id').inTable('subscriptions').onDelete('CASCADE');
      table.integer('cycle_number').notNullable().defaultTo(1);
      table.string('billing_event_id', 128).notNullable().unique('uq_billing_invoices_event');
      table.string('plan_tier', 32).notNullable();
      table.string('currency', 8).notNullable().defaultTo('INR');
      table.decimal('total_amount', 12, 2).notNullable();
      table.decimal('taxable_base', 12, 2).notNullable();
      table.decimal('gst_amount', 12, 2).notNullable();
      table.decimal('cgst_amount', 12, 2);
      table.decimal('sgst_amount', 12, 2);
      table.decimal('igst_amount', 12, 2);
      table.string('sac_code', 16).notNullable().defaultTo('998431');
      table.string('supplier_name', 255).notNullable().defaultTo('Virexa AI Ventures Private Limited');
      table.string('supplier_gstin', 32);
      table.string('tax_compliance_status', 64).notNullable().defaultTo('COMPLIANT');
      table.string('place_of_supply', 32).notNullable().defaultTo('UNKNOWN');
      table.string('status', 32).notNullable().defaultTo('Paid');
      table.string('gateway', 32).notNullable();
      table.boolean('pdf_download_available').notNullable().defaultTo(false);
      table.jsonb('metadata').defaultTo('{}');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.unique(['subscription_id', 'cycle_number'], 'uq_billing_invoices_sub_cycle');
      table.index(['customer_id', 'created_at'], 'idx_billing_invoices_customer_date');
      table.index(['subscription_id'], 'idx_billing_invoices_subscription');
    });
  }

  // 3. Table: billing_credit_notes
  if (!(await knex.schema.hasTable('billing_credit_notes'))) {
    await knex.schema.createTable('billing_credit_notes', (table) => {
      table.string('id', 64).primary();
      table.string('credit_note_number', 64).notNullable().unique('uq_billing_credit_notes_number');
      table.string('original_invoice_number', 64);
      table.string('customer_id', 64).notNullable().references('id').inTable('billing_customers').onDelete('CASCADE');
      table.string('subscription_id', 64).notNullable().references('id').inTable('subscriptions').onDelete('CASCADE');
      table.string('refund_id', 128).notNullable().unique('uq_billing_credit_notes_refund');
      table.decimal('refund_amount', 12, 2).notNullable();
      table.string('currency', 8).notNullable().defaultTo('INR');
      table.boolean('is_partial_refund').notNullable().defaultTo(false);
      table.string('supplier_name', 255).notNullable().defaultTo('Virexa AI Ventures Private Limited');
      table.string('supplier_gstin', 32);
      table.string('status', 32).notNullable().defaultTo('Refunded');
      table.string('gateway', 32).notNullable();
      table.jsonb('metadata').defaultTo('{}');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.index(['customer_id', 'created_at'], 'idx_billing_credit_notes_customer_date');
      table.index(['original_invoice_number'], 'idx_billing_credit_notes_invoice');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const isPg = typeof knex.raw === 'function' && knex.client?.config?.client === 'pg';

  await knex.schema.dropTableIfExists('billing_credit_notes');
  await knex.schema.dropTableIfExists('billing_invoices');

  if (isPg) {
    try {
      await knex.raw('DROP SEQUENCE IF EXISTS billing_credit_note_number_seq');
      await knex.raw('DROP SEQUENCE IF EXISTS billing_invoice_number_seq');
    } catch {}
  }
}
