import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('aira_runtime_leases', table => {
    table.string('name').primary();
    table.string('owner').notNullable();
    table.bigInteger('fence').notNullable().defaultTo(1);
    table.bigInteger('lease_until').notNullable().index();
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();
    table.index(['owner', 'lease_until']);
  });

  await knex.schema.createTable('aira_runtime_outbox', table => {
    table.string('id').primary();
    table.string('topic').notNullable().index();
    table.string('aggregate_type').notNullable();
    table.string('aggregate_id').notNullable();
    table.string('owner_id').nullable().index();
    table.jsonb('payload').notNullable();
    table.string('dedupe_key').nullable().unique();
    table.string('status').notNullable().defaultTo('PENDING');
    table.integer('attempts').notNullable().defaultTo(0);
    table.bigInteger('available_at').notNullable();
    table.string('claimed_by').nullable();
    table.bigInteger('claimed_until').nullable();
    table.bigInteger('delivered_at').nullable();
    table.text('last_error').nullable();
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();
    table.index(['status', 'available_at', 'created_at']);
    table.index(['aggregate_type', 'aggregate_id', 'created_at']);
  });

  // run_events is already the durable execution-event source. The trigger makes
  // event persistence and outbox publication one PostgreSQL transaction, so a
  // worker crash cannot leave a committed run event without a deliverable record.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION aira_outbox_run_event() RETURNS trigger AS $$
    DECLARE event_owner text;
    BEGIN
      SELECT principal_id INTO event_owner FROM runs WHERE id = NEW.run_id;
      INSERT INTO aira_runtime_outbox
        (id, topic, aggregate_type, aggregate_id, owner_id, payload, dedupe_key,
         status, attempts, available_at, created_at, updated_at)
      VALUES
        ('out_run_' || NEW.id, 'run.event', 'run', NEW.run_id, event_owner,
         jsonb_build_object(
           'eventId', NEW.id,
           'runId', NEW.run_id,
           'sequence', NEW.sequence,
           'type', NEW.type,
           'timestamp', NEW."createdAt",
           'data', NEW.payload
         ),
         'run-event:' || NEW.id, 'PENDING', 0, NEW."createdAt", NEW."createdAt", NEW."createdAt")
      ON CONFLICT (dedupe_key) DO NOTHING;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await knex.raw(`
    CREATE TRIGGER aira_run_event_outbox_trigger
    AFTER INSERT ON run_events
    FOR EACH ROW EXECUTE FUNCTION aira_outbox_run_event();
  `);

  await knex.schema.createTable('aira_computer_leases', table => {
    table.string('owner_id').primary();
    table.string('bot_id').notNullable();
    table.string('holder_id').notNullable();
    table.string('mode').notNullable();
    table.string('token_hash').notNullable();
    table.bigInteger('fence').notNullable().defaultTo(1);
    table.bigInteger('acquired_at').notNullable();
    table.bigInteger('expires_at').notNullable().index();
    table.bigInteger('updated_at').notNullable();
    table.index(['holder_id', 'expires_at']);
  });

  await knex.schema.createTable('aira_computer_events', table => {
    table.bigIncrements('sequence').primary();
    table.string('owner_id').notNullable().index();
    table.string('bot_id').notNullable().index();
    table.string('type').notNullable();
    table.jsonb('data').notNullable();
    table.bigInteger('created_at').notNullable();
    table.index(['owner_id', 'bot_id', 'sequence']);
  });

  await knex.schema.createTable('aira_computer_instances', table => {
    table.string('owner_id').primary();
    table.string('provider').notNullable();
    table.string('resource_name').nullable();
    table.string('desired_state').notNullable();
    table.string('observed_state').notNullable();
    table.bigInteger('generation').notNullable().defaultTo(1);
    table.text('last_error').nullable();
    table.bigInteger('last_seen_at').nullable();
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();
    table.index(['provider', 'desired_state', 'observed_state']);
  });

  await knex.schema.alterTable('aira_bot_routine_runs', table => {
    table.string('scheduler_owner').nullable();
    table.bigInteger('scheduler_fence').nullable();
    table.bigInteger('claimed_at').nullable().index();
  });
  await knex('aira_bot_routine_runs').whereNull('claimed_at').update({ claimed_at: knex.ref('created_at') });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('aira_bot_routine_runs', table => {
    table.dropColumn('claimed_at');
    table.dropColumn('scheduler_fence');
    table.dropColumn('scheduler_owner');
  });
  await knex.schema.dropTableIfExists('aira_computer_instances');
  await knex.schema.dropTableIfExists('aira_computer_events');
  await knex.schema.dropTableIfExists('aira_computer_leases');
  await knex.raw('DROP TRIGGER IF EXISTS aira_run_event_outbox_trigger ON run_events');
  await knex.raw('DROP FUNCTION IF EXISTS aira_outbox_run_event()');
  await knex.schema.dropTableIfExists('aira_runtime_outbox');
  await knex.schema.dropTableIfExists('aira_runtime_leases');
}
