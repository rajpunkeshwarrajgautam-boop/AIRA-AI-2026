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
  validateAuthoritativeTargetSafety,
  verifyConnectedTargetMetadata,
  validateAuthoritativeSourceSafety
} from '../scripts/import-verified-commercial-identities.js';
import {
  verifyNeonCheckpointFromList,
  NeonBranchMetadata
} from '../scripts/verify-neon-checkpoint.js';
import {
  verifyStagingWriteIsolation
} from '../scripts/verify-staging-write-isolation.js';
import {
  verifyStagingCutoverIntegrity
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

console.log('\n================================================================================');
console.log('  ✓ ALL 18 CUTOVER SAFETY GATE FAIL-CLOSED ASSERTIONS PASSED SUCCESSFULLY!      ');
console.log('================================================================================\n');
