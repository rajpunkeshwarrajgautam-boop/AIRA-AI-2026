import type { Knex } from 'knex';

/** Object metadata only. Blob bytes are stored in a private S3-compatible bucket. */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('aira_app_build_object_refs')) return;
  await knex.schema.createTable('aira_app_build_object_refs', table => {
    table.uuid('queue_job_id').notNullable().references('id').inTable('aira_app_build_jobs').onDelete('CASCADE');
    table.string('kind', 32).notNullable();
    table.string('owner_id', 160).notNullable();
    table.string('run_id', 160).notNullable();
    table.string('object_key', 240).notNullable();
    table.string('sha256', 64).notNullable();
    table.integer('byte_length').notNullable();
    table.string('content_type', 100).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(['queue_job_id', 'kind'], { constraintName: 'aira_app_build_object_refs_pk' });
    table.index(['owner_id', 'queue_job_id'], 'aira_app_build_object_refs_owner_idx');
  });
  await knex.raw("ALTER TABLE aira_app_build_object_refs ADD CONSTRAINT aira_app_build_object_refs_kind_ck CHECK (kind IN ('source', 'compiled', 'test-evidence'))");
  await knex.raw('ALTER TABLE aira_app_build_object_refs ADD CONSTRAINT aira_app_build_object_refs_size_ck CHECK (byte_length > 0 AND byte_length <= 32000000)');
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('aira_app_build_object_refs');
}
