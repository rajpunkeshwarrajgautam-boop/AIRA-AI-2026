import type { Knex } from 'knex';

/**
 * AIRA AI 2026 — Migration 036: GST Invoicing Compliance Snapshots & FY Sequences
 *
 * Expand-only, backward-compatible migration adding:
 * 1. `billing_document_sequences`: Atomic, FY-partitioned, scope-isolated serial counters
 *    (`INV/26-27/00001`, `CN/26-27/00001`, `SBX/26-27/00001`, `SCN/26-27/00001`).
 * 2. `billing_customers`: Structured billing profile & optional B2B GSTIN fields.
 * 3. `billing_invoices`: Immutable issuance-time snapshots (supplier & customer jurisdiction,
 *    service period, payment evidence, UTGST, voided-serial retention, e-invoice placeholders).
 * 4. `billing_credit_notes`: Complete CGST Rule 53(1A) credit-note tax breakdown & linkage.
 *
 * Strictly preserves all historical sandbox invoices (`INV-2026-0001..0005`), credit balances,
 * and subscription records without backfilling unverifiable statutory attributes.
 */
export async function up(knex: Knex): Promise<void> {
  const isPg = typeof knex.raw === 'function' && knex.client?.config?.client === 'pg';
  if (isPg) {
    try {
      await knex.raw("SET LOCAL lock_timeout = '2s'");
      await knex.raw("SET LOCAL statement_timeout = '5s'");
    } catch {}
  }

  // 1. Atomic FY-scoped document sequences
  if (!(await knex.schema.hasTable('billing_document_sequences'))) {
    await knex.schema.createTable('billing_document_sequences', (table) => {
      table.string('document_scope', 32).notNullable();
      table.string('financial_year', 16).notNullable();
      table.bigInteger('last_number').notNullable().defaultTo(0);
      table.bigInteger('updated_at').notNullable();
      table.primary(['document_scope', 'financial_year']);
      table.check('last_number >= 0', [], 'chk_billing_doc_seq_nonnegative');
    });
  }

  // 2. Extend billing_customers with structured billing profile & B2B GSTIN
  if (await knex.schema.hasTable('billing_customers')) {
    const addCol = async (col: string, fn: (t: Knex.AlterTableBuilder) => void) => {
      if (!(await knex.schema.hasColumn('billing_customers', col))) {
        await knex.schema.alterTable('billing_customers', fn);
      }
    };
    await addCol('billing_legal_name', (t) => t.string('billing_legal_name', 255).nullable());
    await addCol('billing_address_line1', (t) => t.string('billing_address_line1', 255).nullable());
    await addCol('billing_address_line2', (t) => t.string('billing_address_line2', 255).nullable());
    await addCol('billing_city', (t) => t.string('billing_city', 120).nullable());
    await addCol('billing_state_code', (t) => t.string('billing_state_code', 4).nullable());
    await addCol('billing_postal_code', (t) => t.string('billing_postal_code', 16).nullable());
    await addCol('billing_country', (t) => t.string('billing_country', 8).nullable().defaultTo('IN'));
    await addCol('customer_gstin', (t) => t.string('customer_gstin', 15).nullable());
    await addCol('gstin_validated_at', (t) => t.bigInteger('gstin_validated_at').nullable());
  }

  // 3. Extend billing_invoices with immutable snapshot & Rule 46 / voided-serial columns
  if (await knex.schema.hasTable('billing_invoices')) {
    const missingCols: Array<{ name: string; add: (t: Knex.AlterTableBuilder) => void }> = [
      { name: 'financial_year', add: (t) => t.string('financial_year', 16).nullable() },
      { name: 'document_kind', add: (t) => t.string('document_kind', 32).nullable() },
      { name: 'document_status', add: (t) => t.string('document_status', 32).notNullable().defaultTo('ISSUED') },
      { name: 'voided_at', add: (t) => t.bigInteger('voided_at').nullable() },
      { name: 'void_reason', add: (t) => t.string('void_reason', 255).nullable() },
      { name: 'invoice_timing_basis', add: (t) => t.string('invoice_timing_basis', 48).nullable() },
      { name: 'is_sandbox', add: (t) => t.boolean('is_sandbox').notNullable().defaultTo(false) },
      { name: 'billing_period_start', add: (t) => t.bigInteger('billing_period_start').nullable() },
      { name: 'billing_period_end', add: (t) => t.bigInteger('billing_period_end').nullable() },
      { name: 'tax_rate_percent', add: (t) => t.decimal('tax_rate_percent', 5, 2).nullable() },
      { name: 'cgst_rate', add: (t) => t.decimal('cgst_rate', 5, 2).nullable() },
      { name: 'sgst_rate', add: (t) => t.decimal('sgst_rate', 5, 2).nullable() },
      { name: 'utgst_amount', add: (t) => t.decimal('utgst_amount', 12, 2).nullable() },
      { name: 'utgst_rate', add: (t) => t.decimal('utgst_rate', 5, 2).nullable() },
      { name: 'igst_rate', add: (t) => t.decimal('igst_rate', 5, 2).nullable() },
      { name: 'tax_rate_version', add: (t) => t.string('tax_rate_version', 64).nullable() },
      { name: 'rounding_policy', add: (t) => t.string('rounding_policy', 48).nullable() },
      { name: 'supplier_trade_name', add: (t) => t.string('supplier_trade_name', 255).nullable() },
      { name: 'supplier_address', add: (t) => t.text('supplier_address').nullable() },
      { name: 'supplier_state_code', add: (t) => t.string('supplier_state_code', 4).nullable() },
      { name: 'supplier_pan', add: (t) => t.string('supplier_pan', 16).nullable() },
      { name: 'supplier_cin', add: (t) => t.string('supplier_cin', 32).nullable() },
      { name: 'supplier_email', add: (t) => t.string('supplier_email', 255).nullable() },
      { name: 'customer_name', add: (t) => t.string('customer_name', 255).nullable() },
      { name: 'customer_email', add: (t) => t.string('customer_email', 255).nullable() },
      { name: 'customer_address', add: (t) => t.text('customer_address').nullable() },
      { name: 'customer_state_code', add: (t) => t.string('customer_state_code', 4).nullable() },
      { name: 'customer_gstin', add: (t) => t.string('customer_gstin', 15).nullable() },
      { name: 'is_b2b', add: (t) => t.boolean('is_b2b').notNullable().defaultTo(false) },
      { name: 'reverse_charge', add: (t) => t.boolean('reverse_charge').notNullable().defaultTo(false) },
      { name: 'pos_basis', add: (t) => t.string('pos_basis', 48).nullable() },
      { name: 'sac_description', add: (t) => t.text('sac_description').nullable() },
      { name: 'payment_method', add: (t) => t.string('payment_method', 64).nullable() },
      { name: 'gateway_order_id', add: (t) => t.string('gateway_order_id', 128).nullable() },
      { name: 'gateway_payment_id', add: (t) => t.string('gateway_payment_id', 128).nullable() },
      { name: 'irn', add: (t) => t.string('irn', 128).nullable() },
      { name: 'irn_ack_no', add: (t) => t.string('irn_ack_no', 64).nullable() },
      { name: 'irn_ack_date', add: (t) => t.string('irn_ack_date', 64).nullable() },
      { name: 'signed_qr_code', add: (t) => t.text('signed_qr_code').nullable() },
      { name: 'issuance_snapshot', add: (t) => t.jsonb('issuance_snapshot').nullable() }
    ];

    for (const col of missingCols) {
      if (!(await knex.schema.hasColumn('billing_invoices', col.name))) {
        await knex.schema.alterTable('billing_invoices', col.add);
      }
    }

    if (isPg) {
      await knex.raw(
        'CREATE INDEX IF NOT EXISTS idx_billing_invoices_fy_sandbox ON billing_invoices (financial_year, is_sandbox)'
      );
      await knex.raw(
        'CREATE INDEX IF NOT EXISTS idx_billing_invoices_doc_status ON billing_invoices (document_status)'
      );
    }
  }

  // 4. Extend billing_credit_notes with CGST Rule 53(1A) snapshot & tax split columns
  if (await knex.schema.hasTable('billing_credit_notes')) {
    const cnCols: Array<{ name: string; add: (t: Knex.AlterTableBuilder) => void }> = [
      { name: 'financial_year', add: (t) => t.string('financial_year', 16).nullable() },
      { name: 'document_status', add: (t) => t.string('document_status', 32).notNullable().defaultTo('ISSUED') },
      { name: 'voided_at', add: (t) => t.bigInteger('voided_at').nullable() },
      { name: 'void_reason', add: (t) => t.string('void_reason', 255).nullable() },
      { name: 'is_sandbox', add: (t) => t.boolean('is_sandbox').notNullable().defaultTo(false) },
      { name: 'original_invoice_date', add: (t) => t.string('original_invoice_date', 32).nullable() },
      { name: 'reason', add: (t) => t.string('reason', 255).nullable() },
      { name: 'taxable_base', add: (t) => t.decimal('taxable_base', 12, 2).nullable() },
      { name: 'gst_amount', add: (t) => t.decimal('gst_amount', 12, 2).nullable() },
      { name: 'cgst_amount', add: (t) => t.decimal('cgst_amount', 12, 2).nullable() },
      { name: 'sgst_amount', add: (t) => t.decimal('sgst_amount', 12, 2).nullable() },
      { name: 'utgst_amount', add: (t) => t.decimal('utgst_amount', 12, 2).nullable() },
      { name: 'igst_amount', add: (t) => t.decimal('igst_amount', 12, 2).nullable() },
      { name: 'tax_rate_percent', add: (t) => t.decimal('tax_rate_percent', 5, 2).nullable() },
      { name: 'cgst_rate', add: (t) => t.decimal('cgst_rate', 5, 2).nullable() },
      { name: 'sgst_rate', add: (t) => t.decimal('sgst_rate', 5, 2).nullable() },
      { name: 'utgst_rate', add: (t) => t.decimal('utgst_rate', 5, 2).nullable() },
      { name: 'igst_rate', add: (t) => t.decimal('igst_rate', 5, 2).nullable() },
      { name: 'sac_code', add: (t) => t.string('sac_code', 16).nullable() },
      { name: 'sac_description', add: (t) => t.text('sac_description').nullable() },
      { name: 'place_of_supply', add: (t) => t.string('place_of_supply', 128).nullable() },
      { name: 'pos_basis', add: (t) => t.string('pos_basis', 48).nullable() },
      { name: 'supplier_trade_name', add: (t) => t.string('supplier_trade_name', 255).nullable() },
      { name: 'supplier_address', add: (t) => t.text('supplier_address').nullable() },
      { name: 'supplier_state_code', add: (t) => t.string('supplier_state_code', 4).nullable() },
      { name: 'supplier_pan', add: (t) => t.string('supplier_pan', 16).nullable() },
      { name: 'supplier_cin', add: (t) => t.string('supplier_cin', 32).nullable() },
      { name: 'supplier_email', add: (t) => t.string('supplier_email', 255).nullable() },
      { name: 'customer_name', add: (t) => t.string('customer_name', 255).nullable() },
      { name: 'customer_email', add: (t) => t.string('customer_email', 255).nullable() },
      { name: 'customer_address', add: (t) => t.text('customer_address').nullable() },
      { name: 'customer_state_code', add: (t) => t.string('customer_state_code', 4).nullable() },
      { name: 'customer_gstin', add: (t) => t.string('customer_gstin', 15).nullable() },
      { name: 'is_b2b', add: (t) => t.boolean('is_b2b').notNullable().defaultTo(false) },
      { name: 'statutory_gstr1_cutoff', add: (t) => t.string('statutory_gstr1_cutoff', 32).nullable() },
      { name: 'irn', add: (t) => t.string('irn', 128).nullable() },
      { name: 'irn_ack_no', add: (t) => t.string('irn_ack_no', 64).nullable() },
      { name: 'irn_ack_date', add: (t) => t.string('irn_ack_date', 64).nullable() },
      { name: 'signed_qr_code', add: (t) => t.text('signed_qr_code').nullable() },
      { name: 'issuance_snapshot', add: (t) => t.jsonb('issuance_snapshot').nullable() }
    ];

    for (const col of cnCols) {
      if (!(await knex.schema.hasColumn('billing_credit_notes', col.name))) {
        await knex.schema.alterTable('billing_credit_notes', col.add);
      }
    }

    if (isPg) {
      await knex.raw(
        'CREATE INDEX IF NOT EXISTS idx_billing_credit_notes_fy_sandbox ON billing_credit_notes (financial_year, is_sandbox)'
      );
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('billing_invoices')) {
    const row = await knex('billing_invoices').count('* as count').first();
    const count = Number(row?.count || 0);
    if (count > 0) {
      throw new Error(
        `ROLLBACK_BLOCKED: billing_invoices contains ${count} statutory invoice record(s). Destruction of financial audit trails is prohibited.`
      );
    }
  }

  if (await knex.schema.hasTable('billing_credit_notes')) {
    const row = await knex('billing_credit_notes').count('* as count').first();
    const count = Number(row?.count || 0);
    if (count > 0) {
      throw new Error(
        `ROLLBACK_BLOCKED: billing_credit_notes contains ${count} credit note record(s). Destruction of financial audit trails is prohibited.`
      );
    }
  }

  if (await knex.schema.hasTable('billing_document_sequences')) {
    const row = await knex('billing_document_sequences').count('* as count').first();
    const count = Number(row?.count || 0);
    if (count > 0) {
      throw new Error(
        `ROLLBACK_BLOCKED: billing_document_sequences contains ${count} allocated sequence counter(s).`
      );
    }
  }

  if (process.env.ALLOW_DESTRUCTIVE_FINANCIAL_ROLLBACK !== 'true') {
    throw new Error(
      'ROLLBACK_BLOCKED: Migration 036 stores GST compliance snapshots and FY sequences. Set ALLOW_DESTRUCTIVE_FINANCIAL_ROLLBACK=true in disposable tests only.'
    );
  }

  await knex.schema.dropTableIfExists('billing_document_sequences');
}
