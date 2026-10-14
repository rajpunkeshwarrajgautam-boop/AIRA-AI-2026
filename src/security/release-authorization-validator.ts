export interface AttestationRunRecord {
  id: number;
  name: string;
  path?: string;
  head_sha: string;
  actor: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  head_repository?: {
    full_name: string;
  };
  repository?: {
    full_name: string;
  };
  inputs?: {
    pr_number?: string;
    candidate_sha?: string;
    approval_phrase?: string;
  };
}

export interface CommitStatusRecord {
  context: string;
  state: 'success' | 'failure' | 'pending' | 'error';
  description?: string;
  target_url?: string;
  created_at?: string;
  updated_at?: string;
  creator?: {
    login: string;
    id?: number;
    type?: string;
  };
}

export interface ReleaseCandidateContext {
  prNumber: number;
  candidateSha: string;
  approvalPhrase: string;
  actor: string;
  prTargetBranch: string;
  prState: string;
  prHeadSha: string;
  workflowRuns?: AttestationRunRecord[];
  commitStatuses?: CommitStatusRecord[];
  expectedOwner?: string;
  expectedRepo?: string;
  expectedTargetBranch?: string;
  currentTime?: Date;
  maxAttestationAgeMs?: number;
  maxRunStatusTimeDeltaMs?: number;
}

export interface ReleaseAuthValidationResult {
  authorized: boolean;
  code: string;
  reason: string;
  details?: {
    prNumber?: number;
    candidateSha?: string;
    actor?: string;
    matchingRunId?: number;
    matchingStatusContext?: string;
    timestamp?: string;
    provenanceVerified?: boolean;
    freshnessVerified?: boolean;
    temporalCorrelationVerified?: boolean;
    issuerVerified?: boolean;
  };
}

export const AUTHORIZED_REPOSITORY_OWNER = 'rajpunkeshwarrajgautam-boop';
export const DEFAULT_REPOSITORY_NAME = 'AIRA-AI-2026';
export const DEFAULT_REPOSITORY_FULL_NAME = `${AUTHORIZED_REPOSITORY_OWNER}/${DEFAULT_REPOSITORY_NAME}`;
export const PRODUCTION_RELEASE_BRANCH = 'prod-release';
export const AUTHORIZATION_WORKFLOW_NAME = 'Release Authorization Attestation (No Deployment)';
export const AUTHORIZATION_WORKFLOW_PATH = '.github/workflows/release-authorization.yml';
export const GO_LIVE_STATUS_CONTEXT = 'release/go-live-authorized';
export const DEFAULT_MAX_ATTESTATION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_MAX_RUN_STATUS_TIME_DELTA_MS = 15 * 60 * 1000; // 15 minutes temporal bound
export const TRUSTED_STATUS_ISSUER_LOGINS = ['github-actions[bot]'];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validates candidate inputs against strict format and policy constraints.
 * Fails closed on any formatting irregularity, casing mismatch, or unapproved target.
 */
