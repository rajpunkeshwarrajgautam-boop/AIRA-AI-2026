import type { Knex } from 'knex';

/** Durable control-plane queue. Untrusted project bytes stay outside PostgreSQL. */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('aira_app_build_jobs')) return;
  await knex.schema.createTable('aira_app_build_jobs', table => {
    table.uuid('id').primary();
    table.string('owner_id', 160).notNullable();
    table.string('project_id', 160).nullable();
    table.text('objective').notNullable();
    table.string('idempotency_key', 180).notNullable();
    table.string('state', 24).notNullable().defaultTo('QUEUED');
    table.integer('attempts').notNullable().defaultTo(0);
    table.integer('fencing_generation').notNullable().defaultTo(0);
    table.string('lease_owner', 160).nullable();
    table.timestamp('lease_expires_at', { useTz: true }).nullable();
    table.boolean('cancel_requested').notNullable().defaultTo(false);
    table.jsonb('result').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['owner_id', 'idempotency_key'], 'aira_app_build_jobs_owner_key_unique');
    table.index(['state', 'lease_expires_at'], 'aira_app_build_jobs_dispatch_idx');
    table.index(['owner_id', 'created_at'], 'aira_app_build_jobs_owner_idx');
  });
  await knex.raw(`ALTER TABLE aira_app_build_jobs ADD CONSTRAINT aira_app_build_jobs_state_check CHECK (state IN ('QUEUED','LEASED','RUNNING','COMPLETED','FAILED','CANCELLED','BLOCKED'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('aira_app_build_jobs');
}
