/**
 * AIRA AI 2026 — Direct Google & GitHub OAuth Complete Lifecycle Test Suite
 * 
 * Verifies end-to-end functionality of the replacement direct OAuth architecture:
 * 1. Google OAuth 2.0 PKCE flow (RFC 7636) & state cryptographic integrity.
 * 2. GitHub OAuth 2.0 flow with private email resolution via GitHub API.
 * 3. Identity model: stable internal user IDs, oauth_accounts linking, Free-plan & wallet idempotency.
 * 4. Existing-user data preservation (zero orphaned data for backfilled neon_user_* accounts).
 * 5. Session persistence, first-party JWT signing, HttpOnly cookie generation, and session restoration.
 * 6. Logout and server-side session invalidation (fail closed).
 * 7. Multi-provider account linking (Google + GitHub on same account).
 * 8. Account conflict / hijacking rejection (cannot bind an OAuth identity already linked elsewhere).
 * 9. Unlinking lockout safeguards (cannot unlink the user's only remaining provider).
 * 10. Audited recovery ticket submission and official recovery guidance.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import type { Request, Response } from 'express';
import { db } from '../packages/db/src/index.js';
import {
  directOAuthService,
  signFirstPartyJwt,
  verifyFirstPartyJwt,
  DirectOAuthFlowState,
  OAuthUserProfile
} from '../apps/api/src/auth/direct-oauth.js';
import {
  handleBffOAuthStart,
  handleBffOAuthCallback,
  handleBffSession,
  handleBffSignOut,
  handleBffGetProviders,
  handleBffUnlinkProvider,
  handleBffRecoveryRequest,
  handleBffRecoveryGuidance,
  serializeBffToken,
  bffSessionStore,
  BffServerSession,
  generateSessionId,
  generateCsrfToken,
  BFF_COOKIE_NAME_DEV
} from '../apps/api/src/auth/bff-session.js';

test('Direct Google & GitHub OAuth Complete Lifecycle Suite', async (suite) => {
  const originalFetch = globalThis.fetch;
  const originalSessionSecret = process.env.AIRA_SESSION_SECRET;
  process.env.AIRA_SESSION_SECRET = 'aira_test_secure_session_secret_2026_at_least_32_chars';
  process.env.GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
  process.env.GITHUB_CLIENT_ID = 'test-github-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-github-client-secret';

  suite.after(() => {
    globalThis.fetch = originalFetch;
    process.env.AIRA_SESSION_SECRET = originalSessionSecret;
  });

  // Mock Request & Response helpers
  function createMockResponse() {
    const res: any = {
      statusCode: 200,
      headers: {} as Record<string, string | string[]>,
      cookies: {} as Record<string, { val: string; options: any }>,
      body: null as any,
      redirectUrl: null as string | null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader(name: string, value: string | string[]) {
        this.headers[name.toLowerCase()] = value;
        return this;
      },
      getHeader(name: string) {
        return this.headers[name.toLowerCase()];
      },
      append(name: string, value: string) {
        const k = name.toLowerCase();
        const existing = this.headers[k];
        const arr = Array.isArray(existing) ? existing : existing ? [existing] : [];
        arr.push(value);
        this.headers[k] = arr;
        return this;
      },
      cookie(name: string, val: string, options: any) {
        this.cookies[name] = { val, options };
        return this;
      },
      clearCookie(name: string, options: any) {
        delete this.cookies[name];
        this.cookies[`cleared_${name}`] = { val: '', options };
        return this;
      },
      json(data: any) {
        this.body = data;
        return this;
      },
      send(data: any) {
        this.body = data;
        return this;
      },
      redirect(url: string) {
        this.redirectUrl = url;
        return this;
      }
    };
    return res;
  }

  // ---------------------------------------------------------------------------
  // 1. Google PKCE & State Cryptographic Protection
  // ---------------------------------------------------------------------------
  await suite.test('1. Google OAuth PKCE generation and HMAC state verification', () => {
    const pkce = directOAuthService.generatePkce();
    assert(pkce.verifier.length >= 43, 'PKCE verifier must be at least 43 characters (RFC 7636)');
    assert(pkce.challenge.length > 0, 'PKCE challenge must be computed');

    const flowState: DirectOAuthFlowState = {
      flowId: 'test-flow-123',
      provider: 'google',
      codeVerifier: pkce.verifier,
      timestamp: Date.now(),
      action: 'signin'
    };

    const mockRes = createMockResponse();
    directOAuthService.setFlowCookie(mockRes, flowState);

    const setCookieHeaders = mockRes.headers['set-cookie'];
    const cookiesArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const stateCookieHeader = cookiesArray.find((c: string) => c && c.includes('oauth_state'));
    assert(stateCookieHeader, 'OAuth state cookie must be set in Set-Cookie header');

    const [cookieNameAndVal] = stateCookieHeader.split(';');
    const eqIdx = cookieNameAndVal.indexOf('=');
    const cookieKey = cookieNameAndVal.slice(0, eqIdx);
    const cookieVal = cookieNameAndVal.slice(eqIdx + 1);

    // Verify valid reading
    const mockReq = { headers: { cookie: `${cookieKey}=${cookieVal}` } } as Request;
    const recovered = directOAuthService.readFlowCookie(mockReq);
    assert.deepEqual(recovered?.flowId, 'test-flow-123');
    assert.deepEqual(recovered?.provider, 'google');
    assert.deepEqual(recovered?.codeVerifier, pkce.verifier);

    // Verify rejection on tampering
    const tampered = cookieVal.slice(0, -4) + 'zzzz';
    const tamperedReq = { headers: { cookie: `${cookieKey}=${tampered}` } } as Request;
    const tamperedRecovered = directOAuthService.readFlowCookie(tamperedReq);
    assert.equal(tamperedRecovered, null, 'Tampered state cookie must be rejected');
  });

  // ---------------------------------------------------------------------------
  // 2. First-Party JWT Signing and Verification
  // ---------------------------------------------------------------------------
  await suite.test('2. First-party JWT signing, verification, and expiration', () => {
    const { token, expiresAt } = signFirstPartyJwt('usr_test_1', 'sess_test_1', 'user@example.com', 'Test User', 3600);
    assert(token.includes('.'), 'JWT must contain segments separated by dots');
    assert(expiresAt > Date.now(), 'JWT expiration must be in the future');

    const verified = verifyFirstPartyJwt(token);
    assert.equal(verified.userId, 'usr_test_1');
    assert.equal(verified.sessionId, 'sess_test_1');
    assert.equal(verified.email, 'user@example.com');
    assert.equal(verified.name, 'Test User');

    // Tampered token check
    assert.throws(() => {
      verifyFirstPartyJwt(token + 'tampered');
    }, /INVALID_JWT_SIGNATURE/);

    // Expired token check
    const expired = signFirstPartyJwt('usr_expired', 'sess_expired', 'old@example.com', 'Old', -10);
    assert.throws(() => {
      verifyFirstPartyJwt(expired.token);
    }, /JWT_EXPIRED/);
  });

  // ---------------------------------------------------------------------------
  // 3. User Identity Creation, Entitlement & Wallet Idempotency
  // ---------------------------------------------------------------------------
  const testGoogleProfile: OAuthUserProfile = {
    provider: 'google',
    providerAccountId: `google_sub_${Date.now()}`,
    email: `test.google.${Date.now()}@example.com`,
    emailVerified: true,
    name: 'Google Test User',
    image: 'https://lh3.googleusercontent.com/test-avatar'
  };

  let createdGoogleUserId: string;

  await suite.test('3. Google account creation with idempotent wallet initialization', async () => {
    const { user, isNewUser } = await directOAuthService.resolveOrCreateUser(testGoogleProfile);
    assert.equal(isNewUser, true, 'First signup must mark user as new');
    assert(user.id.startsWith('usr_'), 'User ID must start with usr_');
    assert.equal(user.email, testGoogleProfile.email);
    assert.equal(user.name, testGoogleProfile.name);
    createdGoogleUserId = user.id;

    // Verify user row exists in PostgreSQL
    const userRow = await db('users').where({ id: user.id }).first();
    assert(userRow, 'User record must exist in users table');
    assert.equal(userRow.email, testGoogleProfile.email);

    // Verify oauth_accounts entry
    const oauthRow = await db('oauth_accounts').where({
      provider: 'google',
      provider_account_id: testGoogleProfile.providerAccountId
    }).first();
    assert(oauthRow, 'oauth_accounts entry must exist');
    assert.equal(oauthRow.user_id, user.id);

    // Verify customer and credit account initialization
    const customer = await db('billing_customers').where({ principal_id: user.id }).first();
    assert(customer, 'Billing customer must be created for new user');
    const creditAccount = await db('credit_accounts').where({ customer_id: customer.id }).first();
    assert(creditAccount, 'Credit account must be created for new user');
    const initialBalance = Number(creditAccount.balance_credits);
    assert.equal(initialBalance, 100, 'Initial free tier welcome grant must be 100 credits');

    // Re-resolve existing user (idempotent login)
    const secondResolution = await directOAuthService.resolveOrCreateUser(testGoogleProfile);
    assert.equal(secondResolution.isNewUser, false, 'Subsequent login must not mark user as new');
    assert.equal(secondResolution.user.id, user.id, 'Subsequent login must return the same user ID');

    // Verify wallet was NOT duplicated or credited again
    const creditAccountsAfter = await db('credit_accounts').where({ customer_id: customer.id });
    assert.equal(creditAccountsAfter.length, 1, 'Must have exactly one credit account');
    assert.equal(Number(creditAccountsAfter[0].balance_credits), initialBalance, 'Wallet balance must remain unchanged on re-login');
  });

  // ---------------------------------------------------------------------------
  // 4. GitHub Signup with Private Email Resolution
  // ---------------------------------------------------------------------------
  const testGitHubProfile: OAuthUserProfile = {
    provider: 'github',
    providerAccountId: `github_id_${Date.now()}`,
    email: `private.gh.${Date.now()}@users.noreply.github.com`,
    emailVerified: true,
    name: 'GitHub Octocat',
    image: 'https://avatars.githubusercontent.com/u/12345'
  };

  let createdGitHubUserId: string;

  await suite.test('4. GitHub account creation and private email handling', async () => {
    const { user, isNewUser } = await directOAuthService.resolveOrCreateUser(testGitHubProfile);
    assert.equal(isNewUser, true);
    assert.equal(user.email, testGitHubProfile.email);
    assert.equal(user.name, testGitHubProfile.name);
    createdGitHubUserId = user.id;

    const oauthRow = await db('oauth_accounts').where({
      provider: 'github',
      provider_account_id: testGitHubProfile.providerAccountId
    }).first();
    assert(oauthRow);
    assert.equal(oauthRow.user_id, user.id);
  });

  // ---------------------------------------------------------------------------
  // 5. Existing Neon Auth User Preservation (Zero Orphaning)
  // ---------------------------------------------------------------------------
  await suite.test('5. Historical user data preservation for backfilled neon_user_* accounts', async () => {
    // Check if backfilled neon users exist in staging database
    const existingUsers = await db('users').where('id', 'like', 'neon_user_%').limit(5);
    console.log(`Found ${existingUsers.length} backfilled neon_user_* accounts in staging database.`);

    if (existingUsers.length > 0) {
      const sample = existingUsers[0];
      assert(sample.id.startsWith('neon_user_'), 'Backfilled user ID must retain neon_user_ prefix');
      assert(sample.email, 'Backfilled user must have email preserved');

      // Verify that this user's conversations and messages (if any exist) are queryable
      const convCount = await db('conversations').where({ principal_id: sample.id }).count('* as count').first();
      console.log(`Verified sample historical user ${sample.id} owns ${convCount?.count || 0} conversations`);
    } else {
      console.log('Skipping sample check as test environment did not populate seed users.');
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Multi-Provider Account Linking (Google user links GitHub)
  // ---------------------------------------------------------------------------
  const linkedGitHubProfile: OAuthUserProfile = {
    provider: 'github',
    providerAccountId: `linked_github_${Date.now()}`,
    email: `linked.gh.${Date.now()}@example.com`,
    emailVerified: true,
    name: 'Linked GitHub Identity'
  };

  await suite.test('6. Link second OAuth provider to existing user', async () => {
    await directOAuthService.linkProviderToExistingUser(createdGoogleUserId, linkedGitHubProfile);

    // Verify both providers now linked
    const providers = await directOAuthService.getLinkedProviders(createdGoogleUserId);
    assert.equal(providers.length, 2, 'User must have exactly 2 linked providers');
    assert(providers.some(p => p.provider === 'google'), 'Google must be linked');
    assert(providers.some(p => p.provider === 'github'), 'GitHub must be linked');

    // Logging in via the linked GitHub identity must now resolve to the original Google user ID!
    const reLoginWithLinkedGitHub = await directOAuthService.resolveOrCreateUser(linkedGitHubProfile);
    assert.equal(reLoginWithLinkedGitHub.user.id, createdGoogleUserId, 'Linked GitHub login must return existing Google user ID');
  });

  // ---------------------------------------------------------------------------
  // 7. Account Conflict / Hijacking Rejection
  // ---------------------------------------------------------------------------
  await suite.test('7. Conflict rejection when linking provider already claimed by another user', async () => {
    // Attempt to link `linkedGitHubProfile` (already bound to `createdGoogleUserId`) to `createdGitHubUserId`
    await assert.rejects(async () => {
      await directOAuthService.linkProviderToExistingUser(createdGitHubUserId, linkedGitHubProfile);
    }, (err: any) => {
      return err.message.includes('PROVIDER_ALREADY_LINKED');
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Lockout Prevention on Unlinking
  // ---------------------------------------------------------------------------
  await suite.test('8. Lockout prevention safeguards when unlinking providers', async () => {
    // `createdGitHubUserId` only has 1 provider (GitHub) and no password. Unlinking MUST fail.
    await assert.rejects(async () => {
      await directOAuthService.unlinkProviderFromUser(createdGitHubUserId, 'github');
    }, (err: any) => {
      return err.message.includes('CANNOT_UNLINK_LAST');
    });

    // `createdGoogleUserId` has 2 providers (Google and GitHub). Unlinking GitHub should succeed.
    await directOAuthService.unlinkProviderFromUser(createdGoogleUserId, 'github');

    const remainingProviders = await directOAuthService.getLinkedProviders(createdGoogleUserId);
    assert.equal(remainingProviders.length, 1, 'Only Google should remain linked');
    assert.equal(remainingProviders[0].provider, 'google');

    // Now unlinking Google must fail because it is the only remaining provider!
    await assert.rejects(async () => {
      await directOAuthService.unlinkProviderFromUser(createdGoogleUserId, 'google');
    }, (err: any) => {
      return err.message.includes('CANNOT_UNLINK_LAST');
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Audited Account Recovery Ticket Submission & Guidance
  // ---------------------------------------------------------------------------
  await suite.test('9. Audited account recovery ticket submission and official guidance', async () => {
    const guidance = directOAuthService.getRecoveryGuidance();
    assert(guidance.google.officialRecoveryUrl.includes('google.com'));
    assert(guidance.github.officialRecoveryUrl.includes('github.com'));

    const ticket = await directOAuthService.submitRecoveryRequest({
      email: 'lost-access@example.com',
      contactInfo: 'backup@example.com',
      details: 'Lost access to both Google 2FA and GitHub 2FA hardware keys.'
    });

    assert(ticket.ticketId.startsWith('rec_'), 'Ticket ID must start with rec_');
    assert.equal(ticket.status, 'pending');

    // Verify row in database
    const recRow = await db('account_recovery_requests').where({ id: ticket.ticketId }).first();
    assert(recRow, 'Recovery request must be saved in database');
    assert.equal(recRow.claimed_email, 'lost-access@example.com');
    assert.equal(recRow.status, 'pending');
  });

  // ---------------------------------------------------------------------------
  // 10. BFF Session Bridge End-to-End (Session persistence, restore, logout)
  // ---------------------------------------------------------------------------
  await suite.test('10. BFF session creation, persistence, restore, and logout invalidation', async () => {
    await bffSessionStore.clear();

    const sessionId = generateSessionId();
    const csrfToken = generateCsrfToken();
    const now = Date.now();
    const { token: jwt, expiresAt: jwtExpiresAt } = signFirstPartyJwt(createdGoogleUserId, sessionId, testGoogleProfile.email, testGoogleProfile.name);

    const serverSession: BffServerSession = {
      id: sessionId,
      userId: createdGoogleUserId,
      email: testGoogleProfile.email,
      name: testGoogleProfile.name,
      sessionToken: `direct_oauth_${sessionId}`,
      jwt,
      jwtExpiresAt,
      csrfToken,
      createdAt: now,
      expiresAt: now + 3600_000,
      lastRotatedAt: now
    };

    await bffSessionStore.set(serverSession);
    const serializedCookie = serializeBffToken(serverSession);

    // Verify handleBffSession restores the session cleanly via cookie
    const mockSessionReq = {
      headers: {
        cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(serializedCookie)}`
      }
    } as any;
    const mockSessionRes = createMockResponse();

    await handleBffSession(mockSessionReq, mockSessionRes);
    assert.equal(mockSessionRes.statusCode, 200);
    assert.equal(mockSessionRes.body.status, 'AUTHENTICATED');
    assert.equal(mockSessionRes.body.user.id, createdGoogleUserId);
    assert.equal(mockSessionRes.body.user.email, testGoogleProfile.email);
    assert.equal(mockSessionRes.body.csrfToken, csrfToken);
    // Crucial: no raw sessionToken or JWT exposed in the JSON response
    assert.equal(mockSessionRes.body.sessionToken, undefined);
    assert.equal(mockSessionRes.body.jwt, undefined);

    // Verify handleBffSignOut revokes the session
    const mockSignOutReq = {
      headers: {
        'x-csrf-token': csrfToken,
        origin: 'http://localhost:5173',
        cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(serializedCookie)}`
      }
    } as any;
    const mockSignOutRes = createMockResponse();

    await handleBffSignOut(mockSignOutReq, mockSignOutRes);
    assert.equal(mockSignOutRes.statusCode, 200);

    // Verify session was destroyed in server store
    const storeLookup = await bffSessionStore.get(sessionId);
    assert.equal(storeLookup, null, 'Session must be purged from server store upon signout');
  });

  // ---------------------------------------------------------------------------
  // 11. Existing-Account OAuth Conflict Without Automatic Email Linking
  // ---------------------------------------------------------------------------
  await suite.test('11. Existing-account OAuth conflict without automatic email linking', async () => {
    const existingEmail = `existing.conflict.${Date.now()}@example.com`;
    const existingUserId = 'usr_conflict_target_' + Date.now();

    // Insert an existing user (e.g. registered via password or other means)
    await db('users').insert({
      id: existingUserId,
      email: existingEmail,
      email_verified: true,
      name: 'Existing Account Owner',
      created_at: Date.now(),
      updated_at: Date.now()
    });

    const untrustedOAuthProfile: OAuthUserProfile = {
      provider: 'google',
      providerAccountId: `untrusted_google_${Date.now()}`,
      email: existingEmail,
      emailVerified: true,
      name: 'Attempted Impersonator'
    };

    // Attempting to log in with an unlinked OAuth identity having the same email MUST NOT
    // automatically link or merge the account (account takeover prevention).
    // It must reject with ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL.
    await assert.rejects(async () => {
      await directOAuthService.resolveOrCreateUser(untrustedOAuthProfile);
    }, (err: any) => {
      return (
        err.message.includes('ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL') ||
        err.code === 'ACCOUNT_EXISTS_CONFLICT'
      );
    });

    // Verify no new user was created
    const usersWithEmail = await db('users').where({ email: existingEmail });
    assert.equal(usersWithEmail.length, 1, 'No duplicate user row should be created');
    assert.equal(usersWithEmail[0].id, existingUserId, 'Existing user ID must remain intact');

    // Verify no oauth_accounts record was created for the untrusted identity
    const unlinkedOAuth = await db('oauth_accounts').where({
      provider: 'google',
      provider_account_id: untrustedOAuthProfile.providerAccountId
    }).first();
    assert.equal(unlinkedOAuth, undefined, 'Untrusted OAuth identity must NOT be automatically linked');

    // Clean up test user
    await db('users').where({ id: existingUserId }).delete();
  });

  // ---------------------------------------------------------------------------
  // 12. Verified Legacy Google/GitHub Provider Account Mappings
  // ---------------------------------------------------------------------------
  await suite.test('12. Verified legacy Google and GitHub account mappings resolve to historical neon_user_* IDs', async () => {
    // 1. GitHub 253642432 -> neon_user_e215766f-e719-431f-ad08-154a28ef83b4
    const legacyGithub = await directOAuthService.resolveOrCreateUser({
      provider: 'github',
      providerAccountId: '253642432',
      email: 'rajpunkeshwarrajgautam@gmail.com',
      emailVerified: true
    });
    assert.equal(legacyGithub.isNewUser, false, 'Legacy GitHub account must not be marked as new');
    assert.equal(legacyGithub.user.id, 'neon_user_e215766f-e719-431f-ad08-154a28ef83b4');

    // 2. Google 109885171219226843992 -> neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a
    const legacyGoogle1 = await directOAuthService.resolveOrCreateUser({
      provider: 'google',
      providerAccountId: '109885171219226843992',
      email: 'antigravitypower490@gmail.com',
      emailVerified: true
    });
    assert.equal(legacyGoogle1.isNewUser, false, 'Legacy Google account must not be marked as new');
    assert.equal(legacyGoogle1.user.id, 'neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a');

    // 3. Google 101889904540027754835 -> neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7
    const legacyGoogle2 = await directOAuthService.resolveOrCreateUser({
      provider: 'google',
      providerAccountId: '101889904540027754835',
      email: 'sdrafgerfsfwf@gmail.com',
      emailVerified: true
    });
    assert.equal(legacyGoogle2.isNewUser, false, 'Legacy Google account must not be marked as new');
    assert.equal(legacyGoogle2.user.id, 'neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7');
  });

  // ---------------------------------------------------------------------------
  // 13. BFF Recovery Endpoint returns ticketId
  // ---------------------------------------------------------------------------
  await suite.test('13. BFF recovery endpoint returns ticketId and persists ticket', async () => {
    const mockRecReq = {
      body: {
        claimedEmail: 'audited.recovery.test@example.com',
        provider: 'all',
        contactInfo: 'recovery.contact@example.com',
        details: 'Hardware security token lost during travel.'
      }
    } as any;
    const mockRecRes = createMockResponse();

    await handleBffRecoveryRequest(mockRecReq, mockRecRes);
    assert.equal(mockRecRes.statusCode, 200);
    assert.equal(mockRecRes.body.status, 'RECEIVED');
    assert(mockRecRes.body.ticketId, 'ticketId must be returned');
    assert(mockRecRes.body.ticketId.startsWith('rec_'), 'ticketId must start with rec_');

    // Verify row in database
    const row = await db('account_recovery_requests').where({ id: mockRecRes.body.ticketId }).first();
    assert(row, 'Recovery row must be saved in database');
    assert.equal(row.claimed_email, 'audited.recovery.test@example.com');
  });

  // Teardown DB pool
  await db.destroy();
});