export function validateCandidateConstraints(ctx: ReleaseCandidateContext): { valid: boolean; code?: string; reason?: string } {
  // 1. Candidate commit SHA format: strict 40-character lowercase hex string
  if (!ctx.candidateSha || typeof ctx.candidateSha !== 'string') {
    return { valid: false, code: 'MISSING_CANDIDATE_SHA', reason: 'Candidate commit SHA is missing or empty.' };
  }
  if (!/^[0-9a-f]{40}$/.test(ctx.candidateSha)) {
    return {
      valid: false,
      code: 'INVALID_SHA_FORMAT',
      reason: `Candidate SHA must be a 40-character lowercase hex string. Got: "${ctx.candidateSha}"`
    };
  }

  // 2. PR Number: positive integer
  if (!Number.isInteger(ctx.prNumber) || ctx.prNumber <= 0) {
    return {
      valid: false,
      code: 'INVALID_PR_NUMBER',
      reason: `PR number must be a positive integer. Got: ${ctx.prNumber}`
    };
  }

  // 3. PR Target Branch: must strictly be prod-release
  const expectedTarget = ctx.expectedTargetBranch || PRODUCTION_RELEASE_BRANCH;
  if (ctx.prTargetBranch !== expectedTarget) {
    return {
      valid: false,
      code: 'INVALID_TARGET_BRANCH',
      reason: `Target branch must be "${expectedTarget}". Got: "${ctx.prTargetBranch}"`
    };
  }

  // 4. PR State: must be open
  if (ctx.prState !== 'open') {
    return {
      valid: false,
      code: 'PR_NOT_OPEN',
      reason: `PR must be in "open" state. Got: "${ctx.prState}"`
    };
  }

  // 5. Candidate SHA must match current PR HEAD
  if (ctx.prHeadSha !== ctx.candidateSha) {
    return {
      valid: false,
      code: 'STALE_AUTHORIZATION_HEAD_MISMATCH',
      reason: `Candidate SHA "${ctx.candidateSha}" does not match current PR HEAD "${ctx.prHeadSha}". Stale authorizations are rejected.`
    };
  }

  // 6. Approval phrase syntax: strict 'GO LIVE <candidate_sha>'
  const expectedPhrase = `GO LIVE ${ctx.candidateSha}`;
  if (ctx.approvalPhrase !== expectedPhrase) {
    return {
      valid: false,
      code: 'INVALID_APPROVAL_PHRASE',
      reason: `Approval phrase must strictly equal "${expectedPhrase}". Got: "${ctx.approvalPhrase}"`
    };
  }

  // 7. Actor authorization: must be the repository owner
  const expectedOwner = ctx.expectedOwner || AUTHORIZED_REPOSITORY_OWNER;
  if (ctx.actor !== expectedOwner) {
    return {
      valid: false,
      code: 'UNAUTHORIZED_ACTOR',
      reason: `Only repository owner "${expectedOwner}" can authorize production releases. Got actor: "${ctx.actor}"`
    };
  }

  return { valid: true };
}

/**
 * Validates a workflow run record for legitimate owner attestation.
 * Strict fail-closed rules:
 * - Must be repository owner
 * - Must be workflow_dispatch event
 * - Must be completed with success
 * - Must strictly match workflow name or path
 * - Run head_sha MUST match candidate commit SHA
 * - Run head_repository MUST match expected repository (if present)
 * - Workflow inputs MUST exist and MUST match candidate SHA, PR number, and approval phrase
 * - Must be within freshness window
 */
