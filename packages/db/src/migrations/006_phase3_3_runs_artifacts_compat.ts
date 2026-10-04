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
  // It is unsafe to unconditionally drop the `artifacts` column here because
  // we cannot prove if migration 006 created it or if the temporarily modified
  // migration 003 created it. Therefore, this rollback is a no-op to prevent
  // accidental data loss on databases where 003 was the true owner.
}
