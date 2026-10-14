import assert from 'node:assert/strict';
import {
  validateReleaseAuthorization,
  validateCandidateConstraints,
  validateAttestationWorkflowRun,
  validateCommitStatuses,
  extractRunIdFromTargetUrl,
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
 * unauthorized, expired, unlinked, or forged authorization claims.
 */
export async function runSecurityRegressionTests() {
  console.log('[RELEASE_AUTH_TEST] Starting 47 isolated security & policy boundary tests...');

  const validCandidateSha = 'bbf02ea572f4f710bec185890b8b86c45da15057';
  const prodReleaseExecutionSha = 'b1635e132544d0772358cb463131d1e6cd4d40a9';
  const testPr = 64;
  const owner = AUTHORIZED_REPOSITORY_OWNER;
  const now = new Date('2026-10-14T15:00:00Z');
  const validRunId = 194820194;

  const createValidRun = (overrides: Partial<AttestationRunRecord> = {}): AttestationRunRecord => ({
    id: validRunId,
    name: AUTHORIZATION_WORKFLOW_NAME,
    path: '.github/workflows/release-authorization.yml',
    head_branch: 'prod-release',
    head_sha: prodReleaseExecutionSha,
    display_title: `Release Authorization: PR #${testPr} [${validCandidateSha}] [GO LIVE ${validCandidateSha}]`,
    actor: owner,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    created_at: new Date('2026-10-14T14:30:00Z').toISOString(),
    head_repository: { full_name: `${owner}/AIRA-AI-2026` },
    repository: { full_name: `${owner}/AIRA-AI-2026` },
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
    description: `Explicit owner GO LIVE verified by ${owner} for PR #${testPr}`,
    target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/${validRunId}`,
    created_at: new Date('2026-10-14T14:30:00Z').toISOString(),
    creator: { login: 'github-actions[bot]' },
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
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
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
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
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
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_SHA_FORMAT');
    console.log('  ✓ Test 3: Truncated short SHA rejected');
  }

  // Test 4: Non-hex characters in candidate SHA
  {
    const nonHexSha = 'bbf02ea572f4f710bec185890b8b86c45da1505z';
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      candidateSha: nonHexSha,
      approvalPhrase: `GO LIVE ${nonHexSha}`,
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_SHA_FORMAT');
    console.log('  ✓ Test 4: Non-hex candidate SHA rejected');
  }

  // Test 5: Invalid PR number (zero or negative)
  {
    const resZero = validateReleaseAuthorization({
      ...baseValidCtx,
      prNumber: 0,
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(resZero.authorized, false);
    assert.equal(resZero.code, 'INVALID_PR_NUMBER');

    const resNegative = validateReleaseAuthorization({
      ...baseValidCtx,
      prNumber: -5,
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
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
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
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
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
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
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
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
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
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
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
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
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
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
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
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
      workflowRuns: [createValidRun()],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'STALE_AUTHORIZATION_HEAD_MISMATCH');
    console.log('  ✓ Test 13: Stale authorization with moved PR HEAD rejected');
  }

  // Test 14: Failed workflow run rejected
  {
    const failedRun = createValidRun({ id: 9001, conclusion: 'failure' });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [failedRun],
      commitStatuses: [createValidStatus({ target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/9001` })]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 14: Failed workflow run rejected');
  }

  // Test 15: In-progress workflow run rejected
  {
    const inProgressRun = createValidRun({ id: 9002, status: 'in_progress', conclusion: null });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [inProgressRun],
      commitStatuses: [createValidStatus({ target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/9002` })]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 15: In-progress workflow run rejected');
  }

  // Test 16: Cancelled workflow run rejected
  {
    const cancelledRun = createValidRun({ id: 9003, conclusion: 'cancelled' });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [cancelledRun],
      commitStatuses: [createValidStatus({ target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/9003` })]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 16: Cancelled workflow run rejected');
  }

  // Test 17: Unrelated workflow run (wrong name/path)
  {
    const unrelatedRun = createValidRun({
      id: 9004,
      name: 'CI',
      path: '.github/workflows/ci.yml'
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [unrelatedRun],
      commitStatuses: [createValidStatus({ target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/9004` })]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 17: Unrelated CI workflow run rejected');
  }

  // Test 18: Missing candidate_sha input in workflow run
  {
    const missingShaRun = createValidRun({
      id: 9005,
      inputs: {
        pr_number: String(testPr),
        approval_phrase: `GO LIVE ${validCandidateSha}`
      }
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [missingShaRun],
      commitStatuses: [createValidStatus({ target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/9005` })]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 18: Missing candidate_sha in workflow run inputs rejected');
  }

  // Test 19: Missing approval_phrase input in workflow run
  {
    const missingPhraseRun = createValidRun({
      id: 9006,
      inputs: {
        pr_number: String(testPr),
        candidate_sha: validCandidateSha
      }
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [missingPhraseRun],
      commitStatuses: [createValidStatus({ target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/9006` })]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 19: Missing approval_phrase in workflow run inputs rejected');
  }

  // Test 20: Missing pr_number input in workflow run
  {
    const missingPrRun = createValidRun({
      id: 9007,
      inputs: {
        candidate_sha: validCandidateSha,
        approval_phrase: `GO LIVE ${validCandidateSha}`
      }
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [missingPrRun],
      commitStatuses: [createValidStatus({ target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/9007` })]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 20: Missing pr_number in workflow run inputs rejected');
  }

  // Test 21: Mismatched PR number in workflow input
  {
    const wrongPrRun = createValidRun({
      id: 9008,
      inputs: {
        pr_number: '999',
        candidate_sha: validCandidateSha,
        approval_phrase: `GO LIVE ${validCandidateSha}`
      }
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [wrongPrRun],
      commitStatuses: [createValidStatus({ target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/9008` })]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 21: Mismatched PR number in workflow inputs rejected');
  }

  // Test 22: Expired attestation (>24 hours old)
  {
    const expiredTimestamp = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const expiredRun = createValidRun({
      id: 9009,
      created_at: expiredTimestamp
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [expiredRun],
      commitStatuses: [createValidStatus({ target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/9009` })]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'EXPIRED_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 22: Expired attestation (>24 hours) rejected');
  }

  // Test 23: Untrusted trigger event (push instead of workflow_dispatch)
  {
    const pushEventRun = createValidRun({
      id: 9010,
      event: 'push'
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [pushEventRun],
      commitStatuses: [createValidStatus({ target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/9010` })]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 23: Untrusted trigger event (push) rejected');
  }

  // Test 24: Incomplete evidence — Missing commit status (only run provided)
  {
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [createValidRun()],
      commitStatuses: [] // Missing status!
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INCOMPLETE_AUTHORIZATION_EVIDENCE');
    console.log('  ✓ Test 24: Missing commit status rejected (both run and status required)');
  }

  // Test 25: Incomplete evidence — Missing workflow run (only status provided)
  {
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [], // Missing workflow run!
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INCOMPLETE_AUTHORIZATION_EVIDENCE');
    console.log('  ✓ Test 25: Missing workflow run rejected (both run and status required)');
  }

  // Test 26: Commit status state is 'failure' (revoked)
  {
    const failedStatus = createValidStatus({ state: 'failure', description: 'Revoked by operator' });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [createValidRun()],
      commitStatuses: [failedStatus]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'STATUS_CHECK_NOT_SUCCESSFUL');
    console.log('  ✓ Test 26: Revoked / failed commit status rejected');
  }

  // Test 27: Commit status state is 'pending'
  {
    const pendingStatus = createValidStatus({ state: 'pending' });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [createValidRun()],
      commitStatuses: [pendingStatus]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'STATUS_CHECK_NOT_SUCCESSFUL');
    console.log('  ✓ Test 27: Pending commit status rejected');
  }

  // Test 28: Commit status target_url missing run ID provenance
  {
    const noProvenanceStatus = createValidStatus({ target_url: undefined });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [createValidRun()],
      commitStatuses: [noProvenanceStatus]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'STATUS_PROVENANCE_MISSING');
    console.log('  ✓ Test 28: Unverifiable status provenance rejected');
  }

  // Test 29: Commit status links to different run ID (provenance mismatch)
  {
    const mismatchedStatus = createValidStatus({
      target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/888888888` // Different run!
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [createValidRun()],
      commitStatuses: [mismatchedStatus]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'PROVENANCE_LINK_MISMATCH');
    console.log('  ✓ Test 29: Provenance link mismatch rejected');
  }

  // Test 30: Expired commit status (>24 hours old)
  {
    const expiredTimestamp = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const expiredStatus = createValidStatus({ created_at: expiredTimestamp });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [createValidRun()],
      commitStatuses: [expiredStatus]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'EXPIRED_COMMIT_STATUS');
    console.log('  ✓ Test 30: Expired commit status (>24 hours) rejected');
  }

  // Test 31: Full positive path — authentic owner workflow run + authentic commit status + verified provenance link + fresh (<24h)
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
    assert.equal(res.details?.provenanceVerified, true);
    assert.equal(res.details?.freshnessVerified, true);
    assert.equal(res.details?.temporalCorrelationVerified, true);
    assert.equal(res.details?.issuerVerified, true);
    console.log('  ✓ Test 31: Full dual-evidence positive path verified with provenance & freshness');
  }

  // Test 32: Untrusted status issuer / creator login rejected
  {
    const untrustedStatus = createValidStatus({
      creator: { login: 'malicious-attacker' }
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [createValidRun()],
      commitStatuses: [untrustedStatus]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'UNTRUSTED_STATUS_ISSUER');
    console.log('  ✓ Test 32: Untrusted status issuer (non-github-actions[bot]) rejected');
  }

  // Test 33: Forged status target_url pointing to unauthorized external repository rejected
  {
    const forgedRepoStatus = createValidStatus({
      target_url: `https://github.com/attacker-org/AIRA-AI-2026/actions/runs/${validRunId}`
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [createValidRun()],
      commitStatuses: [forgedRepoStatus]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_STATUS_TARGET_URL');
    console.log('  ✓ Test 33: Forged target_url pointing to external/unauthorized repository rejected');
  }

  // Test 34: Forged status target_url with non-numeric or malformed run ID rejected
  {
    const malformedUrlStatus = createValidStatus({
      target_url: `https://github.com/${owner}/AIRA-AI-2026/actions/runs/not-a-number`
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [createValidRun()],
      commitStatuses: [malformedUrlStatus]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'INVALID_STATUS_TARGET_URL');
    console.log('  ✓ Test 34: Forged target_url with malformed run ID rejected');
  }

  // Test 35: Malformed workflow execution commit SHA rejected
  {
    const invalidShaRun = createValidRun({
      head_sha: 'invalid-non-hex-commit-sha'
    });
    const runCheck = validateAttestationWorkflowRun(invalidShaRun, baseValidCtx);
    assert.equal(runCheck.valid, false);
    assert.equal(runCheck.code, 'INVALID_WORKFLOW_EXECUTION_SHA');

    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [invalidShaRun],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 35: Malformed workflow execution commit SHA rejected');
  }

  // Test 36: Workflow run repository mismatch rejected
  {
    const mismatchedRepoRun = createValidRun({
      head_repository: { full_name: 'attacker-org/AIRA-AI-2026' }
    });
    const runCheck = validateAttestationWorkflowRun(mismatchedRepoRun, baseValidCtx);
    assert.equal(runCheck.valid, false);
    assert.equal(runCheck.code, 'RUN_REPOSITORY_MISMATCH');

    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [mismatchedRepoRun],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 36: Workflow run repository mismatch rejected');
  }

  // Test 37: Uncorrelated status and workflow run timestamps (>15 min delta replay attack) rejected
  {
    const runOld = createValidRun({
      created_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString() // 2 hours ago
    });
    const statusNew = createValidStatus({
      created_at: new Date(now.getTime() - 5 * 60 * 1000).toISOString() // 5 minutes ago
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [runOld],
      commitStatuses: [statusNew]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'UNCORRELATED_STATUS_RUN_TIMESTAMPS');
    console.log('  ✓ Test 37: Uncorrelated status and run timestamps (>15 min delta replay attack) rejected');
  }

  // Test 38: Workflow run dispatched on untrusted feature branch rejected
  {
    const featureBranchRun = createValidRun({
      head_branch: 'feat/untrusted-release-bypass'
    });
    const runCheck = validateAttestationWorkflowRun(featureBranchRun, baseValidCtx);
    assert.equal(runCheck.valid, false);
    assert.equal(runCheck.code, 'UNTRUSTED_WORKFLOW_BRANCH');

    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [featureBranchRun],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 38: Workflow run on untrusted feature branch rejected');
  }

  // Test 39: Workflow inputs missing, but authentic server display_title verifies candidate, PR, and phrase
  {
    const titleOnlyRun = createValidRun({
      inputs: undefined,
      display_title: `Release Authorization: PR #${testPr} [${validCandidateSha}] [GO LIVE ${validCandidateSha}]`
    });
    const runCheck = validateAttestationWorkflowRun(titleOnlyRun, baseValidCtx);
    assert.equal(runCheck.valid, true);

    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [titleOnlyRun],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, true);
    assert.equal(res.code, 'AUTHORIZED_GO_LIVE');
    console.log('  ✓ Test 39: Missing run.inputs with verified display_title accepted');
  }

  // Test 40: Workflow inputs missing and display_title lacks candidate SHA
  {
    const badShaTitleRun = createValidRun({
      inputs: undefined,
      display_title: `Release Authorization: PR #${testPr} [0000000000000000000000000000000000000000] [GO LIVE ${validCandidateSha}]`
    });
    const runCheck = validateAttestationWorkflowRun(badShaTitleRun, baseValidCtx);
    assert.equal(runCheck.valid, false);
    assert.equal(runCheck.code, 'RUN_TITLE_SHA_MISMATCH');

    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [badShaTitleRun],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 40: Display title with mismatched candidate SHA rejected');
  }

  // Test 41: Workflow inputs missing and display_title lacks PR number
  {
    const badPrTitleRun = createValidRun({
      inputs: undefined,
      display_title: `Release Authorization: PR #999 [${validCandidateSha}] [GO LIVE ${validCandidateSha}]`
    });
    const runCheck = validateAttestationWorkflowRun(badPrTitleRun, baseValidCtx);
    assert.equal(runCheck.valid, false);
    assert.equal(runCheck.code, 'RUN_TITLE_PR_MISMATCH');

    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [badPrTitleRun],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 41: Display title with mismatched PR number rejected');
  }

  // Test 42: Workflow inputs missing and display_title lacks approval phrase
  {
    const badPhraseTitleRun = createValidRun({
      inputs: undefined,
      display_title: `Release Authorization: PR #${testPr} [${validCandidateSha}] [unapproved phrase]`
    });
    const runCheck = validateAttestationWorkflowRun(badPhraseTitleRun, baseValidCtx);
    assert.equal(runCheck.valid, false);
    assert.equal(runCheck.code, 'RUN_TITLE_PHRASE_MISMATCH');

    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [badPhraseTitleRun],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'NO_MATCHING_AUTHORIZATION_ATTESTATION');
    console.log('  ✓ Test 42: Display title with mismatched approval phrase rejected');
  }

  // Test 43: Inputs and display_title both present, but display_title contradicts candidate SHA
  {
    const contradictingTitleRun = createValidRun({
      inputs: {
        pr_number: String(testPr),
        candidate_sha: validCandidateSha,
        approval_phrase: `GO LIVE ${validCandidateSha}`
      },
      display_title: `Release Authorization: PR #${testPr} [0000000000000000000000000000000000000000] [GO LIVE ${validCandidateSha}]`
    });
    const runCheck = validateAttestationWorkflowRun(contradictingTitleRun, baseValidCtx);
    assert.equal(runCheck.valid, false);
    assert.equal(runCheck.code, 'RUN_TITLE_SHA_MISMATCH');
    console.log('  ✓ Test 43: Contradicting display title rejected even if inputs present');
  }

  // Test 44: Interim workflow state — commit status is pending while workflow executes
  {
    const pendingStatus = createValidStatus({
      state: 'pending',
      description: `Attestation verification in progress by ${owner} for PR #${testPr}`
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [createValidRun()],
      commitStatuses: [pendingStatus]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'STATUS_CHECK_NOT_SUCCESSFUL');
    console.log('  ✓ Test 44: Interim pending commit status rejected (no interim merge window)');
  }

  // Test 45: Interim workflow state — commit status is failure when attestation aborts
  {
    const failureStatus = createValidStatus({
      state: 'failure',
      description: `Authorization attestation failed for PR #${testPr}`
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [createValidRun()],
      commitStatuses: [failureStatus]
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'STATUS_CHECK_NOT_SUCCESSFUL');
    console.log('  ✓ Test 45: Failed commit status on aborted attestation rejected');
  }

  // Test 46: Candidate SHA mismatch in inputs rejected
  {
    const inputMismatchedRun = createValidRun({
      inputs: {
        pr_number: String(testPr),
        candidate_sha: '0000000000000000000000000000000000000000',
        approval_phrase: `GO LIVE ${validCandidateSha}`
      }
    });
    const runCheck = validateAttestationWorkflowRun(inputMismatchedRun, baseValidCtx);
    assert.equal(runCheck.valid, false);
    assert.equal(runCheck.code, 'INPUT_SHA_MISMATCH');
    console.log('  ✓ Test 46: Mismatched candidate SHA in workflow inputs rejected');
  }

  // Test 47: Distinct workflow execution commit on prod-release authorizes candidate PR SHA
  {
    const distinctExecutionRun = createValidRun({
      head_branch: 'prod-release',
      head_sha: '1111222233334444555566667777888899990000', // distinct prod-release HEAD
      inputs: {
        pr_number: String(testPr),
        candidate_sha: validCandidateSha,
        approval_phrase: `GO LIVE ${validCandidateSha}`
      },
      display_title: `Release Authorization: PR #${testPr} [${validCandidateSha}] [GO LIVE ${validCandidateSha}]`
    });
    const res = validateReleaseAuthorization({
      ...baseValidCtx,
      workflowRuns: [distinctExecutionRun],
      commitStatuses: [createValidStatus()]
    });
    assert.equal(res.authorized, true);
    assert.equal(res.code, 'AUTHORIZED_GO_LIVE');
    assert.equal(res.details?.candidateSha, validCandidateSha);
    assert.equal(res.details?.matchingRunId, validRunId);
    console.log('  ✓ Test 47: Distinct execution commit on prod-release authorizes candidate PR SHA');
  }

  console.log('[RELEASE_AUTH_TEST] All 47 security & policy boundary tests PASSED successfully.');
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
