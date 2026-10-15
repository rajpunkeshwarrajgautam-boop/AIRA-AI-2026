import assert from 'node:assert/strict';
import { verifyNeonAuthToken, createNeonAuthPrincipalMiddleware } from '../apps/api/src/auth/neon-auth-principal.js';
import { NeonAuthClient } from '../src/lib/neonAuth.js';

// Real Staging Neon Auth service configured on project mute-frost-50372225, branch br-soft-pine-b3gw5nyr
const STAGING_AUTH_BASE = 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';
const STAGING_JWKS_URL = 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/.well-known/jwks.json';

process.env.NEON_AUTH_BASE_URL = STAGING_AUTH_BASE;
process.env.NEON_AUTH_JWKS_URL = STAGING_JWKS_URL;
process.env.AIRA_EXTERNAL_AUTH_ENABLED = 'true';

async function main() {
  console.log('\n=== AIRA AI 2026 — NEON AUTH STAGING E2E ACCEPTANCE SUITE ===\n');

  const timestamp = Date.now();
  const testEmail1 = `aira_test_${timestamp}_1@example.com`;
  const testEmail2 = `aira_test_${timestamp}_2@example.com`;
  const testPassword = `AiraSecure!2026_${timestamp}`;
  const origin = 'http://localhost:5173';

  // -------------------------------------------------------------
  // TEST 1: Staging Service Liveness Probe
  // -------------------------------------------------------------
  console.log('[1/10] Probing Staging Neon Better Auth endpoint...');
  const probeRes = await fetch(`${STAGING_AUTH_BASE}/ok`);
  assert.equal(probeRes.status, 200, 'Staging /ok probe must return HTTP 200');
  const probeData = await probeRes.json();
  assert.equal(probeData.ok, true, 'Staging probe must return { ok: true }');
  console.log('  ✓ Staging Neon Better Auth service is ONLINE');

  // -------------------------------------------------------------
  // TEST 2: Real User 1 Sign-Up on Staging Neon Auth
  // -------------------------------------------------------------
  console.log('[2/10] Creating verified Account 1 on Staging Neon...');
  const signupRes1 = await fetch(`${STAGING_AUTH_BASE}/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({
      email: testEmail1,
      password: testPassword,
      name: 'Primary Staging Principal'
    })
  });
  assert.equal(signupRes1.status, 200, `Sign-up failed with status ${signupRes1.status}`);
  const signupCookie1 = signupRes1.headers.get('set-cookie') || '';
  const signupData1 = await signupRes1.json();
  assert.ok(signupData1.token, 'Sign-up must return session token');
  assert.equal(signupData1.user.email, testEmail1);
  const accountId1 = signupData1.user.id;
  assert.ok(accountId1, 'User record must have valid id');
  console.log(`  ✓ Account 1 registered: ID=${accountId1}`);

  // -------------------------------------------------------------
  // TEST 3: Staging EdDSA JWT Issuance & Cryptographic Verification
  // -------------------------------------------------------------
  console.log('[3/10] Requesting EdDSA signed JWT from Staging /token...');
  const tokenRes1 = await fetch(`${STAGING_AUTH_BASE}/token`, {
    headers: {
      Authorization: `Bearer ${signupData1.token}`,
      Cookie: signupCookie1,
      Origin: origin
    }
  });
  assert.equal(tokenRes1.status, 200, `Token request failed with ${tokenRes1.status}`);
  const tokenData1 = await tokenRes1.json();
  assert.ok(tokenData1.token, 'Must return JWT token string');

  console.log('  Cryptographically verifying token with verifyNeonAuthToken (Staging JWKS)...');
  const verified1 = await verifyNeonAuthToken(tokenData1.token);
  assert.equal(verified1.userId, `neon_user_${accountId1}`, 'Principal ID must be deterministic neon_user_<sub-uuid>');
  assert.equal(verified1.provider, 'neon_auth');
  assert.equal(verified1.email, testEmail1);
  assert.ok(verified1.sessionId.startsWith('neon_session_'));
  console.log(`  ✓ Token cryptographically verified against live Staging JWKS: principal=${verified1.userId}`);

  // -------------------------------------------------------------
  // TEST 4: Clean Sign-In Workflow
  // -------------------------------------------------------------
  console.log('[4/10] Testing clean sign-in to Account 1...');
  const signinRes = await fetch(`${STAGING_AUTH_BASE}/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email: testEmail1, password: testPassword })
  });
  assert.equal(signinRes.status, 200, `Sign-in failed with status ${signinRes.status}`);
  const signinCookie = signinRes.headers.get('set-cookie') || '';
  const signinData = await signinRes.json();
  assert.equal(signinData.user.id, accountId1);
  assert.ok(signinData.token);
  console.log('  ✓ Clean sign-in succeeded');

  // -------------------------------------------------------------
  // TEST 5: Cross-Device Persistence (Browser A and Browser B)
  // -------------------------------------------------------------
  console.log('[5/10] Simulating cross-device persistence (Browser A vs Browser B)...');
  // Browser A Session
  const browserATokenRes = await fetch(`${STAGING_AUTH_BASE}/token`, {
    headers: { Authorization: `Bearer ${signinData.token}`, Cookie: signinCookie, Origin: origin, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeviceA/2026' }
  });
  const browserAJwt = (await browserATokenRes.json()).token;
  const browserAPrincipal = await verifyNeonAuthToken(browserAJwt);

  // Browser B Session (distinct login on different device)
  const browserBSignin = await fetch(`${STAGING_AUTH_BASE}/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) DeviceB/2026' },
    body: JSON.stringify({ email: testEmail1, password: testPassword })
  });
  const browserBCookie = browserBSignin.headers.get('set-cookie') || '';
  const browserBToken = (await browserBSignin.json()).token;
  const browserBTokenRes = await fetch(`${STAGING_AUTH_BASE}/token`, {
    headers: { Authorization: `Bearer ${browserBToken}`, Cookie: browserBCookie, Origin: origin, 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) DeviceB/2026' }
  });
  const browserBJwt = (await browserBTokenRes.json()).token;
  const browserBPrincipal = await verifyNeonAuthToken(browserBJwt);

  assert.equal(
    browserAPrincipal.userId,
    browserBPrincipal.userId,
    'Cross-device logins with same account MUST resolve to identical server principal'
  );
  console.log(`  ✓ Cross-device persistence verified: Both devices bind to ${browserAPrincipal.userId}`);

  // -------------------------------------------------------------
  // TEST 6: Strict Two-Account Isolation (User 1 vs User 2)
  // -------------------------------------------------------------
  console.log('[6/10] Registering Account 2 and verifying isolation...');
  const signupRes2 = await fetch(`${STAGING_AUTH_BASE}/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({
      email: testEmail2,
      password: testPassword,
      name: 'Secondary Independent Principal'
    })
  });
  assert.equal(signupRes2.status, 200);
  const signupCookie2 = signupRes2.headers.get('set-cookie') || '';
  const signupData2 = await signupRes2.json();
  const accountId2 = signupData2.user.id;
  assert.notEqual(accountId1, accountId2, 'Independent accounts must have distinct IDs');

  const tokenRes2 = await fetch(`${STAGING_AUTH_BASE}/token`, {
    headers: { Authorization: `Bearer ${signupData2.token}`, Cookie: signupCookie2, Origin: origin }
  });
  const tokenData2 = await tokenRes2.json();
  const verified2 = await verifyNeonAuthToken(tokenData2.token);

  assert.notEqual(
    verified1.userId,
    verified2.userId,
    'Distinct users MUST NOT share server execution principals'
  );
  assert.equal(verified2.userId, `neon_user_${accountId2}`);
  console.log(`  ✓ Two-account isolation confirmed: ${verified1.userId} !== ${verified2.userId}`);

  // -------------------------------------------------------------
  // TEST 7: Account Recovery (Password Reset Request)
  // -------------------------------------------------------------
  console.log('[7/10] Testing account recovery request...');
  const resetRes = await fetch(`${STAGING_AUTH_BASE}/request-password-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email: testEmail1 })
  });
  assert.equal(resetRes.status, 200, 'Password reset request must return HTTP 200');
  const resetData = await resetRes.json();
  assert.equal(resetData.status, true, 'Recovery status must be true');
  console.log('  ✓ Account recovery request succeeded');

  // -------------------------------------------------------------
  // TEST 8: Session Logout
  // -------------------------------------------------------------
  console.log('[8/10] Testing session sign-out...');
  const signoutRes = await fetch(`${STAGING_AUTH_BASE}/sign-out`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Authorization: `Bearer ${signupData2.token}`,
      Cookie: signupCookie2
    },
    body: JSON.stringify({})
  });
  assert.equal(signoutRes.status, 200, 'Sign-out must return HTTP 200');
  const signoutData = await signoutRes.json();
  assert.equal(signoutData.success, true);
  console.log('  ✓ Session signed out cleanly');

  // -------------------------------------------------------------
  // TEST 9: Client SDK Integration (NeonAuthClient)
  // -------------------------------------------------------------
  console.log('[9/10] Testing NeonAuthClient SDK lifecycle...');
  const sdkClient = new NeonAuthClient();
  sdkClient.setBaseUrl(STAGING_AUTH_BASE);

  const sdkUserEmail = `aira_sdk_${timestamp}@example.com`;
  const { user: createdUser, session: createdSession } = await sdkClient.signUp({
    email: sdkUserEmail,
    password: testPassword,
    name: 'SDK Verified User',
    preserveGuestData: true
  });
  assert.equal(createdUser.email, sdkUserEmail);
  assert.ok(createdSession.jwt, 'SDK session must include EdDSA JWT');
  assert.ok(sdkClient.isAuthenticated(), 'Client must report authenticated');

  const validJwt = await sdkClient.getValidJwt();
  assert.ok(validJwt, 'SDK must provide valid JWT');
  const verifiedSdkPrincipal = await verifyNeonAuthToken(validJwt!);
  assert.equal(verifiedSdkPrincipal.userId, `neon_user_${createdUser.id}`);

  await sdkClient.signOut();
  assert.equal(sdkClient.isAuthenticated(), false);
  console.log('  ✓ NeonAuthClient SDK lifecycle verified end-to-end');

  // -------------------------------------------------------------
  // TEST 10: Principal Middleware Boundary Checks & Guest Fallback
  // -------------------------------------------------------------
  console.log('[10/10] Verifying principal middleware boundary conditions...');
  const middleware = createNeonAuthPrincipalMiddleware();

  function invokeMiddleware(req: any): Promise<{ res: any; nextCalled: boolean }> {
    return new Promise((resolve, reject) => {
      const res: any = {
        statusCode: 200,
        body: null,
        status(code: number) { this.statusCode = code; return this; },
        json(body: any) { this.body = body; resolve({ res: this, nextCalled: false }); }
      };
      Promise.resolve(middleware(req, res, (err?: Error) => {
        if (err) reject(err);
        else resolve({ res, nextCalled: true });
      })).catch(reject);
    });
  }

  // 10A: Valid Bearer overrides guest cookie
  const guestReq: any = {
    headers: { authorization: `Bearer ${tokenData1.token}` },
    user: { id: 'usr_guest_session_123' }
  };
  const resValid = await invokeMiddleware(guestReq);
  assert.equal(resValid.nextCalled, true);
  assert.equal(guestReq.user.id, `neon_user_${accountId1}`);
  assert.equal(guestReq.managedIdentity.provider, 'neon_auth');

  // 10B: Missing Authorization header preserves guest cookie
  const unauthReq: any = { headers: {}, user: { id: 'usr_guest_preserved' } };
  const resGuest = await invokeMiddleware(unauthReq);
  assert.equal(resGuest.nextCalled, true);
  assert.equal(unauthReq.user.id, 'usr_guest_preserved', 'Guest session must remain untouched');

  // 10C: Invalid Bearer header rejects with 401 without downgrade
  const forgedReq: any = {
    headers: { authorization: 'Bearer forged.invalid.token' },
    user: { id: 'usr_guest_preserved' }
  };
  const resForged = await invokeMiddleware(forgedReq);
  assert.equal(resForged.nextCalled, false);
  assert.equal(resForged.res.statusCode, 401, 'Forged token must fail-closed with 401');

  console.log('  ✓ Middleware boundaries and guest preservation fully verified');

  console.log('\n=============================================================');
  console.log('ALL NEON AUTH STAGING E2E ACCEPTANCE CHECKS PASSED [10/10]');
  console.log('=============================================================\n');
}

main().catch((err) => {
  console.error('\n❌ NEON AUTH STAGING E2E TEST FAILED:', err);
  process.exit(1);
});