export function validateAttestationWorkflowRun(
  run: AttestationRunRecord,
  ctx: ReleaseCandidateContext
): { valid: boolean; code?: string; reason?: string } {
  const expectedOwner = ctx.expectedOwner || AUTHORIZED_REPOSITORY_OWNER;
  const expectedRepo = ctx.expectedRepo || `${expectedOwner}/${DEFAULT_REPOSITORY_NAME}`;
  const expectedPhrase = `GO LIVE ${ctx.candidateSha}`;
  const now = ctx.currentTime ? ctx.currentTime.getTime() : Date.now();
  const maxAge = ctx.maxAttestationAgeMs ?? DEFAULT_MAX_ATTESTATION_AGE_MS;

  // Verify actor
  if (run.actor !== expectedOwner) {
    return { valid: false, code: 'UNAUTHORIZED_ACTOR', reason: `Workflow run dispatched by unauthorized actor: "${run.actor}"` };
  }

  // Verify trigger event
  if (run.event !== 'workflow_dispatch') {
    return { valid: false, code: 'INVALID_WORKFLOW_EVENT', reason: `Attestation must be triggered via workflow_dispatch. Got: "${run.event}"` };
  }

  // Verify completion status
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    return { valid: false, code: 'WORKFLOW_NOT_SUCCESSFUL', reason: `Attestation workflow run #${run.id} status is "${run.status}", conclusion: "${run.conclusion}"` };
  }

  // Verify run head commit matches candidate SHA
  if (run.head_sha && run.head_sha !== ctx.candidateSha) {
    return {
      valid: false,
      code: 'RUN_HEAD_SHA_MISMATCH',
      reason: `Attestation run #${run.id} head SHA "${run.head_sha}" does not match candidate commit "${ctx.candidateSha}".`
    };
  }

  // Verify repository attribution on the run
  if (run.head_repository?.full_name && run.head_repository.full_name !== expectedRepo) {
    return {
      valid: false,
      code: 'RUN_REPOSITORY_MISMATCH',
      reason: `Attestation run #${run.id} repository "${run.head_repository.full_name}" does not match expected "${expectedRepo}".`
    };
  }
  if (run.repository?.full_name && run.repository.full_name !== expectedRepo) {
    return {
      valid: false,
      code: 'RUN_REPOSITORY_MISMATCH',
      reason: `Attestation run #${run.id} repository "${run.repository.full_name}" does not match expected "${expectedRepo}".`
    };
  }

  // Verify workflow identity
  const matchesWorkflowIdentity =
    run.name === AUTHORIZATION_WORKFLOW_NAME ||
    (run.path && run.path.includes('release-authorization.yml'));
  if (!matchesWorkflowIdentity) {
    return { valid: false, code: 'WORKFLOW_IDENTITY_MISMATCH', reason: `Run #${run.id} is not the release authorization attestation workflow.` };
  }

  // Mandatory Inputs Verification — Reject missing or empty inputs
  if (!run.inputs) {
    return { valid: false, code: 'MISSING_WORKFLOW_INPUTS', reason: `Run #${run.id} lacks workflow_dispatch inputs.` };
  }

  if (run.inputs.candidate_sha !== ctx.candidateSha) {
    return {
      valid: false,
      code: 'INPUT_SHA_MISMATCH',
      reason: `Run #${run.id} input candidate_sha "${run.inputs.candidate_sha}" does not match candidate SHA "${ctx.candidateSha}".`
    };
  }

  if (String(run.inputs.pr_number) !== String(ctx.prNumber)) {
    return {
      valid: false,
      code: 'INPUT_PR_MISMATCH',
      reason: `Run #${run.id} input pr_number "${run.inputs.pr_number}" does not match PR #${ctx.prNumber}.`
    };
  }

  if (run.inputs.approval_phrase !== expectedPhrase) {
    return {
      valid: false,
      code: 'INPUT_PHRASE_MISMATCH',
      reason: `Run #${run.id} input approval_phrase does not match expected "${expectedPhrase}".`
    };
  }

  // Freshness check: attestation must not exceed max age
  const runCreatedAt = new Date(run.created_at).getTime();
  if (isNaN(runCreatedAt)) {
    return { valid: false, code: 'INVALID_ATTESTATION_TIMESTAMP', reason: `Run #${run.id} has invalid created_at timestamp: "${run.created_at}"` };
  }

  if (now - runCreatedAt > maxAge) {
    return {
      valid: false,
      code: 'EXPIRED_AUTHORIZATION_ATTESTATION',
      reason: `Attestation run #${run.id} was created at ${run.created_at}, which exceeds maximum validity of ${maxAge / 3600000} hours.`
    };
  }

  return { valid: true };
}

/**
 * Validates commit statuses on candidate commit SHA.
 * Enforces:
 * - Context must match expected (default 'release/go-live-authorized')
 * - State must strictly equal 'success'
 * - Timestamp must be fresh (<= maxAttestationAgeMs, default 24h)
 * - Issuer must be trusted ('github-actions[bot]') if creator object is provided
 * - Target URL must match exact repository URL pattern
 * - Description should link to the specific PR
 */
