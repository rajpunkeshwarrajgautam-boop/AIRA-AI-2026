import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('aira_bot_delegations', t => {
    t.string('id').primary();
    t.string('owner_id').notNullable().index();
    t.string('parent_bot_id').notNullable().references('id').inTable('aira_bots');
    t.string('target_bot_id').notNullable().references('id').inTable('aira_bots');
    t.string('parent_run_id').notNullable().index();
    t.string('child_run_id').notNullable().unique();
    t.text('objective').notNullable();
    t.string('status').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.bigInteger('completed_at').nullable();
    t.index(['owner_id', 'parent_bot_id', 'created_at']);
  });

  await knex.schema.createTable('aira_bot_routines', t => {
    t.string('id').primary();
    t.string('owner_id').notNullable().index();
    t.string('bot_id').notNullable().references('id').inTable('aira_bots');
    t.string('name').notNullable();
    t.text('objective').notNullable();
    t.string('cron_expression').notNullable();
    t.string('timezone').notNullable().defaultTo('UTC');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.bigInteger('last_scheduled_for').nullable();
    t.string('last_run_id').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['owner_id', 'bot_id', 'enabled']);
  });

  await knex.schema.createTable('aira_bot_routine_runs', t => {
    t.string('id').primary();
    t.string('routine_id').notNullable().references('id').inTable('aira_bot_routines').onDelete('CASCADE');
    t.string('owner_id').notNullable().index();
    t.string('bot_id').notNullable();
    t.string('run_id').nullable().unique();
    t.bigInteger('scheduled_for').notNullable();
    t.string('status').notNullable();
    t.text('error').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('completed_at').nullable();
    t.unique(['routine_id', 'scheduled_for']);
  });

  await knex.schema.createTable('aira_bot_notifications', t => {
    t.string('id').primary();
    t.string('owner_id').notNullable().index();
    t.string('bot_id').nullable();
    t.string('run_id').nullable();
    t.string('kind').notNullable();
    t.string('title').notNullable();
    t.text('message').notNullable();
    t.bigInteger('read_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['owner_id', 'read_at', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('aira_bot_notifications');
  await knex.schema.dropTableIfExists('aira_bot_routine_runs');
  await knex.schema.dropTableIfExists('aira_bot_routines');
  await knex.schema.dropTableIfExists('aira_bot_delegations');
}
