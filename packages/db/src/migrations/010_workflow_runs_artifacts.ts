import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasCol = await knex.schema.hasColumn('workflow_runs', 'artifacts');
  if (!hasCol) {
    await knex.schema.alterTable('workflow_runs', (table) => {
      table.jsonb('artifacts').defaultTo('[]');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasCol = await knex.schema.hasColumn('workflow_runs', 'artifacts');
  if (hasCol) {
    await knex.schema.alterTable('workflow_runs', (table) => {
      table.dropColumn('artifacts');
    });
  }
}
