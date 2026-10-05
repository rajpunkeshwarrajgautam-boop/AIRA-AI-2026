import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.createTable('aira_computer_actions', t => {
    t.string('id').primary();
    t.string('owner_id').notNullable().index();
    t.string('bot_id').notNullable();
    t.string('provider').notNullable();
    t.string('operation').notNullable();
    t.string('fingerprint').notNullable();
    t.string('status').notNullable().index();
    t.uuid('lease_token').notNullable();
    t.bigInteger('lease_fence').notNullable();
    t.string('run_id').nullable();
    t.string('execution_owner').nullable();
    t.bigInteger('execution_fence').nullable();
    t.jsonb('result').nullable();
    t.text('error').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('completed_at').nullable();
  });
  // An uncertain external effect blocks new actions/takeover until reconciled
  // or explicitly acknowledged. Lease expiry alone never authorizes replay.
  await knex.raw("CREATE UNIQUE INDEX aira_one_uncertain_action ON aira_computer_actions(owner_id) WHERE status IN ('STARTED', 'AMBIGUOUS')");
  await knex.schema.alterTable('aira_computer_events', t => { t.string('source_key').nullable().unique(); });
  await knex.schema.alterTable('aira_bot_routine_runs', t => {
    t.uuid('dispatch_token').nullable();
    t.bigInteger('dispatch_until').nullable();
    t.bigInteger('dispatch_fence').notNullable().defaultTo(0);
    t.jsonb('dispatch_snapshot').nullable();
  });
}
export async function down(knex: Knex) {
  await knex.schema.alterTable('aira_bot_routine_runs', t => { t.dropColumns('dispatch_token', 'dispatch_until', 'dispatch_fence', 'dispatch_snapshot'); });
  await knex.schema.alterTable('aira_computer_events', t => { t.dropColumn('source_key'); });
  await knex.schema.dropTable('aira_computer_actions');
}
