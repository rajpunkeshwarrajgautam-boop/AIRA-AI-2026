/**
 * AIRA AI 2026 — Permanent Staging Maintenance Barrier Control CLI
 * 
 * Provides automated and interactive control over the staging maintenance barrier:
 * - Activate: Sets database-level read-only default, sentinel table, and table-level write triggers.
 * - Deactivate: Clears maintenance mode, resets read-only, and safely restores normal traffic.
 * - Status: Inspects sentinel state, active triggers, and database settings.
 * - Verify: Actively proves that unprivileged writes are rejected while privileged operations work.
 */

import fs from 'node:fs';
import knex from 'knex';
import {
  classifyDatabaseUrl,
  PRODUCTION_NEON_PROJECT_ID,
  STAGING_NEON_PROJECT_ID
} from '../packages/db/src/security/database-isolation-guard.js';
import {
  activateStagingMaintenance,
  deactivateStagingMaintenance,
  getStagingMaintenanceStatus,
  verifyStagingWriteRestriction,
  verifyStagingPostMaintenanceRestoration,
  generateBypassToken
} from '../packages/db/src/security/staging-maintenance-barrier.js';

async function main() {
  const args = process.argv.slice(2);

  // Reject database connection strings in command-line arguments to prevent credential exposure
  for (const arg of args) {
    if (arg.startsWith('postgres://') || arg.startsWith('postgresql://') || (arg.includes('://') && arg.includes('@'))) {
      console.error('[SECURITY FATAL] Supplying database connection strings via command-line arguments is strictly prohibited to prevent credential exposure in process listings. Pass via STAGING_DB_URL or DATABASE_URL environment variables.');
      process.exit(1);
    }
  }

  const action = args[0] || '--status';
  const dbUrl = process.env.STAGING_DB_URL || process.env.DATABASE_URL;

  if (!dbUrl) {
    console.error('Usage: STAGING_DB_URL=<url> npx tsx scripts/staging-maintenance-control.ts [--activate|--deactivate|--status|--verify-barrier|--verify-restoration]');
    process.exit(1);
  }

  const classification = classifyDatabaseUrl(dbUrl);
  if (classification.isProduction) {
    console.error(`[SECURITY FATAL] Direct execution against Production database (${PRODUCTION_NEON_PROJECT_ID}) is strictly prohibited.`);
    process.exit(1);
  }

  const client = knex({
    client: 'pg',
    connection: { connectionString: dbUrl, ssl: classification.isLocalOrCiTest ? false : true }
  });

  try {
    if (action === '--activate') {
      const operator = process.env.AIRA_MAINTENANCE_OPERATOR || 'rajpunkeshwarrajgautam-boop';
      const reason = process.env.AIRA_MAINTENANCE_REASON || 'PR #96 staging release cutover';
      const bypassToken = process.env.AIRA_MAINTENANCE_BYPASS_TOKEN || generateBypassToken();

      console.log(`[MAINTENANCE_CONTROL] Activating staging maintenance barrier...`);
      const res = await activateStagingMaintenance(client, { operator, reason, bypassToken });
      console.log(`✓ Staging maintenance barrier ACTIVATED.`);
      console.log(`  Operator: ${res.operator}`);
      console.log(`  Activated At: ${res.activatedAt}`);
      console.log(`  Guarded Tables: ${res.guardedTablesCount}`);
      console.log(`  Read-Only Default Set: ${res.readOnlySet}`);
      console.log(`  Details: ${res.details}`);
      console.log(`\n  [SECURITY] Bypass token active in database sentinel.`);
      console.log(`  [SECURITY] Token is held in environment variable AIRA_MAINTENANCE_BYPASS_TOKEN.`);
      console.log(`  [SECURITY] Never logged to console, CI logs, or persistent reports.`);
      if (!process.env.AIRA_MAINTENANCE_BYPASS_TOKEN && res.bypassToken) {
        try {
          fs.writeFileSync('.aira-maintenance-token.local', res.bypassToken, { mode: 0o600 });
          console.log(`  [SECURITY] Generated token saved to gitignored file .aira-maintenance-token.local (mode 0600).`);
        } catch {
          // ignore
        }
      }
      console.log('');
      process.exit(0);
    }

    if (action === '--deactivate') {
      const operator = process.env.AIRA_MAINTENANCE_OPERATOR || 'rajpunkeshwarrajgautam-boop';
      const bypassToken = process.env.AIRA_MAINTENANCE_BYPASS_TOKEN || (
        fs.existsSync('.aira-maintenance-token.local') ? fs.readFileSync('.aira-maintenance-token.local', 'utf8').trim() : undefined
      );

      let runtimeClient: Knex | undefined = undefined;
      const runtimeUrl = process.env.STAGING_RUNTIME_DB_URL || process.env.RUNTIME_DB_URL;
      if (runtimeUrl) {
        runtimeClient = knex({
          client: 'pg',
          connection: { connectionString: runtimeUrl, ssl: classification.isLocalOrCiTest ? false : true }
        });
      }

      console.log(`[MAINTENANCE_CONTROL] Deactivating staging maintenance barrier...`);
      try {
        const res = await deactivateStagingMaintenance(client, { operator, bypassToken, runtimeClient });
        console.log(`✓ Staging maintenance barrier DEACTIVATED.`);
        console.log(`  Operator: ${res.operator}`);
        console.log(`  Deactivated At: ${res.deactivatedAt}`);
        console.log(`  Read-Only Reset: ${res.readOnlyReset}`);
        console.log(`  Triggers Removed: ${res.triggersRemoved}`);
        console.log(`  Writes Restored: ${res.writesRestored}`);
        console.log(`  Details: ${res.details}\n`);

        if (fs.existsSync('.aira-maintenance-token.local')) {
          try {
            fs.unlinkSync('.aira-maintenance-token.local');
            console.log(`  [SECURITY] Local maintenance bypass token file removed.`);
          } catch {
            // ignore
          }
        }
        process.exit(0);
      } finally {
        if (runtimeClient) await runtimeClient.destroy().catch(() => {});
      }
    }

    if (action === '--verify-restoration') {
      console.log(`[MAINTENANCE_CONTROL] Empirically verifying write restoration and absence of maintenance restrictions...`);
      let runtimeClient: Knex | undefined = undefined;
      const runtimeUrl = process.env.STAGING_RUNTIME_DB_URL || process.env.RUNTIME_DB_URL;
      if (runtimeUrl) {
        runtimeClient = knex({
          client: 'pg',
          connection: { connectionString: runtimeUrl, ssl: classification.isLocalOrCiTest ? false : true }
        });
      }
      try {
        const res = await verifyStagingPostMaintenanceRestoration(client, { runtimeClient });
        console.log(`✓ Database write restoration VERIFIED:`);
        console.log(`  Default Read-Only Reset: ${res.defaultReadOnlyReset}`);
        console.log(`  Triggers Removed: ${res.triggersRemoved}`);
        console.log(`  Sentinel Inactive: ${res.sentinelInactive}`);
        console.log(`  Transactional Probe Success: ${res.transactionalProbeSuccess}`);
        if (res.runtimeRoleProbeSuccess !== undefined) {
          console.log(`  Runtime Role Probe Success: ${res.runtimeRoleProbeSuccess}`);
        }
        console.log(`  Details: ${res.details}\n`);
        process.exit(0);
      } finally {
        if (runtimeClient) await runtimeClient.destroy().catch(() => {});
      }
    }

    if (action === '--verify-barrier') {
      const bypassToken = process.env.AIRA_MAINTENANCE_BYPASS_TOKEN || (
        fs.existsSync('.aira-maintenance-token.local') ? fs.readFileSync('.aira-maintenance-token.local', 'utf8').trim() : undefined
      );
      console.log(`[MAINTENANCE_CONTROL] Empirically verifying write restriction on target database...`);
      const res = await verifyStagingWriteRestriction(client, { bypassToken });
      console.log(`Result: writesBlocked=${res.writesBlocked}, privilegedPathOperational=${res.privilegedPathOperational}`);
      console.log(`Details: ${res.details}`);
      if (!res.writesBlocked || !res.privilegedPathOperational) {
        process.exit(1);
      }
      process.exit(0);
    }

    // Default: --status
    const status = await getStagingMaintenanceStatus(client);
    console.log(`\n================================================================================`);
    console.log(`   AIRA AI 2026 — PERMANENT STAGING MAINTENANCE BARRIER STATUS                  `);
    console.log(`================================================================================`);
    console.log(`Active:               ${status.isActive ? 'YES (MAINTENANCE IN EFFECT)' : 'NO (NORMAL TRAFFIC)'}`);
    console.log(`Activated By:         ${status.activatedBy || 'N/A'}`);
    console.log(`Activated At:         ${status.activatedAt || 'N/A'}`);
    console.log(`Reason:               ${status.reason || 'N/A'}`);
    console.log(`Default Read-Only:    ${status.defaultReadOnly ? 'ON' : 'OFF'}`);
    console.log(`Guarded Tables:       ${status.tablesGuarded.length} (${status.tablesGuarded.slice(0, 10).join(', ')}${status.tablesGuarded.length > 10 ? '...' : ''})`);
    console.log(`Target Database:      ${status.databaseName || 'N/A'}`);
    console.log(`Neon Project ID:      ${status.neonProjectId || 'N/A'}`);
    console.log(`Neon Branch ID:       ${status.neonBranchId || 'N/A'}`);
    console.log(`================================================================================\n`);
    process.exit(0);
  } finally {
    await client.destroy();
  }
}

main().catch(err => {
  console.error('[MAINTENANCE_CONTROL_ERROR]', err.message);
  process.exit(1);
});
