import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('runs', (table) => {
    table.string('principal_id').defaultTo('user-default');
    table.string('project_id');
    table.jsonb('context_data');
    table.text('content');
    table.text('thinking');
    table.text('error');
    table.bigInteger('completed_at');
    table.integer('max_steps').defaultTo(10);
    table.string('execution_checkpoint'); // KNOWLEDGE_READY, TOOL_SELECTED, WAITING_FOR_APPROVAL, etc.
    table.jsonb('pending_approval');
    table.jsonb('artifacts').defaultTo('[]');
  });

  await knex.schema.alterTable('tool_calls', (table) => {
    table.string('source'); // e.g., 'model', 'automation'
    table.string('runtime'); // e.g., 'mcp', 'local'
    table.string('idempotency_key');
    table.string('approval_id');
  });

  await knex.schema.createTable('session_grants', (table) => {
    table.string('id').primary();
    table.string('principal_id').notNullable();
    table.string('session_id');
    table.string('workspace_id');
    table.string('tool').notNullable();
    table.string('permission').notNullable();
    table.bigInteger('granted_at').notNullable();
    table.bigInteger('expires_at');
  });

  await knex.schema.alterTable('mcp_servers', (table) => {
    table.string('transport').defaultTo('stdio').notNullable();
    table.boolean('enabled').defaultTo(true);
    table.jsonb('metadata');
    table.bigInteger('updated_at').defaultTo(Date.now()).notNullable();
  });

  await knex.schema.alterTable('automation_runs', (table) => {
    table.bigInteger('claimed_at');
    // We already have attempt
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('automation_runs', (table) => {
    table.dropColumn('claimed_at');
  });
  
  await knex.schema.alterTable('mcp_servers', (table) => {
    table.dropColumn('transport');
    table.dropColumn('enabled');
    table.dropColumn('metadata');
    table.dropColumn('updated_at');
  });
  
  await knex.schema.dropTableIfExists('session_grants');

  await knex.schema.alterTable('tool_calls', (table) => {
    table.dropColumn('source');
    table.dropColumn('runtime');
    table.dropColumn('idempotency_key');
    table.dropColumn('approval_id');
  });

  await knex.schema.alterTable('runs', (table) => {
    table.dropColumn('principal_id');
    table.dropColumn('project_id');
    table.dropColumn('context_data');
    table.dropColumn('content');
    table.dropColumn('thinking');
    table.dropColumn('error');
    table.dropColumn('completed_at');
    table.dropColumn('max_steps');
    table.dropColumn('execution_checkpoint');
    table.dropColumn('pending_approval');
  });
}
