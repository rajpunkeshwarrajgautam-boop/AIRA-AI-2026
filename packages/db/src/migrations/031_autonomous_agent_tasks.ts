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
  const allowDestructiveRollback = process.env.AIRA_ALLOW_DESTRUCTIVE_ROLLBACK === 'true';
  const isDisposableTestDatabase =
    process.env.NODE_ENV === 'test' &&
    process.env.CI_DISPOSABLE_DATABASE === 'true' &&
    Boolean(process.env.DATABASE_URL) &&
    process.env.DATABASE_URL === process.env.ISOLATED_TEST_DATABASE_URL;

  // Unless explicitly authorized via AIRA_ALLOW_DESTRUCTIVE_ROLLBACK=true,
  // enforce strict dual-table safety barriers to prevent catastrophic data loss.
  if (!allowDestructiveRollback) {
    // 1. Inspect autonomous_agent_tasks records
    const hasTasks = await knex.schema.hasTable('autonomous_agent_tasks');
    if (hasTasks) {
      const taskCountResult = await knex('autonomous_agent_tasks').count('* as count').first();
      const taskCount = Number(taskCountResult?.count || 0);
      if (taskCount > 0) {
        throw new Error(
          `[MIGRATION SAFETY BARRIER] Aborting rollback of migration 031: Table "autonomous_agent_tasks" contains ${taskCount} user record(s). ` +
          `Dropping tables in an active environment will cause catastrophic data loss. ` +
          `Use a non-destructive forward migration instead, or set AIRA_ALLOW_DESTRUCTIVE_ROLLBACK=true to force.`
        );
      }
    }

    // 2. Inspect durable_browser_sessions records separately
    const hasBrowserSessions = await knex.schema.hasTable('durable_browser_sessions');
    if (hasBrowserSessions) {
      const sessionCountResult = await knex('durable_browser_sessions').count('* as count').first();
      const sessionCount = Number(sessionCountResult?.count || 0);
      if (sessionCount > 0) {
        throw new Error(
          `[MIGRATION SAFETY BARRIER] Aborting rollback of migration 031: Table "durable_browser_sessions" contains ${sessionCount} user record(s). ` +
          `Dropping tables in an active environment will cause catastrophic data loss. ` +
          `Use a non-destructive forward migration instead, or set AIRA_ALLOW_DESTRUCTIVE_ROLLBACK=true to force.`
        );
      }
    }

    // 3. In non-disposable production/staging environments, block table drop even if empty without explicit authorization
    const isProductionOrStaging = process.env.NODE_ENV === 'production' || process.env.AIRA_ENV === 'staging' || process.env.AIRA_ENV === 'production';
    if (isProductionOrStaging && !isDisposableTestDatabase) {
      throw new Error(
        `[MIGRATION SAFETY BARRIER] Aborting rollback of migration 031: Destructive DDL is forbidden in ${process.env.NODE_ENV || 'production'} without AIRA_ALLOW_DESTRUCTIVE_ROLLBACK=true.`
      );
    }
  }

  await knex.schema.dropTableIfExists('durable_browser_sessions');
  await knex.schema.dropTableIfExists('autonomous_agent_tasks');
}
