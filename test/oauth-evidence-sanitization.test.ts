import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';

// Sanitization helpers used in Phase 1 & Phase 2 OAuth certification
export function sanitizeAccountEvidence(rawAccount: {
  userId?: string;
  userEmail?: string;
  userName?: string;
  sessionCookie?: string;
  accessToken?: string;
  authCode?: string;
  linkedProviders?: string[];
  alreadySignedIn?: boolean;
  authenticated?: boolean;
}) {
  const sanitized: Record<string, unknown> = {
    authenticated: Boolean(rawAccount.authenticated),
    alreadySignedIn: Boolean(rawAccount.alreadySignedIn),
    linkedProviders: rawAccount.linkedProviders || [],
  };

  if (rawAccount.userId) {
    sanitized.userIdPrefix = rawAccount.userId.slice(0, 14);
    sanitized.userIdHash = crypto.createHash('sha256').update(rawAccount.userId).digest('hex').slice(0, 16);
  }

  if (rawAccount.userEmail) {
    // Redact full email address; store only SHA-256 digest prefix
    sanitized.userEmailHash = crypto.createHash('sha256').update(rawAccount.userEmail).digest('hex').slice(0, 16);
  }

  // Strictly ensure NO credentials or sensitive profile information leak
  assert.equal('sessionCookie' in sanitized, false, 'sessionCookie must never be included');
  assert.equal('accessToken' in sanitized, false, 'accessToken must never be included');
  assert.equal('authCode' in sanitized, false, 'authCode must never be included');
  assert.equal('userEmail' in sanitized, false, 'Raw email must never be included');
  assert.equal('userName' in sanitized, false, 'Raw user name must never be included');

  return sanitized;
}

export function sanitizeLandedCallbackUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  // Strip all sensitive OAuth callback parameters (e.g. code, state, session_token)
  const allowedParams = new Set(['auth_success', 'auth_error']);
  const sanitizedParams = new URLSearchParams();
  for (const [key, val] of url.searchParams.entries()) {
    if (allowedParams.has(key)) {
      sanitizedParams.set(key, val);
    }
  }
  const queryStr = sanitizedParams.toString() ? `?${sanitizedParams.toString()}` : '';
  return `${url.origin}${url.pathname}${queryStr}`;
}

test('Evidence Sanitization: redacts full email, tokens, cookies, and secrets', () => {
  const raw = {
    userId: 'usr_abc1234567890xyz_prod',
    userEmail: 'real_engineer_secret@gmail.com',
    userName: 'Principal Engineer',
    sessionCookie: '__Host-aira_auth_session=mock_cookie_sig_123',
    accessToken: 'mock_bearer_token_github_synthetic_123',
    authCode: 'oauth_auth_code_mock_xyz',
    linkedProviders: ['google'],
    authenticated: true,
    alreadySignedIn: false,
  };

  const clean = sanitizeAccountEvidence(raw);

  assert.equal(clean.authenticated, true);
  assert.equal(clean.userIdPrefix, 'usr_abc1234567');
  assert.ok(clean.userIdHash, 'userIdHash must exist');
  assert.ok(clean.userEmailHash, 'userEmailHash must exist');
  assert.equal('userEmail' in clean, false, 'Raw email must not exist');
  assert.equal('userName' in clean, false, 'Raw name must not exist');
  assert.equal('sessionCookie' in clean, false, 'Cookie must not exist');
  assert.equal('accessToken' in clean, false, 'Token must not exist');
  assert.equal('authCode' in clean, false, 'Code must not exist');

  // Verify JSON serialization contains 0 occurrences of secret strings
  const serialized = JSON.stringify(clean);
  assert.ok(!serialized.includes('real_engineer_secret@gmail.com'));
  assert.ok(!serialized.includes('Principal Engineer'));
  assert.ok(!serialized.includes('secret_token'));
  assert.ok(!serialized.includes('mock_bearer_token'));
  assert.ok(!serialized.includes('oauth_auth_code'));
});

test('Evidence Sanitization: callback URL strips authorization code and state parameter', () => {
  const callbackUrl = 'https://staging.virexaaiventures.com/api/auth/oauth/google/callback?code=4%2F0AX4XfWh8&state=xyz123secret&auth_success=google_connected';
  const cleanUrl = sanitizeLandedCallbackUrl(callbackUrl);

  assert.equal(cleanUrl, 'https://staging.virexaaiventures.com/api/auth/oauth/google/callback?auth_success=google_connected');
  assert.ok(!cleanUrl.includes('code='));
  assert.ok(!cleanUrl.includes('state='));
});

test('Fixture Cleanup Boundaries: enforces that deletion filters strictly match staging fixture patterns', () => {
  // Test query predicate generation for fixture deletion
  function isSafeFixtureForDeletion(sub: { id: string; gateway: string; customer_id: string }): boolean {
    return sub.gateway === 'staging_fixture' || sub.id.startsWith('sub_staging_fixture_');
  }

  // Real user subscriptions must NEVER be eligible for deletion
  const realStripeSub = { id: 'sub_1O8xyzRealCustomer', gateway: 'stripe', customer_id: 'cust_real_1' };
  const realRazorpaySub = { id: 'sub_1O8xyzRazorpay', gateway: 'razorpay', customer_id: 'cust_real_2' };
  const stagingFixtureSub1 = { id: 'sub_staging_fixture_1794752000', gateway: 'staging_fixture', customer_id: 'cust_test_1' };
  const stagingFixtureSub2 = { id: 'sub_staging_fixture_1794752001', gateway: 'custom_mock', customer_id: 'cust_test_2' };

  assert.equal(isSafeFixtureForDeletion(realStripeSub), false, 'Real Stripe sub must never be deleted');
  assert.equal(isSafeFixtureForDeletion(realRazorpaySub), false, 'Real Razorpay sub must never be deleted');
  assert.equal(isSafeFixtureForDeletion(stagingFixtureSub1), true, 'Staging fixture sub 1 must be deleted');
  assert.equal(isSafeFixtureForDeletion(stagingFixtureSub2), true, 'Staging fixture sub 2 must be deleted');
});
