import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStagingLiveAcceptanceConfig } from './staging-live-acceptance-config.js';

const valid: NodeJS.ProcessEnv = {
  AIRA_PREVIEW_URL: 'https://aira-ai-2026-abc123-test-projects.vercel.app/',
  STAGING_ISOLATED_NEON_BRANCH_ID: 'br-test-disposable-123',
  STAGING_DATABASE_URL: 'postgresql://test@ep-disposable-123.ap-southeast-1.aws.neon.tech/aira_test',
  STAGING_AUTH_TEST_USER_A_EMAIL: 'a@example.invalid',
  STAGING_AUTH_TEST_USER_A_PASSWORD: 'test-a-placeholder',
  STAGING_AUTH_TEST_USER_B_EMAIL: 'b@example.invalid',
  STAGING_AUTH_TEST_USER_B_PASSWORD: 'test-b-placeholder'
};

test('live acceptance requires every secret and non-production target explicitly', () => {
  for (const key of Object.keys(valid)) {
    assert.throws(() => resolveStagingLiveAcceptanceConfig({ ...valid, [key]: undefined }), new RegExp(key));
  }
});

test('live acceptance rejects canonical production, staging alias and malformed preview addresses', () => {
  for (const preview of [
    'https://aira-ai-2026.vercel.app',
    'https://staging.virexaaiventures.com',
    'http://aira-ai-2026-abc123-test-projects.vercel.app',
    'https://other-project-abc123.vercel.app',
    'javascript:alert(1)'
  ]) {
    assert.throws(() => resolveStagingLiveAcceptanceConfig({ ...valid, AIRA_PREVIEW_URL: preview }), /AIRA_PREVIEW_URL/);
  }
});

test('live acceptance refuses the permanent staging branch and duplicate principals', () => {
  assert.throws(() => resolveStagingLiveAcceptanceConfig({ ...valid,
    STAGING_ISOLATED_NEON_BRANCH_ID: 'br-autumn-star-b36dfu5w'
  }), /STAGING_ISOLATED_NEON_BRANCH_ID/);
  assert.throws(() => resolveStagingLiveAcceptanceConfig({ ...valid,
    STAGING_AUTH_TEST_USER_B_EMAIL: 'A@example.invalid'
  }), /distinct test account/);
});

test('live acceptance exposes no fallback credentials or database bypass', () => {
  const config = resolveStagingLiveAcceptanceConfig(valid);
  assert.equal(config.previewUrl, 'https://aira-ai-2026-abc123-test-projects.vercel.app');
  assert.equal(config.bypassSecret, '');
  assert.equal(config.isolatedBranchId, 'br-test-disposable-123');
});
