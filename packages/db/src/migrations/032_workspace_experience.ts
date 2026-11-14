import type { Knex } from 'knex';

/** Backward-compatible schema expansion; do not drop existing onboarding state. */
export async function up(knex: Knex): Promise<void> {
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
}

/** Rollbacks require an explicit data-retention decision. */
export async function down(_knex: Knex): Promise<void> {
  throw new Error('Migration 032 is expand-only; use an approved manual rollback after assessing data retention.');
}

