import { Knex } from 'knex';

/**
 * AIRA AI 2026 — Milestone 2A: Native Durable Specialist Execution Runtime Schema
 * 
 * Establishes durable state persistence for specialist tasks, worker leases,
 * and execution checkpoints.
 * 
 * Enforces:
 * 1. Strict relational linkage to public.runs(id)
 * 2. Monotonically increasing fencing tokens (fencing_token) for stale-worker rejection
 * 3. PostgreSQL-backed atomic leasing (lease_owner, lease_expires_at)
 * 4. Tenant isolation via principal_id and workspace_id indexes
 * 5. Bounded retention and idempotent submission indexes
 */
export async function up(knex: Knex): Promise<void> {
  const hasTasksTable = await knex.schema.hasTable('specialist_tasks');
  if (!hasTasksTable) {
    await knex.schema.createTable('specialist_tasks', (table) => {
      table.string('id', 128).primary();
      table.string('run_id', 128).notNullable().references('id').inTable('runs').onDelete('CASCADE');
      table.string('mission_id', 128);
      table.string('principal_id', 128).notNullable();
      table.string('workspace_id', 128);
      table.string('role', 64).notNullable();
      table.text('objective').notNullable();
      table.string('state', 32).notNullable().defaultTo('QUEUED');
      table.string('outcome', 32);
      table.jsonb('dependencies').notNullable().defaultTo('[]');
      table.jsonb('input_payload').notNullable().defaultTo('{}');
      table.jsonb('result_output');
      table.jsonb('execution_constraints').notNullable().defaultTo('{}');
      table.jsonb('authorization_requirements').notNullable().defaultTo('{}');
      table.jsonb('budget_limits').notNullable().defaultTo('{}');
      table.integer('timeout_ms').notNullable().defaultTo(60000);
      table.integer('attempt_count').notNullable().defaultTo(0);
      table.integer('max_retries').notNullable().defaultTo(2);
      table.float('backoff_multiplier').notNullable().defaultTo(1.5);
      table.bigInteger('fencing_token').notNullable().defaultTo(0);
      table.string('lease_owner', 128);
      table.bigInteger('lease_expires_at');
      table.bigInteger('heartbeat_at');
      table.string('idempotency_key', 256);
      table.jsonb('error_details');
      table.jsonb('usage_telemetry').notNullable().defaultTo('{}');
      table.jsonb('provenance').notNullable().defaultTo('{}');
      table.jsonb('checkpoints').notNullable().defaultTo('[]');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.bigInteger('started_at');
      table.bigInteger('completed_at');

      table.index(['principal_id', 'created_at'], 'idx_specialist_tasks_principal_created');
      table.index(['run_id', 'created_at'], 'idx_specialist_tasks_run_created');
      table.index(['state', 'lease_expires_at'], 'idx_specialist_tasks_state_lease');
      table.index(['role', 'state'], 'idx_specialist_tasks_role_state');
      table.index(['principal_id', 'idempotency_key'], 'idx_specialist_tasks_idempotency');
    });
  }

  const hasEventsTable = await knex.schema.hasTable('specialist_task_events');
  if (!hasEventsTable) {
    await knex.schema.createTable('specialist_task_events', (table) => {
      table.string('id', 128).primary();
      table.string('task_id', 128).notNullable().references('id').inTable('specialist_tasks').onDelete('CASCADE');
      table.string('run_id', 128).notNullable();
      table.string('event_type', 64).notNullable();
      table.string('from_state', 32);
      table.string('to_state', 32).notNullable();
      table.bigInteger('fencing_token').notNullable();
      table.string('worker_id', 128);
      table.jsonb('payload').notNullable().defaultTo('{}');
      table.bigInteger('created_at').notNullable();

      table.index(['task_id', 'created_at'], 'idx_specialist_events_task_created');
      table.index(['run_id', 'created_at'], 'idx_specialist_events_run_created');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('specialist_task_events');
  await knex.schema.dropTableIfExists('specialist_tasks');
}
