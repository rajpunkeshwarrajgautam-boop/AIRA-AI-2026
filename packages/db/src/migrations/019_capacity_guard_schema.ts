import { Knex } from 'knex';

/**
 * AIRA AI 2026 — P1.6.3 Free-Tier Private Beta Capacity Guard Schema Migration
 * 
 * Replaces runtime DDL with pre-provisioned database schema for distributed
 * concurrency permit leases and sliding-window rate tracking.
 * 
 * Objects created:
 * - capacity_permits: atomic concurrency leases with auto-expiring TTL
 * - capacity_rate_log: sliding-window request timestamps for burst protection
 */
export async function up(knex: Knex): Promise<void> {
  const hasPermitsTable = await knex.schema.hasTable('capacity_permits');
  if (!hasPermitsTable) {
    await knex.schema.createTable('capacity_permits', (table) => {
      table.string('id', 64).primary();
      table.string('scope', 32).notNullable();
      table.string('principal_id', 128).notNullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('expires_at').notNullable();

      table.index(['scope', 'principal_id', 'expires_at'], 'idx_capacity_permits_scope_principal_exp');
    });
  }

  const hasRateLogTable = await knex.schema.hasTable('capacity_rate_log');
  if (!hasRateLogTable) {
    await knex.schema.createTable('capacity_rate_log', (table) => {
      table.string('id', 64).primary();
      table.string('scope', 32).notNullable();
      table.string('principal_id', 128).notNullable();
      table.bigInteger('timestamp').notNullable();

      table.index(['scope', 'principal_id', 'timestamp'], 'idx_capacity_rate_scope_principal_ts');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('capacity_rate_log');
  await knex.schema.dropTableIfExists('capacity_permits');
}
