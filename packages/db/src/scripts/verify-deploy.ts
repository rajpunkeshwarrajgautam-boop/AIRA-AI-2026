import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, closeDb } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../migrations');

function expectedMigrationNames(): string[] {
  return fs.readdirSync(migrationsDir)
    .filter(name => /^\d+_.+\.ts$/.test(name))
    .sort();
}

async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DEPLOY_DB_NOT_CONFIGURED: DATABASE_URL is required before deployment can be certified.');
  }

  const expected = expectedMigrationNames();

  const hasMigrationTable = await db.schema.hasTable('knex_migrations');
  if (!hasMigrationTable) {
    throw new Error('DEPLOY_DB_UNMIGRATED: knex_migrations table is missing.');
  }

  const appliedRows = await db('knex_migrations').select('name').orderBy('id');
  const applied = new Set(appliedRows.map(row => String(row.name)));
  const missing = expected.filter(name => !applied.has(name));

  if (missing.length > 0) {
    throw new Error('DEPLOY_DB_MIGRATIONS_MISSING: ' + missing.join(', '));
  }

  const requiredTables = [
    'runs',
    'run_events',
    'workflow_definitions',
    'workflow_runs',
    'workflow_steps',
    'tool_calls',
    'conversations',
    'conversation_messages',
    'conversation_search_documents',
    'capacity_permits',
    'capacity_rate_log'
  ];

  const missingTables: string[] = [];
  for (const table of requiredTables) {
    if (!(await db.schema.hasTable(table))) missingTables.push(table);
  }

  if (missingTables.length > 0) {
    throw new Error('DEPLOY_DB_SCHEMA_INCOMPLETE: ' + missingTables.join(', '));
  }

  const searchColumns = await db('information_schema.columns')
    .where({
      table_schema: 'public',
      table_name: 'conversation_search_documents'
    })
    .select('column_name', 'udt_name');

  const byName = new Map(
    searchColumns.map(row => [String(row.column_name), String(row.udt_name)])
  );

  const semanticExpected = process.env.AIRA_SEMANTIC_SEARCH !== 'false';
  if (semanticExpected) {
    const vectorEnabled = await db.raw(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS enabled"
    );

    if (!Boolean(vectorEnabled.rows?.[0]?.enabled)) {
      throw new Error('DEPLOY_DB_PGVECTOR_NOT_READY: vector extension is not enabled.');
    }

    if (byName.get('embedding_vector') !== 'vector') {
      throw new Error('DEPLOY_DB_VECTOR_COLUMN_MISSING: conversation_search_documents.embedding_vector is not vector.');
    }
  }

  const branchIdentity = await db.raw(
    "SELECT current_database() AS database_name, current_user AS database_user, current_setting('server_version') AS server_version"
  );

  const identity = branchIdentity.rows?.[0] || {};

  console.log(JSON.stringify({
    status: 'READY',
    migrations: expected.length,
    requiredTables: requiredTables.length,
    semanticSearch: semanticExpected ? 'READY' : 'DISABLED',
    database: {
      name: identity.database_name,
      user: identity.database_user,
      serverVersion: identity.server_version
    }
  }));
}

main()
  .catch(error => {
    console.error('[DEPLOY_DB_VERIFY] FAIL');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
