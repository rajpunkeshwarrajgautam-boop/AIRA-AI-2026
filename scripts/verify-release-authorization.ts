import { execSync } from 'node:child_process';
import {
  validateCandidateConstraints,
  validateAttestationWorkflowRun,
  validateCommitStatuses,
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

  // 2. Fetch commit statuses on candidate commit
  let statuses: CommitStatusRecord[] = [];
  try {
    const statusesRaw = callGitHubApi(`repos/${args.repo}/commits/${args.candidateSha}/statuses`);
    if (Array.isArray(statusesRaw)) {
      statuses = statusesRaw.map((s: any) => ({
        context: s.context,
        state: s.state,
        description: s.description,
        target_url: s.target_url,
        created_at: s.created_at
      }));
    }
  } catch (err: any) {
    console.warn(`[VERIFY_RELEASE_AUTH] Warning: Failed to query commit statuses: ${err.message}`);
  }

  const goLiveStatus = statuses.find(s => s.context === GO_LIVE_STATUS_CONTEXT);
  console.log(`[VERIFY_RELEASE_AUTH] Commit status "${GO_LIVE_STATUS_CONTEXT}": ${goLiveStatus ? `${goLiveStatus.state} (${goLiveStatus.description})` : 'NOT FOUND'}`);

  // 3. Fetch workflow runs for attestation
  let runs: AttestationRunRecord[] = [];
  try {
    // Query repository workflow runs
    const runsRaw = callGitHubApi(`repos/${args.repo}/actions/runs?event=workflow_dispatch&per_page=30`);
    if (runsRaw && Array.isArray(runsRaw.workflow_runs)) {
      runs = runsRaw.workflow_runs.map((r: any) => ({
        id: r.id,
        name: r.name,
        path: r.path,
        head_sha: r.head_sha,
        actor: r.triggering_actor?.login || r.actor?.login,
        event: r.event,
        status: r.status,
        conclusion: r.conclusion,
        created_at: r.created_at,
        inputs: r.inputs
      }));
    }
  } catch (err: any) {
    console.warn(`[VERIFY_RELEASE_AUTH] Warning: Failed to query workflow runs: ${err.message}`);
  }

  let matchingRun: AttestationRunRecord | undefined;
  for (const run of runs) {
    const check = validateAttestationWorkflowRun(run, candidateCtx);
    if (check.valid) {
      matchingRun = run;
      break;
    }
  }

  if (matchingRun) {
    console.log(`[VERIFY_RELEASE_AUTH] Found matching owner attestation run #${matchingRun.id} (Created: ${matchingRun.created_at})`);
  } else {
    console.log('[VERIFY_RELEASE_AUTH] No matching owner attestation run found.');
  }

  // Fail closed if neither status check nor workflow attestation is verified
  if (!matchingRun && (!goLiveStatus || goLiveStatus.state !== 'success')) {
    return {
      authorized: false,
      code: 'RELEASE_NOT_AUTHORIZED',
      reason: `Release candidate ${args.candidateSha} has NOT received verified human GO LIVE authorization from owner ${AUTHORIZED_REPOSITORY_OWNER}. Required status "${GO_LIVE_STATUS_CONTEXT}" is missing or unverified.`,
      details: {
        prNumber: args.prNumber,
        candidateSha: args.candidateSha,
        prHeadSha,
        targetBranch: prTargetBranch,
        prState,
        statusState: goLiveStatus?.state || 'missing',
        attestationRunsFound: runs.length
      }
    };
  }

  return {
    authorized: true,
    code: 'RELEASE_GO_LIVE_VERIFIED',
    reason: `Verified authoritative release authorization on GitHub for candidate ${args.candidateSha}.`,
    details: {
      prNumber: args.prNumber,
      candidateSha: args.candidateSha,
      matchingRunId: matchingRun?.id,
      matchingStatus: goLiveStatus?.context,
      authorizedBy: AUTHORIZED_REPOSITORY_OWNER
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
