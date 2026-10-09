import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('runs', (table) => {
    table.text('prompt').notNullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('runs', (table) => {
    table.string('prompt', 255).notNullable().alter();
  });
}
