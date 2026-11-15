import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { assertCompletedSse } from './helpers/pr178-sse-contract.js';
import { parseBillingSummary } from '../src/lib/accountBillingTruth.js';
import { assertPr178StagingDestination } from './helpers/pr178-staging-host-guard.js';

const STAGING_URL = process.env.STAGING_URL || 'https://staging.virexaaiventures.com';
const CERTIFIED_SHA = '4edbcbd26d6e5789c3898913654377a1dad80783';
assertPr178StagingDestination(STAGING_URL); // fail closed before any FS write or request
const OUT_DIR = process.env.CERTIFICATION_OUT_DIR || path.join(process.cwd(), 'reports', 'p0-free-acceptance');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function runAuthenticatedFreeAcceptance() {
  console.log('\n========================================================================');
  console.log('  AIRA AI 2026 — AUTHENTICATED FREE-PLAN STAGING ACCEPTANCE CERTIFICATION');
  console.log('========================================================================\n');

  // Step 0: Version and environment check
  console.log('--- Step 0: Deployed Version & Environment Attestation ---');
  const verRes = await fetch(`${STAGING_URL}/api/version`, { cache: 'no-store' });
  const verData = await verRes.json();
  console.log('Staging Version:', JSON.stringify(verData));
  assert.equal(verRes.status, 200);
  assert.equal(verData.environment, 'staging');
  assert.equal(verData.commitSha, CERTIFIED_SHA, 'Never certify the wrong staging SHA');
  console.log('PASS: Deployed environment verified as "staging"');

  // Steps 1 & 2: Supported authentication flow (Sign Up / Sign In)
  console.log('\n--- Steps 1 & 2: Authenticate Free Test Account & Establish BFF Session ---');
  const testEmail = `staging.free.p0.${Date.now()}@virexaaiventures.com`;
  const testPassword = randomBytes(32).toString('base64url') + String.fromCharCode(33, 65, 97, 57);
  const testName = 'Free Tier QA Engineer';

  const signUpRes = await fetch(`${STAGING_URL}/api/auth/sign-up`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': STAGING_URL,
      'x-aira-csrf-protection': '1'
    },
    body: JSON.stringify({ email: testEmail, password: testPassword, name: testName })
  });

  assert.equal(signUpRes.status, 200, `Sign-up failed with status ${signUpRes.status}`);
  const authCookie = signUpRes.headers.get('set-cookie');
  assert.ok(authCookie, 'BFF session cookie must be set on successful authentication');
  assert.match(authCookie, /__Host-aira_auth_session=/, 'Expected first-party BFF session cookie');
  assert.match(authCookie, /httponly/i, 'BFF session cookie must be HttpOnly');
  assert.match(authCookie, /secure/i, 'BFF session cookie must be Secure');
  const signUpData = await signUpRes.json();
  assert.equal(signUpData.status, 'AUTHENTICATED');
  assert.ok(signUpData.user?.id, 'User ID must be present');
  const csrfToken = signUpData.csrfToken;
  assert.ok(csrfToken, 'CSRF token must be returned by BFF gateway');
  console.log('PASS: Successfully authenticated user via BFF gateway (sanitized user confirmed, CSRF token issued)');

  // Step 3: GET /api/auth/session
  console.log('\n--- Step 3: Verify GET /api/auth/session ---');
  const sessRes = await fetch(`${STAGING_URL}/api/auth/session`, {
    headers: {
      'Cookie': authCookie,
      'Accept': 'application/json'
    }
  });
  assert.equal(sessRes.status, 200);
  const sessData = await sessRes.json();
  assert.equal(sessData.status, 'AUTHENTICATED');
  assert.equal(sessData.user?.email, testEmail);
  assert.equal(sessData.user?.id, signUpData.user.id, 'Session principal must equal freshly authenticated user');
  console.log('PASS: GET /api/auth/session returned status AUTHENTICATED with verified user');

  // Step 4: GET /api/billing/summary
  console.log('\n--- Step 4: Verify GET /api/billing/summary ---');
  const summaryRes = await fetch(`${STAGING_URL}/api/billing/summary`, {
    headers: {
      'Cookie': authCookie,
      'Accept': 'application/json'
    }
  });
  assert.equal(summaryRes.status, 200);
  const summaryData = await summaryRes.json();
  console.log('Billing summary planId:', summaryData.planId, 'availableCredits:', summaryData.availableCredits, 'dailyChatLimit:', summaryData.dailyChatLimit);
  assert.equal(summaryData.planId, 'free', 'Authenticated account plan must be free');
  assert.equal(summaryData.dailyChatLimit, 15, 'Free tier daily chat limit must be 15');
  assert.equal(summaryData.availableCredits, 100, 'New Free account must start with 100 available credits');
  console.log('PASS: GET /api/billing/summary confirmed planId: free (15 daily chats, 100 credits)');

  // Step 5: GET /api/billing/entitlements
  console.log('\n--- Step 5: Verify GET /api/billing/entitlements ---');
  const entRes = await fetch(`${STAGING_URL}/api/billing/entitlements`, {
    headers: {
      'Cookie': authCookie,
      'Accept': 'application/json'
    }
  });
  assert.equal(entRes.status, 200);
  const entData = await entRes.json();
  console.log('Entitlements plan:', entData.plan, 'canInitiateChat:', entData.canInitiateChat);
  assert.equal(entData.plan, 'free', 'Authoritative entitlements plan must be free');
  assert.equal(entData.availableCredits, summaryData.availableCredits, 'Entitlement and summary credits must match');
  assert.equal(entData.dailyStandardChatLimit, summaryData.dailyChatLimit, 'Entitlement and summary daily limit must match');
  assert.equal(entData.canInitiateChat, true, 'New Free account must be allowed to chat');
  console.log('PASS: GET /api/billing/entitlements confirmed plan: free');

  // Step 6: Confirm both billing responses correspond to the same authenticated principal
  console.log('\n--- Step 6: Verify Principal Consistency Across Billing Responses ---');
  assert.ok(parseBillingSummary(summaryData, sessData.user.id), 'Billing summary must match canonicalized Neon session principal');
  // Entitlements deliberately omit principalId. Verify the session-to-summary canonical principal and identical entitlement metrics.
  console.log('PASS: BFF session and summary principal identical; entitlements quotas match summary');

  // Steps 8-11: Authenticated Aira Auto Streaming Test
  console.log('\n--- Steps 8-11: Authenticated Aira Auto Streaming Test ---');
  const streamRes = await fetch(`${STAGING_URL}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Cookie': authCookie,
      'Origin': STAGING_URL,
      'Content-Type': 'application/json',
      'x-aira-csrf-protection': '1',
      'x-csrf-token': csrfToken,
      'Idempotency-Key': 'idemp_free_auto_' + Date.now()
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Say hello in 3 words' }],
      model: 'aira-auto'
    })
  });

  console.log('Stream response status:', streamRes.status);
  console.log('Stream Content-Type:', streamRes.headers.get('content-type'));
  assert.equal(streamRes.status, 200, `Aira Auto on authenticated Free account must return 200. Got ${streamRes.status}`);
  assert.match(streamRes.headers.get('content-type') || '', /text\/event-stream/);

  const streamText = await streamRes.text();
  console.log('Stream length:', streamText.length);
  console.log('Stream events received:\n', streamText.split('\n\n').filter(Boolean).map(e => e.split('\n')[0]).join(', '));

  assertCompletedSse(streamText, 'Authenticated Free Aira Auto SSE');

  // Independent sequential answer probes; failures and incomplete SSE streams are fatal.
  async function verifyAnswer(prompt: string, expected: RegExp, label: string) {
    const response = await fetch(STAGING_URL + '/api/chat/stream', {
      method: 'POST',
      headers: {
        'Cookie': authCookie!, 'Origin': STAGING_URL, 'Content-Type': 'application/json',
        'x-aira-csrf-protection': '1', 'x-csrf-token': csrfToken,
        'Idempotency-Key': 'idemp_p0_cert_' + randomUUID()
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], model: 'aira-auto' })
    });
    assert.equal(response.status, 200, label + ': expected HTTP 200');
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/, label + ': expected SSE');
    const answer = assertCompletedSse(await response.text(), label);
    assert.match(answer, expected, label + ': unexpected answer');
    console.log('PASS:', label, '(answer verified; raw content intentionally not logged)');
  }
  await verifyAnswer('Calculate 6 times 7. Reply with the number only.', /\b42\b/, 'Aira Auto 42');
  await verifyAnswer('Name the color of a clear daytime sky. One word.', /\bblue\b/i, 'Aira Auto Blue');

  // Step 12: Quotas and model access remain enforced (Free cannot access Plus/Pro-only models)
  console.log('\n--- Step 12: Verify Higher Model Restriction on Free Tier ---');
  const proModelRes = await fetch(`${STAGING_URL}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Cookie': authCookie,
      'Origin': STAGING_URL,
      'Content-Type': 'application/json',
      'x-aira-csrf-protection': '1',
      'x-csrf-token': csrfToken,
      'Idempotency-Key': 'idemp_free_pro_' + Date.now()
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Test pro access' }],
      model: 'aira-pro'
    })
  });

  console.log('Pro model on Free tier status:', proModelRes.status);
  assert.equal(proModelRes.status, 403, 'Aira Pro must be restricted on Free tier');
  const proErr = await proModelRes.json();
  console.log('Pro restriction payload:', JSON.stringify(proErr));
  assert.equal(proErr.error, 'PLAN_MODEL_RESTRICTED');
  assert.equal(proErr.callerTier, 'free');
  assert.equal(proErr.requiredTier, 'plus');
  console.log('PASS: Pro model correctly restricted on Free tier (callerTier: free, requiredTier: plus)');

  // Steps 7, 8, 13: Full Microsoft Edge Browser UI Acceptance
  console.log('\n--- Steps 7, 8, 13: Microsoft Edge Playwright UI Acceptance ---');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // Add the authenticated session cookie to the browser context
  const rawCookie = authCookie.split(';')[0];
  const firstEq = rawCookie.indexOf('=');
  const cookieName = rawCookie.slice(0, firstEq).trim();
  const cookieValue = rawCookie.slice(firstEq + 1).trim();

  await context.addCookies([{
    name: cookieName,
    value: cookieValue,
    url: STAGING_URL
  }]);

  const page = await context.newPage();

  // Do not pre-seed localStorage: the browser must hydrate from the verified BFF session.

  console.log(`Navigating Microsoft Edge to ${STAGING_URL}...`);
  await page.goto(STAGING_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  await page.waitForTimeout(3000);

  // First-time Free accounts show a blocking onboarding dialog. Complete the
  // documented Skip Tour action before interacting with the underlying workspace.
  const onboarding = page.getByTestId('onboarding-walkthrough');
  if (await onboarding.isVisible().catch(() => false)) {
    await page.getByTestId('onboarding-skip-btn').click();
    await onboarding.waitFor({ state: 'detached', timeout: 10000 });
  }
  const whatsNewClose = page.locator('[data-testid="whats-new-modal"] button[aria-label="Close"]');
  if (await whatsNewClose.isVisible().catch(() => false)) {
    await whatsNewClose.click();
    await page.getByTestId('whats-new-modal').waitFor({ state: 'detached', timeout: 10000 });
  }

  const screenshot1 = path.join(OUT_DIR, '01_authenticated_free_workspace.png');
  await page.screenshot({ path: screenshot1 });
  console.log('Captured authenticated landing:', screenshot1);

  // These selectors are the actual data-testid and accessibility contracts.
  // Missing interactive elements fail the test instead of silently skipping UI coverage.
  console.log('Opening My Plan & Usage via the authenticated sidebar badge...');
  await page.getByTestId('sidebar-plan-badge').click();
  const settingsDialog = page.getByTestId('settings-dialog');
  await settingsDialog.waitFor({ state: 'visible', timeout: 15000 });
  await page.getByTestId('settings-tab-plan').click();
  await page.getByText('Daily Standard Chats', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  const modalText = await settingsDialog.innerText();
  assert.match(modalText, /\bFree\b/i, 'Settings must show authenticated Free plan');
  assert.match(modalText, /Daily Standard Chats/, 'Settings must show chat quota');
  assert.match(modalText, /Available Premium Credits/, 'Settings must show credits');
  assert.ok(!modalText.includes('Plan and usage are unavailable'), 'Settings must not show unavailable error');
  const screenshot2 = path.join(OUT_DIR, '02_authenticated_free_settings_usage.png');
  await page.screenshot({ path: screenshot2 });
  console.log('PASS: Free plan settings render with quota and wallet meters; sanitized screenshot captured');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await settingsDialog.waitFor({ state: 'detached', timeout: 10000 });

  console.log('Checking authenticated Free Aira Auto model selector...');
  const modelBtn = page.getByTestId('model-selector-button');
  let modelMenuOpened = false;
  let dismissedLateOnboarding = 0;
  // Server-side onboarding hydration may finish after Settings closes.
  // Honor the real Skip Tour control; never force-click through its modal.
  for (let attempt = 0; attempt < 3 && !modelMenuOpened; attempt++) {
    if (await onboarding.isVisible().catch(() => false)) {
      await page.getByTestId('onboarding-skip-btn').click();
      await onboarding.waitFor({ state: 'detached', timeout: 10000 });
      dismissedLateOnboarding++;
    }
    try {
      await modelBtn.click({ timeout: 2500 });
      modelMenuOpened = true;
    } catch (error) {
      if (!(await onboarding.isVisible().catch(() => false))) throw error;
    }
  }
  assert.ok(modelMenuOpened, 'Repeated onboarding overlay prevented model selector interaction');
  assert.ok(dismissedLateOnboarding <= 2, 'Onboarding persisted after repeated legitimate Skip Tour actions');
  const autoOption = page.getByTestId('model-option-aira-auto');
  await autoOption.waitFor({ state: 'visible', timeout: 10000 });
  await autoOption.click();
  assert.match(await modelBtn.innerText(), /Aira Auto/i, 'Aira Auto must remain selected');
  console.log('PASS: Aira Auto selectable without upgrade prompt (late onboarding dismissals=' + dismissedLateOnboarding + ')');

  // Step 13: Refresh page and verify persistence
  console.log('\n--- Step 13: Refresh Page & Verify Session Persistence ---');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const screenshot3 = path.join(OUT_DIR, '03_page_reloaded_persistence.png');
  await page.screenshot({ path: screenshot3 });
  console.log('Captured reloaded page state:', screenshot3);

  // Step 14: Sign Out and verify permissions revoked
  console.log('\n--- Step 14: Sign Out & Revocation Verification ---');
  const signOutRes = await fetch(`${STAGING_URL}/api/auth/sign-out`, {
    method: 'POST',
    headers: {
      'Cookie': authCookie,
      'Origin': STAGING_URL,
      'x-aira-csrf-protection': '1',
      'x-csrf-token': csrfToken
    }
  });
  console.log('Sign-out status:', signOutRes.status);
  assert.equal(signOutRes.status, 200);

  // Verify /api/auth/session is now ANONYMOUS
  const postSignOutSess = await fetch(`${STAGING_URL}/api/auth/session`, {
    headers: { 'Cookie': authCookie }
  });
  const postSignOutData = await postSignOutSess.json();
  console.log('Post-signout session status:', postSignOutData.status);
  assert.equal(postSignOutData.status, 'ANONYMOUS');
  const postSignOutBilling = await fetch(STAGING_URL + '/api/billing/summary', {
    headers: { 'Cookie': authCookie! }
  });
  assert.equal(postSignOutBilling.status, 401, 'Revoked session must not access billing');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Guest Workspace'), undefined, { timeout: 15000 });
  const guestScreenshot = path.join(OUT_DIR, '04_guest_after_signout.png');
  await page.screenshot({ path: guestScreenshot });
  console.log('PASS: Session revoked, protected billing rejected, and browser returned to Guest Workspace');

  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, 'sanitized-certification.json'), JSON.stringify({
    candidateSha: CERTIFIED_SHA,
    environment: 'staging',
    authenticationMethod: 'email-password',
    oauthProvider: 'not-verified-by-this-test',
    assertions: {
      sessionAuthenticated: true,
      freeDailyChatLimit15: true,
      initialCredits100: true,
      entitlementsAndSummaryConsistent: true,
      principalMatchesSession: true,
      sseCompletedWithContent: true,
      answers42AndBlue: true,
      restrictedProModel403: true,
      sessionRevokedOnSignOut: true,
      guestBrowserAfterSignOut: true
    },
    completedAt: new Date().toISOString()
  }, null, 2));
  console.log('\n========================================================================');
  console.log('  ALL REQUIRED ASSERTIONS PASSED ON EXACT-SHA STAGING!');
  console.log('========================================================================\n');
}

runAuthenticatedFreeAcceptance().catch(err => {
  console.error('\nACCEPTANCE FAILED:', err);
  process.exit(1);
});
