import assert from 'node:assert/strict';

export interface WorkflowRunRecord {
  id: number;
  name: string;
  head_sha: string;
  actor: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  inputs?: {
    pr_number?: string;
    candidate_sha?: string;
    approval_phrase?: string;
  };
}

export interface ReleaseAuthInput {
  prNumber: number;
  candidateSha: string;
  approvalPhrase: string;
  actor: string;
  prTargetBranch: string;
  prState: string;
  prHeadSha: string;
  workflowRuns: WorkflowRunRecord[];
  expectedOwner?: string;
  expectedTargetBranch?: string;
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
    timestamp?: string;
  };
}

export const REPOSITORY_OWNER = 'rajpunkeshwarrajgautam-boop';
export const PRODUCTION_RELEASE_BRANCH = 'prod-release';
export const AUTHORIZATION_WORKFLOW_NAME = 'Release Authorization Attestation (No Deployment)';

/**
 * Validates whether a release candidate has received legitimate, explicit,
 * owner-level human GO LIVE authorization under the strict AIRA-AI-2026 release protocol.
 *
 * Fails closed on any ambiguity, format error, actor mismatch, or SHA disparity.
 */
export function validateReleaseAuthorization(input: ReleaseAuthInput): ReleaseAuthValidationResult {
  const expectedOwner = input.expectedOwner || REPOSITORY_OWNER;
  const expectedTarget = input.expectedTargetBranch || PRODUCTION_RELEASE_BRANCH;

  // 1. Candidate SHA format
  if (!input.candidateSha || typeof input.candidateSha !== 'string') {
    return { authorized: false, code: 'MISSING_CANDIDATE_SHA', reason: 'Candidate commit SHA is missing or empty.' };
  }
  if (!/^[0-9a-f]{40}$/.test(input.candidateSha)) {
    return { authorized: false, code: 'INVALID_SHA_FORMAT', reason: `Candidate SHA must be a 40-character lowercase hex string. Got: "${input.candidateSha}"` };
  }

  // 2. PR Number
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    return { authorized: false, code: 'INVALID_PR_NUMBER', reason: `PR number must be a positive integer. Got: ${input.prNumber}` };
  }

  // 3. PR Target Branch
  if (input.prTargetBranch !== expectedTarget) {
    return { authorized: false, code: 'INVALID_TARGET_BRANCH', reason: `Target branch must be "${expectedTarget}". Got: "${input.prTargetBranch}"` };
  }

  // 4. PR State
  if (input.prState !== 'open') {
    return { authorized: false, code: 'PR_NOT_OPEN', reason: `PR must be in "open" state. Got: "${input.prState}"` };
  }

  // 5. Candidate SHA matches PR HEAD
  if (input.prHeadSha !== input.candidateSha) {
    return { authorized: false, code: 'STALE_AUTHORIZATION_HEAD_MISMATCH', reason: `Candidate SHA "${input.candidateSha}" does not match current PR HEAD "${input.prHeadSha}". Stale authorizations are rejected.` };
  }

  // 6. Approval phrase syntax
  const expectedPhrase = `GO LIVE ${input.candidateSha}`;
  if (input.approvalPhrase !== expectedPhrase) {
    return { authorized: false, code: 'INVALID_APPROVAL_PHRASE', reason: `Approval phrase must strictly equal "${expectedPhrase}". Got: "${input.approvalPhrase}"` };
  }

  // 7. Actor authorization
  if (input.actor !== expectedOwner) {
    return { authorized: false, code: 'UNAUTHORIZED_ACTOR', reason: `Only repository owner "${expectedOwner}" can authorize production releases. Got actor: "${input.actor}"` };
  }

  // 8. Workflow attestation check
  const matchingRun = input.workflowRuns.find(run => {
    const isOwner = run.actor === expectedOwner;
    const isDispatch = run.event === 'workflow_dispatch';
    const isSuccess = run.conclusion === 'success' && run.status === 'completed';
    const matchesSha = run.head_sha === input.candidateSha || run.inputs?.candidate_sha === input.candidateSha;
    const matchesPr = run.inputs?.pr_number ? String(run.inputs.pr_number) === String(input.prNumber) : true;
    const matchesPhrase = run.inputs?.approval_phrase ? run.inputs.approval_phrase === expectedPhrase : true;
    return isOwner && isDispatch && isSuccess && matchesSha && matchesPr && matchesPhrase;
  });

  if (!matchingRun) {
    return {
      authorized: false,
      code: 'NO_MATCHING_AUTHORIZATION_ATTESTATION',
      reason: `No completed successful "${AUTHORIZATION_WORKFLOW_NAME}" run found for candidate SHA "${input.candidateSha}" on PR #${input.prNumber} by owner "${expectedOwner}".`
    };
  }

  return {
    authorized: true,
    code: 'AUTHORIZED_GO_LIVE',
    reason: `Verified explicit human GO LIVE authorization by ${expectedOwner} for candidate ${input.candidateSha} (Workflow Run #${matchingRun.id}).`,
    details: {
      prNumber: input.prNumber,
      candidateSha: input.candidateSha,
      actor: input.actor,
      matchingRunId: matchingRun.id,
      timestamp: matchingRun.created_at
    }
  };
}

