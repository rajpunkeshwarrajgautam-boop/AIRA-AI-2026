import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertValidFullSha,
  assertStagingTargetUrl,
  resolveExpectedCandidateSha,
  assertDeployedShaMatches,
} from '../scripts/oauth-phase2-certify.js';

const VALID_SHA_A = '0123456789abcdef0123456789abcdef01234567';
const VALID_SHA_B = 'fedcba9876543210fedcba9876543210fedcba98';

test('oauth-phase2-certify fails closed when SHA is missing', () => {
  assert.throws(
    () =>
      resolveExpectedCandidateSha({
        argv: [],
        env: {},
        readGitHead: () => null,
      }),
    /Missing expected candidate SHA/i
  );
});

test('oauth-phase2-certify rejects empty, short, and non-hex SHA values without fallback', () => {
  assert.throws(
    () =>
      resolveExpectedCandidateSha({
        argv: [],
        env: { AIRA_EXPECTED_SHA: '' },
        readGitHead: () => VALID_SHA_A,
      }),
    /Invalid AIRA_EXPECTED_SHA/i
  );

  for (const bad of ['e55e8e1', 'HEAD', 'z'.repeat(40), '0'.repeat(39), '0'.repeat(41)]) {
    assert.throws(() => assertValidFullSha(bad, 'test SHA'), /40-character hexadecimal Git SHA/i);
    assert.throws(
      () =>
        resolveExpectedCandidateSha({
          argv: ['--expected-sha', bad],
          env: { AIRA_EXPECTED_SHA: VALID_SHA_A },
          readGitHead: () => VALID_SHA_A,
        }),
      /40-character hexadecimal Git SHA/i
    );
  }
});

test('oauth-phase2-certify resolves validated 40-char SHA from CLI, env, or Git metadata', () => {
  assert.deepEqual(
    resolveExpectedCandidateSha({
      argv: ['--expected-sha=' + VALID_SHA_A.toUpperCase()],
      env: {},
      readGitHead: () => null,
    }),
    { expectedSha: VALID_SHA_A, source: 'cli' }
  );

  assert.deepEqual(
    resolveExpectedCandidateSha({
      argv: [],
      env: { AIRA_EXPECTED_SHA: VALID_SHA_B },
      readGitHead: () => null,
    }),
    { expectedSha: VALID_SHA_B, source: 'env' }
  );

  assert.deepEqual(
    resolveExpectedCandidateSha({
      argv: [],
      env: {},
      readGitHead: () => VALID_SHA_A,
    }),
    { expectedSha: VALID_SHA_A, source: 'git-head' }
  );
});

test('oauth-phase2-certify rejects conflicting SHA environment variables', () => {
  assert.throws(
    () =>
      resolveExpectedCandidateSha({
        argv: [],
        env: { AIRA_EXPECTED_SHA: VALID_SHA_A, EXPECTED_SHA: VALID_SHA_B },
        readGitHead: () => null,
      }),
    /Conflicting SHA environment variables/i
  );
});

test('oauth-phase2-certify fails immediately on /api/version SHA mismatch or missing field', () => {
  assert.equal(assertDeployedShaMatches({ commitSha: VALID_SHA_A }, VALID_SHA_A), VALID_SHA_A);

  assert.throws(
    () => assertDeployedShaMatches({ commitSha: VALID_SHA_B }, VALID_SHA_A),
    /does not match expected candidate SHA/i
  );

  assert.throws(
    () => assertDeployedShaMatches({ commitSha: 'shortsha' }, VALID_SHA_A),
    /40-character hexadecimal Git SHA/i
  );

  assert.throws(
    () => assertDeployedShaMatches({}, VALID_SHA_A),
    /Missing or non-string deployed \/api\/version commitSha/i
  );
});

test('oauth-phase2-certify rejects production hostnames and non-HTTPS URLs', () => {
  assert.equal(
    assertStagingTargetUrl('https://staging.virexaaiventures.com/'),
    'https://staging.virexaaiventures.com'
  );

  assert.throws(
    () => assertStagingTargetUrl('https://aira-ai-2026.vercel.app'),
    /Refusing to run staging certification against production host/i
  );
  assert.throws(
    () => assertStagingTargetUrl('https://prod-release.aira.example'),
    /Refusing to run staging certification against production host/i
  );
  assert.throws(
    () => assertStagingTargetUrl('http://staging.virexaaiventures.com'),
    /HTTPS is required/i
  );
});

test('oauth-phase2-certify source code contains no hardcoded 40-character commit SHA', () => {
  const scriptSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'scripts/oauth-phase2-certify.ts'),
    'utf8'
  );
  const shaLiterals = scriptSrc.match(/\b[a-f0-9]{40}\b/gi) ?? [];
  assert.deepEqual(shaLiterals, [], `Unexpected hardcoded 40-char SHA(s): ${shaLiterals.join(', ')}`);
});
