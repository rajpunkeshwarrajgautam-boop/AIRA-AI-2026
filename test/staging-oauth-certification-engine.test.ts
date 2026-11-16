/**
 * AIRA AI 2026 — Positive OAuth Certification Engine Regression Test Suite
 *
 * Verifies all 12 mandatory rules from Section 3 of the pre-release specification:
 * 1. A missing historical report cannot produce PASS.
 * 2. A historical report marked PASS is insufficient by itself.
 * 3. Provider labels alone cannot certify authentication.
 * 4. Two arbitrary user IDs cannot certify OAuth.
 * 5. A successful HTTP 302 authorization redirect cannot certify login.
 * 6. An invalid authorization code cannot produce PASS.
 * 7. A missing session produces FAIL or BLOCKED.
 * 8. A mismatched principal produces FAIL.
 * 9. Stale evidence tied to a different deployment cannot produce PASS.
 * 10. Missing required evidence causes the overall certification to remain incomplete.
 * 11. Actual sanitized successful authentication evidence can produce PASS.
 * 12. No secret material enters logs or certification artifacts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePositiveOAuthCertification,
  evaluateProviderEvidence,
  validateSanitizedRecord,
  hashPrincipalIdentifier,
  type ProviderPositiveEvidence,
} from '../scripts/oauth-positive-certification-engine.js';

const CANDIDATE_SHA = 'c08ee713f857c8f45c82f5dc59140a9619a7ff62';
const DEPLOYED_SHA = '3bab3f9e585ac7fa5ffaeaad9148d6d0bc86fa68';
const DEPLOYMENT_ID = 'dpl_9WZv3iFBJq7FzeFnT5uFVVRwHmVj';

function createValidEvidence(provider: 'google' | 'github'): ProviderPositiveEvidence {
  return {
    provider,
    timestamp: new Date().toISOString(),
    testHarnessSha: CANDIDATE_SHA,
    deployedStagingSha: DEPLOYED_SHA,
    deploymentId: DEPLOYMENT_ID,
    stagingDatabaseIdentity: 'neon://mute-frost-50372225/br-autumn-star-b36dfu5w',
    principalHash: hashPrincipalIdentifier(`user_${provider}_staging_123`),
    oauthStartObserved: true,
    callbackProcessed: true,
    codeExchangeSucceeded: true,
    providerIdentityValidated: true,
    principalMapped: true,
    sessionStatus: 'AUTHENTICATED',
    sessionObservedEndpoint: '/api/auth/session',
    sessionPersistedOnReload: true,
    logoutRevocationVerified: true,
    freeTierEntitlementsVerified: true,
    negativePathVerified: true,
  };
}

test('1. A missing historical report cannot produce PASS', () => {
  const result = evaluatePositiveOAuthCertification({});
  assert.notEqual(result.overallStatus, 'PASS', 'Missing evidence must not produce PASS');
  assert.equal(result.overallStatus, 'NOT_RUN');
});

test('2. A historical report marked PASS is insufficient by itself', () => {
  const fakeHistoricalReport = {
    overallVerdict: 'PASS',
    candidateSha: DEPLOYED_SHA,
    accountA: { provider: 'direct_oauth_aligned', userId: 'usr-1' },
    accountB: { provider: 'direct_oauth_aligned', userId: 'usr-2' },
  };

  const result = evaluatePositiveOAuthCertification({
    historicalReport: fakeHistoricalReport,
  });

  assert.notEqual(result.overallStatus, 'PASS', 'Historical report alone must never produce PASS');
  assert.equal(result.overallStatus, 'BLOCKED');
  assert.ok(result.reason.includes('contextual only and insufficient'));
});

test('3. Provider labels alone cannot certify authentication', () => {
  const labelOnlyEvidence = {
    provider: 'google',
    label: 'google/direct_oauth_aligned',
    codeExchangeSucceeded: false,
    sessionStatus: 'ANONYMOUS',
  };

  const evalResult = evaluateProviderEvidence(labelOnlyEvidence, {
    expectedDeployedSha: DEPLOYED_SHA,
  });

  assert.notEqual(evalResult.status, 'PASS');
  assert.ok(evalResult.reasons.some((r) => r.includes('codeExchangeSucceeded is false')));
});

test('4. Two arbitrary user IDs cannot certify OAuth', () => {
  const arbitraryIdsEvidence: Partial<ProviderPositiveEvidence> = {
    provider: 'google',
    principalHash: hashPrincipalIdentifier('arbitrary_id_1'),
    sessionStatus: 'INVALID',
    codeExchangeSucceeded: false,
  };

  const evalResult = evaluateProviderEvidence(arbitraryIdsEvidence, {
    expectedDeployedSha: DEPLOYED_SHA,
  });

  assert.notEqual(evalResult.status, 'PASS');
  assert.ok(evalResult.reasons.some((r) => r.includes('Session status is not AUTHENTICATED')));
});

test('5. A successful HTTP 302 authorization redirect cannot certify login', () => {
  const redirectOnlyEvidence: Partial<ProviderPositiveEvidence> = {
    provider: 'google',
    oauthStartObserved: true,
    callbackProcessed: false,
    codeExchangeSucceeded: false,
    sessionStatus: 'ANONYMOUS',
  };

  const evalResult = evaluateProviderEvidence(redirectOnlyEvidence, {
    expectedDeployedSha: DEPLOYED_SHA,
  });

  assert.notEqual(evalResult.status, 'PASS');
  assert.equal(evalResult.status, 'BLOCKED');
  assert.ok(evalResult.reasons.some((r) => r.includes('codeExchangeSucceeded is false')));
});

test('6. An invalid authorization code cannot produce PASS', () => {
  const badCodeEvidence: Partial<ProviderPositiveEvidence> = {
    provider: 'google',
    oauthStartObserved: true,
    callbackProcessed: true,
    codeExchangeSucceeded: false,
    exchangeError: 'invalid_grant',
    sessionStatus: 'ANONYMOUS',
  };

  const evalResult = evaluateProviderEvidence(badCodeEvidence, {
    expectedDeployedSha: DEPLOYED_SHA,
  });

  assert.equal(evalResult.status, 'FAIL');
  assert.ok(evalResult.reasons.some((r) => r.includes('invalid_grant')));
});

test('7. A missing session produces FAIL or BLOCKED', () => {
  const missingSessionEvidence: Partial<ProviderPositiveEvidence> = {
    provider: 'github',
    codeExchangeSucceeded: true,
    sessionStatus: 'GUEST',
  };

  const evalResult = evaluateProviderEvidence(missingSessionEvidence, {
    expectedDeployedSha: DEPLOYED_SHA,
  });

  assert.equal(evalResult.status, 'FAIL');
  assert.ok(evalResult.reasons.some((r) => r.includes('Session status is not AUTHENTICATED')));
});

test('8. A mismatched principal produces FAIL', () => {
  const badHashEvidence: Partial<ProviderPositiveEvidence> = {
    provider: 'google',
    codeExchangeSucceeded: true,
    sessionStatus: 'AUTHENTICATED',
    sessionObservedEndpoint: '/api/auth/session',
    principalHash: 'not-a-valid-sha256-hash',
  };

  const evalResult = evaluateProviderEvidence(badHashEvidence, {
    expectedDeployedSha: DEPLOYED_SHA,
  });

  assert.equal(evalResult.status, 'FAIL');
  assert.ok(evalResult.reasons.some((r) => r.includes('principalHash')));
});

test('9. Stale evidence tied to a different deployment cannot produce PASS', () => {
  const staleEvidence: ProviderPositiveEvidence = {
    ...createValidEvidence('google'),
    deployedStagingSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    deploymentId: 'dpl_OLD_DEPLOYMENT',
  };

  const evalResult = evaluateProviderEvidence(staleEvidence, {
    expectedDeployedSha: DEPLOYED_SHA,
    expectedDeploymentId: DEPLOYMENT_ID,
  });

  assert.equal(evalResult.status, 'FAIL');
  assert.ok(evalResult.reasons.some((r) => r.includes('Stale deployment evidence')));
  assert.ok(evalResult.reasons.some((r) => r.includes('Deployment ID mismatch')));
});

test('10. Missing required evidence causes the overall certification to remain incomplete', () => {
  const googleValid = createValidEvidence('google');

  // Only Google is provided, GitHub is missing
  const verdict = evaluatePositiveOAuthCertification({
    googleEvidence: googleValid,
    expectedDeployedSha: DEPLOYED_SHA,
    expectedDeploymentId: DEPLOYMENT_ID,
    expectedHarnessSha: CANDIDATE_SHA,
  });

  assert.notEqual(verdict.overallStatus, 'PASS', 'Single provider cannot certify dual-provider OAuth');
  assert.equal(verdict.googleStatus, 'PASS');
  assert.equal(verdict.githubStatus, 'NOT_RUN');
  assert.equal(verdict.overallStatus, 'BLOCKED');
  assert.ok(verdict.reason.includes('Incomplete positive OAuth certification'));
});

test('11. Actual sanitized successful authentication evidence can produce PASS', () => {
  const googleValid = createValidEvidence('google');
  const githubValid = createValidEvidence('github');

  const verdict = evaluatePositiveOAuthCertification({
    googleEvidence: googleValid,
    githubEvidence: githubValid,
    expectedDeployedSha: DEPLOYED_SHA,
    expectedDeploymentId: DEPLOYMENT_ID,
    expectedHarnessSha: CANDIDATE_SHA,
  });

  assert.equal(verdict.overallStatus, 'PASS');
  assert.equal(verdict.googleStatus, 'PASS');
  assert.equal(verdict.githubStatus, 'PASS');
  assert.equal(verdict.sanitizedRecords.length, 2);
  assert.equal(verdict.sanitizedRecords[0].finalStatus, 'PASS');
  assert.equal(verdict.sanitizedRecords[1].finalStatus, 'PASS');
});

test('12. No secret material enters logs or certification artifacts', () => {
  // Test secret detector with credential leak
  const leakedPasswordEvidence = {
    ...createValidEvidence('google'),
    rawPassword: 'SuperSecretPassword123!',
  };
  const hygieneFail = validateSanitizedRecord(leakedPasswordEvidence);
  assert.equal(hygieneFail.valid, false, 'Validator must detect raw password field');
  assert.ok(hygieneFail.violations.some((v) => v.includes('rawPassword')));

  // Test with leaked Postgres URI containing password
  const syntheticLeakedConnStr = ['postgres', 'ql://user', ':leakpass', '@example.com/db'].join('');
  const leakedUriEvidence = {
    ...createValidEvidence('github'),
    connectionString: syntheticLeakedConnStr,
  };
  const uriHygiene = validateSanitizedRecord(leakedUriEvidence);
  assert.equal(uriHygiene.valid, false, 'Validator must detect connection string password');

  // Verify that evaluating leaked evidence immediately returns FAIL
  const failEval = evaluateProviderEvidence(leakedPasswordEvidence, {
    expectedDeployedSha: DEPLOYED_SHA,
  });
  assert.equal(failEval.status, 'FAIL');
  assert.ok(failEval.reasons.some((r) => r.includes('CRITICAL_CREDENTIAL_EXPOSURE')));

  // Clean evidence must pass with zero violations
  const cleanEvidence = createValidEvidence('google');
  const cleanHygiene = validateSanitizedRecord(cleanEvidence);
  assert.equal(cleanHygiene.valid, true);
  assert.equal(cleanHygiene.violations.length, 0);
});
