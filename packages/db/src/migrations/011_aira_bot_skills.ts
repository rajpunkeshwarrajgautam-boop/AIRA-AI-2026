import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('aira_bot_skills', t => {
    t.string('id').primary();
    t.string('owner_id').notNullable().index();
    t.string('name').notNullable();
    t.string('description').notNullable().defaultTo('');
    t.text('instructions').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['owner_id', 'name']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('aira_bot_skills');
}
