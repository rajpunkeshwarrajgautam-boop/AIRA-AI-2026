import type { Knex } from 'knex';

/**
 * Repair the production migration-010 postcondition without changing rows.
 * Production ledger records 010 as applied, but workflow_runs.artifacts is absent.
 * Keep this narrow and independently deployable from Workspace V3 migration 032.
 */
export async function up(knex: Knex): Promise<void> {
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
