import 'dotenv/config';
import knex from 'knex';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const connectionString = process.env.DATABASE_URL || 'postgres://aira:aira@localhost:5432/aira_db';

const isServerless = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

export function resolveEffectiveDatabaseUrl(url: string, isServerless: boolean): string {
  if (isServerless && url.includes('neon.tech') && !url.includes('-pooler')) {
    return url.replace(/@([^.]+)\./, '@$1-pooler.');
  }
  return url;
}

const effectiveConnectionString = resolveEffectiveDatabaseUrl(connectionString, isServerless);

export const db = knex({
  client: 'pg',
  connection: {
    connectionString: effectiveConnectionString,
    ssl: effectiveConnectionString.includes('neon.tech') || effectiveConnectionString.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : false,
  },
  pool: {
    min: isServerless ? 0 : 2,
    max: isServerless ? 2 : 10,
    acquireTimeoutMillis: isServerless ? 5000 : 30000,
    idleTimeoutMillis: 10000,
    reapIntervalMillis: 1000,
  },
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
