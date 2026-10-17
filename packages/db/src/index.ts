import 'dotenv/config';
import knex from 'knex';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const connectionString = process.env.DATABASE_URL || 'postgres://aira:aira@localhost:5432/aira_db';

const isServerless = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

export function resolveEffectiveDatabaseUrl(rawUrl: string, isServerless: boolean): string {
  if (!isServerless) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname;
    if (host.endsWith('.neon.tech') && !host.includes('-pooler')) {
      const parts = host.split('.');
      if (parts.length >= 4 && parts[parts.length - 2] === 'neon' && parts[parts.length - 1] === 'tech') {
        parts[0] = `${parts[0]}-pooler`;
        parsed.hostname = parts.join('.');
        return parsed.toString();
      }
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
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
    min: 0,
    max: isServerless ? 8 : 10,
    acquireTimeoutMillis: 15000,
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
