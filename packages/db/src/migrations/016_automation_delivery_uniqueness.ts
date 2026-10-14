import type { Knex } from 'knex';

/** Exactly one claimed execution per automation and scheduled instant. */
export async function up(knex: Knex): Promise<void> {
  // Refuse an unsafe rollout instead of silently deleting historical runs.
  const duplicates = await knex('automation_runs')
    .select('automation_id', 'scheduled_for')
    .count('* as count')
    .groupBy('automation_id', 'scheduled_for')
    .havingRaw('COUNT(*) > 1')
    .limit(1);
  if (duplicates.length) {
    throw new Error('DUPLICATE_AUTOMATION_RUNS: Review existing duplicate run claims before migrating.');
  }
  await knex.schema.alterTable('automation_runs', table => {
    table.unique(['automation_id', 'scheduled_for'], { indexName: 'automation_runs_one_per_slot' });
  });
  await knex.schema.createTable('automation_notifications', table => {
    table.string('id').primary();
    table.string('automation_run_id').notNullable().unique()
      .references('id').inTable('automation_runs').onDelete('CASCADE');
    table.string('automation_id').notNullable()
      .references('id').inTable('automations').onDelete('CASCADE');
    table.string('principal_id').notNullable().index();
    table.string('title').notNullable();
    table.text('message').notNullable();
    table.bigInteger('scheduled_for').notNullable();
    table.bigInteger('created_at').notNullable();
    table.bigInteger('read_at');
    table.index(['principal_id', 'created_at'], 'reminder_inbox_owner_created');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('automation_notifications');
  await knex.schema.alterTable('automation_runs', table => {
    table.dropUnique(['automation_id', 'scheduled_for'], 'automation_runs_one_per_slot');
  });
}
