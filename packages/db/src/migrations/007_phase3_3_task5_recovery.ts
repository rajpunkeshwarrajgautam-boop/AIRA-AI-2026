import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('runs', (table) => {
    table.string('recovery_owner').nullable();
    table.bigInteger('recovery_claimed_at').nullable();
    table.bigInteger('recovery_lease_until').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('runs', (table) => {
    table.dropColumn('recovery_owner');
    table.dropColumn('recovery_claimed_at');
    table.dropColumn('recovery_lease_until');
  });
}
