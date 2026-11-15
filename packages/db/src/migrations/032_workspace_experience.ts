import type { Knex } from 'knex';

/** Backward-compatible schema expansion; do not drop existing onboarding state. */
export async function up(knex: Knex): Promise<void> {
  // Release compatibility: production has workflow_runs migration 010 in its
  // Knex ledger but the artifacts column is absent in the live schema.
  // Restore the exact additive 010 postcondition without rewriting run data.
  // Existing staging schemas already have the column, so this is a no-op there.
  if (!(await knex.schema.hasTable('workflow_runs'))) {
    throw new Error('workflow_runs table missing; verify migrations 009/010 before workspace rollout');
  }
  if (!(await knex.schema.hasColumn('workflow_runs', 'artifacts'))) {
    await knex.schema.alterTable('workflow_runs', table => {
      table.jsonb('artifacts').defaultTo('[]');
    });
  }
  if (await knex.schema.hasTable('users') && !(await knex.schema.hasColumn('users', 'onboarded_at'))) {
    await knex.schema.alterTable('users', table => {
      table.bigInteger('onboarded_at').nullable();
    });
    // Existing accounts have already passed the original onboarding flow.
    // Only accounts created after this migration should see the new introduction.
    const cutoverAt = Date.now();
    await knex('users').whereNull('onboarded_at')
      .where('created_at', '<=', cutoverAt)
      .update({ onboarded_at: cutoverAt });
  }
  if (!(await knex.schema.hasTable('workspace_promo_events'))) {
    await knex.schema.createTable('workspace_promo_events', table => {
      table.string('id', 36).primary();
      table.string('principal_id', 128).notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.string('placement', 24).notNullable();
      table.string('kind', 24).notNullable();
      table.string('session_id', 36).notNullable();
      table.bigInteger('created_at').notNullable();
      table.unique(['principal_id', 'placement', 'kind', 'session_id'], 'uq_workspace_promo_once');
      table.index(['principal_id', 'created_at'], 'idx_workspace_promo_timeline');
    });
  }
  // One guest identity must map to at most one authenticated account, across instances.
  if (!(await knex.schema.hasTable('guest_migration_ledger'))) {
    await knex.schema.createTable('guest_migration_ledger', table => {
      table.string('guest_principal_id', 160).primary();
      table.string('target_principal_id', 128).notNullable().references('id').inTable('users').onDelete('RESTRICT');
      table.integer('migrated_conversation_count').notNullable();
      table.string('guest_session_proof_hash', 64).notNullable();
      table.bigInteger('created_at').notNullable();
      table.index(['target_principal_id', 'created_at'], 'idx_guest_migration_target');
    });
  }
}

/** Rollbacks require an explicit data-retention decision. */
export async function down(_knex: Knex): Promise<void> {
  throw new Error('Migration 032 is expand-only; use an approved manual rollback after assessing data retention.');
}

