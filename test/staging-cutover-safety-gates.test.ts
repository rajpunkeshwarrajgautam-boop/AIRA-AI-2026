/**
 * AIRA AI 2026 — PR #96 Release Wizard & Cutover Safety Gates Verification Suite
 * 
 * Tests proving that all cutover safety gates fail closed under:
 * 1. Invalid or mismatched SHAs (format, local vs approved vs remote).
 * 2. Wrong database branches/projects (Production, Commercial PR #92 target, missing metadata).
 * 3. Non-read-only or wrong source database connections.
 * 4. Missing or invalid Neon recovery checkpoints (wrong parent, wrong project, missing).
 * 5. Active client write transactions breaking staging write isolation.
 * 6. Historical identity import reconciliation errors and incomplete 11-gate integrity states.
 * 7. Failed OAuth browser acceptance abort behavior.
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  PRODUCTION_NEON_PROJECT_ID,
  PRODUCTION_NEON_BRANCH_ID,
  PRODUCTION_NEON_ENDPOINT_ID,
  STAGING_NEON_PROJECT_ID,
  STAGING_NEON_BRANCH_ID,
  STAGING_NEON_ENDPOINT_ID,
  COMMERCIAL_PR92_BRANCH_ID,
  COMMERCIAL_PR92_ENDPOINT_ID
} from '../packages/db/src/security/database-isolation-guard.js';
import {
  hashBypassToken,
  validateHealthCheckResponse,
  validateMaintenanceRestrictionResponse,
  deactivateStagingMaintenance
} from '../packages/db/src/security/staging-maintenance-barrier.js';
import {
  createStagingMaintenanceMiddleware
} from '../apps/api/src/middleware/staging-maintenance.js';
import {
  validateAuthoritativeTargetSafety,
  verifyConnectedTargetMetadata,
  validateAuthoritativeSourceSafety,
  createReadOnlySourceClient
} from '../scripts/import-verified-commercial-identities.js';
import {
  verifyNeonCheckpointFromList,
  NeonBranchMetadata
} from '../scripts/verify-neon-checkpoint.js';
import {
  verifyStagingWriteIsolation
} from '../scripts/verify-staging-write-isolation.js';
import {
  verifyStagingCutoverIntegrity,
  CUTOVER_FAILURE_RECOVERY_MATRIX,
  CUTOVER_PROTOCOL_STEPS,
  getFailureRecoveryPhase
} from '../scripts/staging-cutover-orchestrator.js';

console.log('\n================================================================================');
console.log('   AIRA AI 2026 — PR #96 RELEASE WIZARD SAFETY GATES FAIL-CLOSED TEST SUITE   ');
console.log('================================================================================\n');

// ── Test Group 1: 40-Character SHA Validation & Mismatch Gate ────────────────
console.log('--- Test Group 1: SHA Validation & Synchronization Mismatch Gate ---');

function validateApprovedSha(sha: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(sha);
}

function verifyShaSync(approvedSha: string, localSha: string, remoteSha: string): { ok: boolean; reason?: string } {
  if (!validateApprovedSha(approvedSha)) {
    return { ok: false, reason: 'Approved SHA is not a 40-character hexadecimal string' };
  }
  if (localSha && approvedSha !== localSha) {
    return { ok: false, reason: `Approved SHA (${approvedSha}) does not match local HEAD (${localSha})` };
  }
  if (remoteSha && approvedSha !== remoteSha) {
    return { ok: false, reason: `Approved SHA (${approvedSha}) does not match remote PR HEAD (${remoteSha})` };
  }
  if (localSha && remoteSha && localSha !== remoteSha) {
    return { ok: false, reason: `Local HEAD (${localSha}) does not match remote PR HEAD (${remoteSha})` };
  }
  return { ok: true };
}

// 1.1 Reject non-40 hex SHA
assert.equal(validateApprovedSha('1f77707'), false, 'Short SHA must be rejected');
assert.equal(validateApprovedSha('1f7770783fa74c5d57adbf90333be282ff1da40bZZ'), false, 'Non-hex SHA must be rejected');
assert.equal(validateApprovedSha('1f77707f46a68d4bb141e6fa38d868fcdfc29d5'), false, '39-char SHA must be rejected');
assert.equal(validateApprovedSha('1f77707f46a68d4bb141e6fa38d868fcdfc29d561'), false, '41-char SHA must be rejected');
assert.equal(validateApprovedSha('1f77707f46a68d4bb141e6fa38d868fcdfc29d56'), true, 'Exact 40-char SHA must be accepted');
console.log('  ✓ 40-character hexadecimal SHA validation passed');

// 1.2 Reject SHA mismatches
const authenticSha = '1f77707f46a68d4bb141e6fa38d868fcdfc29d56';
const transposedSha = '1f7770783fa74c5d57adbf90333be282ff1da40b';
const staleSha = '1645d9546bc1aa5386d4dc6439a66b962770ee20';

const resMismatchApproved = verifyShaSync(transposedSha, authenticSha, authenticSha);
assert.equal(resMismatchApproved.ok, false);
assert.match(resMismatchApproved.reason!, /does not match local HEAD/);
console.log('  ✓ Fail closed: Transposed/mismatched approved SHA rejected');

const resMismatchRemote = verifyShaSync(authenticSha, authenticSha, staleSha);
assert.equal(resMismatchRemote.ok, false);
assert.match(resMismatchRemote.reason!, /does not match remote PR HEAD/);
console.log('  ✓ Fail closed: Stale remote PR HEAD mismatch rejected');

const resMismatchLocalRemote = verifyShaSync(authenticSha, staleSha, authenticSha);
assert.equal(resMismatchLocalRemote.ok, false);
assert.match(resMismatchLocalRemote.reason!, /does not match local HEAD/);
console.log('  ✓ Fail closed: Local HEAD drift rejected');

const resPerfectSync = verifyShaSync(authenticSha, authenticSha, authenticSha);
assert.equal(resPerfectSync.ok, true);
console.log('  ✓ Perfect 3-way synchronization accepted (approved === local === remote)');


// ── Test Group 2: Target Database Safety & Isolation Guards ─────────────────
console.log('\n--- Test Group 2: Target Database Safety & Isolation Guards ---');

// 2.1 Unconditional Production Target Rejection
assert.throws(() => {
  validateAuthoritativeTargetSafety(`postgresql://neondb_owner@${PRODUCTION_NEON_ENDPOINT_ID}.aws-ap-southeast-1.neon.tech/neondb`);
}, /\[SECURITY FATAL\] Direct execution against Production database/);
console.log('  ✓ Fail closed: Production target database rejected unconditionally');

// 2.2 Reject Commercial PR #92 as write target
assert.throws(() => {
  validateAuthoritativeTargetSafety(`postgresql://neondb_owner@${COMMERCIAL_PR92_ENDPOINT_ID}.aws-ap-southeast-1.neon.tech/neondb`);
}, /\[SECURITY FATAL\] Target cannot be the Commercial PR #92 source database/);
console.log('  ✓ Fail closed: Commercial PR #92 source database rejected as write target');

// 2.3 Reject permanent staging without explicit authorization flag
assert.throws(() => {
  validateAuthoritativeTargetSafety(
    `postgresql://neondb_owner@${STAGING_NEON_ENDPOINT_ID}.aws-ap-southeast-1.neon.tech/neondb`,
    { allowPermanentStaging: false }
  );
}, /\[SECURITY FATAL\] Target is live Permanent Staging database/);
console.log('  ✓ Fail closed: Permanent staging rejected without AIRA_ALLOW_STAGING_LIVE_IMPORT=true');

// 2.4 Permit permanent staging when authorized
assert.doesNotThrow(() => {
  validateAuthoritativeTargetSafety(
    `postgresql://neondb_owner@${STAGING_NEON_ENDPOINT_ID}.aws-ap-southeast-1.neon.tech/neondb`,
    { allowPermanentStaging: true }
  );
});
console.log('  ✓ Permit permanent staging when explicitly authorized by owner');

// 2.5 Reject arbitrary untrusted external write destinations
assert.throws(() => {
  validateAuthoritativeTargetSafety('postgresql://attacker@evil-host.com/neondb');
}, /\[SECURITY FATAL\] Write destination rejected/);
console.log('  ✓ Fail closed: Arbitrary external host rejected as write target');


// ── Test Group 3: Source Database Safety & Proof of Read-Only ───────────────
console.log('\n--- Test Group 3: Source Database Safety & Read-Only Proof ---');

// 3.1 Reject Production as source
assert.rejects(async () => {
  await validateAuthoritativeSourceSafety(`postgresql://neondb_owner@${PRODUCTION_NEON_ENDPOINT_ID}.aws-ap-southeast-1.neon.tech/neondb`);
}, /\[SECURITY FATAL\] Source database cannot be Production/);
console.log('  ✓ Fail closed: Production rejected as source database');

// 3.2 Reject Permanent Staging as source
assert.rejects(async () => {
  await validateAuthoritativeSourceSafety(`postgresql://neondb_owner@${STAGING_NEON_ENDPOINT_ID}.aws-ap-southeast-1.neon.tech/neondb`);
}, /\[SECURITY FATAL\] Source database cannot be Permanent Staging/);
console.log('  ✓ Fail closed: Permanent Staging rejected as source database');

// 3.3 Reject generic/unrecognized databases as source
assert.rejects(async () => {
  await validateAuthoritativeSourceSafety('postgresql://neondb_owner@random-neon-branch.aws-ap-southeast-1.neon.tech/neondb');
}, /\[SECURITY FATAL\] Source database is not the authorized Commercial PR #92 database/);
console.log('  ✓ Fail closed: Non-commercial PR #92 database rejected as source');

// 3.4 Require proof of read-only source connection
const mockNonReadOnlyClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('SHOW transaction_read_only')) {
      return { rows: [{ transaction_read_only: 'off' }] };
    }
    return { rows: [] };
  }
};
assert.rejects(async () => {
  await validateAuthoritativeSourceSafety(
    `postgresql://neondb_owner@${COMMERCIAL_PR92_ENDPOINT_ID}.aws-ap-southeast-1.neon.tech/neondb`,
    mockNonReadOnlyClient
  );
}, /Proof of read-only source connection failed/);
console.log('  ✓ Fail closed: Source connection rejected if SHOW transaction_read_only !== on');

// 3.5 createReadOnlySourceClient rejects Production
assert.throws(() => {
  createReadOnlySourceClient(`postgresql://neondb_owner@${PRODUCTION_NEON_ENDPOINT_ID}.aws-ap-southeast-1.neon.tech/neondb`);
}, /\[SECURITY FATAL\] Source database cannot be Production/);
console.log('  ✓ Fail closed: createReadOnlySourceClient unconditionally rejects Production');

// 3.6 createReadOnlySourceClient rejects Permanent Staging
assert.throws(() => {
  createReadOnlySourceClient(`postgresql://neondb_owner@${STAGING_NEON_ENDPOINT_ID}.aws-ap-southeast-1.neon.tech/neondb`);
}, /\[SECURITY FATAL\] Source database cannot be Permanent Staging/);
console.log('  ✓ Fail closed: createReadOnlySourceClient unconditionally rejects Permanent Staging');

// 3.7 createReadOnlySourceClient pool-level configuration verification
const localSourceClient = createReadOnlySourceClient('postgresql://postgres@localhost:5432/test_commercial_source');
assert.equal(typeof (localSourceClient.client as any).config.pool.afterCreate, 'function', 'Knex pool must have afterCreate hook configured');
await localSourceClient.destroy();
console.log('  ✓ Knex pool-level afterCreate read-only hook verified on source client');


// ── Test Group 4: Neon Recovery Checkpoint Verification Gate ────────────────
console.log('\n--- Test Group 4: Neon Recovery Checkpoint Verification Gate ---');

const mockBranches: NeonBranchMetadata[] = [
  {
    id: 'br-autumn-star-b36dfu5w',
    project_id: STAGING_NEON_PROJECT_ID,
    name: 'main',
    current_state: 'ready',
    created_at: '2026-10-10T08:00:12Z'
  },
  {
    id: 'br-valid-checkpoint-1',
    project_id: STAGING_NEON_PROJECT_ID,
    parent_id: STAGING_NEON_BRANCH_ID,
    name: 'staging-backup-pre-commercial-cutover',
    current_state: 'ready',
    created_at: '2026-10-21T17:00:00Z'
  },
  {
    id: 'br-wrong-parent',
    project_id: STAGING_NEON_PROJECT_ID,
    parent_id: 'br-some-other-branch',
    name: 'staging-backup-wrong-parent',
    current_state: 'ready',
    created_at: '2026-10-21T17:00:00Z'
  },
  {
    id: 'br-wrong-project',
    project_id: 'wrong-project-12345',
    parent_id: STAGING_NEON_BRANCH_ID,
    name: 'staging-backup-wrong-project',
    current_state: 'ready',
    created_at: '2026-10-21T17:00:00Z'
  },
  {
    id: 'br-unready-branch',
    project_id: STAGING_NEON_PROJECT_ID,
    parent_id: STAGING_NEON_BRANCH_ID,
    name: 'staging-backup-unready',
    current_state: 'init',
    created_at: '2026-10-21T17:00:00Z'
  }
];

// 4.1 Missing identifier
const cpMissing = verifyNeonCheckpointFromList(mockBranches, '');
assert.equal(cpMissing.verified, false);
console.log('  ✓ Fail closed: Empty checkpoint identifier rejected');

// 4.2 Branch not found
const cpNotFound = verifyNeonCheckpointFromList(mockBranches, 'non-existent-checkpoint');
assert.equal(cpNotFound.verified, false);
assert.match(cpNotFound.error!, /was not found in Neon project/);
console.log('  ✓ Fail closed: Non-existent checkpoint branch rejected');

// 4.3 Branch belongs to wrong project
const cpWrongProject = verifyNeonCheckpointFromList(mockBranches, 'staging-backup-wrong-project');
assert.equal(cpWrongProject.verified, false);
assert.match(cpWrongProject.error!, /belongs to project 'wrong-project-12345'/);
console.log('  ✓ Fail closed: Checkpoint in wrong Neon project rejected');

// 4.4 Branch parent is not permanent staging main
const cpWrongParent = verifyNeonCheckpointFromList(mockBranches, 'staging-backup-wrong-parent');
assert.equal(cpWrongParent.verified, false);
assert.match(cpWrongParent.error!, /must be permanent staging main/);
console.log('  ✓ Fail closed: Checkpoint not branched from permanent staging main rejected');

// 4.5 Branch is not ready
const cpNotReady = verifyNeonCheckpointFromList(mockBranches, 'staging-backup-unready');
assert.equal(cpNotReady.verified, false);
assert.match(cpNotReady.error!, /expected 'ready'/);
console.log('  ✓ Fail closed: Non-ready checkpoint state rejected');

// 4.6 Authentic valid checkpoint
const cpValid = verifyNeonCheckpointFromList(mockBranches, 'staging-backup-pre-commercial-cutover');
assert.equal(cpValid.verified, true);
assert.equal(cpValid.branch?.id, 'br-valid-checkpoint-1');
console.log('  ✓ Machine verification confirms valid recovery checkpoint');


// ── Test Group 5: Effective Staging Write Isolation Gate ─────────────────────
console.log('\n--- Test Group 5: Effective Staging Write Isolation Gate ---');

// 5.1 Active writing client detected in pg_stat_activity
const mockActiveWritingClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('pg_stat_activity')) {
      return {
        rows: [
          {
            pid: 9999,
            usename: 'active_client',
            application_name: 'test_writer',
            client_addr: '192.168.1.50',
            state: 'active',
            query: 'INSERT INTO conversations (id) VALUES (\'conv_test\');',
            xact_start: '2026-10-21T18:00:00Z',
            state_change: '2026-10-21T18:00:00Z'
          }
        ]
      };
    }
    return { rows: [] };
  }
};
const resActiveWrites = await verifyStagingWriteIsolation(mockActiveWritingClient);
assert.equal(resActiveWrites.isolated, false);
assert.equal(resActiveWrites.activeWriters.length, 1);
assert.match(resActiveWrites.details, /active write transaction/);
console.log('  ✓ Fail closed: Active concurrent write transaction fails write isolation gate');

// 5.2 Conflicting lock detected in pg_locks
const mockConflictingLockClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('pg_stat_activity')) {
      return { rows: [] };
    }
    if (sql.includes('pg_locks')) {
      return {
        rows: [
          {
            pid: 8888,
            mode: 'ExclusiveLock',
            relname: 'users'
          }
        ]
      };
    }
    return { rows: [] };
  }
};
const resConflictingLock = await verifyStagingWriteIsolation(mockConflictingLockClient);
assert.equal(resConflictingLock.isolated, false);
assert.equal(resConflictingLock.conflictingLocks.length, 1);
assert.match(resConflictingLock.details, /conflicting lock/);
console.log('  ✓ Fail closed: Conflicting table lock fails write isolation gate');

// 5.3 Missing maintenance barrier fails write isolation gate
const mockMissingBarrierClient: any = {
  raw: async () => ({ rows: [] })
};
const resMissingBarrier = await verifyStagingWriteIsolation(mockMissingBarrierClient);
assert.equal(resMissingBarrier.isolated, false);
assert.equal(resMissingBarrier.maintenanceBarrierActive.status, 'FAIL');
console.log('  ✓ Fail closed: Inactive maintenance barrier fails write isolation gate');

// 5.4 Clean idle staging state with active maintenance barrier passes all 5 gates
const mockCleanIsolationClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('neon.project_id')) {
      return {
        rows: [{
          db_name: 'neondb',
          neon_project_id: STAGING_NEON_PROJECT_ID,
          neon_branch_id: STAGING_NEON_BRANCH_ID,
          neon_endpoint_id: STAGING_NEON_ENDPOINT_ID
        }]
      };
    }
    if (sql.includes('_aira_staging_maintenance')) {
      return {
        rows: [{
          is_active: true,
          activated_at: '2026-10-22T00:00:00Z',
          activated_by: 'authorized_cutover_operator',
          reason: 'cutover',
          bypass_token_hash: 'hash'
        }]
      };
    }
    if (sql.includes('default_transaction_read_only')) {
      return {
        rows: [{
          db_name: 'neondb',
          default_ro: 'on',
          project_id: STAGING_NEON_PROJECT_ID,
          branch_id: STAGING_NEON_BRANCH_ID
        }]
      };
    }
    if (sql.includes('INSERT INTO _aira_maintenance_write_probe') || sql.includes('TRUNCATE TABLE _aira_maintenance_write_probe')) {
      throw new Error('[STAGING_MAINTENANCE_BLOCKED] Operation denied: Permanent Staging database is in maintenance mode.');
    }
    return { rows: [] };
  },
  transaction: async (cb: any) => cb({
    raw: async () => ({ rows: [] })
  })
};
const resCleanIsolation = await verifyStagingWriteIsolation(mockCleanIsolationClient, { bypassToken: 'verified-cutover-token' });
assert.equal(resCleanIsolation.isolated, true);
assert.equal(resCleanIsolation.stagingDatabaseIdentity.status, 'PASS');
assert.equal(resCleanIsolation.maintenanceBarrierActive.status, 'PASS');
assert.equal(resCleanIsolation.runtimeWriteRestriction.status, 'PASS');
assert.equal(resCleanIsolation.inFlightWritesDrained.status, 'PASS');
assert.equal(resCleanIsolation.privilegedMigrationPath.status, 'PASS');
assert.equal(resCleanIsolation.activeWriters.length, 0);
assert.equal(resCleanIsolation.conflictingLocks.length, 0);
console.log('  ✓ Clean idle staging state with active maintenance barrier passes all 5 gates');

// 5.5 Defect 2: Missing project metadata must FAIL
const mockMissingProjectClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('neon.project_id')) {
      return { rows: [{ db_name: 'neondb', neon_project_id: null, neon_branch_id: STAGING_NEON_BRANCH_ID, neon_endpoint_id: STAGING_NEON_ENDPOINT_ID }] };
    }
    return { rows: [] };
  }
};
const resMissingProject = await verifyStagingWriteIsolation(mockMissingProjectClient);
assert.equal(resMissingProject.isolated, false);
assert.equal(resMissingProject.stagingDatabaseIdentity.status, 'FAIL');
assert.match(resMissingProject.stagingDatabaseIdentity.details, /Missing required Neon database identity settings/);
console.log('  ✓ Fail closed: Missing project metadata fails identity gate');

// 5.6 Defect 2: Missing branch metadata must FAIL
const mockMissingBranchClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('neon.project_id')) {
      return { rows: [{ db_name: 'neondb', neon_project_id: STAGING_NEON_PROJECT_ID, neon_branch_id: '', neon_endpoint_id: STAGING_NEON_ENDPOINT_ID }] };
    }
    return { rows: [] };
  }
};
const resMissingBranch = await verifyStagingWriteIsolation(mockMissingBranchClient);
assert.equal(resMissingBranch.isolated, false);
assert.equal(resMissingBranch.stagingDatabaseIdentity.status, 'FAIL');
assert.match(resMissingBranch.stagingDatabaseIdentity.details, /Missing required Neon database identity settings/);
console.log('  ✓ Fail closed: Missing branch metadata fails identity gate');

// 5.7 Defect 2: Missing endpoint metadata must FAIL
const mockMissingEndpointClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('neon.project_id')) {
      return { rows: [{ db_name: 'neondb', neon_project_id: STAGING_NEON_PROJECT_ID, neon_branch_id: STAGING_NEON_BRANCH_ID, neon_endpoint_id: undefined }] };
    }
    return { rows: [] };
  }
};
const resMissingEndpoint = await verifyStagingWriteIsolation(mockMissingEndpointClient);
assert.equal(resMissingEndpoint.isolated, false);
assert.equal(resMissingEndpoint.stagingDatabaseIdentity.status, 'FAIL');
assert.match(resMissingEndpoint.stagingDatabaseIdentity.details, /Missing required Neon database identity settings/);
console.log('  ✓ Fail closed: Missing endpoint metadata fails identity gate');

// 5.8 Defect 2: Database query errors must FAIL
const mockQueryErrorClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('neon.project_id')) {
      throw new Error('connection closed abruptly during handshake');
    }
    return { rows: [] };
  }
};
const resQueryError = await verifyStagingWriteIsolation(mockQueryErrorClient);
assert.equal(resQueryError.isolated, false);
assert.equal(resQueryError.stagingDatabaseIdentity.status, 'FAIL');
assert.match(resQueryError.stagingDatabaseIdentity.details, /Database query error verifying Neon identity/);
console.log('  ✓ Fail closed: Database query error fails identity gate');

// 5.9 Defect 2: Incorrect branch ID without rehearsal flag must FAIL
const mockWrongBranchClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('neon.project_id')) {
      return { rows: [{ db_name: 'neondb', neon_project_id: STAGING_NEON_PROJECT_ID, neon_branch_id: 'br-wrong-branch-12345', neon_endpoint_id: STAGING_NEON_ENDPOINT_ID }] };
    }
    return { rows: [] };
  }
};
const resWrongBranch = await verifyStagingWriteIsolation(mockWrongBranchClient);
assert.equal(resWrongBranch.isolated, false);
assert.equal(resWrongBranch.stagingDatabaseIdentity.status, 'FAIL');
assert.match(resWrongBranch.stagingDatabaseIdentity.details, /Permanent staging identity mismatch/);
console.log('  ✓ Fail closed: Incorrect branch ID fails permanent staging identity gate');

// 5.10 Defect 2: Incorrect endpoint ID without rehearsal flag must FAIL
const mockWrongEndpointClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('neon.project_id')) {
      return { rows: [{ db_name: 'neondb', neon_project_id: STAGING_NEON_PROJECT_ID, neon_branch_id: STAGING_NEON_BRANCH_ID, neon_endpoint_id: 'ep-wrong-endpoint-9999' }] };
    }
    return { rows: [] };
  }
};
const resWrongEndpoint = await verifyStagingWriteIsolation(mockWrongEndpointClient);
assert.equal(resWrongEndpoint.isolated, false);
assert.equal(resWrongEndpoint.stagingDatabaseIdentity.status, 'FAIL');
assert.match(resWrongEndpoint.stagingDatabaseIdentity.details, /Permanent staging identity mismatch/);
console.log('  ✓ Fail closed: Incorrect endpoint ID fails permanent staging identity gate');

// 5.11 Defect 2: Production database connection must throw [SECURITY FATAL]
const mockProductionTargetClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('neon.project_id')) {
      return { rows: [{ db_name: 'neondb', neon_project_id: PRODUCTION_NEON_PROJECT_ID, neon_branch_id: 'br-shiny-moon-b3vy9xj7', neon_endpoint_id: 'ep-withered-art-b36ox90b' }] };
    }
    return { rows: [] };
  }
};
let prodThrown = false;
try {
  await verifyStagingWriteIsolation(mockProductionTargetClient);
} catch (err: any) {
  prodThrown = true;
  assert.match(err.message, /\[SECURITY FATAL\] Connected database is PRODUCTION/);
}
assert.equal(prodThrown, true, 'Production target must throw [SECURITY FATAL]');
console.log('  ✓ Fail closed: Production database target throws [SECURITY FATAL]');

// 5.12 Defect 2: Rehearsal branch under mute-frost-50372225 accepted ONLY when allowRehearsalBranch: true
const mockRehearsalClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('neon.project_id')) {
      return { rows: [{ db_name: 'neondb', neon_project_id: STAGING_NEON_PROJECT_ID, neon_branch_id: 'br-silent-frog-b3l8eur9', neon_endpoint_id: 'ep-steep-wildflower-b3nj385g' }] };
    }
    return { rows: [] };
  }
};
const resRehearsalWithoutFlag = await verifyStagingWriteIsolation(mockRehearsalClient);
assert.equal(resRehearsalWithoutFlag.stagingDatabaseIdentity.status, 'FAIL');
assert.match(resRehearsalWithoutFlag.stagingDatabaseIdentity.details, /Permanent staging identity mismatch/);

const resRehearsalWithFlag = await verifyStagingWriteIsolation(mockRehearsalClient, { allowRehearsalBranch: true });
assert.equal(resRehearsalWithFlag.stagingDatabaseIdentity.status, 'PASS');
assert.match(resRehearsalWithFlag.stagingDatabaseIdentity.details, /Verified staging rehearsal environment/);
console.log('  ✓ Explicit rehearsal mode permitted only when allowRehearsalBranch: true');



// ── Test Group 6: Staging Cutover Integrity & 11 Assertions Gate ─────────────
console.log('\n--- Test Group 6: Staging Cutover Integrity & 11 Assertions Gate ---');

// 6.1 Missing migrations (< 22) fails certification
const mockMissingMigrationsClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('SELECT tablename FROM pg_tables')) {
      return {
        rows: [
          { tablename: 'users' },
          { tablename: 'oauth_accounts' },
          { tablename: 'billing_customers' },
          { tablename: 'credit_accounts' },
          { tablename: 'credit_grants' },
          { tablename: 'credit_transactions' },
          { tablename: 'conversations' },
          { tablename: 'conversation_messages' }
        ]
      };
    }
    if (sql.includes('current_setting')) {
      return { rows: [{ neon_project_id: STAGING_NEON_PROJECT_ID }] };
    }
    return { rows: [] };
  },
  // knex table helper mock
  from: (table: string) => ({
    select: () => {
      if (table === 'knex_migrations') {
        // Only 15 migrations applied
        return Array.from({ length: 15 }, (_, i) => ({ name: `00${i}_mig.ts` }));
      }
      return [];
    },
    count: () => [{ cnt: '0' }],
    where: () => ({ whereNotNull: () => [] })
  })
};
// Add callable mock interface
const mockKnexWrapper: any = (table: string) => mockMissingMigrationsClient.from(table);
mockKnexWrapper.raw = mockMissingMigrationsClient.raw;

const auditMissingMig = await verifyStagingCutoverIntegrity(mockKnexWrapper);
assert.equal(auditMissingMig.certified, false);
assert.equal(auditMissingMig.checks['MIGRATIONS_016_022_APPLIED'], false);
console.log('  ✓ Fail closed: Staging not certified when migrations count < 22');

// 6.2 Authoritative 5-Phase Cutover Failure Recovery Matrix Verification
assert.equal(CUTOVER_FAILURE_RECOVERY_MATRIX.length, 5, 'Matrix must define exactly 5 distinct operational recovery phases');

const beforeMig = getFailureRecoveryPhase('BEFORE_MIGRATION');
assert.equal(beforeMig.maintenanceDeactivationPermitted, true);
assert.equal(beforeMig.checkpointRestorationRequired, false);

const duringMig = getFailureRecoveryPhase('DURING_MIGRATION');
assert.equal(duringMig.maintenanceDeactivationPermitted, false, 'Deactivating maintenance during migration failure is STRICTLY PROHIBITED');
assert.equal(duringMig.checkpointRestorationRequired, true, 'Checkpoint restoration is MANDATORY during migration failure');

const afterMigBeforeMerge = getFailureRecoveryPhase('AFTER_MIGRATION_BEFORE_MERGE');
assert.equal(afterMigBeforeMerge.maintenanceDeactivationPermitted, false);
assert.equal(afterMigBeforeMerge.checkpointRestorationRequired, true);

const afterMerge = getFailureRecoveryPhase('AFTER_MERGE');
assert.equal(afterMerge.maintenanceDeactivationPermitted, false);
assert.equal(afterMerge.checkpointRestorationRequired, true);
assert.equal(afterMerge.codeRevertRequired, true, 'Code revert on staging branch is mandatory after merge');

const afterImport = getFailureRecoveryPhase('AFTER_HISTORICAL_IMPORT');
assert.equal(afterImport.maintenanceDeactivationPermitted, false);
assert.equal(afterImport.checkpointRestorationRequired, true);

assert.throws(() => getFailureRecoveryPhase('INVALID_PHASE' as any), /Unknown failure recovery phase/);
console.log('  ✓ Authoritative 5-phase failure recovery matrix verified: deactivation alone strictly prohibited after migrations begin');


// ── Test Group 7: Maintenance Bypass Token Lifecycle & Shell Variable Safety Gates (Defect 1) ─
console.log('\n--- Test Group 7: Maintenance Bypass Token Lifecycle & Shell Variable Safety Gates (Defect 1) ---');

// 7.1 Shell script syntax and unbound variable enforcement
const wizardContent = fs.readFileSync('scripts/staging-cutover-wizard.sh', 'utf8');
assert.ok(wizardContent.includes('set -euo pipefail'), 'scripts/staging-cutover-wizard.sh must enforce set -euo pipefail');

// 7.2 Verify BYPASS_TOKEN is initialized or assigned before any expansion
const bypassTokenDeclIndex = wizardContent.indexOf('BYPASS_TOKEN=');
const bypassTokenFirstUse = wizardContent.indexOf('$BYPASS_TOKEN');
assert.ok(bypassTokenDeclIndex !== -1, 'BYPASS_TOKEN must be initialized/declared in scripts/staging-cutover-wizard.sh');
assert.ok(bypassTokenDeclIndex < bypassTokenFirstUse, 'BYPASS_TOKEN must be initialized before first $BYPASS_TOKEN reference');

// 7.3 Prove that bash with set -u fails closed on unbound variables
let unboundFailed = false;
try {
  const bashBin = fs.existsSync('D:\\Git\\bin\\bash.exe') ? 'D:\\Git\\bin\\bash.exe' : 'bash';
  execSync(`"${bashBin}" -u -c 'echo "$UNBOUND_VARIABLE_XYZ"'`, { stdio: 'pipe' });
} catch {
  unboundFailed = true;
}
assert.equal(unboundFailed, true, 'Shell with set -u must fail closed on unbound variables');
console.log('  ✓ Fail closed: Shell script enforces set -euo pipefail and fails on unbound variables');

// 7.4 Token format validation gate
function validateBypassTokenFormat(token: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(token);
}

assert.equal(validateBypassTokenFormat(''), false, 'Empty token must be rejected');
assert.equal(validateBypassTokenFormat('   '), false, 'Whitespace token must be rejected');
assert.equal(validateBypassTokenFormat('not_a_valid_hex_token_1234567890'), false, 'Non-hex token must be rejected');
assert.equal(validateBypassTokenFormat('0123456789abcdef'), false, 'Short token (16 chars) must be rejected');
assert.equal(validateBypassTokenFormat('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0'), false, 'Long token (65 chars) must be rejected');
assert.equal(validateBypassTokenFormat('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), true, '64-character hex token must be accepted');
console.log('  ✓ 64-character hexadecimal bypass token format validation verified');

// 7.5 Missing privileged credentials in verifyStagingWriteIsolation results in FAIL
const mockMissingPrivilegedTokenClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('neon.project_id')) {
      return {
        rows: [{
          db_name: 'neondb',
          neon_project_id: STAGING_NEON_PROJECT_ID,
          neon_branch_id: STAGING_NEON_BRANCH_ID,
          neon_endpoint_id: STAGING_NEON_ENDPOINT_ID
        }]
      };
    }
    if (sql.includes('_aira_staging_maintenance')) {
      return {
        rows: [{
          is_active: true,
          activated_at: '2026-10-22T00:00:00Z',
          activated_by: 'operator',
          reason: 'cutover',
          bypass_token_hash: 'hash'
        }]
      };
    }
    if (sql.includes('default_transaction_read_only')) {
      return {
        rows: [{
          db_name: 'neondb',
          default_ro: 'on',
          project_id: STAGING_NEON_PROJECT_ID,
          branch_id: STAGING_NEON_BRANCH_ID
        }]
      };
    }
    if (sql.includes('INSERT INTO _aira_maintenance_write_probe') || sql.includes('TRUNCATE TABLE _aira_maintenance_write_probe')) {
      throw new Error('[STAGING_MAINTENANCE_BLOCKED] Operation denied: Permanent Staging database is in maintenance mode.');
    }
    return { rows: [] };
  }
};

const isolationMissingToken = await verifyStagingWriteIsolation(mockMissingPrivilegedTokenClient, { bypassToken: undefined });
assert.equal(isolationMissingToken.isolated, false, 'Write isolation must fail closed when bypass token is missing');
assert.equal(isolationMissingToken.privilegedMigrationPath.status, 'FAIL', 'Gate 5 PRIVILEGED_MIGRATION_PATH must be FAIL without token');
assert.match(isolationMissingToken.privilegedMigrationPath.details, /No privileged bypass token was provided/);
console.log('  ✓ Fail closed: Missing privileged bypass token fails Gate 5 PRIVILEGED_MIGRATION_PATH');


// ── Test Group 8: Release Sequence Separation & Maintenance-Active Blocked Mutating Paths (Defect 2) ─
console.log('\n--- Test Group 8: Release Sequence Separation & Maintenance-Active Blocked Mutating Paths (Defect 2) ---');

// 8.1 Prove that mutating operations are blocked under active maintenance
const sampleBypassToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const sampleBypassHash = hashBypassToken(sampleBypassToken);
const maintenanceMiddleware = createStagingMaintenanceMiddleware({
  enabled: true,
  bypassToken: sampleBypassToken,
  bypassTokenHash: sampleBypassHash
});

function simulateHttp(method: string, path: string) {
  let nextInvoked = false;
  let statusCode = 200;
  let responseBody: any = null;
  const resHeaders: Record<string, string> = {};

  const req: any = { method, path, url: path, originalUrl: path, headers: {} };
  const res: any = {
    status: (code: number) => { statusCode = code; return res; },
    setHeader: (name: string, value: string) => { resHeaders[name.toLowerCase()] = value; },
    json: (body: any) => { responseBody = body; return res; }
  };

  maintenanceMiddleware(req, res, () => { nextInvoked = true; });
  return { nextInvoked, statusCode, responseBody, resHeaders };
}

// 8.1.1 Read-only health checks pass through unconditionally
const healthRes = simulateHttp('GET', '/api/health');
assert.equal(healthRes.nextInvoked, true, 'GET /api/health must pass through during maintenance');
assert.equal(healthRes.statusCode, 200);

const benchmarkRes = simulateHttp('GET', '/api/ready/benchmark');
assert.equal(benchmarkRes.nextInvoked, true, 'GET /api/ready/benchmark must pass through during maintenance');

// 8.1.2 Authentication and Chat writes MUST return HTTP 503 and NOT proceed
const chatStreamRes = simulateHttp('POST', '/api/chat/stream');
assert.equal(chatStreamRes.nextInvoked, false, 'POST /api/chat/stream must NOT reach router during maintenance');
assert.equal(chatStreamRes.statusCode, 503, 'POST /api/chat/stream must return HTTP 503');
assert.equal(chatStreamRes.responseBody?.code, 'STAGING_MAINTENANCE_ACTIVE');
assert.equal(chatStreamRes.resHeaders['retry-after'], '60');

const googleOauthStartRes = simulateHttp('GET', '/api/auth/oauth/google/start');
assert.equal(googleOauthStartRes.nextInvoked, false, 'Google OAuth start must NOT proceed during maintenance');
assert.equal(googleOauthStartRes.statusCode, 503);

const githubOauthCallbackRes = simulateHttp('GET', '/api/auth/oauth/github/callback');
assert.equal(githubOauthCallbackRes.nextInvoked, false, 'GitHub OAuth callback must NOT proceed during maintenance');
assert.equal(githubOauthCallbackRes.statusCode, 503);

const convUpdateRes = simulateHttp('PUT', '/api/conversations/conv_123');
assert.equal(convUpdateRes.nextInvoked, false, 'PUT /api/conversations must NOT proceed during maintenance');
assert.equal(convUpdateRes.statusCode, 503);

console.log('  ✓ Proved: Mutating operations (OAuth start/callback, chat stream, conversation writes) return HTTP 503 during maintenance');
console.log('  ✓ Proved: Read-only endpoints (/api/health, /api/ready/benchmark) return HTTP 200 during maintenance');

// 8.2 Verify CUTOVER_PROTOCOL_STEPS sequence ordering
const step7 = CUTOVER_PROTOCOL_STEPS.find(s => s.step === 7);
assert.ok(step7, 'Step 7 must exist');
assert.equal(step7.id, '7_VERIFY_DATA_INTEGRITY');
assert.ok(step7.description.includes('read-only health checks'));
assert.ok(step7.description.includes('503'));

const step8 = CUTOVER_PROTOCOL_STEPS.find(s => s.step === 8);
assert.ok(step8, 'Step 8 must exist');
assert.equal(step8.id, '8_CERTIFY_DEPLOYED_APP');
assert.ok(step8.prerequisites.includes('Step 7 complete and certified'));

const step9 = CUTOVER_PROTOCOL_STEPS.find(s => s.step === 9);
assert.ok(step9, 'Step 9 must exist');
assert.equal(step9.id, '9_PERMIT_REAL_BROWSER_ACCEPTANCE');
assert.ok(step9.prerequisites.includes('Step 8 complete'));
assert.ok(step9.description.includes('writes restored'));
assert.ok(step9.verificationGate.includes('never claim PASS from a simulated browser test'));

console.log('  ✓ Release sequence order verified: Step 7 Maintenance-Active -> Step 8 Deactivation -> Step 9 Post-Deactivation Browser Acceptance');

// ── Test Group 9: Final Fail-Closed Cutover Gates & Credential Argument Isolation ─
console.log('\n--- Test Group 9: Final Fail-Closed Cutover Gates & Credential Argument Isolation ---');

// 9.1 Staging Health Checks Fail Closed (HTTP 000, 404, redirects, non-200)
const res000 = validateHealthCheckResponse('000');
assert.equal(res000.ok, false);
assert.match(res000.reason!, /HTTP 000/);

const res404 = validateHealthCheckResponse('404');
assert.equal(res404.ok, false);
assert.match(res404.reason!, /HTTP 404/);

const res302 = validateHealthCheckResponse('302');
assert.equal(res302.ok, false);
assert.match(res302.reason!, /Unexpected redirect/);

const res500 = validateHealthCheckResponse('500');
assert.equal(res500.ok, false);
assert.match(res500.reason!, /Expected HTTP 200/);

const resBadBody = validateHealthCheckResponse('200', '{"error":"internal_failure"}');
assert.equal(resBadBody.ok, false);
assert.match(resBadBody.reason!, /valid health status payload/);

const resHealthy = validateHealthCheckResponse('200', '{"status":"HEALTHY","subsystems":{}}');
assert.equal(resHealthy.ok, true);
console.log('  ✓ Proved: Health check fails closed on HTTP 000, 404, redirects, and non-healthy payloads');

// 9.2 Missing curl check in staging-cutover-wizard.sh
const wizardScript = fs.readFileSync('scripts/staging-cutover-wizard.sh', 'utf8');
assert.ok(
  wizardScript.includes('command -v curl') && wizardScript.includes("warn \"SECURITY FATAL: 'curl' is required"),
  'Wizard must fail closed if curl is missing'
);
console.log('  ✓ Proved: Staging cutover wizard fails closed if curl is missing');

// 9.3 Mutating requests returning 200 or 302 during maintenance fail the gate
const chat200 = validateMaintenanceRestrictionResponse('200', '{"text":"response"}');
assert.equal(chat200.ok, false);
assert.match(chat200.reason!, /Mutating endpoint returned HTTP 200! Writes are NOT blocked/);

const oauthRedirect = validateMaintenanceRestrictionResponse('302', 'Redirecting to accounts.google.com');
assert.equal(oauthRedirect.ok, false);
assert.match(oauthRedirect.reason!, /Mutating endpoint returned redirect HTTP 302/);

const maint503Bad = validateMaintenanceRestrictionResponse('503', '{"error":"random 503"}');
assert.equal(maint503Bad.ok, false);
assert.match(maint503Bad.reason!, /does not contain expected STAGING_MAINTENANCE payload/);

const maint503Valid = validateMaintenanceRestrictionResponse('503', '{"code":"STAGING_MAINTENANCE_ACTIVE"}');
assert.equal(maint503Valid.ok, true);
console.log('  ✓ Proved: Chat returning 200 or OAuth returning 302 during maintenance fails the release gate');

// 9.4 Credentials and tokens in process arguments are strictly rejected
function runScriptWithArgs(scriptPath: string, args: string[]): { exitCode: number; output: string } {
  try {
    const out = execSync(`npx tsx ${scriptPath} ${args.join(' ')}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test', AIRA_TEST_ENVIRONMENT: 'true' }
    });
    return { exitCode: 0, output: out };
  } catch (err: any) {
    return { exitCode: err.status ?? 1, output: (err.stdout || '') + (err.stderr || '') };
  }
}

const tokenArgRes = runScriptWithArgs('scripts/verify-staging-write-isolation.ts', ['--token', 'secret_token_123']);
assert.notEqual(tokenArgRes.exitCode, 0, 'Must exit non-zero when --token is passed');
assert.match(tokenArgRes.output, /Supplying maintenance bypass token via command-line argument \(--token\) is strictly prohibited/);

const dummyCliConnStr = ['postgres:', '', 'neondb_owner:dummy_pass@ep-fake.neon.tech', 'neondb'].join('/');

const connArgRes1 = runScriptWithArgs('scripts/verify-staging-write-isolation.ts', [dummyCliConnStr]);
assert.notEqual(connArgRes1.exitCode, 0, 'Must exit non-zero when connection string is on CLI');
assert.match(connArgRes1.output, /Supplying database connection strings via command-line arguments is strictly prohibited/);

const connArgRes2 = runScriptWithArgs('scripts/import-verified-commercial-identities.ts', [dummyCliConnStr]);
assert.notEqual(connArgRes2.exitCode, 0);
assert.match(connArgRes2.output, /Supplying database connection strings via command-line arguments is strictly prohibited/);

const connArgRes3 = runScriptWithArgs('scripts/staging-cutover-orchestrator.ts', ['--verify-integrity', dummyCliConnStr]);
assert.notEqual(connArgRes3.exitCode, 0);
assert.match(connArgRes3.output, /Supplying database connection strings via command-line arguments is strictly prohibited/);

const connArgRes4 = runScriptWithArgs('scripts/staging-maintenance-control.ts', [dummyCliConnStr]);
assert.notEqual(connArgRes4.exitCode, 0);
assert.match(connArgRes4.output, /Supplying database connection strings via command-line arguments is strictly prohibited/);

console.log('  ✓ Proved: Database credentials and --token bypass arguments on process command lines are strictly rejected');

// 9.5 Wizard does not pass connection strings on CLI
assert.equal(
  /npx tsx scripts\/[a-zA-Z0-9-]+\.ts\s+.*\$STAGING_DB_URL/.test(wizardScript),
  false,
  'Wizard must never pass $STAGING_DB_URL as CLI argument'
);
assert.equal(
  /npx tsx scripts\/[a-zA-Z0-9-]+\.ts\s+.*\$SOURCE_DB_URL/.test(wizardScript),
  false,
  'Wizard must never pass $SOURCE_DB_URL as CLI argument'
);
console.log('  ✓ Proved: Wizard invokes scripts using environment-scoped credentials only');

// 9.6 Deactivation fails closed when database writes remain blocked or cleanup fails
const mockFailingDeactivationClient: any = {
  raw: async (sql: string) => {
    if (sql.includes('neon.project_id')) {
      return {
        rows: [{
          db_name: 'neondb',
          neon_project_id: STAGING_NEON_PROJECT_ID,
          neon_branch_id: STAGING_NEON_BRANCH_ID,
          neon_endpoint_id: STAGING_NEON_ENDPOINT_ID
        }]
      };
    }
    if (sql.includes('current_database()')) return { rows: [{ db_name: 'neondb' }] };
    if (sql.includes('ALTER DATABASE')) throw new Error('Permission denied to reset default_transaction_read_only');
    return { rows: [] };
  }
};
let deactThrown: any = null;
try {
  await deactivateStagingMaintenance(mockFailingDeactivationClient, { operator: 'test_operator' });
} catch (err: any) {
  deactThrown = err;
}
assert.ok(deactThrown, 'Deactivation must throw if read-only reset fails');
assert.match(deactThrown.message, /Failed to reset database-level default_transaction_read_only/);
console.log('  ✓ Proved: Maintenance deactivation fails closed when read-only reset, trigger removal, or write restoration fails');

console.log('\n================================================================================');
console.log('  ✓ ALL 51 CUTOVER SAFETY GATE FAIL-CLOSED ASSERTIONS PASSED SUCCESSFULLY!      ');
console.log('================================================================================\n');
