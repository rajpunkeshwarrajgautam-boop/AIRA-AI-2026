import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CERTIFIED_STAGING_ORIGIN,
  assertPr178StagingDestination,
  assertStagingTargetUrl,
  assertStagingEndpointUrl,
  assertAllowedOAuthNavigation
} from './helpers/pr178-staging-host-guard.js';

test('Staging Host Guard: accepts exact certified staging origin', () => {
  assert.equal(assertPr178StagingDestination('https://staging.virexaaiventures.com'), CERTIFIED_STAGING_ORIGIN);
  assert.equal(assertPr178StagingDestination('https://staging.virexaaiventures.com/'), CERTIFIED_STAGING_ORIGIN);
  assert.equal(assertPr178StagingDestination('  https://staging.virexaaiventures.com  '), CERTIFIED_STAGING_ORIGIN);
  assert.equal(assertStagingTargetUrl('https://staging.virexaaiventures.com'), CERTIFIED_STAGING_ORIGIN);
});

test('Staging Host Guard: strictly rejects production domains', () => {
  assert.throws(
    () => assertPr178StagingDestination('https://aira-ai-2026.vercel.app'),
    /PR178_CERTIFICATION_DESTINATION_REJECTED/
  );
  assert.throws(
    () => assertPr178StagingDestination('https://aira-ai-2026.vercel.app/'),
    /PR178_CERTIFICATION_DESTINATION_REJECTED/
  );
});

test('Staging Host Guard: strictly rejects Vercel preview domains', () => {
  assert.throws(
    () => assertPr178StagingDestination('https://aira-ai-2026-git-fix-auth.vercel.app'),
    /PR178_CERTIFICATION_DESTINATION_REJECTED/
  );
  assert.throws(
    () => assertPr178StagingDestination('https://aira-ai-2026-preview.vercel.app'),
    /PR178_CERTIFICATION_DESTINATION_REJECTED/
  );
});

test('Staging Host Guard: strictly rejects arbitrary HTTPS domains', () => {
  assert.throws(() => assertPr178StagingDestination('https://attacker.com'), /PR178_CERTIFICATION_DESTINATION_REJECTED/);
  assert.throws(() => assertPr178StagingDestination('https://example.com'), /PR178_CERTIFICATION_DESTINATION_REJECTED/);
  assert.throws(() => assertPr178StagingDestination('https://google.com'), /PR178_CERTIFICATION_DESTINATION_REJECTED/);
});

test('Staging Host Guard: strictly rejects lookalike domains and subdomains', () => {
  // Attacker-controlled suffix
  assert.throws(
    () => assertPr178StagingDestination('https://staging.virexaaiventures.com.attacker.com'),
    /PR178_CERTIFICATION_DESTINATION_REJECTED/
  );
  // Hyphenated lookalike
  assert.throws(
    () => assertPr178StagingDestination('https://staging-virexaaiventures.com'),
    /PR178_CERTIFICATION_DESTINATION_REJECTED/
  );
  // Apex domain
  assert.throws(
    () => assertPr178StagingDestination('https://virexaaiventures.com'),
    /PR178_CERTIFICATION_DESTINATION_REJECTED/
  );
  // Subdomain of staging
  assert.throws(
    () => assertPr178StagingDestination('https://sub.staging.virexaaiventures.com'),
    /PR178_CERTIFICATION_DESTINATION_REJECTED/
  );
});

test('Staging Host Guard: strictly rejects insecure HTTP protocol', () => {
  assert.throws(
    () => assertPr178StagingDestination('http://staging.virexaaiventures.com'),
    /PR178_CERTIFICATION_DESTINATION_REJECTED: insecure protocol/
  );
  assert.throws(
    () => assertPr178StagingDestination('http://localhost:3000'),
    /PR178_CERTIFICATION_DESTINATION_REJECTED/
  );
});

test('Staging Host Guard: strictly rejects embedded credentials', () => {
  assert.throws(
    () => assertPr178StagingDestination('https://admin:secret@staging.virexaaiventures.com'),
    /embedded credentials are strictly forbidden/
  );
  assert.throws(
    () => assertPr178StagingDestination('https://user@staging.virexaaiventures.com'),
    /embedded credentials are strictly forbidden/
  );
});

