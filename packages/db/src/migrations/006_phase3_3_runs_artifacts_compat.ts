import { Knex } from 'knex';

/**
 * Migration 006: Compatibility patch for runs.artifacts
 *
 * Context: Migration 003 was modified after some development databases
 * had already recorded and applied the original 003. Those existing
 * databases will never re-run 003, so they will never receive the
 * `artifacts` column that was added retroactively.
 *
 * This forward migration is idempotent and safe for BOTH paths:
 *   - Clean DB where modified 003 already created `artifacts` → no-op
 *   - Existing DB where historical 003 did not create it  → adds it
 */
export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasColumn('runs', 'artifacts');
  if (!exists) {
    await knex.schema.alterTable('runs', (table) => {
      table.jsonb('artifacts').defaultTo('[]');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasColumn('runs', 'artifacts');
  if (exists) {
    await knex.schema.alterTable('runs', (table) => {
      table.dropColumn('artifacts');
    });
  }
}
