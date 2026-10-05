import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('aira_computer_leases', t => {
    t.string('owner_id').primary();
    t.string('bot_id').notNullable().index();
    t.string('holder_id').notNullable().index();
    t.string('mode').notNullable();
    t.uuid('token').notNullable().unique();
    t.bigInteger('fence').notNullable().defaultTo(1);
    t.bigInteger('acquired_at').notNullable();
    t.bigInteger('lease_until').notNullable().index();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('aira_computer_event_sequences', t => {
    t.string('owner_id').primary();
    t.bigInteger('sequence').notNullable().defaultTo(0);
  });

  await knex.schema.createTable('aira_computer_events', t => {
    t.string('owner_id').notNullable();
    t.bigInteger('sequence').notNullable();
    t.string('bot_id').notNullable().index();
    t.string('type').notNullable().index();
    t.jsonb('data').notNullable().defaultTo('{}');
    t.bigInteger('created_at').notNullable().index();
    t.primary(['owner_id', 'sequence']);
  });

  await knex.schema.createTable('aira_runtime_outbox', t => {
    t.uuid('id').primary();
    t.string('topic').notNullable().index();
    t.string('aggregate_id').notNullable().index();
    t.string('dedupe_key').notNullable().unique();
    t.jsonb('payload').notNullable();
    t.string('status').notNullable().defaultTo('PENDING').index();
    t.integer('attempts').notNullable().defaultTo(0);
    t.bigInteger('available_at').notNullable().index();
    t.string('claimed_by').nullable().index();
    t.bigInteger('claim_until').nullable().index();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('published_at').nullable();
    t.text('last_error').nullable();
  });

  await knex.schema.createTable('aira_scheduler_leases', t => {
    t.string('name').primary();
    t.string('holder_id').notNullable().index();
    t.bigInteger('fence').notNullable().defaultTo(1);
    t.bigInteger('lease_until').notNullable().index();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('aira_runtime_instances', t => {
    t.string('instance_id').primary();
    t.string('role').notNullable().index();
    t.string('version').notNullable();
    t.bigInteger('started_at').notNullable();
    t.bigInteger('heartbeat_at').notNullable().index();
    t.jsonb('metadata').notNullable().defaultTo('{}');
  });

  await knex.schema.createTable('aira_computer_instances', t => {
    t.string('owner_id').primary();
    t.string('provider').notNullable();
    t.string('desired_state').notNullable().defaultTo('STOPPED');
    t.string('observed_state').notNullable().defaultTo('STOPPED');
    t.string('provider_ref').nullable();
    t.bigInteger('generation').notNullable().defaultTo(0);
    t.bigInteger('observed_generation').notNullable().defaultTo(0);
    t.bigInteger('last_reconciled_at').nullable().index();
    t.text('last_error').nullable();
    t.bigInteger('updated_at').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('aira_computer_instances');
  await knex.schema.dropTableIfExists('aira_runtime_instances');
  await knex.schema.dropTableIfExists('aira_scheduler_leases');
  await knex.schema.dropTableIfExists('aira_runtime_outbox');
  await knex.schema.dropTableIfExists('aira_computer_events');
  await knex.schema.dropTableIfExists('aira_computer_event_sequences');
  await knex.schema.dropTableIfExists('aira_computer_leases');
}
