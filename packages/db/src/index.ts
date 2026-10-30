import 'dotenv/config';
import knex, { Knex } from 'knex';
import * as path from 'path';
import * as fs from 'fs';
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
      ? { rejectUnauthorized: true }
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

export interface MigrationMaintenancePlanResult {
  canProceed: boolean;
  shouldSkipLock: boolean;
  isMaintenanceActive: boolean;
  missingMigrations: string[];
  appliedCount: number;
  expectedCount: number;
  reason: string;
}

/**
 * Evaluates whether migrations can execute under the staging maintenance barrier.
 * In maintenance mode without a privileged token (such as automated Vercel staging builds),
 * checks read-only whether all discovered schema migrations were already applied out-of-band.
 * If all migrations are applied, skips Knex lock acquisition (which requires DML).
 * If unapplied migrations remain without a token, fails closed immediately.
 */
export async function evaluateMigrationMaintenancePlan(
  client: Knex,
  options: { bypassToken?: string; migrationsDir?: string } = {}
): Promise<MigrationMaintenancePlanResult> {
  const token = options.bypassToken || process.env.AIRA_MAINTENANCE_BYPASS_TOKEN || process.env.STAGING_MAINTENANCE_TOKEN;
  const dir = options.migrationsDir || path.join(__dirname, 'migrations');

  let isMaintenanceActive = false;
  try {
    const sentinelRes = await client.raw(`
      SELECT is_active FROM _aira_staging_maintenance WHERE id = 1;
    `);
    isMaintenanceActive = Boolean(sentinelRes.rows?.[0]?.is_active);
  } catch {
    isMaintenanceActive = false;
  }

  if (!isMaintenanceActive) {
    return {
      canProceed: true,
      shouldSkipLock: false,
      isMaintenanceActive: false,
      missingMigrations: [],
      appliedCount: 0,
      expectedCount: 0,
      reason: 'Maintenance barrier is inactive: normal Knex migration flow permitted'
    };
  }

  if (token) {
    return {
      canProceed: true,
      shouldSkipLock: false,
      isMaintenanceActive: true,
      missingMigrations: [],
      appliedCount: 0,
      expectedCount: 0,
      reason: 'Privileged maintenance bypass token provided: elevated Knex migration permitted'
    };
  }

  // Maintenance is active, and NO bypass token is provided (Vercel automated build after merge)
  const expectedMigrations = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => /^\d+_.+\.ts$/.test(f)).sort()
    : [];

  const hasKnexTable = await client.schema.hasTable('knex_migrations');
  if (!hasKnexTable) {
    return {
      canProceed: false,
      shouldSkipLock: false,
      isMaintenanceActive: true,
      missingMigrations: expectedMigrations,
      appliedCount: 0,
      expectedCount: expectedMigrations.length,
      reason: 'knex_migrations table missing under maintenance mode without bypass token'
    };
  }

  const appliedRows = await client('knex_migrations').select('name');
  const appliedSet = new Set(appliedRows.map((r: any) => String(r.name)));
  const missing = expectedMigrations.filter(m => !appliedSet.has(m));

  if (missing.length === 0) {
    return {
      canProceed: true,
      shouldSkipLock: true,
      isMaintenanceActive: true,
      missingMigrations: [],
      appliedCount: appliedRows.length,
      expectedCount: expectedMigrations.length,
      reason: `All ${expectedMigrations.length} discovered schema migrations already applied: skipping Knex lock acquisition under maintenance`
    };
  }

  return {
    canProceed: false,
    shouldSkipLock: false,
    isMaintenanceActive: true,
    missingMigrations: missing,
    appliedCount: appliedRows.length,
    expectedCount: expectedMigrations.length,
    reason: `${missing.length} unapplied migration(s) remain (${missing.join(', ')}) under maintenance mode without bypass token`
  };
}

export interface RunMigrationsOptions {
  bypassToken?: string;
  connectionString?: string;
}

/**
 * Executes Knex database migrations using a dedicated single connection (`pool: { min: 1, max: 1 }`).
 * 
 * Connection Isolation Guarantee:
 * Every connection acquired during migrations runs `pool.afterCreate` which explicitly executes:
 * 1. `SET default_transaction_read_only = off;`
 * 2. `SET aira.privileged_token = '<token>';`
 * 
 * Any elevation failure throws immediately and halts migration execution (fail-closed, never swallowed).
 *
 * Staging Maintenance Guarantee (Defect 3 resolution):
 * In permanent staging maintenance mode, if no bypass token is provided (such as in Vercel's automated
 * preview buildCommand following merge), all discovered migrations are verified read-only.
 * If already applied out-of-band by the cutover operator, Knex lock acquisition is safely skipped.
 * If unapplied migrations remain without token, execution fails closed immediately.
 */
export async function runMigrations(options: RunMigrationsOptions = {}) {
  const token = options.bypassToken || process.env.AIRA_MAINTENANCE_BYPASS_TOKEN || process.env.STAGING_MAINTENANCE_TOKEN;
  const targetConnStr = options.connectionString || effectiveConnectionString;

  // Single connection pool guarantees all migration queries execute on the elevated backend
  const migrationDb = knex({
    client: 'pg',
    connection: {
      connectionString: targetConnStr,
      ssl: targetConnStr.includes('neon.tech') || targetConnStr.includes('sslmode=require')
        ? { rejectUnauthorized: true }
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
    const plan = await evaluateMigrationMaintenancePlan(migrationDb, { bypassToken: token });

    if (!plan.canProceed) {
      throw new Error(`[SECURITY FATAL] Staging database is in maintenance mode and unapplied migrations remain: ${plan.reason}. Fail-closed.`);
    }

    if (plan.shouldSkipLock) {
      console.log(`[db:migrate] ${plan.reason}`);
      return;
    }

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
export * from './security/database-isolation-guard.js';
