import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('automation_runs', (table) => {
    table.string('id').primary();
    table.string('automation_id').notNullable().references('id').inTable('automations').onDelete('CASCADE');
    table.string('run_id'); // nullable if automation fails before run
    table.bigInteger('scheduled_for').notNullable();
    table.bigInteger('started_at').notNullable();
    table.bigInteger('completed_at');
    table.integer('attempt').defaultTo(1);
    table.string('status').notNullable(); // e.g., 'SUCCESS', 'FAILED', 'RUNNING'
    table.text('error');
  });

  await knex.schema.createTable('tool_calls', (table) => {
    table.string('id').primary();
    table.string('run_id').notNullable().references('id').inTable('runs').onDelete('CASCADE');
    table.string('tool').notNullable();
    table.jsonb('arguments'); // or sanitized arguments
    table.string('permission'); // e.g., 'READ', 'DESTRUCTIVE'
    table.string('status').notNullable(); // e.g., 'PENDING', 'COMPLETED', 'FAILED'
    table.bigInteger('started_at').notNullable();
    table.bigInteger('completed_at');
    table.jsonb('result');
    table.text('error');
  });

  await knex.schema.createTable('approvals', (table) => {
    table.string('id').primary();
    table.string('run_id').notNullable().references('id').inTable('runs').onDelete('CASCADE');
    table.string('tool_call_id').references('id').inTable('tool_calls').onDelete('CASCADE');
    table.string('status').notNullable(); // e.g., 'PENDING', 'APPROVED', 'REJECTED'
    table.string('reason');
    table.bigInteger('created_at').notNullable();
    table.bigInteger('resolved_at');
    table.string('resolved_by'); // user id
  });

  await knex.schema.createTable('artifacts', (table) => {
    table.string('id').primary();
    table.string('run_id').notNullable().references('id').inTable('runs').onDelete('CASCADE');
    table.string('name').notNullable();
    table.string('type').notNullable();
    table.text('content');
    table.jsonb('metadata');
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('knowledge_sources', (table) => {
    table.string('id').primary();
    table.string('type').notNullable();
    table.string('uri').notNullable();
    table.string('hash').notNullable();
    table.jsonb('metadata');
    table.bigInteger('created_at').notNullable();
  });

  await knex.schema.createTable('knowledge_chunks', (table) => {
    table.string('id').primary();
    table.string('source_id').notNullable().references('id').inTable('knowledge_sources').onDelete('CASCADE');
    table.text('content').notNullable();
    table.string('hash').notNullable();
    table.integer('index').notNullable();
    table.jsonb('metadata');
  });

  await knex.schema.createTable('knowledge_entities', (table) => {
    table.string('id').primary();
    table.string('name').notNullable();
    table.string('type').notNullable();
    table.text('description');
  });

  await knex.schema.createTable('knowledge_edges', (table) => {
    table.string('id').primary();
    table.string('source_entity_id').notNullable().references('id').inTable('knowledge_entities').onDelete('CASCADE');
    table.string('target_entity_id').notNullable().references('id').inTable('knowledge_entities').onDelete('CASCADE');
    table.string('relation').notNullable();
    table.jsonb('provenance'); // chunks that produced this edge
  });

  await knex.schema.createTable('memory_records', (table) => {
    table.string('id').primary();
    table.string('agent_id');
    table.string('type').notNullable();
    table.text('content').notNullable();
    table.jsonb('context');
    table.bigInteger('created_at').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('memory_records');
  await knex.schema.dropTableIfExists('knowledge_edges');
  await knex.schema.dropTableIfExists('knowledge_entities');
  await knex.schema.dropTableIfExists('knowledge_chunks');
  await knex.schema.dropTableIfExists('knowledge_sources');
  await knex.schema.dropTableIfExists('artifacts');
  await knex.schema.dropTableIfExists('approvals');
  await knex.schema.dropTableIfExists('tool_calls');
  await knex.schema.dropTableIfExists('automation_runs');
}
