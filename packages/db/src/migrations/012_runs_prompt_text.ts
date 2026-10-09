import { Knex } from 'knex';

// Expand run prompt storage before production accepts long-form document requests.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('runs', (table) => {
    table.text('prompt').notNullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  // Reverting to varchar(255) while long prompts exist would lose user data.
  const overLimit = await knex('runs').whereRaw('char_length("prompt") > ?', [255]).first('id');
  if (overLimit) {
    throw new Error('Cannot roll back prompt to varchar(255): long prompts exist.');
  }
  await knex.schema.alterTable('runs', (table) => {
    table.string('prompt', 255).notNullable().alter();
  });
}
