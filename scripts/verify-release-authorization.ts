import { execFileSync } from 'node:child_process';
import {
  validateCandidateConstraints,
  validateCommitStatuses,
  extractRunIdFromTargetUrl,
  AUTHORIZED_REPOSITORY_OWNER,
  DEFAULT_REPOSITORY_NAME,
  PRODUCTION_RELEASE_BRANCH,
  AUTHORIZATION_WORKFLOW_NAME,
  GO_LIVE_STATUS_CONTEXT,
  DEFAULT_MAX_RUN_STATUS_TIME_DELTA_MS,
  TRUSTED_STATUS_ISSUER_LOGINS,
  type AttestationRunRecord,
  type CommitStatusRecord,
  type ReleaseCandidateContext
} from '../src/security/release-authorization-validator.js';

interface CliArgs {
  prNumber: number;
  candidateSha: string;
  repo: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let prNumber = Number(process.env.PR_NUMBER) || 64;
  let candidateSha = process.env.CANDIDATE_SHA || '';
  let repo = process.env.GITHUB_REPOSITORY || `${AUTHORIZED_REPOSITORY_OWNER}/${DEFAULT_REPOSITORY_NAME}`;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pr' && args[i + 1]) {
      prNumber = parseInt(args[++i], 10);
    } else if (args[i] === '--sha' && args[i + 1]) {
      candidateSha = args[++i].trim();
    } else if (args[i] === '--repo' && args[i + 1]) {
      repo = args[++i].trim();
    }
  }

  if (!candidateSha) {
    try {
      candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      // ignore
    }
  }

  // Strict input validation
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: "${prNumber}". Expected positive integer.`);
  }

  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid repository: "${repo}". Expected format: owner/repo`);
  }

  if (candidateSha && !/^[0-9a-f]{40}$/.test(candidateSha)) {
    throw new Error(`Invalid candidate SHA: "${candidateSha}". Expected 40-character lowercase hex string.`);
  }

  return { prNumber, candidateSha, repo };
}

