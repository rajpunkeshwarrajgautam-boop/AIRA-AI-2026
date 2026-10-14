import assert from 'node:assert/strict';
import {
  validateReleaseAuthorization,
  validateCandidateConstraints,
  validateAttestationWorkflowRun,
  validateCommitStatuses,
  AUTHORIZED_REPOSITORY_OWNER,
  PRODUCTION_RELEASE_BRANCH,
  AUTHORIZATION_WORKFLOW_NAME,
  GO_LIVE_STATUS_CONTEXT,
  type AttestationRunRecord,
  type CommitStatusRecord,
  type ReleaseCandidateContext
} from '../src/security/release-authorization-validator.js';

/**
 * Isolated security & policy boundary tests for AIRA AI 2026 Production Release Authorization.
 * Verifies that the rules engine fails closed on all tampering, formatting, stale,
 * unauthorized, expired, or forged authorization claims.
 */
export async function runSecurityRegressionTests() {
  console.log('[RELEASE_AUTH_TEST] Starting 24 isolated security & policy boundary tests...');

  const validCandidateSha = '9ea8c6f9a15eeac9054f84ab777c45671100007c';
  const testPr = 64;
  const owner = AUTHORIZED_REPOSITORY_OWNER;
  const now = new Date('2026-10-14T15:00:00Z');

  const createValidRun = (overrides: Partial<AttestationRunRecord> = {}): AttestationRunRecord => ({
    id: 194820194,
    name: AUTHORIZATION_WORKFLOW_NAME,
    path: '.github/workflows/release-authorization.yml',
    head_sha: validCandidateSha,
    actor: owner,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    created_at: new Date('2026-10-14T14:30:00Z').toISOString(),
    inputs: {
      pr_number: String(testPr),
      candidate_sha: validCandidateSha,
      approval_phrase: `GO LIVE ${validCandidateSha}`
    },
    ...overrides
  });

  const createValidStatus = (overrides: Partial<CommitStatusRecord> = {}): CommitStatusRecord => ({
    context: GO_LIVE_STATUS_CONTEXT,
    state: 'success',
    description: `Explicit owner GO LIVE attestation verified for PR #${testPr}`,
    target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/194820194`,
    created_at: new Date('2026-10-14T14:30:00Z').toISOString(),
    ...overrides
  });

  const baseValidCtx: ReleaseCandidateContext = {
    prNumber: testPr,
    candidateSha: validCandidateSha,
    approvalPhrase: `GO LIVE ${validCandidateSha}`,
    actor: owner,
    prTargetBranch: PRODUCTION_RELEASE_BRANCH,
    prState: 'open',
    prHeadSha: validCandidateSha,
    currentTime: now
  };

  // Test 1: Missing Candidate SHA
  {
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      candidateSha: '',
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'MISSING_CANDIDATE_SHA');
    console.log('  ✓ Test 1: Missing candidate SHA rejected');
  }

  // Test 2: Uppercase Candidate SHA
  {
    const upperSha = validCandidateSha.toUpperCase();
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      candidateSha: upperSha,
      approvalPhrase: `GO LIVE ${upperSha}`,
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_SHA_FORMAT');
    console.log('  ✓ Test 2: Uppercase candidate SHA rejected');
  }

  // Test 3: Truncated 7-character short SHA
  {
    const shortSha = validCandidateSha.slice(0, 7);
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      candidateSha: shortSha,
      approvalPhrase: `GO LIVE ${shortSha}`,
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_SHA_FORMAT');
    console.log('  ✓ Test 3: Truncated short SHA rejected');
  }

  // Test 4: Non-hex characters in candidate SHA
  {
    const nonHexSha = '9ea8c6f9a15eeac9054f84ab777c45671100007z';
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      candidateSha: nonHexSha,
      approvalPhrase: `GO LIVE ${nonHexSha}`,
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_SHA_FORMAT');
    console.log('  ✓ Test 4: Non-hex candidate SHA rejected');
  }

  // Test 5: Invalid PR number (zero or negative or non-integer)
  {
    const resZero = validateReleaseAuthorization({
      ...baseValidCtx,
      prNumber: 0,
      workflowRuns: [createValidRun()]
    });
    assert.equal(resZero.authorized, false);
    assert.equal(resZero.code, 'INVALID_PR_NUMBER');

    const resNegative = validateReleaseAuthorization({
      ...baseValidCtx,
      prNumber: -5,
      workflowRuns: [createValidRun()]
    });
    assert.equal(resNegative.authorized, false);
    assert.equal(resNegative.code, 'INVALID_PR_NUMBER');
    console.log('  ✓ Test 5: Invalid PR number rejected');
  }

  // Test 6: Missing approval phrase
  {
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      approvalPhrase: '',
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_APPROVAL_PHRASE');
    console.log('  ✓ Test 6: Missing approval phrase rejected');
  }

  // Test 7: Approval phrase missing candidate SHA (bare "GO LIVE")
  {
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      approvalPhrase: 'GO LIVE',
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_APPROVAL_PHRASE');
    console.log('  ✓ Test 7: Bare approval phrase without SHA rejected');
  }

  // Test 8: Casual approval phrase ("approved" / "lgtm")
  {
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      approvalPhrase: 'LGTM approved for release',
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_APPROVAL_PHRASE');
    console.log('  ✓ Test 8: Casual approval phrase rejected');
  }

  // Test 9: Approval phrase with wrong SHA
  {
    const wrongSha = '0000000000000000000000000000000000000000';
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      approvalPhrase: `GO LIVE ${wrongSha}`,
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_APPROVAL_PHRASE');
    console.log('  ✓ Test 9: Approval phrase with wrong SHA rejected');
  }

  // Test 10: Non-owner actor rejected
  {
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      actor: 'malicious-contributor-or-bot',
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'UNAUTHORIZED_ACTOR');
    console.log('  ✓ Test 10: Non-owner actor rejected');
  }

  // Test 11: Non-prod-release target branch (attempting to release to main or feature)
  {
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      prTargetBranch: 'main',
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_TARGET_BRANCH');
    console.log('  ✓ Test 11: Non-prod-release target branch rejected');
  }

  // Test 12: Closed PR rejected
  {
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      prState: 'closed',
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'PR_NOT_OPEN');
    console.log('  ✓ Test 12: Closed PR rejected');
  }

  // Test 13: Stale authorization (PR HEAD moved after attestation)
  {
    const newHeadSha = '1111111111111111111111111111111111111111';
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      prHeadSha: newHeadSha, // PR received a new commit!
      workflowRuns: [createValidRun()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'STALE_AUTHORIZATION_HEAD_MISMATCH');
    console.log('  ✓ Test 13: Stale authorization with moved PR HEAD rejected');
  }

  // Test 14: Failed attestation workflow run rejected
  {
    const failedRun = createValidRun({ id: 9001, conclusion: 'failure' });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [failedRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 14: Failed workflow run rejected');
  }

  // Test 15: In-progress attestation workflow run rejected
  {
    const inProgressRun = createValidRun({ id: 9002, status: 'in_progress', conclusion: null });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [inProgressRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 15: In-progress workflow run rejected');
  }

  // Test 16: Cancelled attestation workflow run rejected
  {
    const cancelledRun = createValidRun({ id: 9003, conclusion: 'cancelled' });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [cancelledRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 16: Cancelled workflow run rejected');
  }

  // Test 17: Unrelated successful workflow run rejected (different workflow)
  {
    const unrelatedRun = createValidRun({
      id: 9004,
      name: 'CI',
      path: '.github/workflows/ci.yml'
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [unrelatedRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 17: Unrelated CI workflow run rejected');
  }

  // Test 18: Missing candidate_sha input in workflow run rejected (non-permissive check)
  {
    const missingShaInputRun = createValidRun({
      id: 9005,
      inputs: {
        pr_number: String(testPr),
        approval_phrase: `GO LIVE ${validCandidateSha}`
      }
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [missingShaInputRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 18: Missing candidate_sha in workflow run inputs rejected');
  }

  // Test 19: Missing approval_phrase input in workflow run rejected
  {
    const missingPhraseInputRun = createValidRun({
      id: 9006,
      inputs: {
        pr_number: String(testPr),
        candidate_sha: validCandidateSha
      }
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [missingPhraseInputRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 19: Missing approval_phrase in workflow run inputs rejected');
  }

  // Test 20: Missing pr_number input in workflow run rejected
  {
    const missingPrInputRun = createValidRun({
      id: 9007,
      inputs: {
        candidate_sha: validCandidateSha,
        approval_phrase: `GO LIVE ${validCandidateSha}`
      }
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [missingPrInputRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 20: Missing pr_number in workflow run inputs rejected');
  }

  // Test 21: Mismatched PR number in workflow input rejected
  {
    const wrongPrInputRun = createValidRun({
      id: 9008,
      inputs: {
        pr_number: '999', // Different PR!
        candidate_sha: validCandidateSha,
        approval_phrase: `GO LIVE ${validCandidateSha}`
      }
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [wrongPrInputRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 21: Mismatched PR number in workflow inputs rejected');
  }

  // Test 22: Expired attestation (>24 hours old) rejected
  {
    const expiredTimestamp = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
    const expiredRun = createValidRun({
      id: 9009,
      created_at: expiredTimestamp
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [expiredRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'EXPIRED_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 22: Expired attestation (>24 hours) rejected');
  }

  // Test 23: Untrusted trigger event (e.g. 'push' or 'pull_request' instead of 'workflow_dispatch')
  {
    const forgedEventRun = createValidRun({
      id: 9010,
      event: 'push' // Not an interactive manual dispatch!
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [forgedEventRun]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 23: Untrusted trigger event (push instead of workflow_dispatch) rejected');
  }

  // Test 24: Positive validation path — exact match on owner, phrase, PR, open state, fresh attestation & status check
  {
    const validRun = createValidRun();
    const validStatus = createValidStatus();
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [validRun],
      commitStatuses: [validStatus]
    });
    assert.equal(res.authorized, true);
    assert.equal(res.code, 'AUTHORIZED_GO_LIVE');
    assert.equal(res.details?.matchingRunId, validRun.id);
    assert.equal(res.details?.matchingStatusContext, GO_LIVE_STATUS_CONTEXT);
    assert.equal(res.details?.actor, owner);
    console.log('  ✓ Test 24: Full positive path with owner dispatch & commit status check authorized');
  }

  console.log('[RELEASE_AUTH_TEST] All 24 security & policy boundary tests PASSED successfully.');
}

async function main() {
  await runSecurityRegressionTests();
}

if (process.argv[1]?.includes('release-authorization-guard.test')) {
  main().catch(err => {
    console.error('[RELEASE_AUTH_TEST] FAILED:', err);
    process.exit(1);
  });
}
