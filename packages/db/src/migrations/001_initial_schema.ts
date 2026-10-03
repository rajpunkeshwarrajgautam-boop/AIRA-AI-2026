import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('agents', (table) => {
    table.string('id').primary();
    table.string('name').notNullable();
    table.text('description');
    table.text('instructions').notNullable();
    table.jsonb('modelPolicy');
    table.jsonb('tools');
    table.jsonb('memoryScopes');
    table.string('approvalPolicy');
    table.integer('maxSteps');
    table.jsonb('timeoutPolicy');
    table.bigInteger('createdAt').notNullable();
    table.bigInteger('updatedAt').notNullable();
  });

  await knex.schema.createTable('automations', (table) => {
    table.string('id').primary();
    table.string('name').notNullable();
    table.string('agent_id').notNullable();
    table.string('cron_expression').notNullable();
    table.boolean('enabled').defaultTo(true);
    table.jsonb('triggerParams');
    table.bigInteger('last_run');
    table.bigInteger('createdAt').notNullable();
    table.bigInteger('updatedAt').notNullable();
  });

  await knex.schema.createTable('runs', (table) => {
    table.string('id').primary();
    table.string('agent_id');
    table.string('prompt').notNullable();
    table.text('systemPrompt');
    table.string('intent');
    table.string('status').notNullable();
    table.string('state').notNullable();
    table.bigInteger('createdAt').notNullable();
    table.bigInteger('updatedAt').notNullable();
    table.jsonb('modelPolicy');
  });

  await knex.schema.createTable('run_events', (table) => {
    table.string('id').primary();
    table.string('run_id').notNullable().references('id').inTable('runs').onDelete('CASCADE');
    table.string('type').notNullable();
    table.jsonb('payload').notNullable();
    table.bigInteger('createdAt').notNullable();
  });

  await knex.schema.createTable('mcp_servers', (table) => {
    table.string('id').primary();
    table.string('name').notNullable().unique();
    table.string('url').notNullable();
    table.jsonb('credentials');
    table.bigInteger('createdAt').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('mcp_servers');
  await knex.schema.dropTableIfExists('run_events');
  await knex.schema.dropTableIfExists('runs');
  await knex.schema.dropTableIfExists('automations');
  await knex.schema.dropTableIfExists('agents');
}
