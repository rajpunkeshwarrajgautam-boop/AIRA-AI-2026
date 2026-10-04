import type { Knex } from 'knex';
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('aira_bots', t => {
    t.string('id').primary();
    t.string('owner_id').notNullable().index();
    t.jsonb('definition').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });
  await knex.schema.createTable('aira_bot_tasks', t => {
    t.string('id').primary();
    t.string('bot_id').notNullable().references('id').inTable('aira_bots');
    t.string('owner_id').notNullable();
    t.string('run_id').notNullable().unique();
    t.text('objective').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['owner_id', 'bot_id', 'created_at']);
  });
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('aira_bot_tasks');
  await knex.schema.dropTable('aira_bots');
}
