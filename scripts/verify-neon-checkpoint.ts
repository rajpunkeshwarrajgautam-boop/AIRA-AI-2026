/**
 * AIRA AI 2026 — Neon Recovery Checkpoint Verification Gate
 * 
 * Machine-verifiable gate proving that an isolated point-in-time recovery branch
 * exists on Neon project mute-frost-50372225, branched from permanent staging main
 * (br-autumn-star-b36dfu5w), prior to permanent staging cutover/migrations.
 */

import { execSync } from 'child_process';
import {
  STAGING_NEON_PROJECT_ID,
  STAGING_NEON_BRANCH_ID
} from '../packages/db/src/security/database-isolation-guard.js';

export interface NeonBranchMetadata {
  id: string;
  project_id: string;
  parent_id?: string;
  parent_lsn?: string;
  parent_timestamp?: string;
  name: string;
  current_state: string;
  created_at: string;
}

export interface CheckpointVerificationResult {
  verified: boolean;
  branch?: NeonBranchMetadata;
  error?: string;
}

export function verifyNeonCheckpointFromList(
  branches: NeonBranchMetadata[],
  checkpointIdentifier: string,
  expectedProjectId: string = STAGING_NEON_PROJECT_ID,
  expectedParentBranchId: string = STAGING_NEON_BRANCH_ID
): CheckpointVerificationResult {
  if (!checkpointIdentifier || !checkpointIdentifier.trim()) {
    return {
      verified: false,
      error: 'Checkpoint branch identifier must be provided.'
    };
  }

  const query = checkpointIdentifier.trim().toLowerCase();
  const matched = branches.find(
    b => b.id.toLowerCase() === query || b.name.toLowerCase() === query
  );

  if (!matched) {
    return {
      verified: false,
      error: `Recovery checkpoint branch '${checkpointIdentifier}' was not found in Neon project ${expectedProjectId}.`
    };
  }

  if (matched.project_id !== expectedProjectId) {
    return {
      verified: false,
      branch: matched,
      error: `Recovery checkpoint branch belongs to project '${matched.project_id}', expected '${expectedProjectId}'.`
    };
  }

  if (matched.parent_id !== expectedParentBranchId) {
    return {
      verified: false,
      branch: matched,
      error: `Recovery checkpoint branch parent is '${matched.parent_id}', but must be permanent staging main (${expectedParentBranchId}).`
    };
  }

  if (matched.current_state !== 'ready') {
    return {
      verified: false,
      branch: matched,
      error: `Recovery checkpoint branch state is '${matched.current_state}', expected 'ready'.`
    };
  }

  return {
    verified: true,
    branch: matched
  };
}

export function fetchNeonBranches(projectId: string = STAGING_NEON_PROJECT_ID): NeonBranchMetadata[] {
  // If mock branches provided in environment (for unit testing), use them
  if (process.env.AIRA_TEST_NEON_BRANCHES_JSON) {
    return JSON.parse(process.env.AIRA_TEST_NEON_BRANCHES_JSON);
  }

  try {
    const stdout = execSync(`npx neonctl branches list --project-id ${projectId} --output json`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return JSON.parse(stdout);
  } catch (err: any) {
    throw new Error(`Failed to list Neon branches for project ${projectId}: ${err.message}`);
  }
}

export async function verifyNeonCheckpoint(
  checkpointIdentifier: string,
  projectId: string = STAGING_NEON_PROJECT_ID,
  expectedParentBranchId: string = STAGING_NEON_BRANCH_ID
): Promise<CheckpointVerificationResult> {
  const branches = fetchNeonBranches(projectId);
  return verifyNeonCheckpointFromList(branches, checkpointIdentifier, projectId, expectedParentBranchId);
}

async function main() {
  const checkpointIdentifier = process.argv[2] || process.env.AIRA_CHECKPOINT_BRANCH || 'staging-backup-pre-commercial-cutover';
  console.log(`[CHECKPOINT_VERIFY] Querying Neon project ${STAGING_NEON_PROJECT_ID} for recovery checkpoint: '${checkpointIdentifier}'...`);

  try {
    const result = await verifyNeonCheckpoint(checkpointIdentifier);
    if (!result.verified || !result.branch) {
      console.error(`\n❌ [CHECKPOINT_VERIFY_FATAL] ${result.error}`);
      process.exit(1);
    }

    console.log('\n✓ [CHECKPOINT_VERIFIED] Machine-verifiable Neon recovery checkpoint confirmed:');
    console.log(`  - Branch ID:   ${result.branch.id}`);
    console.log(`  - Branch Name: ${result.branch.name}`);
    console.log(`  - Project ID:  ${result.branch.project_id}`);
    console.log(`  - Parent ID:   ${result.branch.parent_id} (permanent staging main)`);
    console.log(`  - Parent LSN:  ${result.branch.parent_lsn || 'N/A'}`);
    console.log(`  - State:       ${result.branch.current_state}`);
    console.log(`  - Created At:  ${result.branch.created_at}\n`);
    process.exit(0);
  } catch (err: any) {
    console.error(`\n❌ [CHECKPOINT_VERIFY_FATAL] Error verifying Neon checkpoint: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('verify-neon-checkpoint')) {
  main().catch(err => {
    console.error('[CHECKPOINT_VERIFY] Uncaught error:', err);
    process.exit(1);
  });
}
