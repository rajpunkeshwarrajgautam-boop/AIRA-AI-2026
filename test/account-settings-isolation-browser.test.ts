/**
 * AIRA AI 2026 — Browser Account Isolation, Migration & Onboarding Sync E2E Suite
 *
 * Uses Playwright Chromium against the built `dist/` bundle served by a first-party
 * Express BFF gateway with HttpOnly cookies, CSRF tokens, and real `/api/user/onboarding`
 * + `/api/chat/stream` handlers to verify:
 * 1. Provenance-verified legacy `aira_settings_v1` quarantine & migration
 * 2. Account A -> B -> A personalization & outgoing request prompt isolation
 * 3. Active slow-stream request abort across authentication switch (zero late crosstalk)
 * 4. Full browser `page.reload()` session restoration retaining isolated account state
 * 5. Onboarding walkthrough closure + server `/api/user/onboarding` sync on switch
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { createAccountRoutes, resetOnboardingStoreForTesting } from '../apps/api/src/account-routes.js';
import type { ExecutionPrincipal } from '../packages/contracts/src/index.js';

interface TestUserRecord {
  id: string;
  email: string;
  name: string;
  password: string;
  tier: 'free' | 'plus' | 'pro';
}

interface CapturedStreamCall {
  userId: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  aborted: boolean;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function ensureBuiltDist(): string {
  const distDir = path.resolve(process.cwd(), 'dist');
  const distIndex = path.join(distDir, 'index.html');
  if (!fs.existsSync(distIndex)) {
    const buildRes = spawnSync('npx', ['vite', 'build'], {
      shell: true,
      stdio: 'inherit'
    });
    if (buildRes.status !== 0) {
      throw new Error(`Vite build failed with exit code ${buildRes.status}`);
    }
  }
  return distDir;
}

async function dismissBlockingOverlays(page: Page): Promise<void> {
  const whatsNewClose = page.locator('[data-testid="whats-new-dismiss-btn"], [data-testid="whats-new-close-btn"]').first();
  if (await whatsNewClose.isVisible().catch(() => false)) {
    await whatsNewClose.click().catch(() => {});
    await page.locator('[data-testid="whats-new-modal"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  }
  const skipBtn = page.locator('[data-testid="onboarding-skip-btn"]');
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click();
    await page.locator('[data-testid="onboarding-walkthrough"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  }
}

async function signInViaAuthModal(page: Page, email: string, password: string): Promise<void> {
  await dismissBlockingOverlays(page);
  const accountBtn = page.locator('[data-testid="account-button"]');
  const signInBtn = page.locator('[data-testid="account-menu-signin"]');
  await accountBtn.waitFor({ state: 'visible', timeout: 8000 });
  if (!(await signInBtn.isVisible().catch(() => false))) {
    await accountBtn.click();
  }
  await signInBtn.waitFor({ state: 'visible', timeout: 8000 });
  await signInBtn.click();

  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: 'Sign In with Email' }).click();

  await page.getByRole('button', { name: 'Sign Out' }).waitFor({ state: 'visible', timeout: 10000 });
  await dismissBlockingOverlays(page);
  await page.locator('[aria-labelledby="auth-modal-title"] button[aria-label="Close dialog"]').click();
  await page.locator('[aria-labelledby="auth-modal-title"]').waitFor({ state: 'detached', timeout: 8000 });
  await dismissBlockingOverlays(page);
}

async function signOutViaAccountMenu(page: Page): Promise<void> {
  await dismissBlockingOverlays(page);
  const accountBtn = page.locator('[data-testid="account-button"]');
  const logoutBtn = page.locator('[data-testid="account-menu-logout"]');
  await accountBtn.waitFor({ state: 'visible', timeout: 8000 });
  if (!(await logoutBtn.isVisible().catch(() => false))) {
    await accountBtn.click();
  }
  await logoutBtn.waitFor({ state: 'visible', timeout: 8000 });
  await logoutBtn.click();
  await logoutBtn.waitFor({ state: 'detached', timeout: 8000 });
  await page.locator('[data-testid="account-button"][aria-label*="Sign in"]').waitFor({ state: 'visible', timeout: 8000 });
  await dismissBlockingOverlays(page);
}

async function openSettingsModal(page: Page): Promise<void> {
  await dismissBlockingOverlays(page);
  await page.locator('button[title="Settings"]').click();
  await page.locator('#aira-settings-title').waitFor({ state: 'visible', timeout: 8000 });
}

async function closeSettingsModal(page: Page): Promise<void> {
  await page.locator('button[aria-label="Close settings"]').click();
  await page.locator('#aira-settings-title').waitFor({ state: 'detached', timeout: 8000 });
}

test('Browser E2E: Account A -> B -> A Isolation, Provenance Migration, Active Stream Abort & Onboarding Sync', async () => {
  const origDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  resetOnboardingStoreForTesting();

  const distDir = ensureBuiltDist();

  const usersByEmail = new Map<string, TestUserRecord>([
    [
      'alice@example.com',
      { id: 'usr_alice_browser', email: 'alice@example.com', name: 'Alice Principal', password: 'password-alice', tier: 'pro' }
    ],
    [
      'bob@example.com',
      { id: 'usr_bob_browser', email: 'bob@example.com', name: 'Bob Principal', password: 'password-bob', tier: 'free' }
    ]
  ]);
  const usersById = new Map<string, TestUserRecord>(Array.from(usersByEmail.values()).map((u) => [u.id, u]));
  const sessions = new Map<string, { userId: string; csrfToken: string }>();
  const streamCalls: CapturedStreamCall[] = [];
  let slowStreamDelayMs = 0;

  const app = express();
  app.use(express.json());

  // Resolve HttpOnly session cookie into req.principal
  app.use((req, _res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies['aira_test_session'];
    if (sid && sessions.has(sid)) {
      const sess = sessions.get(sid)!;
      const user = usersById.get(sess.userId);
      if (user) {
        const principal: ExecutionPrincipal = {
          userId: user.id,
          sessionId: sid,
          workspaceId: `ws_${user.id}`,
          tier: user.tier,
          scopes: ['chat:write']
        };
        req.principal = principal;
      }
    }
    next();
  });

  app.post('/api/auth/sign-in', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = usersByEmail.get(email);
    if (!user || user.password !== password) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
      return;
    }
    const sid = `sid_${user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const csrfToken = `csrf_${user.id}_${Math.random().toString(36).slice(2, 10)}`;
    sessions.set(sid, { userId: user.id, csrfToken });
    res.setHeader('Set-Cookie', `aira_test_session=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax`);
    res.json({
      status: 'AUTHENTICATED',
      user: { id: user.id, email: user.email, name: user.name },
      csrfToken
    });
  });

  app.post('/api/auth/sign-out', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies['aira_test_session'];
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'aira_test_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    res.json({ ok: true });
  });

  app.get('/api/auth/session', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies['aira_test_session'];
    const sess = sid ? sessions.get(sid) : undefined;
    const user = sess ? usersById.get(sess.userId) : undefined;
    if (!sess || !user) {
      res.json({ status: 'ANONYMOUS', user: null, csrfToken: null });
      return;
    }
    res.json({
      status: 'AUTHENTICATED',
      user: { id: user.id, email: user.email, name: user.name },
      csrfToken: sess.csrfToken
    });
  });

  app.get('/api/auth/providers', (req, res) => {
    if (!req.principal) {
      res.status(401).json({ providers: [] });
      return;
    }
    res.json({ providers: [] });
  });

  app.post('/api/auth/link-guest', (_req, res) => {
    res.json({ success: true, transferredConversations: 0 });
  });

  app.post('/api/conversations/sync', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/announcements', (_req, res) => {
    res.json({ announcements: [], unreadCount: 0 });
  });

  app.post('/api/announcements/dismiss', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/user', createAccountRoutes());

  app.get('/api/billing/summary', (req, res) => {
    const user = req.principal ? usersById.get(req.principal.userId) : undefined;
    const tier = user?.tier || 'guest';
    res.json({
      tier,
      usage: { standardDaily: 0, standardMonthly: 0, deepMonthly: 0, tokensMonthly: 0 },
      limits: {
        standardDaily: tier === 'pro' ? 150 : tier === 'free' ? 15 : 5,
        standardMonthly: tier === 'pro' ? 2000 : tier === 'free' ? 150 : 5,
        deepMonthly: tier === 'pro' ? 200 : tier === 'free' ? 5 : 0
      },
      creditBalance: 0
    });
  });

  app.get('/api/billing/entitlements', (req, res) => {
    const user = req.principal ? usersById.get(req.principal.userId) : undefined;
    const tier = user?.tier || 'guest';
    res.json({ tier });
  });

  app.get('/api/feature-flags', (_req, res) => {
    res.json({ flags: {} });
  });

  app.get('/api/conversations', (_req, res) => {
    res.json({ conversations: [] });
  });

  app.get('/api/projects', (_req, res) => {
    res.json({ projects: [] });
  });

  app.get('/api/memories', (_req, res) => {
    res.json({ memories: [] });
  });

  app.post('/api/chat/stream', async (req, res) => {
    const userId = req.principal?.userId || 'guest';
    const prompt = String(req.body?.prompt || '');
    const systemPrompt = String(req.body?.systemPrompt || '');
    const model = String(req.body?.model || 'aira-auto');
    const record: CapturedStreamCall = { userId, prompt, systemPrompt, model, aborted: false };
    streamCalls.push(record);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let disconnected = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        disconnected = true;
        record.aborted = true;
      }
    });

    const delay = prompt.includes('SLOW_ALICE_STREAM') ? slowStreamDelayMs : 10;
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    if (disconnected) return;

    const executedModel = model === 'aira-deep' ? 'nvidia/llama-3.1-nemotron-70b-instruct' : 'openai/gpt-oss-120b';
    const provider = model === 'aira-deep' ? 'nvidia' : 'groq';
    res.write(`event: model_provenance\ndata: ${JSON.stringify({
      requestedModel: model,
      resolvedPolicyModel: model,
      provider,
      executedModel,
      fallbackOccurred: false,
      verified: true,
      executionStatus: 'SUCCESS',
      timestamp: Date.now()
    })}\n\n`);

    const replyText = prompt.includes('SLOW_ALICE_STREAM')
      ? 'LATE_ALICE_CHUNK_SHOULD_ABORT'
      : `Reply for ${userId}: ${prompt}`;
    res.write(`event: content_delta\ndata: ${JSON.stringify({ text: replyText })}\n\n`);
    res.write('event: done\ndata: [DONE]\n\n');
    res.end();
  });

  app.use(express.static(distDir));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let browser: Browser | undefined;
  try {
    try {
      browser = await chromium.launch({ headless: true, channel: 'msedge' });
    } catch {
      browser = await chromium.launch({ headless: true });
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'warn' || msg.type() === 'error') {
        console.log(`[BROWSER_${msg.type().toUpperCase()}]`, msg.text());
      }
    });
    page.on('pageerror', (err) => console.error('[BROWSER_PAGEERROR]', err.message));
    page.on('response', (res) => {
      if (res.url().includes('/api/') && res.status() >= 400) {
        console.error('[BROWSER_API_ERR]', res.status(), res.url());
      }
    });

    // Seed legacy global aira_settings_v1 belonging to Alice ONCE on first boot before React mounts.
    await page.addInitScript(() => {
      if (!window.localStorage.getItem('__aira_iso_seeded__')) {
        window.localStorage.setItem('__aira_iso_seeded__', '1');
        window.localStorage.setItem('aira_settings_v1', JSON.stringify({
          userName: 'Alice Legacy',
          email: 'alice@example.com',
          userBio: 'ALICE_LEGACY_BIO_DO_NOT_LEAK',
          customInstructions: 'ALICE_LEGACY_INSTRUCTIONS_DO_NOT_LEAK',
          activeModel: 'aira-pro',
          extendedThinking: true,
          thinkingBudget: 4096,
          theme: 'light'
        }));
        // Suppress What's New popup annoyance so layout interactions stay deterministic
        window.localStorage.setItem('aira_dismissed_announcements', JSON.stringify(['v2.5-truthful-models']));
      }
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // -------------------------------------------------------------------------
    // Step 1: Bob logs in first — must NOT inherit Alice's legacy global bio!
    // -------------------------------------------------------------------------
    await dismissBlockingOverlays(page);
    await signInViaAuthModal(page, 'bob@example.com', 'password-bob');
    await dismissBlockingOverlays(page);

    await openSettingsModal(page);
    assert.equal(await page.locator('#aira-settings-email').inputValue(), 'bob@example.com');
    await page.locator('[data-testid="settings-tab-instructions"]').click();
    assert.equal(await page.locator('#aira-settings-bio').inputValue(), '', 'Bob must NOT inherit Alice legacy bio');
    assert.equal(await page.locator('#aira-settings-instructions').inputValue(), '', 'Bob must NOT inherit Alice legacy instructions');
    await closeSettingsModal(page);

    const sanitizedGlobalRaw = await page.evaluate(() => window.localStorage.getItem('aira_settings_v1') || '');
    assert.equal(sanitizedGlobalRaw.includes('ALICE_LEGACY_BIO_DO_NOT_LEAK'), false, 'Legacy aira_settings_v1 must be scrubbed');
    assert.equal(sanitizedGlobalRaw.includes('alice@example.com'), false, 'Legacy aira_settings_v1 must drop personal email');

    // Finish onboarding for Bob in server store so we can verify A -> B onboarding auto-close later!
    await page.evaluate(async () => {
      const sessRes = await fetch('/api/auth/session', { credentials: 'include' });
      const sess = await sessRes.json();
      await fetch('/api/user/onboarding', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': sess.csrfToken || '',
          'x-aira-csrf-protection': '1'
        },
        body: JSON.stringify({ action: 'finish' })
      });
    });

    // -------------------------------------------------------------------------
    // Step 2: Switch to Alice -> reclaims provenance-matched legacy bio!
    // -------------------------------------------------------------------------
    await signOutViaAccountMenu(page);
    await signInViaAuthModal(page, 'alice@example.com', 'password-alice');
    await dismissBlockingOverlays(page);

    await openSettingsModal(page);
    assert.equal(await page.locator('#aira-settings-email').inputValue(), 'alice@example.com');
    await page.locator('[data-testid="settings-tab-instructions"]').click();
    assert.equal(
      await page.locator('#aira-settings-bio').inputValue(),
      'ALICE_LEGACY_BIO_DO_NOT_LEAK',
      'Provenance-matched Alice must safely reclaim her quarantined legacy bio'
    );

    // Update Alice to distinct A settings and save
    await page.locator('#aira-settings-instructions').fill('ALICE_PRIVATE_RULE_99');
    await page.locator('#aira-settings-bio').fill('ALICE_PRIVATE_BIO_TOKEN');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await closeSettingsModal(page);

    // Send a chat message as Alice and verify outgoing systemPrompt contains Alice's personalization
    const composer = page.locator('main textarea').first();
    await composer.fill('Hello from Alice');
    await composer.press('Enter');
    await page.getByText('Reply for usr_alice_browser: Hello from Alice').waitFor({ state: 'visible', timeout: 8000 });

    const aliceCall = streamCalls.find((c) => c.userId === 'usr_alice_browser' && c.prompt.includes('Hello from Alice'));
    assert.ok(aliceCall, 'Alice request must be recorded');
    assert.ok(aliceCall.systemPrompt.includes('ALICE_PRIVATE_BIO_TOKEN'));
    assert.ok(aliceCall.systemPrompt.includes('ALICE_PRIVATE_RULE_99'));

    // -------------------------------------------------------------------------
    // Step 3: Account A -> B switch, settings save, outgoing request & reload check
    // -------------------------------------------------------------------------
    await signOutViaAccountMenu(page);
    await signInViaAuthModal(page, 'bob@example.com', 'password-bob');

    await openSettingsModal(page);
    await page.locator('[data-testid="settings-tab-instructions"]').click();
    assert.equal(await page.locator('#aira-settings-bio').inputValue(), '');
    assert.equal(await page.locator('#aira-settings-instructions').inputValue(), '');
    await page.locator('#aira-settings-bio').fill('BOB_PRIVATE_BIO_TOKEN');
    await page.locator('#aira-settings-instructions').fill('BOB_PRIVATE_RULE_77');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await closeSettingsModal(page);

    const bobComposer = page.locator('main textarea').first();
    await bobComposer.fill('Hello from Bob');
    await bobComposer.press('Enter');
    await page.getByText('Reply for usr_bob_browser: Hello from Bob').waitFor({ state: 'visible', timeout: 8000 });

    const bobCall = streamCalls.find((c) => c.userId === 'usr_bob_browser' && c.prompt.includes('Hello from Bob'));
    assert.ok(bobCall, 'Bob request must be recorded');
    assert.ok(bobCall.systemPrompt.includes('BOB_PRIVATE_BIO_TOKEN'));
    assert.ok(bobCall.systemPrompt.includes('BOB_PRIVATE_RULE_77'));
    assert.equal(bobCall.systemPrompt.includes('ALICE_PRIVATE_BIO_TOKEN'), false, 'Account A bio leaked into Account B request');
    assert.equal(bobCall.systemPrompt.includes('ALICE_PRIVATE_RULE_99'), false, 'Account A instructions leaked into Account B request');

    // Full browser page.reload() session restoration for Bob
    await page.reload({ waitUntil: 'networkidle' });
    await openSettingsModal(page);
    assert.equal(await page.locator('#aira-settings-email').inputValue(), 'bob@example.com');
    await page.locator('[data-testid="settings-tab-instructions"]').click();
    assert.equal(await page.locator('#aira-settings-bio').inputValue(), 'BOB_PRIVATE_BIO_TOKEN');
    assert.equal(await page.locator('#aira-settings-instructions').inputValue(), 'BOB_PRIVATE_RULE_77');
    await closeSettingsModal(page);

    const bobReloadComposer = page.locator('main textarea').first();
    await bobReloadComposer.fill('Post-reload Bob check');
    await bobReloadComposer.press('Enter');
    await page.getByText('Reply for usr_bob_browser: Post-reload Bob check').waitFor({ state: 'visible', timeout: 8000 });
    const bobReloadCall = streamCalls.find((c) => c.userId === 'usr_bob_browser' && c.prompt.includes('Post-reload Bob check'));
    assert.ok(bobReloadCall);
    assert.equal(bobReloadCall.systemPrompt.includes('ALICE_PRIVATE_BIO_TOKEN'), false);

    // -------------------------------------------------------------------------
    // Step 4: Active slow stream aborted across B -> A -> B transition + B -> A check
    // -------------------------------------------------------------------------
    await signOutViaAccountMenu(page);
    await signInViaAuthModal(page, 'alice@example.com', 'password-alice');

    // Confirm Alice kept her own state intact after B's edits
    await openSettingsModal(page);
    await page.locator('[data-testid="settings-tab-instructions"]').click();
    assert.equal(await page.locator('#aira-settings-bio').inputValue(), 'ALICE_PRIVATE_BIO_TOKEN');
    assert.equal(await page.locator('#aira-settings-instructions').inputValue(), 'ALICE_PRIVATE_RULE_99');
    await closeSettingsModal(page);

    slowStreamDelayMs = 600;
    const aliceSlowComposer = page.locator('main textarea').first();
    await aliceSlowComposer.fill('SLOW_ALICE_STREAM');
    await aliceSlowComposer.press('Enter');

    // Switch immediately while Alice's stream is still pending
    await page.waitForTimeout(80);
    await signOutViaAccountMenu(page);
    await signInViaAuthModal(page, 'bob@example.com', 'password-bob');
    await page.waitForTimeout(700);

    const bodyTextForBob = await page.locator('body').innerText();
    assert.equal(
      bodyTextForBob.includes('LATE_ALICE_CHUNK_SHOULD_ABORT'),
      false,
      'Late stream chunk from Account A must be aborted and never rendered in Account B'
    );

    // -------------------------------------------------------------------------
    // Step 5: Open Onboarding modal in Account A auto-closes when switched to completed Account B
    // -------------------------------------------------------------------------
    await signOutViaAccountMenu(page);
    await signInViaAuthModal(page, 'alice@example.com', 'password-alice');

    // Open onboarding walkthrough for Alice via sidebar Account menu -> Help & Resources -> Interactive Tour
    await page.locator('[data-testid="account-button"]').click();
    const helpSubmenuBtn = page.getByRole('menuitem', { name: /Help & Resources/i });
    await helpSubmenuBtn.waitFor({ state: 'visible', timeout: 8000 });
    await helpSubmenuBtn.click();
    const restartBtn = page.locator('[data-testid="account-menu-restart-onboarding"]');
    await restartBtn.waitFor({ state: 'visible', timeout: 8000 });
    await restartBtn.click();
    await page.locator('[data-testid="onboarding-walkthrough"]').waitFor({ state: 'visible', timeout: 8000 });

    // Trigger an external session transition to Bob (as happens on OAuth redirect or cross-tab sign-in)
    await page.evaluate(async () => {
      await fetch('/api/auth/sign-in', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-aira-csrf-protection': '1'
        },
        body: JSON.stringify({ email: 'bob@example.com', password: 'password-bob' })
      });
      const sessRes = await fetch('/api/auth/session', { credentials: 'include' });
      const sess = await sessRes.json();
      // Dispatch storage event matching cross-tab auth transition into Bob
      window.localStorage.setItem('aira_neon_auth_session_v1', JSON.stringify({
        user: sess.user,
        token: 'bff_session',
        csrfToken: sess.csrfToken
      }));
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'aira_neon_auth_session_v1',
        newValue: window.localStorage.getItem('aira_neon_auth_session_v1')
      }));
    });

    await page.locator('[data-testid="onboarding-walkthrough"]').waitFor({ state: 'detached', timeout: 8000 });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(
      await page.locator('[data-testid="onboarding-walkthrough"]').count(),
      0,
      'Completed Account B must keep onboarding closed across reload'
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetOnboardingStoreForTesting();
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
  }
});