test('Staging Host Guard: strictly rejects non-standard ports', () => {
  assert.throws(
    () => assertPr178StagingDestination('https://staging.virexaaiventures.com:8443'),
    /unexpected port "8443"/
  );
  assert.throws(
    () => assertPr178StagingDestination('https://staging.virexaaiventures.com:3000'),
    /unexpected port "3000"/
  );
});

test('Staging Host Guard: strictly rejects base staging URL with unexpected subpaths, queries, fragments', () => {
  assert.throws(
    () => assertPr178StagingDestination('https://staging.virexaaiventures.com/api/admin'),
    /cannot contain subpaths/
  );
  assert.throws(
    () => assertPr178StagingDestination('https://staging.virexaaiventures.com/?token=evil'),
    /cannot contain query parameters/
  );
  assert.throws(
    () => assertPr178StagingDestination('https://staging.virexaaiventures.com/#fragment'),
    /cannot contain fragments/
  );
});

test('Staging Host Guard: strictly rejects null, undefined, empty, or non-string inputs', () => {
  assert.throws(() => assertPr178StagingDestination(null), /must be a non-empty string/);
  assert.throws(() => assertPr178StagingDestination(undefined), /must be a non-empty string/);
  assert.throws(() => assertPr178StagingDestination(''), /must be a non-empty string/);
  assert.throws(() => assertPr178StagingDestination('   '), /must be a non-empty string/);
  assert.throws(() => assertPr178StagingDestination(12345), /must be a non-empty string/);
});

test('Staging Host Guard: environment variable override validation', () => {
  const originalEnv = process.env.AIRA_STAGING_URL;
  try {
    // Valid override
    process.env.AIRA_STAGING_URL = 'https://staging.virexaaiventures.com';
    assert.equal(assertPr178StagingDestination(process.env.AIRA_STAGING_URL), CERTIFIED_STAGING_ORIGIN);

    // Malicious override
    process.env.AIRA_STAGING_URL = 'https://attacker.com';
    assert.throws(() => assertPr178StagingDestination(process.env.AIRA_STAGING_URL), /PR178_CERTIFICATION_DESTINATION_REJECTED/);

    // Production override
    process.env.AIRA_STAGING_URL = 'https://aira-ai-2026.vercel.app';
    assert.throws(() => assertPr178StagingDestination(process.env.AIRA_STAGING_URL), /PR178_CERTIFICATION_DESTINATION_REJECTED/);
  } finally {
    if (originalEnv !== undefined) {
      process.env.AIRA_STAGING_URL = originalEnv;
    } else {
      delete process.env.AIRA_STAGING_URL;
    }
  }
});

test('Staging Host Guard: validates endpoint URLs on staging origin', () => {
  const valid = 'https://staging.virexaaiventures.com/api/version';
  assert.equal(assertStagingEndpointUrl(valid), valid);

  assert.throws(
    () => assertStagingEndpointUrl('https://attacker.com/api/version'),
    /PR178_CERTIFICATION_ENDPOINT_REJECTED/
  );
  assert.throws(
    () => assertStagingEndpointUrl('https://aira-ai-2026.vercel.app/api/version'),
    /PR178_CERTIFICATION_ENDPOINT_REJECTED/
  );
});

test('Staging Host Guard: OAuth navigation guard controls IdP redirects', () => {
  // Staging origin is always allowed
  assert.doesNotThrow(() => assertAllowedOAuthNavigation('https://staging.virexaaiventures.com/welcome'));

  // Google IdP allowed for Google provider
  assert.doesNotThrow(() => assertAllowedOAuthNavigation('https://accounts.google.com/o/oauth2/v2/auth?client_id=123', 'google'));

  // GitHub IdP allowed for GitHub provider
  assert.doesNotThrow(() => assertAllowedOAuthNavigation('https://github.com/login/oauth/authorize?client_id=456', 'github'));

  // Untrusted external domain is blocked
  assert.throws(
    () => assertAllowedOAuthNavigation('https://evil-oauth.com/login', 'google'),
    /UNAUTHORIZED_OAUTH_NAVIGATION/
  );

  // Insecure protocol blocked
  assert.throws(
    () => assertAllowedOAuthNavigation('http://accounts.google.com/auth', 'google'),
    /UNAUTHORIZED_OAUTH_NAVIGATION: insecure protocol/
  );
});
