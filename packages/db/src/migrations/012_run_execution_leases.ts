import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('runs', t => {
    t.string('execution_owner').nullable().index();
    t.bigInteger('execution_lease_until').nullable().index();
    t.bigInteger('execution_fence').notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('runs', t => {
    t.dropColumn('execution_fence');
    t.dropColumn('execution_lease_until');
    t.dropColumn('execution_owner');
  });
}
