import type { Knex } from 'knex';

/**
 * Repair schema drift in deployments where 012_runs_prompt_text was recorded
 * as applied but public.runs.prompt was later restored to varchar(255).
 * This is a widening-only, idempotent change; no prompt data is truncated.
 */
export async function reconcileRunPromptColumn(knex: Knex, tableName = 'runs'): Promise<void> {
  const column = await knex('information_schema.columns')
    .where({ table_schema: 'public', table_name: tableName, column_name: 'prompt' })
    .first('data_type');

  if (!column) {
    throw new Error(`Schema contract violation: public.${tableName}.prompt is missing`);
  }
  if (column.data_type === 'text') return;
  if (column.data_type !== 'character varying') {
    throw new Error(`Unexpected public.${tableName}.prompt data type: ${column.data_type}`);
  }

  await knex.schema.alterTable(tableName, (table) => {
    table.text('prompt').notNullable().alter();
  });
}

export async function up(knex: Knex): Promise<void> {
  await reconcileRunPromptColumn(knex);
}

export async function down(_knex: Knex): Promise<void> {
  // Migration 012 already established TEXT as the canonical schema.
  // Reverting this repair to varchar(255) would reintroduce a production defect.
}
