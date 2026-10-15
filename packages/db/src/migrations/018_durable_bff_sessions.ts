import type { Knex } from 'knex';

/**
 * Migration 018: Durable PostgreSQL BFF Sessions
 * 
 * Provides distributed, shared session persistence for first-party BFF sessions
 * across multi-instance and serverless Vercel deployments.
 */
export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable('bff_sessions');
  if (!exists) {
    await knex.schema.createTable('bff_sessions', (table) => {
      table.string('id', 255).primary();
      table.string('user_id', 255).notNullable();
      table.string('email', 255).nullable();
      table.string('name', 255).nullable();
      table.text('session_token').notNullable();
      table.text('upstream_cookie').nullable();
      table.text('jwt').notNullable();
      table.bigInteger('jwt_expires_at').notNullable();
      table.string('csrf_token', 255).notNullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('expires_at').notNullable();
      table.bigInteger('last_rotated_at').notNullable();
      table.bigInteger('revoked_at').nullable();

      table.index(['user_id'], 'bff_sessions_user_id_idx');
      table.index(['expires_at'], 'bff_sessions_expires_at_idx');
      table.index(['revoked_at'], 'bff_sessions_revoked_at_idx');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('bff_sessions');
}
