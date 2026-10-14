/**
 * Tier B: trusted post-completion GitHub App publisher.
 *
 * Invoked ONLY by release-authorization-publisher.yml from prod-release.
 * Step "verify" has read-only GITHUB_TOKEN; step "publish" receives a repository-
 * scoped GitHub App token from a protected Environment after verification.
 * No token material or approval payload is read from PR checkout content.
 */
export const RELEASE_REPO = 'rajpunkeshwarrajgautam-boop/AIRA-AI-2026';
export const RELEASE_BRANCH = 'prod-release';
export const APPROVAL_WORKFLOW = 'Release Authorization Attestation (No Deployment)';
export const APPROVAL_WORKFLOW_PATH = '.github/workflows/release-authorization.yml';
export const STATUS_CONTEXT = 'release/go-live-authorized';
export const MAX_RUN_AGE_MS = 15 * 60 * 1000;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const TITLE_PATTERN = /^Release Authorization: PR #([1-9][0-9]*) \[([a-f0-9]{40})\] \[GO LIVE ([a-f0-9]{40})\]$/;

export function parseApprovalTitle(title) {
  if (typeof title !== 'string') throw new Error('INVALID_ATTESTATION_TITLE');
  const match = TITLE_PATTERN.exec(title);
  if (!match || match[2] !== match[3]) throw new Error('INVALID_ATTESTATION_TITLE');
  const prNumber = Number(match[1]);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('INVALID_PR_NUMBER');
  return { prNumber, candidateSha: match[2] };
}

function requireCondition(value, error) {
  if (!value) throw new Error(error);
}

function validTimestamp(value, now, maxAgeMs) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time <= now && now - time <= maxAgeMs;
}

/** Pure, side-effect-free policy evaluation; used by real publisher and tests. */
export function validateCompletedApproval(run, pr, { now = Date.now(), expectedRunId } = {}) {
  requireCondition(run && typeof run === 'object', 'MISSING_ATTESTATION_RUN');
  requireCondition(Number.isSafeInteger(run.id) && run.id > 0 && (!expectedRunId || run.id === expectedRunId), 'RUN_ID_MISMATCH');
  requireCondition(run.name === APPROVAL_WORKFLOW, 'WORKFLOW_NAME_MISMATCH');
  requireCondition(run.path?.split('@')[0] === APPROVAL_WORKFLOW_PATH, 'WORKFLOW_PATH_MISMATCH');
  requireCondition(run.event === 'workflow_dispatch', 'WORKFLOW_EVENT_MISMATCH');
  requireCondition(run.status === 'completed' && run.conclusion === 'success', 'ATTESTATION_NOT_COMPLETED_SUCCESS');
  requireCondition(run.head_branch === RELEASE_BRANCH, 'UNTRUSTED_EXECUTION_BRANCH');
  requireCondition(SHA_PATTERN.test(run.head_sha || ''), 'INVALID_EXECUTION_SHA');
  requireCondition(run.head_repository?.full_name === RELEASE_REPO && run.repository?.full_name === RELEASE_REPO, 'RUN_REPOSITORY_MISMATCH');
  requireCondition(run.actor?.login === 'rajpunkeshwarrajgautam-boop', 'UNAUTHORIZED_ACTOR');
  requireCondition(run.triggering_actor?.login === 'rajpunkeshwarrajgautam-boop', 'UNAUTHORIZED_TRIGGERING_ACTOR');
  requireCondition(validTimestamp(run.created_at, now, MAX_RUN_AGE_MS), 'ATTESTATION_STALE_OR_INVALID');
  requireCondition(validTimestamp(run.updated_at, now, MAX_RUN_AGE_MS), 'COMPLETION_TIMESTAMP_INVALID');
  const { prNumber, candidateSha } = parseApprovalTitle(run.display_title);
  requireCondition(pr && pr.number === prNumber, 'PR_NUMBER_MISMATCH');
  requireCondition(pr.state === 'open' && !pr.draft, 'PR_NOT_READY');
  requireCondition(pr.base?.ref === RELEASE_BRANCH && pr.base?.repo?.full_name === RELEASE_REPO, 'PR_TARGET_MISMATCH');
  requireCondition(pr.head?.sha === candidateSha && pr.head?.repo?.full_name === RELEASE_REPO, 'PR_CANDIDATE_MISMATCH');
  return { prNumber, candidateSha, approvalRunId: run.id };
}

