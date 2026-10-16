import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('agents');
  if (hasTable) {
    const hasColumn = await knex.schema.hasColumn('agents', 'principal_id');
    if (!hasColumn) {
      await knex.schema.alterTable('agents', (table) => {
        table.string('principal_id', 255).nullable().index();
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('agents');
  if (hasTable) {
    const hasColumn = await knex.schema.hasColumn('agents', 'principal_id');
    if (hasColumn) {
      await knex.schema.alterTable('agents', (table) => {
        table.dropColumn('principal_id');
      });
    }
  }
}