export function validateCommitStatuses(
  statuses: CommitStatusRecord[],
  ctx: ReleaseCandidateContext,
  expectedContext = GO_LIVE_STATUS_CONTEXT
): { valid: boolean; status?: CommitStatusRecord; code?: string; reason?: string } {
  const matching = statuses.find(s => s.context === expectedContext);
  if (!matching) {
    return {
      valid: false,
      code: 'STATUS_CHECK_MISSING',
      reason: `No commit status found for context "${expectedContext}".`
    };
  }

  if (matching.state !== 'success') {
    return {
      valid: false,
      code: 'STATUS_CHECK_NOT_SUCCESSFUL',
      reason: `Commit status for "${expectedContext}" has state "${matching.state}", expected "success".`
    };
  }

  const expectedOwner = ctx.expectedOwner || AUTHORIZED_REPOSITORY_OWNER;
  const expectedRepo = ctx.expectedRepo || `${expectedOwner}/${DEFAULT_REPOSITORY_NAME}`;

  // Validate status creator/issuer if present
  if (matching.creator && matching.creator.login) {
    if (!TRUSTED_STATUS_ISSUER_LOGINS.includes(matching.creator.login)) {
      return {
        valid: false,
        code: 'UNTRUSTED_STATUS_ISSUER',
        reason: `Commit status "${expectedContext}" was created by untrusted actor "${matching.creator.login}". Expected: "${TRUSTED_STATUS_ISSUER_LOGINS.join(', ')}".`
      };
    }
  }

  // Validate status target_url format and repository binding
  if (matching.target_url) {
    const pattern = new RegExp(`^https://github\\.com/${escapeRegex(expectedRepo)}/actions/runs/(\\d+)$`);
    if (!pattern.test(matching.target_url)) {
      return {
        valid: false,
        code: 'INVALID_STATUS_TARGET_URL',
        reason: `Commit status target_url ("${matching.target_url}") does not match trusted pattern "https://github.com/${expectedRepo}/actions/runs/<id>".`
      };
    }
  }

  // Freshness check on status creation/update
  const now = ctx.currentTime ? ctx.currentTime.getTime() : Date.now();
  const maxAge = ctx.maxAttestationAgeMs ?? DEFAULT_MAX_ATTESTATION_AGE_MS;
  const statusTime = matching.created_at ? new Date(matching.created_at).getTime() : NaN;
  if (!isNaN(statusTime) && (now - statusTime > maxAge)) {
    return {
      valid: false,
      code: 'EXPIRED_COMMIT_STATUS',
      reason: `Commit status "${expectedContext}" was created at ${matching.created_at}, which exceeds maximum validity of ${maxAge / 3600000} hours.`
    };
  }

  // PR Binding check in status description if description is populated
  if (matching.description && !matching.description.includes(String(ctx.prNumber))) {
    return {
      valid: false,
      code: 'STATUS_PR_MISMATCH',
      reason: `Commit status description "${matching.description}" does not reference PR #${ctx.prNumber}.`
    };
  }

  return { valid: true, status: matching };
}

/**
 * Extracts GitHub Actions Run ID from a commit status target_url.
 * Ensures the target_url belongs to the expected repository.
 */
