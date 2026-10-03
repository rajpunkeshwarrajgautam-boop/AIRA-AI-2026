import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('automation_runs', (table) => {
    table.unique(['automation_id', 'scheduled_for']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('automation_runs', (table) => {
    table.dropUnique(['automation_id', 'scheduled_for']);
  });
}
