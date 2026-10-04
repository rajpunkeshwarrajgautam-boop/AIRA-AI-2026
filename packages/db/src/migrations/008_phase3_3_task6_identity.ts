import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Add new identity & context columns to `runs` table
  await knex.schema.alterTable('runs', (table) => {
    table.string('session_id');
    table.string('workspace_id');
    table.string('conversation_id');
  });

  // 2. Data Migration: Backfill existing runs safely 
  await knex('runs').update({
    principal_id: knex.raw("COALESCE(principal_id, agent_id, 'user-default')"),
    session_id: 'legacy-session',
    agent_id: null // Clear it since it was wrongly used for user ID in legacy versions
  });

  // 3. Enforce NOT NULL constraints on principal_id and session_id
  await knex.schema.alterTable('runs', (table) => {
    table.string('principal_id').notNullable().alter();
    table.string('session_id').notNullable().alter();
  });

  // 4. Create performance indices for identity & session lookups
  await knex.schema.alterTable('runs', (table) => {
    table.index(['principal_id', 'createdAt'], 'idx_runs_principal_id_created_at');
    table.index(['session_id', 'createdAt'], 'idx_runs_session_id_created_at');
    table.index(['project_id', 'createdAt'], 'idx_runs_project_id_created_at');
    table.index(['conversation_id', 'createdAt'], 'idx_runs_conversation_id_created_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  // Revert indices and columns
  await knex.schema.alterTable('runs', (table) => {
    table.dropIndex(['conversation_id', 'createdAt'], 'idx_runs_conversation_id_created_at');
    table.dropIndex(['project_id', 'createdAt'], 'idx_runs_project_id_created_at');
    table.dropIndex(['session_id', 'createdAt'], 'idx_runs_session_id_created_at');
    table.dropIndex(['principal_id', 'createdAt'], 'idx_runs_principal_id_created_at');
  });

  // Re-conflate data for rollback
  await knex('runs').update({
    agent_id: knex.raw("principal_id")
  });

  await knex.schema.alterTable('runs', (table) => {
    table.string('principal_id').nullable().alter();
    table.dropColumn('session_id');
    table.dropColumn('workspace_id');
    table.dropColumn('conversation_id');
  });
}