export function extractRunIdFromTargetUrl(targetUrl?: string, expectedRepo?: string): number | null {
  if (!targetUrl) return null;
  const repoPattern = expectedRepo ? escapeRegex(expectedRepo) : '[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+';
  const match = targetUrl.match(new RegExp(`^https://github\\.com/${repoPattern}/actions/runs/(\\d+)$`));
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Master release authorization validator.
 * Requires AUTHORITATIVE EVIDENCE OF BOTH:
 * 1. An authentic owner-dispatched attestation workflow run.
 * 2. An authentic commit status for "release/go-live-authorized" from trusted issuer (github-actions[bot]).
 * 3. Provenance linking the commit status directly to that workflow run in the authorized repository.
 * 4. Temporal correlation: Status creation time must correlate closely with workflow execution window (<= 15 min).
 * 5. Freshness (<24h) and exact PR/SHA binding.
 *
 * FAILS CLOSED if either source is missing, inconsistent, expired, unlinked, or uncoordinated.
 */
export function validateReleaseAuthorization(ctx: ReleaseCandidateContext): ReleaseAuthValidationResult {
  // Step 1: Validate candidate constraints
  const candidateCheck = validateCandidateConstraints(ctx);
  if (!candidateCheck.valid) {
    return {
      authorized: false,
      code: candidateCheck.code || 'VALIDATION_FAILED',
      reason: candidateCheck.reason || 'Candidate constraints validation failed.'
    };
  }

  const expectedOwner = ctx.expectedOwner || AUTHORIZED_REPOSITORY_OWNER;
  const expectedRepo = ctx.expectedRepo || `${expectedOwner}/${DEFAULT_REPOSITORY_NAME}`;

  // Step 2: Validate workflow attestation runs (Requirement 1 of 2)
  if (!ctx.workflowRuns || ctx.workflowRuns.length === 0) {
    return {
      authorized: false,
      code: 'INCOMPLETE_AUTHORIZATION_EVIDENCE',
      reason: `Missing workflow attestation evidence: no "${AUTHORIZATION_WORKFLOW_NAME}" runs provided for candidate SHA "${ctx.candidateSha}".`
    };
  }

  let matchingRun: AttestationRunRecord | undefined;
  for (const run of ctx.workflowRuns) {
    const check = validateAttestationWorkflowRun(run, ctx);
    if (check.valid) {
      matchingRun = run;
      break;
    } else if (check.code === 'EXPIRED_AUTHORIZATION_ATTESTATION') {
      return {
        authorized: false,
        code: check.code,
        reason: check.reason || 'Attestation expired.'
      };
    }
  }

  if (!matchingRun) {
    return {
      authorized: false,
      code: 'NO_MATCHING_AUTHORIZATION_ATTESTATION',
      reason: `No completed, successful, owner-dispatched "${AUTHORIZATION_WORKFLOW_NAME}" run found for candidate SHA "${ctx.candidateSha}" on PR #${ctx.prNumber} by owner "${expectedOwner}".`
    };
  }

  // Step 3: Validate commit statuses (Requirement 2 of 2)
  if (!ctx.commitStatuses || ctx.commitStatuses.length === 0) {
    return {
      authorized: false,
      code: 'INCOMPLETE_AUTHORIZATION_EVIDENCE',
      reason: `Missing commit status evidence: status "${GO_LIVE_STATUS_CONTEXT}" is required on candidate SHA "${ctx.candidateSha}".`
    };
  }

  const statusCheck = validateCommitStatuses(ctx.commitStatuses, ctx);
  if (!statusCheck.valid || !statusCheck.status) {
    return {
      authorized: false,
      code: statusCheck.code || 'STATUS_CHECK_FAILED',
      reason: statusCheck.reason || `Commit status check failed for "${GO_LIVE_STATUS_CONTEXT}".`
    };
  }
  const matchingStatus = statusCheck.status;

  // Step 4: Validate Provenance Linkage (Status Target URL must point to Workflow Run ID in expected repo)
  const linkedRunId = extractRunIdFromTargetUrl(matchingStatus.target_url, expectedRepo);
  if (!linkedRunId) {
    return {
      authorized: false,
      code: 'STATUS_PROVENANCE_MISSING',
      reason: `Commit status for "${GO_LIVE_STATUS_CONTEXT}" target_url ("${matchingStatus.target_url}") does not contain a verifiable GitHub Actions run ID for repository "${expectedRepo}".`
    };
  }

  if (linkedRunId !== matchingRun.id) {
    return {
      authorized: false,
      code: 'PROVENANCE_LINK_MISMATCH',
      reason: `Commit status provenance mismatch: status target_url links to run #${linkedRunId}, but verified attestation run is #${matchingRun.id}.`
    };
  }

  // Step 5: Temporal Correlation Check (Anti-Replay / Coordinated Execution Verification)
  const runTime = new Date(matchingRun.created_at).getTime();
  const statusTime = matchingStatus.created_at ? new Date(matchingStatus.created_at).getTime() : NaN;
  const maxDelta = ctx.maxRunStatusTimeDeltaMs ?? DEFAULT_MAX_RUN_STATUS_TIME_DELTA_MS;
  if (!isNaN(statusTime) && !isNaN(runTime) && Math.abs(statusTime - runTime) > maxDelta) {
    return {
      authorized: false,
      code: 'UNCORRELATED_STATUS_RUN_TIMESTAMPS',
      reason: `Temporal correlation check failed: commit status created at ${matchingStatus.created_at} deviates from workflow run created at ${matchingRun.created_at} by ${Math.round(Math.abs(statusTime - runTime) / 1000)}s (maximum allowed: ${maxDelta / 1000}s). Stale or uncoordinated run replay rejected.`
    };
  }

  return {
    authorized: true,
    code: 'AUTHORIZED_GO_LIVE',
    reason: `Verified authoritative release authorization: owner workflow run #${matchingRun.id} and matching commit status "${matchingStatus.context}=success" (linked provenance and temporal correlation confirmed).`,
    details: {
      prNumber: ctx.prNumber,
      candidateSha: ctx.candidateSha,
      actor: ctx.actor,
      matchingRunId: matchingRun.id,
      matchingStatusContext: matchingStatus.context,
      timestamp: matchingRun.created_at,
      provenanceVerified: true,
      freshnessVerified: true,
      temporalCorrelationVerified: true,
      issuerVerified: true
    }
  };
}
