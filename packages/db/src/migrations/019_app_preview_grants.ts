import type { Knex } from 'knex';

/** Only hashes of short-lived preview credentials are persisted. */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('aira_app_preview_grants')) return;
  await knex.schema.createTable('aira_app_preview_grants', table => {
    table.string('ticket_hash', 64).primary();
    table.uuid('queue_job_id').notNullable().references('id').inTable('aira_app_build_jobs').onDelete('CASCADE');
    table.string('owner_id', 160).notNullable();
    table.string('compiled_sha256', 64).notNullable();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('revoked_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['queue_job_id', 'owner_id'], 'aira_app_preview_grant_owner_idx');
    table.index('expires_at', 'aira_app_preview_grant_expiry_idx');
  });
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('aira_app_preview_grants');
}
