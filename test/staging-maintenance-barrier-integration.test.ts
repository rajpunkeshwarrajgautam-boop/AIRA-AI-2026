/**
 * AIRA AI 2026 — Staging Maintenance Barrier Real PostgreSQL Integration Test Suite
 * 
 * Executes real PostgreSQL operations against an isolated disposable database:
 * Target: Neon Isolated Rehearsal Branch (rehearsal-pr96-final-20261021 / ep-steep-wildflower-b3nj385g)
 * 
 * Distinct Role Dual-Authentication Lifecycle Assertions:
 * 1. Authenticate as least-privilege runtime role (test_aira_staging_runtime).
 * 2. Pre-maintenance: unprivileged runtime writes succeed.
 * 3. Barrier activation: migration role (neondb_owner) transactionally activates barrier.
 * 4. Maintenance write interception: runtime role INSERT blocked with exact SQLSTATE 55P03.
 * 5. Maintenance write interception: runtime role UPDATE blocked with exact SQLSTATE 55P03.
 * 6. Maintenance write interception: runtime role DELETE blocked with exact SQLSTATE 55P03.
 * 7. Maintenance write interception: runtime role TRUNCATE blocked with exact SQLSTATE 55P03.
 * 8. Role privilege enforcement: runtime role cannot disable triggers (exact SQLSTATE 42501).
 * 9. Role privilege enforcement: runtime role cannot modify maintenance sentinel (exact SQLSTATE 42501).
 * 10. Legacy owner credential containment: owner connection without token is blocked with SQLSTATE 55P03.
 * 11. Privileged migration path: migration role inside transaction with token succeeds.
 * 12. Barrier deactivation: migration role cleanly clears sentinel and drops triggers.
 * 13. Post-maintenance: unprivileged runtime writes resume cleanly.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import knex, { Knex } from 'knex';
import {
  activateStagingMaintenance,
  deactivateStagingMaintenance,
  getStagingMaintenanceStatus,
  generateBypassToken,
  STAGING_MAINTENANCE_TABLE,
  STAGING_MAINTENANCE_TRIGGER,
  STAGING_MAINTENANCE_TRUNC_TRIGGER,
  STAGING_MAINTENANCE_FUNCTION,
  STAGING_PROBE_TABLE
} from '../packages/db/src/security/staging-maintenance-barrier.js';
import {
  auditConnectedRolePrivileges
} from '../packages/db/src/security/staging-role-separation.js';

// Resolve environment configuration from .env.local or .env if present
if (!process.env.TEST_DATABASE_URL && !process.env.REHEARSAL_DATABASE_URL) {
  for (const envFile of ['.env.local', '.env']) {
    if (fs.existsSync(envFile)) {
      try {
        const content = fs.readFileSync(envFile, 'utf8');
        const match = content.match(/^(?:TEST_DATABASE_URL|REHEARSAL_DATABASE_URL)=(.*)$/m);
        if (match && match[1]?.trim()) {
          process.env.TEST_DATABASE_URL = match[1].trim();
          break;
        }
      } catch {
        // Ignore file read errors
      }
    }
  }
}

const targetUrl = process.env.TEST_DATABASE_URL || process.env.REHEARSAL_DATABASE_URL || process.env.DATABASE_URL;
if (!targetUrl) {
  console.log('\n================================================================================');
  console.log('   AIRA AI 2026 — REAL POSTGRESQL STAGING BARRIER INTEGRATION SUITE             ');
  console.log('   NOTICE: Neither TEST_DATABASE_URL nor DATABASE_URL is set.                   ');
  console.log('   Skipping live PostgreSQL integration suite (requires active database).       ');
  console.log('================================================================================\n');
  process.exit(0);
}

const isNeon = targetUrl.includes('neon.tech');

console.log('\n================================================================================');
console.log('   AIRA AI 2026 — REAL POSTGRESQL STAGING BARRIER INTEGRATION SUITE             ');
console.log(`   Target: ${targetUrl.replace(/:[^:@]+@/, ':***@')} (isNeon: ${isNeon})        `);
console.log('================================================================================\n');

// Primary Migration / Administrator client (neondb_owner)
const migrationClient: Knex = knex({
  client: 'pg',
  connection: {
    connectionString: targetUrl,
    ssl: isNeon ? { rejectUnauthorized: false } : false
  },
  pool: { min: 1, max: 2, acquireTimeoutMillis: 15000 }
});

const TEST_TABLE = '_test_barrier_integration_items';
const RUNTIME_ROLE = 'test_aira_staging_runtime';
const RUNTIME_PASSWORD = `AiraRuntime_${Date.now()}!`;
let passed = 0;

async function runStep(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ [INTEGRATION] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}`);
    console.error(err);
    await migrationClient.destroy().catch(() => {});
    process.exit(1);
  }
}

async function main() {
  const metaRes = await migrationClient.raw(`
    SELECT 
      current_database() as db, 
      current_user as db_user, 
      version() as pg_version,
      current_setting('neon.project_id', true) as neon_project_id,
      current_setting('neon.branch_id', true) as neon_branch_id
  `);
  const meta = metaRes.rows?.[0] || {};
  console.log(`Connected Migration Role: ${meta.db_user} (Database: ${meta.db})`);
  if (meta.neon_project_id) {
    console.log(`Neon Project: ${meta.neon_project_id} (Branch: ${meta.neon_branch_id})`);
  }

  // Recovery initialization: ensure session elevation if previous run was interrupted mid-maintenance
  await migrationClient.raw('SET default_transaction_read_only = off;').catch(() => {});
  await migrationClient.raw(`ALTER DATABASE "${meta.db}" SET default_transaction_read_only = off;`).catch(() => {});
  await migrationClient.raw(`DROP FUNCTION IF EXISTS ${STAGING_MAINTENANCE_FUNCTION}() CASCADE;`).catch(() => {});
  await migrationClient.raw(`DROP TABLE IF EXISTS ${STAGING_MAINTENANCE_TABLE};`).catch(() => {});
  await migrationClient.raw(`
    DO $$
    BEGIN
      EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM test_legacy_preview_deploy_role', '${meta.db}');
      DROP ROLE IF EXISTS test_legacy_preview_deploy_role;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END
    $$;
  `).catch(() => {});

  // Ensure isolated integration test table exists
  await migrationClient.raw(`
    CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (
      id VARCHAR(64) PRIMARY KEY,
      title TEXT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await migrationClient.raw(`TRUNCATE TABLE ${TEST_TABLE};`);

  // Provision disposable least-privilege runtime role
  await migrationClient.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
        CREATE ROLE ${RUNTIME_ROLE} WITH LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
      ELSE
        ALTER ROLE ${RUNTIME_ROLE} WITH PASSWORD '${RUNTIME_PASSWORD}';
      END IF;
    END
    $$;
  `);

  await migrationClient.raw(`
    DO $$
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${RUNTIME_ROLE}', current_database());
    END
    $$;
  `);

  await migrationClient.raw(`
    GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE};
    REVOKE CREATE ON SCHEMA public FROM ${RUNTIME_ROLE};
  `);

  // Construct dedicated runtime client connecting as test_aira_staging_runtime
  const parsedUrl = new URL(targetUrl);
  parsedUrl.username = RUNTIME_ROLE;
  parsedUrl.password = RUNTIME_PASSWORD;
  const runtimeUrl = parsedUrl.toString();

  const runtimeClient: Knex = knex({
    client: 'pg',
    connection: {
      connectionString: runtimeUrl,
      ssl: isNeon ? { rejectUnauthorized: false } : false
    },
    pool: { min: 1, max: 2, acquireTimeoutMillis: 15000 }
  });

  const whoRes = await runtimeClient.raw('SELECT current_user, session_user;');
  console.log(`Connected Runtime Role: ${whoRes.rows[0].current_user} (Least-privilege role verified)\n`);
  assert.equal(whoRes.rows[0].current_user, RUNTIME_ROLE);

  const bypassToken = generateBypassToken();

  try {
    // ── 1. Pre-maintenance verification with runtimeClient ─────────────────────
    await runStep('1. Pre-maintenance: unprivileged runtime writes succeed', async () => {
      const itemId = `pre_maint_${Date.now()}`;
      await runtimeClient(TEST_TABLE).insert({ id: itemId, title: 'Pre-maintenance write' });
      const row = await runtimeClient(TEST_TABLE).where({ id: itemId }).first();
      assert.ok(row, 'Pre-maintenance record inserted successfully');

      await runtimeClient(TEST_TABLE).where({ id: itemId }).update({ title: 'Updated pre-maintenance' });
      const updated = await runtimeClient(TEST_TABLE).where({ id: itemId }).first();
      assert.equal(updated.title, 'Updated pre-maintenance');

      await runtimeClient(TEST_TABLE).where({ id: itemId }).delete();

      // Seed a persistent canary row to verify UPDATE & DELETE row trigger interception during maintenance
      await runtimeClient(TEST_TABLE).insert({ id: 'canary_row_1', title: 'Original Canary Title', status: 'active' });
    });

    // ── 2. Maintenance barrier activation with migrationClient ─────────────────
    await runStep('2. Barrier activation: atomic installation of row & truncate triggers', async () => {
      const actRes = await activateStagingMaintenance(migrationClient, {
        operator: 'rajpunkeshwarrajgautam-boop',
        reason: 'PR #96 live security integration certification',
        bypassToken,
        allowRehearsalBranch: true
      });

      assert.equal(actRes.active, true);
      assert.equal(actRes.bypassToken, bypassToken);

      const status = await getStagingMaintenanceStatus(migrationClient);
      assert.equal(status.isActive, true);
      assert.ok(status.tablesGuarded.includes(TEST_TABLE), `${TEST_TABLE} must have trigger attached`);
      console.log(`     Guarded Tables count: ${status.tablesGuarded.length}`);
    });

    // ── 3. Runtime write interception with SQLSTATE 55P03 ─────────────────────
    // Explicitly reset default_transaction_read_only = off for runtime session to prove
    // that the triggers are the authoritative barrier (not relying on read-only default).
    await runStep('3. Runtime role INSERT intercepted with exact SQLSTATE 55P03', async () => {
      let thrownError: any = null;
      try {
        await runtimeClient.raw('SET default_transaction_read_only = off;').catch(() => {});
        await runtimeClient(TEST_TABLE).insert({ id: `unauth_ins_${Date.now()}`, title: 'Unauthorized Insert' });
      } catch (err: any) {
        thrownError = err;
      }

      assert.ok(thrownError, 'Unauthorized insert must throw error');
      assert.equal(thrownError.code, '55P03', `Expected SQLSTATE 55P03, got ${thrownError.code}`);
      assert.match(thrownError.message, /STAGING_MAINTENANCE_BLOCKED/);
    });

    await runStep('4. Runtime role UPDATE intercepted with exact SQLSTATE 55P03', async () => {
      let thrownError: any = null;
      try {
        await runtimeClient.raw('SET default_transaction_read_only = off;').catch(() => {});
        await runtimeClient(TEST_TABLE).where({ status: 'active' }).update({ title: 'Mutated under maintenance' });
      } catch (err: any) {
        thrownError = err;
      }

      assert.ok(thrownError, 'Unauthorized update must throw error');
      assert.equal(thrownError.code, '55P03', `Expected SQLSTATE 55P03, got ${thrownError.code}`);
    });

    await runStep('5. Runtime role DELETE intercepted with exact SQLSTATE 55P03', async () => {
      let thrownError: any = null;
      try {
        await runtimeClient.raw('SET default_transaction_read_only = off;').catch(() => {});
        await runtimeClient(TEST_TABLE).where({ status: 'active' }).delete();
      } catch (err: any) {
        thrownError = err;
      }

      assert.ok(thrownError, 'Unauthorized delete must throw error');
      assert.equal(thrownError.code, '55P03', `Expected SQLSTATE 55P03, got ${thrownError.code}`);
    });

    await runStep('6. Runtime role TRUNCATE blocked by role permissions (exact SQLSTATE 42501)', async () => {
      let thrownError: any = null;
      try {
        await runtimeClient.raw('SET default_transaction_read_only = off;').catch(() => {});
        await runtimeClient.raw(`TRUNCATE TABLE "${TEST_TABLE}";`);
      } catch (err: any) {
        thrownError = err;
      }

      assert.ok(thrownError, 'Unauthorized TRUNCATE must throw error for runtime role');
      assert.equal(thrownError.code, '42501', `Expected SQLSTATE 42501 (must be table owner), got ${thrownError.code}`);
    });

    // ── 4. Role privilege enforcement: SQLSTATE 42501 ─────────────────────────
    await runStep('7. Runtime role cannot disable triggers (exact SQLSTATE 42501)', async () => {
      let thrownError: any = null;
      try {
        await runtimeClient.raw(`ALTER TABLE "${TEST_TABLE}" DISABLE TRIGGER ALL;`);
      } catch (err: any) {
        thrownError = err;
      }

      assert.ok(thrownError, 'Disabling triggers must fail for non-owner');
      assert.equal(thrownError.code, '42501', `Expected SQLSTATE 42501, got ${thrownError.code}`);
    });

    await runStep('8. Runtime role cannot modify maintenance sentinel (exact SQLSTATE 42501)', async () => {
      let thrownError: any = null;
      try {
        await runtimeClient.raw(`UPDATE ${STAGING_MAINTENANCE_TABLE} SET is_active = false WHERE id = 1;`);
      } catch (err: any) {
        thrownError = err;
      }

      assert.ok(thrownError, 'Updating sentinel must fail for runtime role');
      assert.equal(thrownError.code, '42501', `Expected SQLSTATE 42501, got ${thrownError.code}`);
    });

    // ── 5. Legacy owner credential containment ─────────────────────────────────
    await runStep('9. Legacy owner credentials contained: write & truncate without token blocked (SQLSTATE 55P03)', async () => {
      let insertErr: any = null;
      try {
        await migrationClient.raw('SET default_transaction_read_only = off;').catch(() => {});
        // Owner connection attempting normal write without token elevation
        await migrationClient(TEST_TABLE).insert({ id: `owner_no_token_${Date.now()}`, title: 'Owner without token' });
      } catch (err: any) {
        insertErr = err;
      }

      assert.ok(insertErr, 'Owner write without token elevation must be blocked by maintenance triggers');
      assert.equal(insertErr.code, '55P03', `Expected SQLSTATE 55P03, got ${insertErr.code}`);

      let truncErr: any = null;
      try {
        await migrationClient.raw('SET default_transaction_read_only = off;').catch(() => {});
        await migrationClient.raw(`TRUNCATE TABLE "${TEST_TABLE}";`);
      } catch (err: any) {
        truncErr = err;
      }

      assert.ok(truncErr, 'Owner TRUNCATE without token elevation must be blocked by statement trigger');
      assert.equal(truncErr.code, '55P03', `Expected SQLSTATE 55P03, got ${truncErr.code}`);
    });

    // ── 5b. Defect 1: Legacy credential containment proof (terminate backends + NOLOGIN) ────
    await runStep('9b. Legacy credential containment: backend termination and NOLOGIN invalidation in rehearsal', async () => {
      const LEGACY_MOCK_ROLE = 'test_legacy_preview_deploy_role';
      const LEGACY_MOCK_PASSWORD = `LegacySec_${Date.now()}!`;

      // 1. Provision disposable legacy preview role
      await migrationClient.raw(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${LEGACY_MOCK_ROLE}') THEN
            CREATE ROLE ${LEGACY_MOCK_ROLE} WITH LOGIN PASSWORD '${LEGACY_MOCK_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
          ELSE
            ALTER ROLE ${LEGACY_MOCK_ROLE} WITH LOGIN PASSWORD '${LEGACY_MOCK_PASSWORD}';
          END IF;
        END
        $$;
      `);

      await migrationClient.raw(`
        DO $$
        BEGIN
          EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${LEGACY_MOCK_ROLE}', current_database());
        END
        $$;
      `);

      // 2. Establish connection as legacy role (simulating older Vercel preview deployment)
      const legacyUrl = new URL(targetUrl);
      legacyUrl.username = LEGACY_MOCK_ROLE;
      legacyUrl.password = LEGACY_MOCK_PASSWORD;

      const legacyClient: Knex = knex({
        client: 'pg',
        connection: {
          connectionString: legacyUrl.toString(),
          ssl: isNeon ? { rejectUnauthorized: false } : false
        },
        pool: { min: 1, max: 1, acquireTimeoutMillis: 10000 }
      });

      const legacyWho = await legacyClient.raw('SELECT current_user;');
      assert.equal(legacyWho.rows?.[0]?.current_user, LEGACY_MOCK_ROLE, 'Legacy preview role connected');
      await legacyClient.destroy();

      // 3. Containment Sequence: Terminate active backends
      await migrationClient.raw(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE usename = :role AND pid <> pg_backend_pid();
      `, { role: LEGACY_MOCK_ROLE });

      // 4. Containment Sequence: Invalidate login for legacy role
      await migrationClient.raw(`ALTER ROLE ${LEGACY_MOCK_ROLE} NOLOGIN;`);

      // 5. Prove older deployment cannot connect with invalidated credential
      let rejected = false;
      const invalidClient: Knex = knex({
        client: 'pg',
        connection: {
          connectionString: legacyUrl.toString(),
          ssl: isNeon ? { rejectUnauthorized: false } : false
        },
        pool: { min: 1, max: 1, acquireTimeoutMillis: 5000 }
      });

      try {
        await invalidClient.raw('SELECT 1;');
      } catch (err: any) {
        rejected = true;
        assert.ok(
          err.code === '28000' || String(err.message).includes('not permitted to log in') || String(err.message).includes('authentication failed'),
          `Expected login rejection error, got code=${err.code} msg=${err.message}`
        );
      } finally {
        await invalidClient.destroy().catch(() => {});
      }

      assert.equal(rejected, true, 'Legacy role with NOLOGIN must be rejected upon connection attempt');

      // 6. Clean up mock legacy role
      await migrationClient.raw(`
        DO $$
        BEGIN
          EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM ${LEGACY_MOCK_ROLE}', current_database());
          DROP ROLE IF EXISTS ${LEGACY_MOCK_ROLE};
        END
        $$;
      `);
    });

    // ── 6. Privileged session elevation with valid token ───────────────────────
    await runStep('10. Privileged migration path: transaction with token succeeds', async () => {
      const privId = `priv_item_${Date.now()}`;
      await migrationClient.transaction(async (trx) => {
        await trx.raw('SET LOCAL default_transaction_read_only = off;');
        await trx.raw("SELECT set_config('aira.privileged_token', :token, true);", { token: bypassToken });
        await trx(TEST_TABLE).insert({
          id: privId,
          title: 'Privileged Migration Item',
          status: 'migrated'
        });
      });

      const row = await migrationClient(TEST_TABLE).where({ id: privId }).first();
      assert.ok(row, 'Privileged transaction must successfully persist record');
      assert.equal(row.title, 'Privileged Migration Item');
    });

    // ── 7. Barrier deactivation with migrationClient ───────────────────────────
    await runStep('11. Barrier deactivation: cleanly drops triggers & resets read-only', async () => {
      const deactRes = await deactivateStagingMaintenance(migrationClient, {
        operator: 'rajpunkeshwarrajgautam-boop',
        bypassToken,
        allowRehearsalBranch: true
      });

      assert.equal(deactRes.active, false);
      assert.equal(deactRes.triggersRemoved, true);

      const status = await getStagingMaintenanceStatus(migrationClient);
      assert.equal(status.isActive, false);
      assert.equal(status.defaultReadOnly, false);
    });

    // ── 8. Post-maintenance write restoration with runtimeClient ───────────────
    await runStep('12. Post-maintenance: normal runtime writes resume cleanly', async () => {
      const postItemId = `post_maint_${Date.now()}`;
      await runtimeClient(TEST_TABLE).insert({
        id: postItemId,
        title: 'Post-maintenance normal runtime write',
        status: 'active'
      });

      const row = await runtimeClient(TEST_TABLE).where({ id: postItemId }).first();
      assert.ok(row, 'Post-maintenance write must succeed for runtime role without elevation');

      await runtimeClient(TEST_TABLE).where({ id: postItemId }).delete();
      const checkPost = await runtimeClient(TEST_TABLE).where({ id: postItemId }).first();
      assert.equal(checkPost, undefined, 'Post-maintenance row was cleanly deleted');

      await runtimeClient(TEST_TABLE).del();
      const countRes = await runtimeClient(TEST_TABLE).count('* as count');
      assert.equal(Number(countRes[0].count), 0, 'Runtime DELETE on all rows must succeed post-maintenance');
    });

  } finally {
    // Teardown runtime client and clean up disposable role
    await runtimeClient.destroy().catch(() => {});
    await migrationClient.raw(`DROP TABLE IF EXISTS ${TEST_TABLE};`).catch(() => {});
    await migrationClient.raw(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
          REVOKE ALL ON SCHEMA public FROM ${RUNTIME_ROLE};
          REVOKE CONNECT ON DATABASE ${meta.db} FROM ${RUNTIME_ROLE};
          DROP ROLE ${RUNTIME_ROLE};
        END IF;
      END
      $$;
    `).catch(() => {});
    await migrationClient.destroy().catch(() => {});
  }

  console.log(`\n================================================================================`);
  console.log(`  ✓ ALL ${passed} REAL RUNTIME-ROLE POSTGRESQL INTEGRATION ASSERTIONS PASSED!    `);
  console.log('================================================================================\n');
}

main().catch(async (err) => {
  console.error('[FATAL_INTEGRATION_ERROR]', err);
  await migrationClient.destroy().catch(() => {});
  process.exit(1);
});
