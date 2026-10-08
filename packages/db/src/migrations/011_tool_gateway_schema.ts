import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasToolCalls = await knex.schema.hasTable('tool_calls');
  if (!hasToolCalls) return;

  await knex.schema.alterTable('tool_calls', (table) => {
    table.string('principal_id');
    table.string('tool_id');
    table.string('workflow_run_id');
    table.string('agent_mission_id');
    table.string('adapter');
    table.string('side_effect_level');
    table.jsonb('permission_scopes').defaultTo('[]');
    table.jsonb('input_metadata').defaultTo('{}');
    table.integer('attempt_count').defaultTo(1);
    table.string('error_code');
    table.integer('duration_ms');

    table.index(['principal_id', 'started_at'], 'idx_tool_calls_principal_started');
    table.index(['run_id', 'started_at'], 'idx_tool_calls_run_started');
    table.index(['status'], 'idx_tool_calls_status');
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasToolCalls = await knex.schema.hasTable('tool_calls');
  if (!hasToolCalls) return;

  await knex.schema.alterTable('tool_calls', (table) => {
    table.dropIndex(['status'], 'idx_tool_calls_status');
    table.dropIndex(['run_id', 'started_at'], 'idx_tool_calls_run_started');
    table.dropIndex(['principal_id', 'started_at'], 'idx_tool_calls_principal_started');

    table.dropColumn('principal_id');
    table.dropColumn('tool_id');
    table.dropColumn('workflow_run_id');
    table.dropColumn('agent_mission_id');
    table.dropColumn('adapter');
    table.dropColumn('side_effect_level');
    table.dropColumn('permission_scopes');
    table.dropColumn('input_metadata');
    table.dropColumn('attempt_count');
    table.dropColumn('error_code');
    table.dropColumn('duration_ms');
  });
}
