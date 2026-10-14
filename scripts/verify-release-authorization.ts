import { execSync } from 'node:child_process';
import {
  validateCandidateConstraints,
  validateAttestationWorkflowRun,
  validateCommitStatuses,
  extractRunIdFromTargetUrl,
  AUTHORIZED_REPOSITORY_OWNER,
  PRODUCTION_RELEASE_BRANCH,
  GO_LIVE_STATUS_CONTEXT,
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
  let repo = process.env.GITHUB_REPOSITORY || `${AUTHORIZED_REPOSITORY_OWNER}/AIRA-AI-2026`;

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
      candidateSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
      // ignore
    }
  }

  return { prNumber, candidateSha, repo };
}

function callGitHubApi(endpoint: string): any {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const authHeader = token ? `-H "Authorization: Bearer ${token}"` : '';
  const cmd = `gh api ${authHeader} "${endpoint}"`;
  try {
    const raw = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
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
  console.log(`[VERIFY_RELEASE_AUTH] Commit status "${GO_LIVE_STATUS_CONTEXT}": state=${matchingStatus.state}, description="${matchingStatus.description}"`);

  // 3. Extract linked workflow run ID from commit status target_url (Provenance Link)
  const linkedRunId = extractRunIdFromTargetUrl(matchingStatus.target_url);
  if (!linkedRunId) {
    return {
      authorized: false,
      code: 'STATUS_PROVENANCE_MISSING',
      reason: `Commit status target_url ("${matchingStatus.target_url}") does not contain a verifiable GitHub Actions run ID.`
    };
  }
  console.log(`[VERIFY_RELEASE_AUTH] Verified status provenance: linked to Actions run #${linkedRunId}`);

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
    inputs: runData.inputs
  };

  // 5. Validate linked run against strict owner attestation rules
  // Note: Since GitHub /actions/runs does not echo inputs in the run payload,
  // we verify the status description binds PR number and SHA, and that the run
  // was triggered via workflow_dispatch by the owner, succeeded, is fresh, and matches path/name.
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

  // Freshness check on the workflow run
  const runTime = new Date(linkedRun.created_at).getTime();
  const maxAge = 24 * 60 * 60 * 1000;
  if (Date.now() - runTime > maxAge) {
    return {
      authorized: false,
      code: 'EXPIRED_AUTHORIZATION_ATTESTATION',
      reason: `Linked run #${linkedRun.id} was created at ${linkedRun.created_at}, which exceeds 24-hour freshness validity.`
    };
  }

  console.log(`[VERIFY_RELEASE_AUTH] Authoritative dual evidence verified successfully:`);
  console.log(`  - Commit Status: ${matchingStatus.context}=success (Created: ${matchingStatus.created_at})`);
  console.log(`  - Workflow Run: #${linkedRun.id} (${linkedRun.conclusion}) by ${linkedRun.actor} (Created: ${linkedRun.created_at})`);
  console.log(`  - Provenance: target_url links directly to run #${linkedRun.id}`);

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
      freshnessVerified: true
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
