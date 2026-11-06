import type { Knex } from 'knex';

/** Durable browser ownership and specialist child execution; no browser credentials stored here. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('v2_browser_sessions', table => {
    table.string('id', 100).primary();
    table.string('owner_id', 160).notNullable();
    table.string('workspace_id', 160).nullable();
    table.string('state', 24).notNullable().defaultTo('STOPPED');
    table.string('holder', 160).nullable();
    table.string('lease_mode', 16).nullable();
    table.bigInteger('lease_until').nullable();
    table.bigInteger('fence').notNullable().defaultTo(0);
    table.string('profile_ref', 255).nullable();
    table.string('observed_url', 2048).nullable();
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();
    table.unique(['owner_id','id']);
    table.index(['owner_id','state']);
    table.index(['lease_until']);
  });
  await knex.schema.createTable('v2_delegations', table => {
    table.string('id', 120).primary();
    table.string('owner_id', 160).notNullable();
    table.string('parent_run_id', 120).notNullable();
    table.string('child_run_id', 120).notNullable().unique();
    table.string('specialist', 40).notNullable();
    table.string('idempotency_key', 180).notNullable();
    table.jsonb('scopes').notNullable();
    table.text('objective').notNullable();
    table.string('status', 32).notNullable().defaultTo('QUEUED');
    table.integer('depth').notNullable().defaultTo(1);
    table.string('worker_owner', 160).nullable();
    table.bigInteger('lease_until').nullable();
    table.bigInteger('fence').notNullable().defaultTo(0);
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();
    table.unique(['owner_id','parent_run_id','idempotency_key'], { indexName:'v2_delegations_unique_request' });
    table.index(['owner_id','parent_run_id']);
    table.index(['status','lease_until']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('v2_delegations');
  await knex.schema.dropTableIfExists('v2_browser_sessions');
}
