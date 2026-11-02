import { Knex } from 'knex';

/**
 * AIRA AI 2026 — Milestone 3: Autonomous Agent Task Persistence Schema
 * 
 * Provides durable PostgreSQL storage for high-level autonomous agent missions,
 * objective plans, observations, artifacts, approval checkpoints, and worker leases.
 * 
 * Enforces:
 * 1. Monotonically increasing fencing tokens (fencing_token) for stale-worker rejection
 * 2. Lease-based execution ownership (lease_owner, lease_expires_at) for crash recovery
 * 3. Tenant and workspace isolation via principal_id and workspace_id indexes
 * 4. Idempotent submission index (principal_id, idempotency_key)
 */
export async function up(knex: Knex): Promise<void> {
  const hasTasksTable = await knex.schema.hasTable('autonomous_agent_tasks');
  if (!hasTasksTable) {
    await knex.schema.createTable('autonomous_agent_tasks', (table) => {
      table.string('task_id', 128).primary();
      table.string('principal_id', 128).notNullable();
      table.string('workspace_id', 128);
      table.string('session_id', 128);
      table.text('objective').notNullable();
      table.string('state', 32).notNullable().defaultTo('CREATED');
      table.string('active_step_id', 64);
      table.string('approval_request_id', 128);
      table.jsonb('plan');
      table.jsonb('dag');
      table.jsonb('observations').notNullable().defaultTo('[]');
      table.jsonb('artifacts').notNullable().defaultTo('[]');
      table.jsonb('working_memory').notNullable().defaultTo('{}');
      table.jsonb('execution_history').notNullable().defaultTo('[]');
      table.text('deliverable_summary');
      table.text('error');
      table.bigInteger('fencing_token').notNullable().defaultTo(0);
      table.string('lease_owner', 128);
      table.bigInteger('lease_expires_at');
      table.bigInteger('heartbeat_at');
      table.string('idempotency_key', 256);
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.bigInteger('completed_at');

      table.index(['principal_id', 'created_at'], 'idx_auto_tasks_principal_created');
      table.index(['workspace_id', 'created_at'], 'idx_auto_tasks_workspace_created');
      table.index(['state', 'lease_expires_at'], 'idx_auto_tasks_state_lease');
      table.unique(['principal_id', 'idempotency_key'], 'uq_auto_tasks_idempotency');
    });
  } else {
    const hasWorkingMemory = await knex.schema.hasColumn('autonomous_agent_tasks', 'working_memory');
    if (!hasWorkingMemory) {
      await knex.schema.alterTable('autonomous_agent_tasks', (table) => {
        table.jsonb('working_memory').notNullable().defaultTo('{}');
      });
    }

    // Ensure unique constraint uq_auto_tasks_idempotency exists on existing schema
    const hasUniqueConstraint = await knex.raw(`
      SELECT 1 FROM pg_constraint WHERE conname = 'uq_auto_tasks_idempotency'
    `).then(res => res?.rows && res.rows.length > 0).catch(() => false);

    if (!hasUniqueConstraint) {
      try {
        await knex.schema.alterTable('autonomous_agent_tasks', (table) => {
          table.unique(['principal_id', 'idempotency_key'], 'uq_auto_tasks_idempotency');
        });
      } catch {
        // Idempotent catch if constraint already applied concurrently
      }
    }
  }

  const hasBrowserSessionsTable = await knex.schema.hasTable('durable_browser_sessions');
  if (!hasBrowserSessionsTable) {
    await knex.schema.createTable('durable_browser_sessions', (table) => {
      table.string('session_key', 256).primary();
      table.string('principal_id', 128).notNullable();
      table.string('workspace_id', 128);
      table.string('session_id', 128).notNullable();
      table.text('encrypted_envelope').notNullable();
      table.bigInteger('expires_at').notNullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();

      table.index(['principal_id', 'expires_at'], 'idx_browser_sessions_principal_expires');
      table.index(['workspace_id', 'created_at'], 'idx_browser_sessions_workspace');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('durable_browser_sessions');
  await knex.schema.dropTableIfExists('autonomous_agent_tasks');
}
