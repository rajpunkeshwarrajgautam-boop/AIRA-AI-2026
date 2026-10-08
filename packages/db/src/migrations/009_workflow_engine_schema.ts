import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Workflow Definitions
  await knex.schema.createTable('workflow_definitions', (table) => {
    table.string('id').primary();
    table.integer('version').notNullable().defaultTo(1);
    table.string('name').notNullable();
    table.text('description');
    table.string('principal_id');
    table.jsonb('input_schema').notNullable().defaultTo('{}');
    table.jsonb('steps').notNullable();
    table.jsonb('execution_policy').notNullable().defaultTo('{}');
    table.jsonb('output_schema').notNullable().defaultTo('{}');
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();

    table.index(['principal_id', 'created_at'], 'idx_workflow_defs_principal_created');
  });

  // 2. Workflow Runs
  await knex.schema.createTable('workflow_runs', (table) => {
    table.string('id').primary();
    table.string('workflow_id').notNullable().references('id').inTable('workflow_definitions').onDelete('CASCADE');
    table.string('run_id').notNullable().references('id').inTable('runs').onDelete('CASCADE');
    table.string('principal_id').notNullable();
    table.string('session_id').notNullable();
    table.string('state').notNullable().defaultTo('CREATED');
    table.jsonb('step_states').notNullable().defaultTo('{}');
    table.jsonb('step_outputs').notNullable().defaultTo('{}');
    table.jsonb('step_attempts').notNullable().defaultTo('{}');
    table.string('pending_approval_step_id');
    table.string('recovery_owner');
    table.bigInteger('recovery_claimed_at');
    table.bigInteger('recovery_lease_until');
    table.text('error');
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();
    table.bigInteger('completed_at');

    table.index(['principal_id', 'created_at'], 'idx_workflow_runs_principal_created');
    table.index(['run_id'], 'idx_workflow_runs_run_id');
    table.index(['state'], 'idx_workflow_runs_state');
  });

  // 3. Workflow Steps
  await knex.schema.createTable('workflow_steps', (table) => {
    table.string('id').primary();
    table.string('workflow_run_id').notNullable().references('id').inTable('workflow_runs').onDelete('CASCADE');
    table.string('step_id').notNullable();
    table.string('name').notNullable();
    table.string('state').notNullable().defaultTo('PENDING');
    table.jsonb('depends_on').notNullable().defaultTo('[]');
    table.integer('attempt').notNullable().defaultTo(1);
    table.jsonb('input');
    table.jsonb('output');
    table.text('error');
    table.string('side_effect_level').notNullable().defaultTo('NONE');
    table.boolean('approval_required').notNullable().defaultTo(false);
    table.string('idempotency_key');
    table.bigInteger('started_at');
    table.bigInteger('completed_at');

    table.index(['workflow_run_id', 'step_id'], 'idx_workflow_steps_run_step');
    table.index(['idempotency_key'], 'idx_workflow_steps_idempotency');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('workflow_steps');
  await knex.schema.dropTableIfExists('workflow_runs');
  await knex.schema.dropTableIfExists('workflow_definitions');
}