export async function githubApi(path, token, { method = 'GET', body, request = fetch } = {}) {
  requireCondition(typeof token === 'string' && token.length > 10, 'GITHUB_TOKEN_REQUIRED');
  const response = await request('https://api.github.com/repos/' + RELEASE_REPO + '/' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error('GITHUB_API_REQUEST_FAILED_' + response.status + '_' + path.split('/')[0]);
  return response.json();
}

export async function verifyApprovalFromGitHub({ runId, readToken, now = Date.now(), request = fetch }) {
  requireCondition(Number.isSafeInteger(runId) && runId > 0, 'INVALID_RUN_ID');
  const run = await githubApi('actions/runs/' + runId, readToken, { request });
  requireCondition(run.id === runId, 'RUN_ID_MISMATCH');
  // Reject forged/contradictory dispatch evidence before selecting a PR.
  requireCondition(run.name === APPROVAL_WORKFLOW && run.path?.split('@')[0] === APPROVAL_WORKFLOW_PATH, 'WORKFLOW_IDENTITY_MISMATCH');
  const { prNumber } = parseApprovalTitle(run.display_title);
  const pr = await githubApi('pulls/' + prNumber, readToken, { request });
  return validateCompletedApproval(run, pr, { now, expectedRunId: runId });
}

export async function publishApprovedStatus({ runId, readToken, appToken, now = Date.now(), request = fetch }) {
  requireCondition(typeof appToken === 'string' && appToken.length > 10, 'APP_TOKEN_REQUIRED');
  const verified = await verifyApprovalFromGitHub({ runId, readToken, now, request });
  // Reject attempts to republish a prior approval after a later App-issued revocation.
  // App tokens are accepted only by the trusted publisher job, not PR builds.
  const recent = await githubApi('commits/' + verified.candidateSha + '/statuses?per_page=100', appToken, { request });
  requireCondition(Array.isArray(recent), 'STATUS_HISTORY_INVALID');
  const latest = recent.find(s => s?.context === STATUS_CONTEXT);
  if (latest && latest.state === 'failure' &&
      typeof latest.description === 'string' && latest.description.startsWith('REVOKED')) {
    const revokedAt = Date.parse(latest.created_at);
    requireCondition(Number.isFinite(revokedAt) && revokedAt < now, 'REVOCATION_TIMESTAMP_INVALID');
    const attestation = await githubApi('actions/runs/' + runId, readToken, { request });
    const attestedAt = Date.parse(attestation.created_at);
    requireCondition(Number.isFinite(attestedAt) && attestedAt > revokedAt, 'PRIOR_APPROVAL_REVOKED');
  }
  // The only write in this program. App credential must NEVER be repository GITHUB_TOKEN.
  const status = await githubApi('statuses/' + verified.candidateSha, appToken, {
    method: 'POST',
    body: {
      state: 'success',
      context: STATUS_CONTEXT,
      description: 'Owner attestation complete for PR #' + verified.prNumber,
      target_url: 'https://github.com/' + RELEASE_REPO + '/actions/runs/' + runId
    },
    request
  });
  requireCondition(status.state === 'success' && status.context === STATUS_CONTEXT, 'STATUS_WRITE_NOT_CONFIRMED');
  return verified;
}

function requireRuntimeGuards() {
  requireCondition(process.env.GITHUB_REPOSITORY === RELEASE_REPO, 'WRONG_REPOSITORY');
  requireCondition(process.env.GITHUB_REF === 'refs/heads/' + RELEASE_BRANCH, 'UNTRUSTED_PUBLISHER_REF');
  const eventRunId = Number(process.env.APPROVAL_RUN_ID);
  requireCondition(Number.isSafeInteger(eventRunId) && eventRunId > 0, 'INVALID_RUN_ID');
  return eventRunId;
}

async function main() {
  const action = process.argv[2];
  requireCondition(action === 'verify' || action === 'publish', 'INVALID_PUBLISHER_MODE');
  const runId = requireRuntimeGuards();
  const readToken = process.env.GH_READ_TOKEN;
  if (action === 'verify') {
    const result = await verifyApprovalFromGitHub({ runId, readToken });
    console.log('Tier B source attestation verified; PR #' + result.prNumber + ', SHA ' + result.candidateSha);
  } else {
    const result = await publishApprovedStatus({ runId, readToken, appToken: process.env.RELEASE_GATE_APP_TOKEN });
    console.log('Tier B GitHub App status published; PR #' + result.prNumber + ', SHA ' + result.candidateSha);
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch(error => {
    console.error('RELEASE_GATE_DENIED: ' + (error?.message || 'UNKNOWN_ERROR'));
    process.exitCode = 1;
  });
}