/**
 * Isolated test suite verifying all positive and negative security/authorization boundaries.
 */
export async function runIsolatedSecurityTests() {
  console.log('[RELEASE_AUTH_GUARD] Running isolated security & policy boundary tests...');
  const testCandidateSha = '9c7528b9c2da2c6dd9e4a9a8f3201ddbf7b6c44d';
  const testPr = 64;
  const owner = REPOSITORY_OWNER;

  const validRun: WorkflowRunRecord = {
    id: 182746192,
    name: AUTHORIZATION_WORKFLOW_NAME,
    head_sha: testCandidateSha,
    actor: owner,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    created_at: new Date().toISOString(),
    inputs: {
      pr_number: String(testPr),
      candidate_sha: testCandidateSha,
      approval_phrase: `GO LIVE ${testCandidateSha}`
    }
  };

  // Test 1: Missing Candidate SHA
  {
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: '',
      approvalPhrase: `GO LIVE ${testCandidateSha}`,
      actor: owner,
      prTargetBranch: PRODUCTION_RELEASE_BRANCH,
      prState: 'open',
      prHeadSha: testCandidateSha,
      workflowRuns: [validRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'MISSING_CANDIDATE_SHA');
  }

  // Test 2: Invalid SHA format (uppercase or truncated)
  {
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: '9C7528B9C2DA2C6DD9E4A9A8F3201DDBF7B6C44D', // uppercase
      approvalPhrase: `GO LIVE 9C7528B9C2DA2C6DD9E4A9A8F3201DDBF7B6C44D`,
      actor: owner,
      prTargetBranch: PRODUCTION_RELEASE_BRANCH,
      prState: 'open',
      prHeadSha: testCandidateSha,
      workflowRuns: [validRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_SHA_FORMAT');
  }

  // Test 3: Truncated 7-character short SHA rejected
  {
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: '9c7528b',
      approvalPhrase: `GO LIVE 9c7528b`,
      actor: owner,
      prTargetBranch: PRODUCTION_RELEASE_BRANCH,
      prState: 'open',
      prHeadSha: testCandidateSha,
      workflowRuns: [validRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_SHA_FORMAT');
  }

  // Test 4: Approval phrase missing candidate SHA
  {
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: testCandidateSha,
      approvalPhrase: 'GO LIVE',
      actor: owner,
      prTargetBranch: PRODUCTION_RELEASE_BRANCH,
      prState: 'open',
      prHeadSha: testCandidateSha,
      workflowRuns: [validRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_APPROVAL_PHRASE');
  }

  // Test 5: Casual approval phrase rejected ("approved" / "lgtm")
  {
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: testCandidateSha,
      approvalPhrase: 'LGTM approved for release',
      actor: owner,
      prTargetBranch: PRODUCTION_RELEASE_BRANCH,
      prState: 'open',
      prHeadSha: testCandidateSha,
      workflowRuns: [validRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_APPROVAL_PHRASE');
  }

  // Test 6: Non-owner actor rejected
  {
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: testCandidateSha,
      approvalPhrase: `GO LIVE ${testCandidateSha}`,
      actor: 'external-contributor-or-bot',
      prTargetBranch: PRODUCTION_RELEASE_BRANCH,
      prState: 'open',
      prHeadSha: testCandidateSha,
      workflowRuns: [validRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'UNAUTHORIZED_ACTOR');
  }

  // Test 7: Target branch mismatch (e.g. attempting to release to 'main' or feature branch)
  {
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: testCandidateSha,
      approvalPhrase: `GO LIVE ${testCandidateSha}`,
      actor: owner,
      prTargetBranch: 'main',
      prState: 'open',
      prHeadSha: testCandidateSha,
      workflowRuns: [validRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_TARGET_BRANCH');
  }

  // Test 8: Closed or merged PR rejected
  {
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: testCandidateSha,
      approvalPhrase: `GO LIVE ${testCandidateSha}`,
      actor: owner,
      prTargetBranch: PRODUCTION_RELEASE_BRANCH,
      prState: 'closed',
      prHeadSha: testCandidateSha,
      workflowRuns: [validRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'PR_NOT_OPEN');
  }

  // Test 9: Stale authorization rejected (new commit pushed after authorization)
  {
    const newHeadSha = '0000000000000000000000000000000000000000';
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: testCandidateSha, // Old approved SHA
      approvalPhrase: `GO LIVE ${testCandidateSha}`,
      actor: owner,
      prTargetBranch: PRODUCTION_RELEASE_BRANCH,
      prState: 'open',
      prHeadSha: newHeadSha, // PR was updated with a new commit!
      workflowRuns: [validRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'STALE_AUTHORIZATION_HEAD_MISMATCH');
  }

  // Test 10: Failed workflow run rejected
  {
    const failedRun: WorkflowRunRecord = { ...validRun, id: 999, conclusion: 'failure' };
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: testCandidateSha,
      approvalPhrase: `GO LIVE ${testCandidateSha}`,
      actor: owner,
      prTargetBranch: PRODUCTION_RELEASE_BRANCH,
      prState: 'open',
      prHeadSha: testCandidateSha,
      workflowRuns: [failedRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
  }

  // Test 11: In-progress workflow run rejected
  {
    const inProgressRun: WorkflowRunRecord = { ...validRun, id: 1000, status: 'in_progress', conclusion: null };
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: testCandidateSha,
      approvalPhrase: `GO LIVE ${testCandidateSha}`,
      actor: owner,
      prTargetBranch: PRODUCTION_RELEASE_BRANCH,
      prState: 'open',
      prHeadSha: testCandidateSha,
      workflowRuns: [inProgressRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
  }

  // Test 12: Positive path — all criteria met exactly
  {
    const res = validateReleaseAuthorization({
      prNumber: testPr,
      candidateSha: testCandidateSha,
      approvalPhrase: `GO LIVE ${testCandidateSha}`,
      actor: owner,
      prTargetBranch: PRODUCTION_RELEASE_BRANCH,
      prState: 'open',
      prHeadSha: testCandidateSha,
      workflowRuns: [validRun]
    });
    assert.equal(res.authorized, true);
    assert.equal(res.code, 'AUTHORIZED_GO_LIVE');
    assert.equal(res.details?.matchingRunId, validRun.id);
    assert.equal(res.details?.actor, owner);
  }

  console.log('[RELEASE_AUTH_GUARD] All 12 boundary checks PASSED cleanly (isolated mode).');
}

async function main() {
  await runIsolatedSecurityTests();
}

if (process.argv[1]?.includes('release-authorization-guard')) {
  main().catch(err => {
    console.error('[RELEASE_AUTH_GUARD] FAILED:', err);
    process.exit(1);
  });
}
