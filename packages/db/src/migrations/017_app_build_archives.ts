import type { Knex } from 'knex';

/** Staging-scale immutable artifact bytes; separate production object storage remains required. */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('aira_app_build_archives')) return;
  await knex.schema.createTable('aira_app_build_archives', table => {
    table.uuid('queue_job_id').primary().references('id').inTable('aira_app_build_jobs').onDelete('CASCADE');
    table.string('owner_id', 160).notNullable();
    table.string('run_id', 160).notNullable();
    table.uuid('worker_job_id').notNullable();
    table.string('sha256', 64).notNullable();
    table.binary('archive').notNullable();
    table.integer('byte_length').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['owner_id', 'created_at'], 'aira_app_build_archives_owner_idx');
  });
  await knex.raw('ALTER TABLE aira_app_build_archives ADD CONSTRAINT aira_app_build_archives_size_check CHECK (byte_length > 0 AND byte_length <= 1500000)');
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('aira_app_build_archives');
}
