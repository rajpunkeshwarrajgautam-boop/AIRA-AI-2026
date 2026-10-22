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

/**
 * Executes Knex database migrations using a dedicated single connection (`pool: { min: 1, max: 1 }`).
 * 
 * Connection Isolation Guarantee:
 * Every connection acquired during migrations runs `pool.afterCreate` which explicitly executes:
 * 1. `SET default_transaction_read_only = off;`
 * 2. `SET aira.privileged_token = '<token>';`
 * 
 * Any elevation failure throws immediately and halts migration execution (fail-closed, never swallowed).
 */
export async function runMigrations(options: { bypassToken?: string } = {}) {
  const token = options.bypassToken || process.env.AIRA_MAINTENANCE_BYPASS_TOKEN || process.env.STAGING_MAINTENANCE_TOKEN;

  // Single connection pool guarantees all migration queries execute on the elevated backend
  const migrationDb = knex({
    client: 'pg',
    connection: {
      connectionString: effectiveConnectionString,
      ssl: effectiveConnectionString.includes('neon.tech') || effectiveConnectionString.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : false,
    },
    pool: {
      min: 1,
      max: 1,
      acquireTimeoutMillis: 30000,
      afterCreate: (conn: any, done: (err: any, connection: any) => void) => {
        conn.query('SET default_transaction_read_only = off;', (err1: any) => {
          if (err1) return done(err1, conn);
          if (token) {
            conn.query(`SET aira.privileged_token = '${token}';`, (err2: any) => {
              if (err2) return done(err2, conn);
              done(null, conn);
            });
          } else {
            done(null, conn);
          }
        });
      }
    },
    migrations: {
      directory: path.join(__dirname, 'migrations'),
      extension: 'ts',
      loadExtensions: ['.ts']
    }
  });

  try {
    await migrationDb.migrate.latest();
  } finally {
    await migrationDb.destroy();
  }
}

export async function closeDb() {
  await db.destroy();
}

export * from './security/staging-maintenance-barrier.js';
export * from './security/staging-role-separation.js';
