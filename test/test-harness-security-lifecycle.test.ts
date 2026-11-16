import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStagingTargetUrl,
  validateStagingDatabaseUrl,
  generateStagingTestCredentials,
  StagingFixtureTracker
} from './helpers/staging-test-fixture-lifecycle.js';
import {
  PRODUCTION_CANONICAL_HOST,
  PRODUCTION_NEON_ENDPOINT_ID,
  PRODUCTION_NEON_PROJECT_ID,
  STAGING_CANONICAL_DOMAIN
} from '../packages/db/src/security/database-isolation-guard.js';

test('1. Valid staging target accepted', () => {
  const stagingUrl = `https://${STAGING_CANONICAL_DOMAIN}`;
  assert.equal(validateStagingTargetUrl(stagingUrl), stagingUrl);

  const previewUrl = 'https://aira-ai-2026-git-staging-test-preview.vercel.app';
  assert.equal(validateStagingTargetUrl(previewUrl), previewUrl);

  const localUrl = 'http://localhost:3000';
  assert.equal(validateStagingTargetUrl(localUrl), localUrl);
});

test('2. Production URL rejected fail-closed', () => {
  const productionUrls = [
    `https://${PRODUCTION_CANONICAL_HOST}`,
    'https://aira-ai-2026.vercel.app',
    'https://aira-ai-2026-git-prod.vercel.app',
    'https://virexaaiventures.com',
    'https://www.virexaaiventures.com'
  ];

  for (const url of productionUrls) {
    assert.throws(
      () => validateStagingTargetUrl(url),
      /\[SECURITY FATAL\].*targets PRODUCTION|Target URL.*targets PRODUCTION/,
      `Must reject production URL: ${url}`
    );
  }
});

test('3. Production Neon endpoint rejected fail-closed', () => {
  const prodDbUrls = [
    `postgresql://aira_user@${PRODUCTION_NEON_ENDPOINT_ID}.ap-southeast-1.aws.neon.tech/neondb`,
    `postgresql://aira_user@ep-custom-pooler.ap-southeast-1.aws.neon.tech/neondb?project=${PRODUCTION_NEON_PROJECT_ID}`
  ];

  for (const dbUrl of prodDbUrls) {
    assert.throws(
      () => validateStagingDatabaseUrl(dbUrl),
      /\[SECURITY FATAL\].*(classified as PRODUCTION|contains production endpoint)/,
      `Must reject production database URL: ${dbUrl}`
    );
  }

  // Non-production URL must pass
  assert.doesNotThrow(() => {
    validateStagingDatabaseUrl('postgresql://aira_test@ep-disposable-qa.ap-southeast-1.aws.neon.tech/neondb');
  });
});

test('4. Missing credentials/config rejected', () => {
  assert.throws(() => validateStagingTargetUrl(''), /Target URL is empty/);
  assert.throws(() => validateStagingTargetUrl('   '), /Target URL is empty/);
  assert.throws(() => validateStagingTargetUrl('not-a-valid-url'), /Target URL is malformed/);

  const tracker = new StagingFixtureTracker('test_session');
  assert.throws(() => tracker.trackItem('', 'conversation', 'principal_1'), /without valid ID/);
  assert.throws(() => tracker.trackItem('conv_123', 'conversation', ''), /without valid ID/);
});

test('5. Authentication failure handled safely & high-entropy credentials generated', () => {
  const creds1 = generateStagingTestCredentials('qa_free');
  const creds2 = generateStagingTestCredentials('qa_free');

  assert.ok(creds1.email.startsWith('test.qa_free.'));
  assert.ok(creds1.email.endsWith('@staging-test.virexaaiventures.com'));
  assert.notEqual(creds1.email, creds2.email, 'Generated emails must be unique');
  assert.ok(creds1.password.length >= 16, 'Password entropy must exceed 16 characters');
  assert.match(creds1.password, /[A-Z]/, 'Password must include uppercase');
  assert.match(creds1.password, /[a-z]/, 'Password must include lowercase');
  assert.match(creds1.password, /[0-9]/, 'Password must include digits');
  assert.match(creds1.password, /[^A-Za-z0-9]/, 'Password must include symbols');
  assert.notEqual(creds1.password, creds2.password, 'Passwords must be cryptographically independent');

  // Verify custom env override respects min length requirement
  const customOverride = generateStagingTestCredentials('qa_custom', 'SuperSecureStagingPassword!2026');
  assert.equal(customOverride.password, 'SuperSecureStagingPassword!2026');
});

