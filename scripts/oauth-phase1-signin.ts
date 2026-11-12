/**
 * AIRA AI 2026 — Phase 1: Interactive Genuine Google & GitHub OAuth in Isolated Edge Profiles
 *
 * Launches two separate headed Microsoft Edge profiles:
 *   - Profile A: Genuine Google OAuth via AIRA's UI (#signin-google-btn)
 *   - Profile B: Genuine GitHub OAuth via AIRA's UI (#signin-github-btn)
 *
 * Never captures or logs passwords, OAuth authorization codes, cookies, or secrets.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const STAGING_URL = process.env.AIRA_STAGING_URL || 'https://staging.virexaaiventures.com';
const ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts/staging-acceptance/pr164');
if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const PROFILE_A_DIR = path.resolve(process.cwd(), 'artifacts/staging-acceptance/edge_oauth_profile_a');
const PROFILE_B_DIR = path.resolve(process.cwd(), 'artifacts/staging-acceptance/edge_oauth_profile_b');

interface OAuthFlowMetadata {
  provider: 'google' | 'github';
  authorizeHost?: string;
  clientId?: string;
  redirectUri?: string;
  statePrefix?: string;
  codeChallengeMethod?: string;
  alreadySignedIn: boolean;
  callbackLandedUrl?: string;
  authenticated: boolean;
  userId?: string;
  userEmail?: string;
  userName?: string;
  linkedProviders?: string[];
  error?: string;
}

async function getSessionAndProviders(page: Page) {
  return page.evaluate(async () => {
    const sRes = await fetch('/api/auth/session', { credentials: 'include' });
    const session = await sRes.json().catch(() => null);
    let providers: any = null;
    if (session?.status === 'AUTHENTICATED' && session?.user) {
      const pRes = await fetch('/api/auth/providers', { credentials: 'include' });
      providers = await pRes.json().catch(() => null);
    }
    return { sessionStatus: sRes.status, session, providers };
  });
}

async function initiateOAuthIfNeeded(
  page: Page,
  provider: 'google' | 'github'
): Promise<OAuthFlowMetadata> {
  const meta: OAuthFlowMetadata = {
    provider,
    alreadySignedIn: false,
    authenticated: false,
  };

  await page.goto(STAGING_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const initial = await getSessionAndProviders(page);
  const existingProviders: string[] = Array.isArray(initial.providers?.providers)
    ? initial.providers.providers.map((p: any) => p.provider)
    : [];

  if (initial.session?.status === 'AUTHENTICATED' && existingProviders.includes(provider)) {
    meta.alreadySignedIn = true;
    meta.authenticated = true;
    meta.userId = initial.session.user?.id;
    meta.userEmail = initial.session.user?.email;
    meta.userName = initial.session.user?.name;
    meta.linkedProviders = existingProviders;
    console.log(`[${provider.toUpperCase()}] Profile already authenticated via ${provider} (User ID: ${meta.userId?.slice(0, 8)}...)`);
    return meta;
  }

  // If signed in with a different session or guest, sign out first to start clean
  if (initial.session?.status === 'AUTHENTICATED') {
    const csrf = initial.session.csrfToken || '';
    await page.evaluate(async ({ c }) => {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'x-aira-csrf-protection': '1', ...(c ? { 'X-CSRF-Token': c } : {}) },
        credentials: 'include',
      });
    }, { c: csrf });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
  }

  // Dismiss any tour modal if present
  const skipBtn = page.locator('button:has-text("Skip"), [aria-label="Close"]');
  if ((await skipBtn.count()) > 0) {
    try {
      await skipBtn.first().click({ timeout: 1500 });
    } catch {
      // ignore
    }
  }

  // Open sidebar if collapsed on this viewport
  const menuBtn = page.locator('[aria-label="Sign in to account and workspace menu"]');
  if ((await menuBtn.count()) === 0) {
    const openSidebar = page.locator('[aria-label="Open sidebar navigation"]');
    if ((await openSidebar.count()) > 0) {
      await openSidebar.first().click({ force: true });
      await page.waitForTimeout(400);
    }
  }
  await menuBtn.first().waitFor({ state: 'visible', timeout: 10000 });
  await menuBtn.first().click({ force: true });
  await page.waitForTimeout(400);

  const signInBtn = page.locator('button:has-text("Sign in or Create Account")');
  await signInBtn.first().click();
  await page.waitForTimeout(400);

  const oauthBtnSelector = provider === 'google' ? '#signin-google-btn' : '#signin-github-btn';
  await page.locator(oauthBtnSelector).waitFor({ state: 'visible', timeout: 5000 });

  // Capture authorize request redirect URL safely (never log secrets)
  const navPromise = page.waitForURL(
    (url) => url.hostname.includes('google.com') || url.hostname.includes('github.com'),
    { timeout: 20_000 }
  );
  await page.locator(oauthBtnSelector).click();
  await navPromise;

  const currentUrl = new URL(page.url());
  meta.authorizeHost = currentUrl.hostname;
  meta.clientId = currentUrl.searchParams.get('client_id') || undefined;

  if (provider === 'google') {
    meta.redirectUri = currentUrl.searchParams.get('redirect_uri') || undefined;
    const state = currentUrl.searchParams.get('state') || '';
    meta.statePrefix = state.slice(0, 8) + '...';
    meta.codeChallengeMethod = currentUrl.searchParams.get('code_challenge_method') || undefined;
  } else {
    const returnTo = currentUrl.searchParams.get('return_to') || '';
    const nestedParams = returnTo.includes('?') ? new URLSearchParams(returnTo.split('?')[1]) : currentUrl.searchParams;
    meta.clientId = meta.clientId || nestedParams.get('client_id') || undefined;
    meta.redirectUri = nestedParams.get('redirect_uri') || undefined;
    const state = nestedParams.get('state') || '';
    meta.statePrefix = state.startsWith('github.') ? 'github....' : state.slice(0, 8) + '...';
  }

  console.log(`[${provider.toUpperCase()}] Browser navigated to ${meta.authorizeHost} (client_id=${meta.clientId}, redirect_uri=${meta.redirectUri})`);
  console.log(`[${provider.toUpperCase()}] >>> WAITING FOR INTERACTIVE USER LOGIN & CONSENT IN MICROSOFT EDGE WINDOW <<<`);

  return meta;
}

async function waitForOAuthCompletion(
  page: Page,
  meta: OAuthFlowMetadata
): Promise<OAuthFlowMetadata> {
  if (meta.alreadySignedIn && meta.authenticated) return meta;

  const targetHost = new URL(STAGING_URL).hostname;
  await page.waitForURL(
    (url) => url.hostname === targetHost,
    { timeout: 600_000, waitUntil: 'domcontentloaded' }
  );

  const landed = new URL(page.url());
  const redactedLanded = `${landed.origin}${landed.pathname}${landed.searchParams.has('auth_success') ? '?auth_success=' + landed.searchParams.get('auth_success') : landed.searchParams.has('auth_error') ? '?auth_error=' + landed.searchParams.get('auth_error') : ''}`;
  meta.callbackLandedUrl = redactedLanded;

  if (landed.searchParams.has('auth_error')) {
    meta.error = landed.searchParams.get('auth_error') || 'unknown_error';
    throw new Error(`[${meta.provider.toUpperCase()}] OAuth returned error: ${meta.error}`);
  }

  // Wait briefly for frontend session hydration & poll /api/auth/session
  let check = await getSessionAndProviders(page);
  for (let i = 0; i < 20; i++) {
    if (check.session?.status === 'AUTHENTICATED' && check.session?.user) break;
    await page.waitForTimeout(500);
    check = await getSessionAndProviders(page);
  }

  const linked = Array.isArray(check.providers?.providers)
    ? check.providers.providers.map((p: any) => p.provider)
    : [];

  meta.authenticated = check.session?.status === 'AUTHENTICATED' && Boolean(check.session?.user);
  meta.userId = check.session?.user?.id;
  meta.userEmail = check.session?.user?.email;
  meta.userName = check.session?.user?.name;
  meta.linkedProviders = linked;

  assert.equal(meta.authenticated, true, `${meta.provider} OAuth must yield an authenticated session`);
  assert.ok(linked.includes(meta.provider), `Linked providers must include ${meta.provider}`);

  console.log(`[${meta.provider.toUpperCase()}] ✓ Authenticated session verified! User=${meta.userId?.slice(0, 8)}... Providers=[${linked.join(', ')}]`);
  return meta;
}

async function main() {
  console.log('========================================================================');
  console.log(' AIRA AI 2026 — PHASE 1: GENUINE GOOGLE & GITHUB OAUTH IN MS EDGE');
  console.log(` Target: ${STAGING_URL}`);
  console.log('========================================================================');

  let contextA: BrowserContext | null = null;
  let contextB: BrowserContext | null = null;

  try {
    contextA = await chromium.launchPersistentContext(PROFILE_A_DIR, {
      headless: false,
      channel: 'msedge',
      viewport: { width: 1366, height: 860 },
      args: ['--window-position=30,30'],
    });
    const pageA = await contextA.newPage();

    contextB = await chromium.launchPersistentContext(PROFILE_B_DIR, {
      headless: false,
      channel: 'msedge',
      viewport: { width: 1366, height: 860 },
      args: ['--window-position=480,70'],
    });
    const pageB = await contextB.newPage();

    const [metaAInit, metaBInit] = await Promise.all([
      initiateOAuthIfNeeded(pageA, 'google'),
      initiateOAuthIfNeeded(pageB, 'github'),
    ]);

    await pageA.bringToFront().catch(() => {});
    await pageB.bringToFront().catch(() => {});

    const [finalA, finalB] = await Promise.all([
      waitForOAuthCompletion(pageA, metaAInit),
      waitForOAuthCompletion(pageB, metaBInit),
    ]);

    const result = {
      timestamp: new Date().toISOString(),
      stagingUrl: STAGING_URL,
      googleAccountA: finalA,
      githubAccountB: finalB,
    };

    const outPath = path.join(ARTIFACTS_DIR, 'oauth_phase1_status.json');
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`\n✓ Phase 1 Complete! Saved sanitized OAuth status to ${outPath}`);
  } finally {
    if (contextA) await contextA.close();
    if (contextB) await contextB.close();
  }
}

main().catch((err) => {
  console.error('\n✗ Phase 1 Failed:', err?.message || err);
  process.exit(1);
});
