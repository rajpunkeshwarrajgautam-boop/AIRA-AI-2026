import type { Knex } from 'knex';

/**
 * Repair schema drift in deployments where 011_tool_gateway_schema was recorded
 * as applied in knex_migrations but public.tool_calls lacks the gateway execution columns.
 * This is an additive, idempotent reconciliation; all pre-existing tool call data is preserved.
 */
export async function reconcileToolCallsSchema(knex: Knex, tableName = 'tool_calls'): Promise<void> {
  const hasTable = await knex.schema.hasTable(tableName);
  if (!hasTable) {
    throw new Error(`Schema contract violation: public.${tableName} is missing`);
  }

  const existingColumns = await knex('information_schema.columns')
    .where({ table_schema: 'public', table_name: tableName })
    .select('column_name', 'data_type');

  const existingColumnMap = new Map(existingColumns.map(c => [String(c.column_name), String(c.data_type)]));

  const validateType = (col: string, allowed: string[]) => {
    if (existingColumnMap.has(col)) {
      const actual = existingColumnMap.get(col)!;
      if (!allowed.includes(actual)) {
        throw new Error(`Schema contract violation: public.${tableName}.${col} has incompatible data type '${actual}' (expected: ${allowed.join(', ')})`);
      }
    }
  };

  const stringTypes = ['character varying', 'text'];
  const jsonTypes = ['jsonb', 'json'];
  const intTypes = ['integer', 'smallint', 'bigint'];

  validateType('principal_id', stringTypes);
  validateType('tool_id', stringTypes);
  validateType('workflow_run_id', stringTypes);
  validateType('agent_mission_id', stringTypes);
  validateType('adapter', stringTypes);
  validateType('side_effect_level', stringTypes);
  validateType('error_code', stringTypes);
  validateType('permission_scopes', jsonTypes);
  validateType('input_metadata', jsonTypes);
  validateType('attempt_count', intTypes);
  validateType('duration_ms', intTypes);

  await knex.schema.alterTable(tableName, (table) => {
    if (!existingColumnMap.has('principal_id')) {
      table.string('principal_id');
    }
    if (!existingColumnMap.has('tool_id')) {
      table.string('tool_id');
    }
    if (!existingColumnMap.has('workflow_run_id')) {
      table.string('workflow_run_id');
    }
    if (!existingColumnMap.has('agent_mission_id')) {
      table.string('agent_mission_id');
    }
    if (!existingColumnMap.has('adapter')) {
      table.string('adapter');
    }
    if (!existingColumnMap.has('side_effect_level')) {
      table.string('side_effect_level');
    }
    if (!existingColumnMap.has('permission_scopes')) {
      table.jsonb('permission_scopes').defaultTo('[]');
    }
    if (!existingColumnMap.has('input_metadata')) {
      table.jsonb('input_metadata').defaultTo('{}');
    }
    if (!existingColumnMap.has('attempt_count')) {
      table.integer('attempt_count').defaultTo(1);
    }
    if (!existingColumnMap.has('error_code')) {
      table.string('error_code');
    }
    if (!existingColumnMap.has('duration_ms')) {
      table.integer('duration_ms');
    }
  });

  // Conditionally create indexes if not already present
  const existingIndexes = await knex('pg_indexes')
    .where({ schemaname: 'public', tablename: tableName })
    .select('indexname');

  const existingIndexSet = new Set(existingIndexes.map(i => String(i.indexname)));

  const idxPrincipal = tableName === 'tool_calls' ? 'idx_tool_calls_principal_started' : `idx_${tableName}_principal_started`;
  const idxRun = tableName === 'tool_calls' ? 'idx_tool_calls_run_started' : `idx_${tableName}_run_started`;
  const idxStatus = tableName === 'tool_calls' ? 'idx_tool_calls_status' : `idx_${tableName}_status`;

  await knex.schema.alterTable(tableName, (table) => {
    if (!existingIndexSet.has(idxPrincipal)) {
      table.index(['principal_id', 'started_at'], idxPrincipal);
    }
    if (!existingIndexSet.has(idxRun)) {
      table.index(['run_id', 'started_at'], idxRun);
    }
    if (!existingIndexSet.has(idxStatus)) {
      table.index(['status'], idxStatus);
    }
  });
}

export async function up(knex: Knex): Promise<void> {
  await reconcileToolCallsSchema(knex);
}

export async function down(_knex: Knex): Promise<void> {
  // Migration 011 already established these columns as part of canonical schema.
  // Dropping these columns would destroy active agent tool execution history.
}
