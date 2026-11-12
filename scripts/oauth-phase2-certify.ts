/**
 * AIRA AI 2026 — Phase 2: Real OAuth Cross-Account Isolation, Runtime Model Matrix & Logout Certification
 *
 * Consumes the genuine Google-authenticated (Profile A) and GitHub-authenticated (Profile B)
 * persistent Microsoft Edge contexts against an isolated staging deployment matching the
 * validated 40-character candidate commit SHA.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupProFixture, resetStagingTestDailyQuota, cleanupAllStagingFixtures, verifyStagingDbIntegrity } from './staging-fixture-lifecycle.js';

const DEFAULT_STAGING_URL = 'https://staging.virexaaiventures.com';
const FULL_SHA_REGEX = /^[a-f0-9]{40}$/i;
const FORBIDDEN_PROD_HOST_PATTERNS = [
  /^aira-ai-2026\.vercel\.app$/i,
  /^prod-release\./i,
];

const ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts/staging-acceptance/pr164');
const PROFILE_A_DIR = path.resolve(process.cwd(), 'artifacts/staging-acceptance/edge_oauth_profile_a');
const PROFILE_B_DIR = path.resolve(process.cwd(), 'artifacts/staging-acceptance/edge_oauth_profile_b');

export function assertValidFullSha(value: unknown, sourceLabel = 'candidate SHA'): string {
  if (typeof value !== 'string') {
    throw new Error(`Missing or non-string ${sourceLabel}; expected a 40-character hexadecimal Git SHA.`);
  }
  const trimmed = value.trim();
  if (!FULL_SHA_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid ${sourceLabel} "${trimmed}": must be a complete 40-character hexadecimal Git SHA.`
    );
  }
  return trimmed.toLowerCase();
}

export function assertStagingTargetUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('Missing staging URL: AIRA_STAGING_URL must be an HTTPS staging origin.');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Invalid staging URL "${rawUrl}": unable to parse as URL.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Unsafe staging URL "${parsed.origin}": HTTPS is required.`);
  }
  if (FORBIDDEN_PROD_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
    throw new Error(
      `Refusing to run staging certification against production host "${parsed.hostname}".`
    );
  }
  return parsed.origin;
}

function readGitHeadShaFromRepo(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function resolveExpectedCandidateSha(options?: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  readGitHead?: () => string | null;
}): { expectedSha: string; source: 'cli' | 'env' | 'git-head' } {
  const argv = options?.argv ?? process.argv.slice(2);
  const env = options?.env ?? process.env;
  const readGitHead = options?.readGitHead ?? readGitHeadShaFromRepo;

  let cliSha: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--expected-sha') {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error('Flag --expected-sha requires a 40-character hexadecimal Git SHA argument.');
      }
      cliSha = next;
      break;
    }
    if (arg.startsWith('--expected-sha=')) {
      cliSha = arg.slice('--expected-sha='.length);
      break;
    }
  }

  if (cliSha !== undefined) {
    return {
      expectedSha: assertValidFullSha(cliSha, '--expected-sha'),
      source: 'cli',
    };
  }

  const hasAiraEnv = Object.prototype.hasOwnProperty.call(env, 'AIRA_EXPECTED_SHA');
  const hasExpectedEnv = Object.prototype.hasOwnProperty.call(env, 'EXPECTED_SHA');
  if (hasAiraEnv || hasExpectedEnv) {
    const airaVal = env.AIRA_EXPECTED_SHA;
    const expectedVal = env.EXPECTED_SHA;
    const validatedAira = hasAiraEnv ? assertValidFullSha(airaVal, 'AIRA_EXPECTED_SHA') : undefined;
    const validatedExpected = hasExpectedEnv ? assertValidFullSha(expectedVal, 'EXPECTED_SHA') : undefined;
    if (validatedAira && validatedExpected && validatedAira !== validatedExpected) {
      throw new Error(
        `Conflicting SHA environment variables: AIRA_EXPECTED_SHA=${validatedAira} vs EXPECTED_SHA=${validatedExpected}.`
      );
    }
    return {
      expectedSha: (validatedAira ?? validatedExpected)!,
      source: 'env',
    };
  }

  const gitHead = readGitHead();
  if (!gitHead) {
    throw new Error(
      'Missing expected candidate SHA: provide AIRA_EXPECTED_SHA (or --expected-sha) or execute inside a Git checkout with a valid HEAD commit.'
    );
  }
  return {
    expectedSha: assertValidFullSha(gitHead, 'Git HEAD release metadata'),
    source: 'git-head',
  };
}

export function assertDeployedShaMatches(
  versionPayload: { commitSha?: unknown } | null | undefined,
  expectedSha: string
): string {
  const normalizedExpected = assertValidFullSha(expectedSha, 'expected candidate SHA');
  const deployedSha = assertValidFullSha(versionPayload?.commitSha, 'deployed /api/version commitSha');
  assert.equal(
    deployedSha,
    normalizedExpected,
    `Staging /api/version commitSha (${deployedSha}) does not match expected candidate SHA (${normalizedExpected})`
  );
  return deployedSha;
}

async function getBrowserSessionInfo(page: Page) {
  return page.evaluate(async () => {
    const sRes = await fetch('/api/auth/session', { credentials: 'include' });
    const session = await sRes.json().catch(() => null);
    let providers: any = null;
    let entitlements: any = null;
    if (session?.status === 'AUTHENTICATED') {
      const pRes = await fetch('/api/auth/providers', { credentials: 'include' });
      providers = await pRes.json().catch(() => null);
      const eRes = await fetch('/api/billing/entitlements', { credentials: 'include' });
      entitlements = await eRes.json().catch(() => null);
    }
    return { sStatus: sRes.status, session, providers, entitlements };
  });
}

async function parseStreamInPage(page: Page, payload: Record<string, any>, csrf: string) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await page.evaluate(async ({ body, csrfToken }) => {
        const res = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AIRA-CSRF-Protection': '1',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
          credentials: 'include',
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          return {
            status: res.status,
            errBody,
            sseError: null as any,
            doneReceived: false,
            provenance: null as any,
            routingDecision: null as any,
            latencyMetrics: null as any,
            contentText: '',
            thinkingCount: 0,
            deltaCount: 0,
          };
        }

        const text = await res.text();
        const lines = text.split('\n');
        let currentEvent = 'message';
        let contentText = '';
        let thinkingCount = 0;
        let deltaCount = 0;
        let provenance: any = null;
        let routingDecision: any = null;
        let latencyMetrics: any = null;
        let sseError: any = null;
        let doneReceived = false;

        for (const rawLine of lines) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const raw = line.slice(6).trim();
            if (!raw) continue;
            if (raw === '[DONE]') {
              if (currentEvent === 'done') doneReceived = true;
              continue;
            }
            try {
              const parsed = JSON.parse(raw);
              if (currentEvent === 'error' || parsed?.error) {
                sseError = parsed;
              } else if (currentEvent === 'done') {
                doneReceived = true;
              } else if (currentEvent === 'content_delta' && typeof parsed.text === 'string') {
                contentText += parsed.text;
                deltaCount++;
              } else if (currentEvent === 'thinking_delta') {
                thinkingCount++;
              } else if (currentEvent === 'model_provenance') {
                provenance = parsed;
              } else if (currentEvent === 'routing_decision') {
                routingDecision = parsed;
              } else if (currentEvent === 'latency_metrics') {
                latencyMetrics = parsed;
              }
            } catch {
              // ignore partial JSON
            }
          }
        }

        return {
          status: res.status,
          sseError,
          doneReceived,
          provenance,
          routingDecision,
          latencyMetrics,
          contentText,
          thinkingCount,
          deltaCount,
        };
      }, { body: payload, csrfToken: csrf });
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (attempt === 1 && /Failed to fetch|ERR_CONNECTION|ERR_NETWORK|ECONNRESET/i.test(msg)) {
        console.log(`[Stream Transport Retry] Transient fetch failure before HTTP headers (${msg}); retrying in 3s...`);
        await page.waitForTimeout(3000);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable parseStreamInPage exit');
}

export async function runPhase2() {
  const STAGING_URL = assertStagingTargetUrl(process.env.AIRA_STAGING_URL || DEFAULT_STAGING_URL);
  const { expectedSha, source: shaSource } = resolveExpectedCandidateSha();
  if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  console.log('========================================================================');
  console.log(' AIRA AI 2026 — PHASE 2: REAL OAUTH ISOLATION & RUNTIME MATRIX CERT');
  console.log(` Target: ${STAGING_URL}`);
  console.log(` Expected SHA (${shaSource}): ${expectedSha}`);
  console.log('========================================================================\n');

  const versionData = await fetch(`${STAGING_URL}/api/version`).then((r) => r.json());
  const deployedSha = assertDeployedShaMatches(versionData, expectedSha);
  console.log(`[Preflight] ✓ Staging verified at exact SHA: ${deployedSha}`);

  let contextA: BrowserContext | null = null;
  let contextB: BrowserContext | null = null;
  let proFixtureActivated = false;

  try {
    contextA = await chromium.launchPersistentContext(PROFILE_A_DIR, {
      headless: true,
      channel: 'msedge',
      viewport: { width: 1440, height: 900 },
    });
    const pageA = await contextA.newPage();
    await pageA.goto(STAGING_URL, { waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(2000);

    contextB = await chromium.launchPersistentContext(PROFILE_B_DIR, {
      headless: true,
      channel: 'msedge',
      viewport: { width: 1440, height: 900 },
    });
    const pageB = await contextB.newPage();
    await pageB.goto(STAGING_URL, { waitUntil: 'domcontentloaded' });
    await pageB.waitForTimeout(2000);

    // -----------------------------------------------------------------------
    // 1. Verify Google (A) and GitHub (B) Authentic Sessions & Reload Persistence
    // -----------------------------------------------------------------------
    const infoA = await getBrowserSessionInfo(pageA);
    assert.equal(infoA.session?.status, 'AUTHENTICATED', 'Profile A (Google) must be authenticated');
    const providersA = (infoA.providers?.providers || []).map((p: any) => p.provider);
    assert.ok(providersA.includes('google'), 'Profile A must have Google provider linked');

    const infoB = await getBrowserSessionInfo(pageB);
    assert.equal(infoB.session?.status, 'AUTHENTICATED', 'Profile B (GitHub) must be authenticated');
    const providersB = (infoB.providers?.providers || []).map((p: any) => p.provider);
    assert.ok(providersB.includes('github'), 'Profile B must have GitHub provider linked');

    const userIdA = infoA.session.user.id;
    const userIdB = infoB.session.user.id;
    assert.notEqual(userIdA, userIdB, 'Google A and GitHub B must have distinct internal user IDs');

    const csrfA = infoA.session.csrfToken || '';
    const csrfB = infoB.session.csrfToken || '';
    const customerA = infoA.entitlements?.customerId;
    const customerB = infoB.entitlements?.customerId;
    assert.ok(customerA && customerB && customerA !== customerB, 'Distinct customer IDs required for Account A and B');

    if ((infoA.entitlements?.dailyStandardChatRemaining ?? 0) < 4 || (infoB.entitlements?.dailyStandardChatRemaining ?? 0) < 4) {
      await resetStagingTestDailyQuota([customerA, customerB]);
      infoA.entitlements = (await getBrowserSessionInfo(pageA)).entitlements;
      infoB.entitlements = (await getBrowserSessionInfo(pageB)).entitlements;
    }

    console.log(`[OAuth Verify] ✓ Google Account A: ${userIdA.slice(0, 14)}... | Customer: ${customerA} | Plan: ${infoA.entitlements?.plan} | Providers: [${providersA.join(', ')}]`);
    console.log(`[OAuth Verify] ✓ GitHub Account B: ${userIdB.slice(0, 14)}... | Customer: ${customerB} | Plan: ${infoB.entitlements?.plan} | Providers: [${providersB.join(', ')}]`);

    // Reload persistence check
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(1500);
    const infoAReload = await getBrowserSessionInfo(pageA);
    assert.equal(infoAReload.session?.user?.id, userIdA, 'Google session must persist across page reload');

    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await pageB.waitForTimeout(1500);
    const infoBReload = await getBrowserSessionInfo(pageB);
    assert.equal(infoBReload.session?.user?.id, userIdB, 'GitHub session must persist across page reload');

    const shotGoogle = path.join(ARTIFACTS_DIR, '01_real_google_oauth_authenticated.png');
    await pageA.screenshot({ path: shotGoogle });
    const shotGithub = path.join(ARTIFACTS_DIR, '02_real_github_oauth_authenticated.png');
    await pageB.screenshot({ path: shotGithub });
    console.log('[OAuth Verify] ✓ Session persistence across reload & screenshots verified.');

    // -----------------------------------------------------------------------
    // 2. Task 4: Bidirectional Cross-Account Isolation (A <-> B)
    // -----------------------------------------------------------------------
    console.log('\n[Task 4] Executing bidirectional cross-account isolation matrix...');

    const convIdA = `conv_oauth_a_${Date.now()}`;
    const nowA = Date.now();
    const chatCreateA = await pageA.evaluate(async ({ cId, ts, csrf }) => {
      const r = await fetch('/api/conversations/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
        credentials: 'include',
        body: JSON.stringify({
          id: cId,
          title: 'Confidential Google Account A Thread',
          messages: [{ id: 'm1', role: 'user', content: 'SECRET_ALPHA_PROJECT_NOTES', createdAt: ts }],
          createdAt: ts,
          updatedAt: ts,
        }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { cId: convIdA, ts: nowA, csrf: csrfA });
    assert.ok(chatCreateA.status >= 200 && chatCreateA.status < 300, `Conv A create failed: ${chatCreateA.status}`);

    const projA = await pageA.evaluate(async ({ csrf }) => {
      const existing = await fetch('/api/projects', { credentials: 'include' }).then((r) => r.json().catch(() => ({})));
      for (const p of (existing?.projects || [])) {
        if (typeof p?.name === 'string' && p.name.startsWith('Google Private Project A')) {
          await fetch(`/api/projects/${p.id}`, {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
            credentials: 'include',
          });
        }
      }
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
        credentials: 'include',
        body: JSON.stringify({ name: 'Google Private Project A', description: 'Top secret alpha', tags: ['alpha'] }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { csrf: csrfA });
    assert.ok([200, 201].includes(projA.status), `Project A creation failed: ${projA.status}`);
    const projIdA = projA.body.project?.id || projA.body.id;

    const memA = await pageA.evaluate(async ({ csrf }) => {
      const r = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
        credentials: 'include',
        body: JSON.stringify({ content: 'SECRET_ALPHA_MEMORY_DATA', tags: ['confidential'] }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { csrf: csrfA });
    assert.ok([200, 201].includes(memA.status), `Memory A creation failed: ${memA.status}`);
    const memIdA = memA.body.memory?.id || memA.body.id;

    // Personalization & Onboarding on A
    await pageA.evaluate(({ uId }) => {
      localStorage.setItem(`aira_settings_${uId}_v1`, JSON.stringify({
        userBio: 'GOOGLE_ACCOUNT_A_CONFIDENTIAL_BIO',
        customInstructions: 'GOOGLE_ACCOUNT_A_STRICT_STYLE',
        model: 'aira-auto',
      }));
    }, { uId: userIdA });

    const onbA = await pageA.evaluate(async ({ csrf }) => {
      const r = await fetch('/api/user/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
        credentials: 'include',
        body: JSON.stringify({ action: 'finish' }),
      });
      return { status: r.status, body: await r.json() };
    }, { csrf: csrfA });
    assert.equal(onbA.status, 200);

    // B creates private conversation, project, memory
    const convIdB = `conv_oauth_b_${Date.now()}`;
    const nowB = Date.now();
    const chatCreateB = await pageB.evaluate(async ({ cId, ts, csrf }) => {
      const r = await fetch('/api/conversations/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
        credentials: 'include',
        body: JSON.stringify({
          id: cId,
          title: 'Confidential GitHub Account B Thread',
          messages: [{ id: 'm2', role: 'user', content: 'SECRET_BETA_PROJECT_NOTES', createdAt: ts }],
          createdAt: ts,
          updatedAt: ts,
        }),
      });
      return { status: r.status };
    }, { cId: convIdB, ts: nowB, csrf: csrfB });
    assert.ok(chatCreateB.status >= 200 && chatCreateB.status < 300);

    const projB = await pageB.evaluate(async ({ csrf }) => {
      const existing = await fetch('/api/projects', { credentials: 'include' }).then((r) => r.json().catch(() => ({})));
      for (const p of (existing?.projects || [])) {
        if (typeof p?.name === 'string' && p.name.startsWith('GitHub Private Project B')) {
          await fetch(`/api/projects/${p.id}`, {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
            credentials: 'include',
          });
        }
      }
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
        credentials: 'include',
        body: JSON.stringify({ name: 'GitHub Private Project B', description: 'Top secret beta', tags: ['beta'] }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { csrf: csrfB });
    assert.ok([200, 201].includes(projB.status), `Project B creation failed: ${projB.status}`);
    const projIdB = projB.body.project?.id || projB.body.id;

    const memB = await pageB.evaluate(async ({ csrf }) => {
      const r = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
        credentials: 'include',
        body: JSON.stringify({ content: 'SECRET_BETA_MEMORY_DATA', tags: ['beta'] }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { csrf: csrfB });
    assert.ok([200, 201].includes(memB.status), `Memory B creation failed: ${memB.status}`);
    const memIdB = memB.body.memory?.id || memB.body.id;

    // Cross-tenant IDOR matrix: B -> A
    const bOnA = await pageB.evaluate(async ({ cId, pId, mId, uIdA, csrf }) => {
      const getConv = await fetch(`/api/conversations/${cId}`, { credentials: 'include' }).then((r) => r.status);
      const delConv = await fetch(`/api/conversations/${cId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' }).then((r) => r.status);
      const getProj = await fetch(`/api/projects/${pId}`, { credentials: 'include' }).then((r) => r.status);
      const patchProj = await fetch(`/api/projects/${pId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
        credentials: 'include',
        body: JSON.stringify({ name: 'HIJACKED' }),
      }).then((r) => r.status);
      const delProj = await fetch(`/api/projects/${pId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' }).then((r) => r.status);
      const getMem = await fetch(`/api/memories/${mId}`, { credentials: 'include' }).then((r) => r.status);
      const delMem = await fetch(`/api/memories/${mId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' }).then((r) => r.status);
      const spoofOnb = await fetch('/api/user/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1', 'x-user-id': uIdA },
        credentials: 'include',
        body: JSON.stringify({ userId: uIdA, action: 'restart' }),
      });
      const spoofBody = await spoofOnb.json().catch(() => null);
      return { getConv, delConv, getProj, patchProj, delProj, getMem, delMem, spoofStatus: spoofOnb.status, spoofCode: spoofBody?.code || spoofBody?.error };
    }, { cId: convIdA, pId: projIdA, mId: memIdA, uIdA: userIdA, csrf: csrfB });

    assert.ok([403, 404].includes(bOnA.getConv));
    assert.ok([403, 404].includes(bOnA.delConv));
    assert.ok([403, 404].includes(bOnA.getProj));
    assert.ok([403, 404].includes(bOnA.patchProj));
    assert.ok([403, 404].includes(bOnA.delProj));
    assert.ok([403, 404].includes(bOnA.getMem));
    assert.ok([403, 404].includes(bOnA.delMem));
    assert.equal(bOnA.spoofStatus, 403);
    assert.equal(bOnA.spoofCode, 'FORBIDDEN_OWNERSHIP_SPOOF');
    console.log('[Task 4] ✓ B -> A IDOR probes blocked (404/403) and ownership spoof rejected (403 FORBIDDEN_OWNERSHIP_SPOOF).');

    // Opposite direction: A -> B
    const aOnB = await pageA.evaluate(async ({ cId, pId, mId, uIdB, csrf }) => {
      const getConv = await fetch(`/api/conversations/${cId}`, { credentials: 'include' }).then((r) => r.status);
      const delConv = await fetch(`/api/conversations/${cId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' }).then((r) => r.status);
      const getProj = await fetch(`/api/projects/${pId}`, { credentials: 'include' }).then((r) => r.status);
      const patchProj = await fetch(`/api/projects/${pId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
        credentials: 'include',
        body: JSON.stringify({ name: 'HIJACKED' }),
      }).then((r) => r.status);
      const delProj = await fetch(`/api/projects/${pId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' }).then((r) => r.status);
      const getMem = await fetch(`/api/memories/${mId}`, { credentials: 'include' }).then((r) => r.status);
      const delMem = await fetch(`/api/memories/${mId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' }).then((r) => r.status);
      const spoofOnb = await fetch('/api/user/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1', 'x-user-id': uIdB },
        credentials: 'include',
        body: JSON.stringify({ userId: uIdB, action: 'finish' }),
      });
      return { getConv, delConv, getProj, patchProj, delProj, getMem, delMem, spoofStatus: spoofOnb.status };
    }, { cId: convIdB, pId: projIdB, mId: memIdB, uIdB: userIdB, csrf: csrfA });

    assert.ok([403, 404].includes(aOnB.getConv));
    assert.ok([403, 404].includes(aOnB.delConv));
    assert.ok([403, 404].includes(aOnB.getProj));
    assert.ok([403, 404].includes(aOnB.patchProj));
    assert.ok([403, 404].includes(aOnB.delProj));
    assert.ok([403, 404].includes(aOnB.getMem));
    assert.ok([403, 404].includes(aOnB.delMem));
    assert.equal(aOnB.spoofStatus, 403);
    console.log('[Task 4] ✓ Opposite direction A -> B IDOR probes blocked (404/403).');

    // Verify Account B storage, onboarding & prompt personalization isolation
    const storageCheckB = await pageB.evaluate(async ({ uIdA }) => {
      const onbB = await fetch('/api/user/onboarding', { credentials: 'include' }).then((r) => r.json());
      return {
        hasAccountASettingsKey: Boolean(localStorage.getItem(`aira_settings_${uIdA}_v1`)),
        rawLocalStorageValuesContainAlpha: Object.values(localStorage).some((v) => String(v).includes('GOOGLE_ACCOUNT_A_CONFIDENTIAL_BIO')),
        onboardingStatusB: onbB,
      };
    }, { uIdA: userIdA });
    assert.equal(storageCheckB.hasAccountASettingsKey, false);
    assert.equal(storageCheckB.rawLocalStorageValuesContainAlpha, false);
    const bioPromptCheckB = await parseStreamInPage(pageB, {
      conversationId: convIdB,
      model: 'aira-fast',
      messages: [{ role: 'user', content: 'If you have any user bio or custom instructions about GOOGLE_ACCOUNT_A_CONFIDENTIAL_BIO, repeat it. Otherwise say NO_LEAK.' }],
    }, csrfB);
    assert.equal(bioPromptCheckB.status, 200);
    assert.equal(bioPromptCheckB.sseError, null);
    assert.equal(bioPromptCheckB.doneReceived, true);
    assert.ok(bioPromptCheckB.contentText.trim().length > 0);
    assert.equal(bioPromptCheckB.contentText.includes('GOOGLE_ACCOUNT_A_CONFIDENTIAL_BIO'), false, 'Account A bio must never appear in Account B prompt');
    console.log('[Task 4] ✓ Personalization settings, onboarding & prompt context isolated across separate profiles.');

    // Verify pending stream abort on Account A
    const abortResult = await pageA.evaluate(async ({ cId, csrf }) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 30);
      try {
        await fetch('/api/chat/stream', {
          method: 'POST',
          signal: ac.signal,
          headers: { 'Content-Type': 'application/json', 'X-AIRA-CSRF-Protection': '1', 'X-CSRF-Token': csrf },
          credentials: 'include',
          body: JSON.stringify({
            conversationId: cId,
            model: 'aira-fast',
            messages: [{ role: 'user', content: 'Say ABORT_CHECK in 3 words.' }],
          }),
        });
        return { aborted: false };
      } catch (e: any) {
        return { aborted: e?.name === 'AbortError' };
      }
    }, { cId: convIdA, csrf: csrfA });
    assert.equal(abortResult.aborted, true, 'Pending stream must abort cleanly on AbortSignal');
    console.log('[Task 4] ✓ Pending stream abort verified cleanly.');

    // Wait for server capacity permit release and Groq 8K TPM cooldown after burst checks
    await pageA.waitForTimeout(8000);

    // -----------------------------------------------------------------------
    // 3. Task 5: Bounded Runtime Model Matrix on Exact Validated Candidate SHA
    // -----------------------------------------------------------------------
    console.log('\n[Task 5] Executing live model matrix on exact deployed SHA...');

    const remA = infoA.entitlements?.dailyStandardChatRemaining ?? 0;
    const remBPostBio = Math.max(0, (infoB.entitlements?.dailyStandardChatRemaining ?? 0) - 1);
    const useAForFree = remA >= 2;
    const freePage = useAForFree ? pageA : pageB;
    const freeConvId = useAForFree ? convIdA : convIdB;
    const freeCsrf = useAForFree ? csrfA : csrfB;
    const freeLabel = useAForFree ? 'Account A' : 'Account B';
    assert.ok(
      useAForFree || remBPostBio >= 2,
      `At least one Free account must have >=2 remaining daily chats for Free-tier matrix (A=${remA}, B_postBio=${remBPostBio})`
    );
    console.log(`[Task 5] Using ${freeLabel} for Free-tier inference checks (A remaining=${remA}, B post-bio=${remBPostBio}).`);

    let fastRes = await parseStreamInPage(freePage, {
      conversationId: freeConvId,
      model: 'aira-fast',
      messages: [{ role: 'user', content: 'Reply cleanly with FAST_OK.' }],
    }, freeCsrf);
    if (fastRes.status === 429 && fastRes.errBody?.error !== 'DAILY_QUOTA_EXHAUSTED' && fastRes.deltaCount === 0) {
      console.log('[Task 5] Retrying aira-fast after brief cooldown...');
      await freePage.waitForTimeout(8000);
      fastRes = await parseStreamInPage(freePage, {
        conversationId: freeConvId,
        model: 'aira-fast',
        messages: [{ role: 'user', content: 'Reply cleanly with FAST_OK.' }],
      }, freeCsrf);
    }
    assert.equal(fastRes.status, 200, `aira-fast failed with ${fastRes.status}: ${JSON.stringify(fastRes.errBody)}`);
    assert.equal(fastRes.sseError, null);
    assert.equal(fastRes.doneReceived, true);
    assert.ok(fastRes.deltaCount > 0 && fastRes.contentText.trim().length > 0, 'Fast stream must have >0 non-empty deltas');
    assert.equal(fastRes.provenance?.provider, 'groq');
    assert.equal(fastRes.provenance?.executedModel, 'openai/gpt-oss-120b');
    console.log(`[Model Matrix] ✓ AIRA Fast (${freeLabel}): ${fastRes.provenance?.provider}/${fastRes.provenance?.executedModel} (${fastRes.deltaCount} deltas)`);

    await freePage.waitForTimeout(6000);

    const autoRes = await parseStreamInPage(freePage, {
      conversationId: freeConvId,
      model: 'aira-auto',
      messages: [{ role: 'user', content: 'Compute 19 + 23 cleanly in one sentence.' }],
    }, freeCsrf);
    assert.equal(autoRes.status, 200);
    assert.equal(autoRes.sseError, null);
    assert.equal(autoRes.doneReceived, true);
    assert.ok(autoRes.deltaCount > 0 && autoRes.contentText.trim().length > 0);
    assert.ok(['groq', 'gemini'].includes(autoRes.provenance?.provider), `Unexpected auto provider: ${autoRes.provenance?.provider}`);
    console.log(`[Model Matrix] ✓ AIRA Auto (${freeLabel}): ${autoRes.provenance?.provider}/${autoRes.provenance?.executedModel} (fallback=${autoRes.provenance?.fallbackOccurred}, text=${autoRes.contentText.trim().slice(0, 40)})`);

    // Check Free tier blocking on Account B
    const tierB = infoB.entitlements?.plan || 'free';
    let freeProBlockedStatus: number | null = null;
    if (tierB === 'free') {
      const blocked = await parseStreamInPage(pageB, {
        conversationId: convIdB,
        model: 'aira-pro',
        messages: [{ role: 'user', content: 'Test pro gating' }],
      }, csrfB);
      freeProBlockedStatus = blocked.status;
      assert.equal(blocked.status, 403, 'Free user must be blocked from aira-pro with 403');
      console.log(`[Model Matrix] ✓ Free Tier Gating: aira-pro returned 403 PLAN_MODEL_RESTRICTED`);
    }

    // Activate disposable staging Pro fixture for Account A
    console.log(`[Model Matrix] Activating disposable Pro fixture for customer ${customerA}...`);
    await setupProFixture(customerA);
    proFixtureActivated = true;

    await pageA.waitForTimeout(6000);

    const proRes = await parseStreamInPage(pageA, {
      conversationId: convIdA,
      model: 'aira-pro',
      messages: [{ role: 'user', content: 'Respond with PRO_OK and two brief sentences on zero trust.' }],
    }, csrfA);
    assert.equal(proRes.status, 200);
    assert.equal(proRes.sseError, null);
    assert.equal(proRes.doneReceived, true);
    assert.ok(proRes.deltaCount > 0 && proRes.contentText.trim().length > 0, 'Pro stream must not hit zero-delta race');
    assert.ok(['groq', 'gemini'].includes(proRes.provenance?.provider));
    console.log(`[Model Matrix] ✓ AIRA Pro: ${proRes.provenance?.provider}/${proRes.provenance?.executedModel} (fallback=${proRes.provenance?.fallbackOccurred}, ${proRes.deltaCount} deltas)`);

    await pageA.waitForTimeout(7000);

    const deepRes = await parseStreamInPage(pageA, {
      conversationId: convIdA,
      model: 'aira-deep',
      extendedThinking: true,
      thinkingBudget: 4096,
      messages: [{ role: 'user', content: 'Analyze why BFF cookie sessions protect OAuth tokens. Keep answer concise.' }],
    }, csrfA);
    assert.equal(deepRes.status, 200);
    assert.equal(deepRes.sseError, null);
    assert.equal(deepRes.doneReceived, true);
    assert.ok(deepRes.deltaCount > 0 && deepRes.contentText.trim().length > 0);
    assert.ok(['groq', 'gemini'].includes(deepRes.provenance?.provider));
    console.log(`[Model Matrix] ✓ AIRA Deep: ${deepRes.provenance?.provider}/${deepRes.provenance?.executedModel} (fallback=${deepRes.provenance?.fallbackOccurred}, ${deepRes.deltaCount} deltas, ${deepRes.thinkingCount} thinking deltas, reasoningControl=${deepRes.provenance?.reasoningControl || 'effort_mapped'})`);

    await pageA.waitForTimeout(7000);

    // Gemini long-context failover (>28K chars triggers Groq TPM/413 failover -> Gemini 1M context)
    const longPrompt = 'CONTEXT_BLOCK '.repeat(2600) + '\nSummarize in 5 words ending with FAILOVER_OK.';
    const longRes = await parseStreamInPage(pageA, {
      conversationId: convIdA,
      model: 'aira-pro',
      messages: [{ role: 'user', content: longPrompt }],
    }, csrfA);
    assert.equal(longRes.status, 200);
    assert.equal(longRes.sseError, null, `Gemini long-context failover emitted SSE error: ${JSON.stringify(longRes.sseError)}`);
    assert.equal(longRes.doneReceived, true, 'Gemini long-context failover must emit terminal done event');
    assert.equal(longRes.provenance?.provider, 'gemini');
    assert.equal(longRes.provenance?.executedModel, 'gemini-3.5-flash-lite');
    assert.equal(longRes.provenance?.fallbackOccurred, true);
    assert.ok(longRes.deltaCount > 0, `Gemini long-context failover must emit >0 content deltas, got ${longRes.deltaCount}`);
    assert.ok(longRes.contentText.trim().length > 0, 'Gemini long-context failover must return non-empty text content');

    // Sync the completed Gemini fallback answer into conversation history and verify reload persistence in browser UI
    const syncedAt = Date.now();
    const syncFallbackRes = await pageA.evaluate(async ({ cId, created, updated, promptTxt, answerTxt, csrf }) => {
      const r = await fetch('/api/conversations/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' },
        credentials: 'include',
        body: JSON.stringify({
          id: cId,
          title: 'Gemini Long-Context Failover Verification',
          messages: [
            { id: 'm1', role: 'user', content: 'SECRET_ALPHA_PROJECT_NOTES', createdAt: created },
            { id: 'm2', role: 'user', content: promptTxt.slice(0, 120) + '...', createdAt: updated - 1 },
            { id: 'm3', role: 'assistant', content: answerTxt.trim(), createdAt: updated },
          ],
          createdAt: created,
          updatedAt: updated,
        }),
      });
      return { status: r.status };
    }, { cId: convIdA, created: nowA, updated: syncedAt, promptTxt: longPrompt, answerTxt: longRes.contentText, csrf: csrfA });
    assert.ok(syncFallbackRes.status >= 200 && syncFallbackRes.status < 300, `Conversation sync failed: ${syncFallbackRes.status}`);

    const persistedConv = await pageA.evaluate(async ({ cId }) => {
      const r = await fetch(`/api/conversations/${cId}`, { credentials: 'include' });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { cId: convIdA });
    assert.equal(persistedConv.status, 200);
    const persistedMsgs = persistedConv.body?.conversation?.messages || persistedConv.body?.messages || [];
    const expectedSnippet = longRes.contentText.trim().slice(0, 24);
    assert.ok(
      persistedMsgs.some((m: any) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes(expectedSnippet)),
      'Persisted conversation must include Gemini fallback assistant response'
    );

    await pageA.goto(`${STAGING_URL}/?c=${encodeURIComponent(convIdA)}`, { waitUntil: 'domcontentloaded' });
    await pageA.getByText(expectedSnippet, { exact: false }).first().waitFor({ state: 'visible', timeout: 25000 });
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.getByText(expectedSnippet, { exact: false }).first().waitFor({ state: 'visible', timeout: 25000 });
    console.log(`[Model Matrix] ✓ Gemini Long-Context Failover: ${longRes.provenance?.provider}/${longRes.provenance?.executedModel} (${longRes.deltaCount} deltas, ${longRes.contentText.trim().length} chars, UI & reload persistence PASS)`);

    // Post-inference quota check (also refreshes active CSRF after pageA reload)
    const postEntA = await getBrowserSessionInfo(pageA);
    const activeCsrfA = postEntA.session?.csrfToken || csrfA;
    const remainingChatsA = postEntA.entitlements?.dailyStandardChatRemaining;
    const remainingBoostsA = postEntA.entitlements?.reasoningBoostsRemaining;
    console.log(`[Quota Accounting] ✓ Account A post-matrix: dailyStandardChatRemaining=${remainingChatsA}, reasoningBoostsRemaining=${remainingBoostsA}`);

    // Cleanup test resources created in DB and Pro fixture
    await pageA.evaluate(async ({ cId, pId, mId, csrf }) => {
      await fetch(`/api/conversations/${cId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' });
      await fetch(`/api/projects/${pId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' });
      await fetch(`/api/memories/${mId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' });
    }, { cId: convIdA, pId: projIdA, mId: memIdA, csrf: activeCsrfA });

    await pageB.evaluate(async ({ cId, pId, mId, csrf }) => {
      await fetch(`/api/conversations/${cId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' });
      await fetch(`/api/projects/${pId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' });
      await fetch(`/api/memories/${mId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf, 'X-AIRA-CSRF-Protection': '1' }, credentials: 'include' });
    }, { cId: convIdB, pId: projIdB, mId: memIdB, csrf: csrfB });

    // -----------------------------------------------------------------------
    // 4. Logout & Session Revocation Verification
    // -----------------------------------------------------------------------
    console.log('\n[Session Revocation] Executing logout and post-logout verification...');
    await pageA.evaluate(async ({ c }) => {
      await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'x-aira-csrf-protection': '1', 'X-CSRF-Token': c }, credentials: 'include' });
    }, { c: activeCsrfA });
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    const afterLogoutA = await getBrowserSessionInfo(pageA);
    assert.equal(afterLogoutA.session?.status, 'ANONYMOUS', 'Account A session must be revoked after logout');

    await pageB.evaluate(async ({ c }) => {
      await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'x-aira-csrf-protection': '1', 'X-CSRF-Token': c }, credentials: 'include' });
    }, { c: csrfB });
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    const afterLogoutB = await getBrowserSessionInfo(pageB);
    assert.equal(afterLogoutB.session?.status, 'ANONYMOUS', 'Account B session must be revoked after logout');
    console.log('[Session Revocation] ✓ Both Google and GitHub sessions revoked cleanly on logout.');

    // Save sanitized report
    const finalReport = {
      timestamp: new Date().toISOString(),
      stagingUrl: STAGING_URL,
      deploymentUrl: versionData.deploymentUrl ?? null,
      expectedSha,
      shaSource,
      candidateSha: deployedSha,
      browserProfiles: {
        googleProfile: 'edge_oauth_profile_a',
        githubProfile: 'edge_oauth_profile_b',
      },
      googleAccountA: {
        userIdPrefix: userIdA.slice(0, 14),
        customerId: customerA,
        linkedProviders: providersA,
        reloadPersisted: true,
        revokedOnLogout: true,
      },
      githubAccountB: {
        userIdPrefix: userIdB.slice(0, 14),
        customerId: customerB,
        linkedProviders: providersB,
        reloadPersisted: true,
        revokedOnLogout: true,
      },
      crossAccountIsolation: {
        bAccessingA: bOnA,
        aAccessingB: aOnB,
        personalizationIsolated: true,
        pendingStreamAbortVerified: true,
      },
      runtimeMatrix: {
        fast: { provider: fastRes.provenance?.provider, model: fastRes.provenance?.executedModel, deltas: fastRes.deltaCount, fallbackOccurred: fastRes.provenance?.fallbackOccurred },
        auto: { provider: autoRes.provenance?.provider, model: autoRes.provenance?.executedModel, deltas: autoRes.deltaCount, fallbackOccurred: autoRes.provenance?.fallbackOccurred },
        freeProBlockedStatus,
        pro: { provider: proRes.provenance?.provider, model: proRes.provenance?.executedModel, deltas: proRes.deltaCount, fallbackOccurred: proRes.provenance?.fallbackOccurred },
        deep: { provider: deepRes.provenance?.provider, model: deepRes.provenance?.executedModel, deltas: deepRes.deltaCount, thinkingDeltas: deepRes.thinkingCount, reasoningControl: deepRes.provenance?.reasoningControl },
        longContextFailover: { provider: longRes.provenance?.provider, model: longRes.provenance?.executedModel, deltas: longRes.deltaCount, contentLength: longRes.contentText.trim().length, fallbackOccurred: longRes.provenance?.fallbackOccurred, persistedAfterReload: true },
      },
      quotaAccounting: {
        accountADailyChatRemainingPostMatrix: remainingChatsA,
        accountAReasoningBoostsRemainingPostMatrix: remainingBoostsA,
      },
      screenshots: [shotGoogle, shotGithub],
      verdict: 'PASS',
    };

    const reportPath = path.join(ARTIFACTS_DIR, 'REAL_OAUTH_CERTIFICATION_REPORT.json');
    fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2));
    console.log(`\n✓ Phase 2 Certification Complete! Evidence saved to ${reportPath}`);
  } finally {
    if (proFixtureActivated) {
      await cleanupAllStagingFixtures().catch((err) => console.error('Fixture cleanup failed:', err));
      await verifyStagingDbIntegrity().catch((err) => console.error('DB verify failed:', err));
    }
    if (contextA) await contextA.close();
    if (contextB) await contextB.close();
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runPhase2().catch((err) => {
    console.error('\n✗ Phase 2 Failed:', err);
    process.exit(1);
  });
}
