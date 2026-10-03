import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('run_events', (table) => {
    table.specificType('sequence', 'bigserial');
    table.index(['run_id', 'sequence']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('run_events', (table) => {
    table.dropColumn('sequence');
  });
}
