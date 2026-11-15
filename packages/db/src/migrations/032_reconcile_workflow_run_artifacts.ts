import type { Knex } from 'knex';

/**
 * Repair the production migration-010 postcondition without changing rows.
 * Production ledger records 010 as applied, but workflow_runs.artifacts is absent.
 * Keep this narrow and independently deployable from Workspace V3 migration 032.
 * 
 * Safety Guarantees:
 * - Bounded lock_timeout = '2s' prevents lock queue pileup on concurrent workloads.
 * - Bounded statement_timeout = '5s' bounds execution time.
 * - Expand-only: down() strictly refuses column dropping.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw("SET LOCAL lock_timeout = '2s'");
  await knex.raw("SET LOCAL statement_timeout = '5s'");

  if (!(await knex.schema.hasTable('workflow_runs'))) {
    throw new Error('workflow_runs is absent; migration 009 must be inspected before proceeding');
  }
  if (!(await knex.schema.hasColumn('workflow_runs', 'artifacts'))) {
    await knex.schema.alterTable('workflow_runs', table => {
      table.jsonb('artifacts').defaultTo('[]');
    });
  }
}

/** Preserve historical workflow artifacts. Rollback is a reviewed restore/roll-forward. */
export async function down(_knex: Knex): Promise<void> {
  throw new Error('Migration 032 artifacts repair is expand-only; never drop persisted artifacts');
}