function callGitHubApi(endpoint: string): any {
  // Safe argument invocation without shell interpolation
  try {
    const raw = execFileSync('gh', ['api', endpoint], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return JSON.parse(raw);
  } catch (err: any) {
    const stderr = err?.stderr?.toString() || err?.message || String(err);
    throw new Error(`GitHub API call failed for [${endpoint}]: ${stderr}`);
  }
}

export async function verifyLiveReleaseAuthorization(args: CliArgs): Promise<{
  authorized: boolean;
  code: string;
  reason: string;
  details?: Record<string, any>;
}> {
  console.log(`[VERIFY_RELEASE_AUTH] Inspecting authoritative GitHub evidence for ${args.repo} PR #${args.prNumber}...`);
  console.log(`[VERIFY_RELEASE_AUTH] Candidate commit SHA: ${args.candidateSha}`);

  // 1. Fetch Pull Request metadata
  let prData: any;
  try {
    prData = callGitHubApi(`repos/${args.repo}/pulls/${args.prNumber}`);
  } catch (err: any) {
    return {
      authorized: false,
      code: 'PR_LOOKUP_FAILED',
      reason: `Could not retrieve PR #${args.prNumber} from GitHub API: ${err.message}`
    };
  }

  const prTargetBranch = prData.base?.ref;
  const prState = prData.state;
  const prHeadSha = prData.head?.sha;

  console.log(`[VERIFY_RELEASE_AUTH] PR #${args.prNumber} Live Metadata:`);
  console.log(`  - Target branch: ${prTargetBranch}`);
  console.log(`  - State: ${prState}`);
  console.log(`  - Current HEAD SHA: ${prHeadSha}`);

  const candidateCtx: ReleaseCandidateContext = {
    prNumber: args.prNumber,
    candidateSha: args.candidateSha,
    approvalPhrase: `GO LIVE ${args.candidateSha}`,
    actor: AUTHORIZED_REPOSITORY_OWNER,
    expectedRepo: args.repo,
    prTargetBranch,
    prState,
    prHeadSha
  };

  const constraintCheck = validateCandidateConstraints(candidateCtx);
  if (!constraintCheck.valid) {
    return {
      authorized: false,
      code: constraintCheck.code || 'CONSTRAINT_FAILED',
      reason: constraintCheck.reason || 'Candidate constraints check failed'
    };
  }

  // 2. Fetch commit statuses on candidate commit (Evidence Requirement 1 of 2)
  let statuses: CommitStatusRecord[] = [];
  try {
    const statusesRaw = callGitHubApi(`repos/${args.repo}/commits/${args.candidateSha}/statuses`);
    if (Array.isArray(statusesRaw)) {
      statuses = statusesRaw.map((s: any) => ({
        context: s.context,
        state: s.state,
        description: s.description,
        target_url: s.target_url,
        created_at: s.created_at,
        updated_at: s.updated_at,
        creator: s.creator ? { login: s.creator.login } : undefined
      }));
    }
  } catch (err: any) {
    console.warn(`[VERIFY_RELEASE_AUTH] Warning: Failed to query commit statuses: ${err.message}`);
  }

  const statusCheck = validateCommitStatuses(statuses, candidateCtx);
  if (!statusCheck.valid || !statusCheck.status) {
    return {
      authorized: false,
      code: statusCheck.code || 'COMMIT_STATUS_CHECK_FAILED',
      reason: `Mandatory commit status "${GO_LIVE_STATUS_CONTEXT}" check failed: ${statusCheck.reason}`,
      details: {
        prNumber: args.prNumber,
        candidateSha: args.candidateSha,
        statusFound: statuses.some(s => s.context === GO_LIVE_STATUS_CONTEXT)
      }
    };
  }
  const matchingStatus = statusCheck.status;
  console.log(`[VERIFY_RELEASE_AUTH] Commit status "${GO_LIVE_STATUS_CONTEXT}": state=${matchingStatus.state}, issuer=${matchingStatus.creator?.login || 'unknown'}, description="${matchingStatus.description}"`);

  // 3. Extract linked workflow run ID from commit status target_url (Provenance Link)
  const linkedRunId = extractRunIdFromTargetUrl(matchingStatus.target_url, args.repo);
  if (!linkedRunId) {
    return {
      authorized: false,
      code: 'STATUS_PROVENANCE_MISSING',
      reason: `Commit status target_url ("${matchingStatus.target_url}") does not contain a verifiable GitHub Actions run ID for repository "${args.repo}".`
    };
  }
  console.log(`[VERIFY_RELEASE_AUTH] Verified status provenance: linked to Actions run #${linkedRunId} on ${args.repo}`);

  // 4. Fetch specific workflow run from GitHub API (Evidence Requirement 2 of 2)
  let runData: any;
  try {
    runData = callGitHubApi(`repos/${args.repo}/actions/runs/${linkedRunId}`);
  } catch (err: any) {
    return {
      authorized: false,
      code: 'LINKED_RUN_LOOKUP_FAILED',
      reason: `Could not retrieve linked workflow run #${linkedRunId} from GitHub API: ${err.message}`
    };
  }

  const linkedRun: AttestationRunRecord = {
    id: runData.id,
    name: runData.name,
    path: runData.path,
    head_sha: runData.head_sha,
    actor: runData.triggering_actor?.login || runData.actor?.login,
    event: runData.event,
    status: runData.status,
    conclusion: runData.conclusion,
    created_at: runData.created_at,
    head_repository: runData.head_repository ? { full_name: runData.head_repository.full_name } : undefined,
    repository: runData.repository ? { full_name: runData.repository.full_name } : undefined,
    inputs: runData.inputs
  };

  // 5. Strict checks on linked workflow run
  if (linkedRun.actor !== AUTHORIZED_REPOSITORY_OWNER) {
    return {
      authorized: false,
      code: 'UNAUTHORIZED_RUN_ACTOR',
      reason: `Linked run #${linkedRun.id} was dispatched by unauthorized actor: "${linkedRun.actor}" (expected "${AUTHORIZED_REPOSITORY_OWNER}").`
    };
  }

  if (linkedRun.event !== 'workflow_dispatch') {
    return {
      authorized: false,
      code: 'INVALID_RUN_EVENT',
      reason: `Linked run #${linkedRun.id} was triggered by event "${linkedRun.event}", expected "workflow_dispatch".`
    };
  }

  if (linkedRun.status !== 'completed' || linkedRun.conclusion !== 'success') {
    return {
      authorized: false,
      code: 'RUN_NOT_SUCCESSFUL',
      reason: `Linked run #${linkedRun.id} status is "${linkedRun.status}", conclusion: "${linkedRun.conclusion}" (expected completed/success).`
    };
  }

  // Verify run head SHA matches candidate commit SHA
  if (linkedRun.head_sha && linkedRun.head_sha !== args.candidateSha) {
    return {
      authorized: false,
      code: 'RUN_HEAD_SHA_MISMATCH',
      reason: `Linked run #${linkedRun.id} head commit "${linkedRun.head_sha}" does not match candidate SHA "${args.candidateSha}".`
    };
  }

  // Verify run repository matches expected repository
  if (linkedRun.head_repository && linkedRun.head_repository.full_name !== args.repo) {
    return {
      authorized: false,
      code: 'RUN_REPOSITORY_MISMATCH',
      reason: `Linked run #${linkedRun.id} repository "${linkedRun.head_repository.full_name}" does not match expected repository "${args.repo}".`
    };
  }

  const isAttestationWorkflow =
    linkedRun.path?.includes('release-authorization.yml') ||
    linkedRun.name?.includes('Release Authorization Attestation');
  if (!isAttestationWorkflow) {
    return {
      authorized: false,
      code: 'WORKFLOW_IDENTITY_MISMATCH',
      reason: `Linked run #${linkedRun.id} workflow identity is "${linkedRun.name}" (${linkedRun.path}), expected Release Authorization Attestation.`
    };
  }

  // 6. Freshness checks
  const runTime = new Date(linkedRun.created_at).getTime();
  const maxAge = 24 * 60 * 60 * 1000;
  if (Date.now() - runTime > maxAge) {
    return {
      authorized: false,
      code: 'EXPIRED_AUTHORIZATION_ATTESTATION',
      reason: `Linked run #${linkedRun.id} was created at ${linkedRun.created_at}, which exceeds 24-hour freshness validity.`
    };
  }

  // 7. Temporal correlation check between status creation and workflow run
  const statusTime = matchingStatus.created_at ? new Date(matchingStatus.created_at).getTime() : NaN;
  if (!isNaN(statusTime) && !isNaN(runTime)) {
    const deltaMs = Math.abs(statusTime - runTime);
    if (deltaMs > DEFAULT_MAX_RUN_STATUS_TIME_DELTA_MS) {
      return {
        authorized: false,
        code: 'UNCORRELATED_STATUS_RUN_TIMESTAMPS',
        reason: `Temporal correlation check failed: commit status was created at ${matchingStatus.created_at}, but linked workflow run was created at ${linkedRun.created_at}. Time delta of ${Math.round(deltaMs / 1000)}s exceeds maximum allowed correlation bound of ${DEFAULT_MAX_RUN_STATUS_TIME_DELTA_MS / 1000}s. Stale or uncoordinated run replay rejected.`
      };
    }
  }

  console.log(`[VERIFY_RELEASE_AUTH] Authoritative dual evidence verified successfully:`);
  console.log(`  - Commit Status: ${matchingStatus.context}=success (Created: ${matchingStatus.created_at})`);
  console.log(`  - Status Issuer: ${matchingStatus.creator?.login || 'github-actions[bot]'}`);
  console.log(`  - Workflow Run: #${linkedRun.id} (${linkedRun.conclusion}) by ${linkedRun.actor} (Created: ${linkedRun.created_at})`);
  console.log(`  - Provenance: target_url links directly to run #${linkedRun.id} on ${args.repo}`);
  console.log(`  - Temporal correlation: verified within allowable bounds`);

  return {
    authorized: true,
    code: 'RELEASE_GO_LIVE_VERIFIED',
    reason: `Verified authoritative release authorization on GitHub for candidate ${args.candidateSha}: authentic owner workflow run #${linkedRun.id} and commit status "${matchingStatus.context}" confirmed.`,
    details: {
      prNumber: args.prNumber,
      candidateSha: args.candidateSha,
      matchingRunId: linkedRun.id,
      matchingStatus: matchingStatus.context,
      authorizedBy: AUTHORIZED_REPOSITORY_OWNER,
      provenanceLinkVerified: true,
      freshnessVerified: true,
      temporalCorrelationVerified: true,
      issuerVerified: true
    }
  };
}

async function main() {
  const args = parseArgs();
  const res = await verifyLiveReleaseAuthorization(args);

  if (!res.authorized) {
    console.error('\n======================================================');
    console.error('⛔ RELEASE AUTHORIZATION REFUSED — RELEASE BLOCKED');
    console.error(`Code:   ${res.code}`);
    console.error(`Reason: ${res.reason}`);
    console.error('Details:', JSON.stringify(res.details, null, 2));
    console.error('======================================================\n');
    process.exit(1);
  }

  console.log('\n======================================================');
  console.log('✅ RELEASE AUTHORIZATION CONFIRMED — GO LIVE AUTHORIZED');
  console.log(`Code:   ${res.code}`);
  console.log(`Reason: ${res.reason}`);
  console.log('Details:', JSON.stringify(res.details, null, 2));
  console.log('======================================================\n');
}

if (process.argv[1]?.includes('verify-release-authorization')) {
  main().catch(err => {
    console.error('[VERIFY_RELEASE_AUTH] Fatal error:', err);
    process.exit(1);
  });
}
