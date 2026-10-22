import { Knex } from 'knex';

/**
 * AIRA AI 2026 — Versioned Durable Idempotency Operations Migration
 * 
 * Provides database-backed principal-scoped idempotency for mutating operations
 * (automation creation, vision generation, billing holds).
 * 
 * Enforces:
 * 1. Primary key on `key` (principal_id:operation_id)
 * 2. Unique constraint on (principal_id, operation_id)
 * 3. Durable status ('IN_PROGRESS', 'COMPLETED', 'FAILED')
 * 4. Lease timeout ('locked_until') for deterministic recovery of abandoned operations
 * 5. Fail-closed security in production (no silent downgrading to process memory)
 */
export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable('idempotent_operations');
  if (!exists) {
    await knex.schema.createTable('idempotent_operations', (table) => {
      table.string('key', 256).primary();
      table.string('principal_id', 128).notNullable();
      table.string('operation_id', 128).notNullable();
      table.string('operation_type', 64).notNullable();
      table.string('payload_hash', 64).notNullable();
      table.string('status', 32).notNullable(); // IN_PROGRESS, COMPLETED, FAILED
      table.integer('response_status').defaultTo(200);
      table.text('response_body').defaultTo('');
      table.bigInteger('locked_until').notNullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.unique(['principal_id', 'operation_id'], 'uq_idempotent_principal_operation');
      table.index(['status', 'locked_until'], 'idx_idempotent_status_locked');
      table.index(['principal_id'], 'idx_idempotent_principal');
    });
  } else {
    // Ensure locked_until exists if table was partially created previously
    const hasLockedUntil = await knex.schema.hasColumn('idempotent_operations', 'locked_until');
    if (!hasLockedUntil) {
      await knex.schema.alterTable('idempotent_operations', (table) => {
        table.bigInteger('locked_until').defaultTo(0);
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('idempotent_operations');
}
