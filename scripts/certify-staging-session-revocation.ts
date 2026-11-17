/**
 * Staging-only, consent-gated session revocation acceptance.
 * Run after BOTH dedicated OAuth browser profiles have authenticated:
 *   $env:AIRA_CONFIRM_STAGING_LOGOUT='YES'
 *   npx tsx scripts/certify-staging-session-revocation.ts
 *
 * Signs both TEST profiles out. No provider credentials or BFF cookies are logged
 * or persisted. Old session cookies are replayed only to staging /api/auth/session
 * in-memory to establish server-side revocation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, request } from 'playwright';
import { hashPrincipalIdentifier, validateSanitizedRecord, type ProviderPositiveEvidence } from './oauth-positive-certification-engine.js';
import { hasObservedLogoutRevocation, type ObservedLogoutProof } from './oauth-observed-logout-proof.js';

const STAGING_ORIGIN = 'https://staging.virexaaiventures.com';
const STAGING_SHA = '3bab3f9e585ac7fa5ffaeaad9148d6d0bc86fa68';
const DEPLOYMENT_ID = 'dpl_9WZv3iFBJq7FzeFnT5uFVVRwHmVj';
const DB_ID = 'neon://mute-frost-50372225/br-autumn-star-b36dfu5w';
// An isolated corrective worktree may verify profiles in the original owner-controlled
// working copy without copying browser cookies or mutating the original checkout.
const artifacts = path.resolve(process.env.AIRA_STAGING_EVIDENCE_DIR || 'artifacts/staging-acceptance');
assert.equal(path.basename(artifacts).toLowerCase(), 'staging-acceptance',
  'AIRA_STAGING_EVIDENCE_DIR must target a staging-acceptance directory');
const evidencePath = path.join(artifacts, 'live_oauth_positive_evidence.json');
const statusPath = path.join(artifacts, 'oauth_phase1_status.json');
const legacyPath = path.join(artifacts, 'pr164/oauth_phase1_status.json');

type Provider = 'google' | 'github';
type Evidence = {
  timestamp?: string;
  stagingUrl?: string;
  google: ProviderPositiveEvidence;
  github: ProviderPositiveEvidence;
  [key: string]: unknown;
};

function readEvidence(): Evidence {
  const raw = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as Evidence;
  assert.equal(raw.google?.provider, 'google');
  assert.equal(raw.github?.provider, 'github');
  for (const provider of ['google', 'github'] as const) {
    const entry = raw[provider];
    assert.equal(entry.deployedStagingSha, STAGING_SHA);
    assert.equal(entry.deploymentId, DEPLOYMENT_ID);
    assert.equal(entry.stagingDatabaseIdentity, DB_ID);
    assert.match(entry.principalHash, /^[a-f0-9]{64}$/i);
    assert.equal(entry.sessionStatus, 'AUTHENTICATED');
    assert.equal(entry.sessionPersistedOnReload, true);
  }
  // Deliberately discard potentially identifying legacy profile metadata.
  return {
    timestamp: new Date().toISOString(),
    stagingUrl: STAGING_ORIGIN,
    google: { ...raw.google, logoutRevocationVerified: false, logoutProof: undefined },
    github: { ...raw.github, logoutRevocationVerified: false, logoutProof: undefined },
  };
}

function saveEvidence(evidence: Evidence): void {
  const clean = validateSanitizedRecord(evidence);
  assert.equal(clean.valid, true, 'Refusing to save unsanitized OAuth evidence');
  // Save current evidence atomically. Never persist the old cookie or CSRF token.
  const temp = evidencePath + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  fs.renameSync(temp, evidencePath);
  for (const p of [statusPath, legacyPath]) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
}

async function verify(provider: Provider, expected: ProviderPositiveEvidence): Promise<ObservedLogoutProof> {
  const profile = path.join(artifacts, provider === 'google' ? 'edge_oauth_profile_a' : 'edge_oauth_profile_b');
  const browser = await chromium.launchPersistentContext(profile, {
    headless: false,
    channel: 'msedge',
    viewport: { width: 1280, height: 800 },
  });
  let replayContext: Awaited<ReturnType<typeof request.newContext>> | undefined;
  try {
    const page = browser.pages()[0] ?? await browser.newPage();
    await page.goto(STAGING_ORIGIN, { waitUntil: 'domcontentloaded' });
    const before = await page.evaluate(async () => {
      const s = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
      return { status: s.status, payload: await s.json() };
    });
    assert.equal(before.status, 200);
    assert.equal(before.payload?.status, 'AUTHENTICATED');
    assert.ok(before.payload?.user?.id, 'Authenticated principal required');
    const principalMatched = hashPrincipalIdentifier(before.payload.user.id) === expected.principalHash;
    assert.ok(principalMatched, 'Staging principal differs from prior OAuth evidence');

    const providers = await page.evaluate(async () => {
      const r = await fetch('/api/auth/providers', { credentials: 'include' });
      if (r.status !== 200) throw new Error('Linked provider lookup failed');
      return r.json();
    });
    const providerMatched = Array.isArray(providers?.providers) &&
      providers.providers.some((x: { provider?: string }) => x.provider === provider);
    assert.equal(providerMatched, true, 'Expected linked OAuth provider not found');

    const cookies = await browser.cookies(STAGING_ORIGIN);
    const sessionCookie = cookies.find(c => c.name === '__Host-aira_auth_session' || c.name === 'aira_auth_session');
    assert.ok(sessionCookie?.value, 'Missing pre-logout BFF cookie');

    // Independent request context, not sharing the active browser cookie jar.
    replayContext = await request.newContext({ storageState: { cookies: [], origins: [] } });
    const oldHeader = `${sessionCookie.name}=${sessionCookie.value}`;
    const replay = async () => {
      const res = await replayContext!.get(STAGING_ORIGIN + '/api/auth/session', {
        headers: { Cookie: oldHeader, 'Cache-Control': 'no-store' },
      });
      return { status: res.status(), body: await res.json() };
    };
    const beforeReplay = await replay();
    const oldCookieAuthorizedBefore = beforeReplay.status === 200 &&
      beforeReplay.body?.status === 'AUTHENTICATED' &&
      beforeReplay.body?.user?.id === before.payload.user.id;
    assert.ok(oldCookieAuthorizedBefore, 'Original cookie was not valid before sign-out');

    const logout = await page.evaluate(async csrfToken => {
      const response = await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-aira-csrf-protection': '1', 'X-CSRF-Token': csrfToken },
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }, before.payload.csrfToken);
    const signOutStatus = logout.status;
    assert.equal(signOutStatus, 200, 'Authenticated sign-out did not return HTTP 200');
    assert.equal(logout.body?.success, true, 'Authenticated sign-out did not succeed');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const after = await page.evaluate(async () => {
      const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
      return { status: response.status, body: await response.json() };
    });
    const anonymousAfter = after.status === 200 &&
      (after.body?.status === 'ANONYMOUS' || after.body?.status === 'GUEST') &&
      !after.body?.user;
    assert.ok(anonymousAfter, 'Browser retained an authenticated session after logout');

    const staleReplay = await replay();
    const oldCookieRejectedAfter = staleReplay.status === 200 &&
      (staleReplay.body?.status === 'ANONYMOUS' || staleReplay.body?.status === 'GUEST') &&
      !staleReplay.body?.user;
    assert.ok(oldCookieRejectedAfter, 'Previously valid cookie remains authorized after sign-out');

    return {
      principalMatched, providerMatched,
      authenticatedBefore: true,
      oldCookieAuthorizedBefore,
      signOutStatus,
      anonymousAfter,
      oldCookieRejectedAfter,
    };
  } finally {
    await replayContext?.dispose();
    await browser.close();
  }
}


async function main() {
  assert.equal(process.env.AIRA_CONFIRM_STAGING_LOGOUT, 'YES',
    'Explicit opt-in required: AIRA_CONFIRM_STAGING_LOGOUT=YES (revokes both staging test sessions)');
  assert.equal(new URL(STAGING_ORIGIN).hostname, 'staging.virexaaiventures.com');
  const data = readEvidence();
  // Clearing old booleans first prevents a stale PASS if a test is interrupted.
  saveEvidence(data);
  const revocationVerifierSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  for (const provider of ['google', 'github'] as const) {
    const proof = await verify(provider, data[provider]);
    assert.equal(hasObservedLogoutRevocation(proof), true, 'Incomplete revocation proof');
    data[provider] = {
      ...data[provider],
      logoutRevocationVerified: true,
      logoutProof: proof,
      revocationVerifierSha,
      revocationVerifiedAt: new Date().toISOString(),
    };
    saveEvidence(data);
    console.log(`[${provider.toUpperCase()}] Authenticated sign-out and stale-cookie replay rejection: PASS`);
  }
  console.log('Both staging test sessions revoked and sanitized evidence updated.');
}
main().catch(e => {
  console.error('Staging logout certification incomplete:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
