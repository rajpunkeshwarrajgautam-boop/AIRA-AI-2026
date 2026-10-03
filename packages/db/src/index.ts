import knex from 'knex';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const connectionString = process.env.DATABASE_URL || 'postgres://aira:aira@localhost:5432/aira_db';

export const db = knex({
  client: 'pg',
  connection: connectionString,
  pool: { min: 2, max: 10 },
  migrations: {
    directory: path.join(__dirname, 'migrations'),
    extension: 'ts',
    loadExtensions: ['.ts']
  }
});

export async function runMigrations() {
  await db.migrate.latest();
}

export async function closeDb() {
  await db.destroy();
}
