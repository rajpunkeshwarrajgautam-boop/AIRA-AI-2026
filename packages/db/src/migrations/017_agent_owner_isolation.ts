import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agents', table => {
    table.string('principal_id').nullable();
    table.index(['principal_id'], 'agents_principal_id_index');
  });
}

export async function down(): Promise<void> {
  throw new Error('Agent ownership metadata cannot be discarded automatically. Use a reviewed rollback that preserves tenant ownership.');
}