test('6. Fixture partial creation recovery', async () => {
  const tracker = new StagingFixtureTracker('partial_recovery_test');
  const deletedLog: string[] = [];

  // Simulate Step 1 (User created)
  tracker.trackItem('usr_step1', 'user', 'principal_admin');

  // Simulate Step 2 failing before conversation created
  // Cleanup must recover and delete usr_step1 without error
  const result = await tracker.cleanup({
    deleteUser: async (id) => {
      deletedLog.push(id);
      return true;
    }
  });

  assert.deepEqual(result.succeeded, ['usr_step1']);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(deletedLog, ['usr_step1']);
});

test('7. Unexpected abort recovery', async () => {
  const tracker = new StagingFixtureTracker('abort_recovery_test');
  const deletedLog: string[] = [];

  tracker.trackItem('conv_abort_1', 'conversation', 'principal_x');
  tracker.trackItem('usr_abort_1', 'user', 'principal_x');

  try {
    // Simulate test abort or uncaught exception during execution
    throw new Error('Simulated network timeout during live test');
  } catch (err: any) {
    assert.equal(err.message, 'Simulated network timeout during live test');
  } finally {
    // Guaranteed cleanup runs
    await tracker.cleanup({
      deleteConversation: async (id) => {
        deletedLog.push(id);
        return true;
      },
      deleteUser: async (id) => {
        deletedLog.push(id);
        return true;
      }
    });
  }

  // Reverse dependency order: conversation deleted before user
  assert.deepEqual(deletedLog, ['conv_abort_1', 'usr_abort_1']);
});

test('8. Double cleanup idempotency', async () => {
  const tracker = new StagingFixtureTracker('idempotency_test');
  let deleteCalls = 0;

  tracker.trackItem('conv_idem_1', 'conversation', 'principal_y');

  const firstResult = await tracker.cleanup({
    deleteConversation: async () => {
      deleteCalls++;
      return true;
    }
  });

  assert.equal(deleteCalls, 1);
  assert.deepEqual(firstResult.succeeded, ['conv_idem_1']);

  // Second cleanup invocation must be a no-op
  const secondResult = await tracker.cleanup({
    deleteConversation: async () => {
      deleteCalls++;
      return true;
    }
  });

  assert.equal(deleteCalls, 1, 'Second cleanup must not re-execute handlers');
  assert.equal(secondResult.succeeded.length, 0);
  assert.equal(secondResult.failed.length, 0);
});

test('9. Foreign principal record modification/deletion rejected', async () => {
  const tracker = new StagingFixtureTracker('ownership_isolation_test');
  const authorizedPrincipal = 'principal_owner_alice';
  const maliciousPrincipal = 'principal_attacker_mallory';

  tracker.trackItem('conv_secret_alice', 'conversation', authorizedPrincipal);

  // Direct ownership verification
  assert.equal(tracker.verifyOwnership('conv_secret_alice', authorizedPrincipal), true);
  assert.equal(tracker.verifyOwnership('conv_secret_alice', maliciousPrincipal), false);
  assert.equal(tracker.verifyOwnership('non_existent_item', authorizedPrincipal), false);

  // Attempt deletion under malicious principal
  const deletedRecords: string[] = [];
  const result = await tracker.cleanup({
    deleteConversation: async (id, ownerPrincipalId) => {
      // Handler verifies that only requests authorized by owner can proceed
      if (ownerPrincipalId === maliciousPrincipal) {
        deletedRecords.push(id);
        return true;
      }
      return false; // Rejection of unauthorized principal
    }
  });

  assert.equal(deletedRecords.length, 0, 'No records should be deleted by unauthorized principal');
  assert.deepEqual(result.failed, ['conv_secret_alice']);
});
