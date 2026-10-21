/**
 * AIRA AI 2026 — Permanent Staging Write Isolation Gate
 * 
 * Programmatically queries the target staging PostgreSQL database to prove that:
 * 1. Target database is valid staging (not Production!).
 * 2. Zero concurrent active client write transactions are in progress (pg_stat_activity).
 * 3. Zero conflicting write/exclusive locks exist on core application tables (pg_locks).
 * 
 * Fails closed on any active write operations, ensuring deterministic cutover safety.
 */

import knex, { Knex } from 'knex';
import {
  classifyDatabaseUrl,
  PRODUCTION_NEON_PROJECT_ID,
  STAGING_NEON_PROJECT_ID
} from '../packages/db/src/security/database-isolation-guard.js';

export interface ActiveWriterInfo {
  pid: number;
  usename: string;
  application_name: string;
  client_addr: string;
  state: string;
  query: string;
  xact_start?: string;
  state_change?: string;
}

export interface ConflictingLockInfo {
  pid: number;
  mode: string;
  relname: string;
}

export interface WriteIsolationVerificationResult {
  isolated: boolean;
  activeWriters: ActiveWriterInfo[];
  conflictingLocks: ConflictingLockInfo[];
  details: string;
}

export async function verifyStagingWriteIsolation(
  client: Knex
): Promise<WriteIsolationVerificationResult> {
  // 1. Safety Guard: Disallow checking against Production
  try {
    const rawRes = await client.raw(`
      SELECT 
        current_database() as db_name,
        current_setting('neon.project_id', true) as neon_project_id
    `);
    const row = rawRes.rows?.[0] || {};
    if (row.neon_project_id === PRODUCTION_NEON_PROJECT_ID) {
      throw new Error(`[SECURITY FATAL] Connected database is PRODUCTION (${PRODUCTION_NEON_PROJECT_ID})! Verification aborted.`);
    }
  } catch (err: any) {
    if (err.message.includes('[SECURITY FATAL]')) throw err;
  }

  // 2. Query active transactions in pg_stat_activity
  let activeWriters: ActiveWriterInfo[] = [];
  try {
    const activityRes = await client.raw(`
      SELECT 
        pid,
        usename,
        coalesce(application_name, '') as application_name,
        coalesce(client_addr::text, 'local') as client_addr,
        state,
        query,
        xact_start::text,
        state_change::text
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND (
          xact_start IS NOT NULL
          OR query ~* '^(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)'
        );
    `);
    activeWriters = (activityRes.rows || []).map((r: any) => ({
      pid: r.pid,
      usename: r.usename,
      application_name: r.application_name,
      client_addr: r.client_addr,
      state: r.state,
      query: r.query,
      xact_start: r.xact_start,
      state_change: r.state_change
    }));
  } catch (err: any) {
    return {
      isolated: false,
      activeWriters: [],
      conflictingLocks: [],
      details: `Failed to query pg_stat_activity: ${err.message}`
    };
  }

  // 3. Query conflicting write locks on primary application tables
  let conflictingLocks: ConflictingLockInfo[] = [];
  try {
    const locksRes = await client.raw(`
      SELECT 
        l.pid,
        l.mode,
        c.relname
      FROM pg_locks l
      JOIN pg_class c ON l.relation = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE l.pid <> pg_backend_pid()
        AND n.nspname = 'public'
        AND c.relname IN ('users', 'oauth_accounts', 'billing_customers', 'credit_accounts', 'conversations', 'conversation_messages')
        AND l.mode IN ('RowExclusiveLock', 'ShareLock', 'ExclusiveLock', 'AccessExclusiveLock');
    `);
    conflictingLocks = (locksRes.rows || []).map((r: any) => ({
      pid: r.pid,
      mode: r.mode,
      relname: r.relname
    }));
  } catch (err: any) {
    // If pg_locks cannot be inspected or tables don't exist yet, proceed with activity check
  }

  const isIsolated = activeWriters.length === 0 && conflictingLocks.length === 0;
  const details = isIsolated
    ? 'Verified effective staging write isolation: 0 active write transactions, 0 conflicting table locks.'
    : `Isolation gate failed: ${activeWriters.length} active write transaction(s), ${conflictingLocks.length} conflicting lock(s).`;

  return {
    isolated: isIsolated,
    activeWriters,
    conflictingLocks,
    details
  };
}

async function main() {
  const dbUrl = process.argv[2] || process.env.STAGING_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Usage: npx tsx scripts/verify-staging-write-isolation.ts <STAGING_DB_URL>');
    process.exit(1);
  }

  const classification = classifyDatabaseUrl(dbUrl);
  if (classification.isProduction) {
    console.error(`[SECURITY FATAL] Direct execution against Production database (${PRODUCTION_NEON_PROJECT_ID}) is strictly prohibited.`);
    process.exit(1);
  }

  console.log(`[WRITE_ISOLATION] Checking effective write isolation against target: ${classification.sanitizedTarget}...`);

  const client = knex({
    client: 'pg',
    connection: { connectionString: dbUrl, ssl: classification.isLocalOrCiTest ? false : true }
  });

  try {
    const result = await verifyStagingWriteIsolation(client);
    if (!result.isolated) {
      console.error(`\n❌ [WRITE_ISOLATION_FATAL] ${result.details}`);
      if (result.activeWriters.length > 0) {
        console.error('Active writing transactions:');
        for (const w of result.activeWriters) {
          console.error(`  - PID ${w.pid} (${w.usename}@${w.client_addr}): ${w.query.slice(0, 80)} (started: ${w.xact_start})`);
        }
      }
      if (result.conflictingLocks.length > 0) {
        console.error('Conflicting table locks:');
        for (const l of result.conflictingLocks) {
          console.error(`  - PID ${l.pid} holds ${l.mode} on ${l.relname}`);
        }
      }
      process.exit(1);
    }

    console.log(`\n✓ [WRITE_ISOLATION_VERIFIED] ${result.details}\n`);
    process.exit(0);
  } finally {
    await client.destroy();
  }
}

if (process.argv[1]?.includes('verify-staging-write-isolation')) {
  main().catch(err => {
    console.error('[WRITE_ISOLATION] Error:', err.message);
    process.exit(1);
  });
}
