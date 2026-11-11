import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const TEST_PORT = 5192;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const ARTIFACTS_DIR = 'C:\\Users\\WORKSTATION\\.gemini\\antigravity\\brain\\37882de1-40fa-4894-902d-dcb2e7b28583';
const REPO_SCREENSHOTS_DIR = path.resolve(process.cwd(), 'test', 'screenshots');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function killPort(port: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`
      ], { stdio: 'ignore' });
    } catch {}
  }
}

function killProcessTree(proc: ChildProcess | null): void {
  if (proc && proc.pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { shell: true, stdio: 'ignore' });
      } else {
        proc.kill('SIGKILL');
      }
    } catch {}
  }
}

async function waitForHttp(url: string, timeoutMs = 25000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Server at ${url} failed to respond within ${timeoutMs}ms`);
}

async function startServer(): Promise<ChildProcess> {
  killPort(TEST_PORT);

  console.log(`[SERVER] Launching Vite preview on http://127.0.0.1:${TEST_PORT}...`);
  const serverProc: ChildProcess = spawn(
    'npx',
    ['vite', 'preview', '--host', '127.0.0.1', '--port', String(TEST_PORT), '--strictPort'],
    {
      shell: true,
      stdio: 'pipe'
    }
  );

  await waitForHttp(BASE_URL, 20000);
  console.log(`[SERVER] Vite preview server is ready on ${BASE_URL}`);
  return serverProc;
}

interface SetupOptions {
  userTier?: 'guest' | 'free' | 'plus' | 'pro';
  onboardingState?: { completed: boolean; currentStage?: string; skipped: boolean };
  dismissedAnnouncements?: string[];
  viewport?: { width: number; height: number };
}

async function createBrowserSession(
  browser: Browser,
  options: SetupOptions = {}
): Promise<{ context: BrowserContext; page: Page }> {
  const viewport = options.viewport || { width: 1280, height: 800 };
  const userTier = options.userTier || 'free';
  const isAuth = userTier !== 'guest';

  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1
  });

  const page = await context.newPage();

  // Intercept routes
  await page.route('**/api/auth/session', async (route) => {
    if (isAuth) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'AUTHENTICATED',
          user: {
            id: `usr_${userTier}_test`,
            name: `Aira ${userTier.toUpperCase()} User`,
            email: `${userTier}.user@aira.ai`,
            role: 'user',
            emailVerified: true
          }
        })
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ANONYMOUS',
          user: null
        })
      });
    }
  });

  await page.route('**/api/feature-flags', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ flags: {} })
    });
  });

  await page.route('**/api/announcements/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true })
    });
  });

  await page.route('**/api/onboarding/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true })
    });
  });

  await page.route('**/api/billing/summary', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        principalId: `usr_${userTier}_test`,
        planId: userTier,
        planName: userTier === 'pro' ? 'AIRA Pro' : userTier === 'plus' ? 'AIRA Plus' : 'AIRA Free',
        subscriptionStatus: 'active',
        availableCredits: 100,
        lifetimeGranted: 100,
        lifetimeSpent: 0,
        dailyChatsUsed: 1,
        dailyChatLimit: 15,
        monthlyUnitsUsed: 1,
        monthlyUnitLimit: 15,
        reasoningBoostsUsed: 0,
        reasoningBoostLimit: 5
      })
    });
  });

  await page.route('**/api/billing/entitlements', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        plan: userTier,
        subscriptionStatus: 'active',
        dailyStandardChatLimit: 15,
        dailyStandardChatRemaining: 14,
        availableCredits: 100,
        reasoningBoostsRemaining: 5,
        reasoningBoostsLimit: 5
      })
    });
  });

  await page.addInitScript(({ tier, isAuthed, onboarding, dismissed }) => {
    const scope = isAuthed ? `usr_${tier}_test` : 'guest';

    if (isAuthed) {
      localStorage.setItem('aira_neon_auth_session_v1', JSON.stringify({
        user: {
          id: `usr_${tier}_test`,
          name: `Aira ${tier.toUpperCase()} User`,
          email: `${tier}.user@aira.ai`,
          role: 'user',
          emailVerified: true
        },
        token: `mock_session_token_${tier}`,
        jwt: `mock_jwt_token_${tier}`,
        jwtExpiresAt: Date.now() + 86400000
      }));
    }

    if (onboarding) {
      localStorage.setItem(`aira_onboarding_${scope}`, JSON.stringify(onboarding));
    }

    if (dismissed) {
      localStorage.setItem(`aira_dismissed_announcements_${scope}`, JSON.stringify(dismissed));
      localStorage.setItem('aira_seen_announcements', JSON.stringify(dismissed));
    }
  }, {
    tier: userTier,
    isAuthed: isAuth,
    onboarding: options.onboardingState,
    dismissed: options.dismissedAnnouncements
  });

  return { context, page };
}

async function saveScreenshot(page: Page, filename: string) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.mkdirSync(REPO_SCREENSHOTS_DIR, { recursive: true });

  const artifactTarget = path.join(ARTIFACTS_DIR, filename);
  const repoTarget = path.join(REPO_SCREENSHOTS_DIR, filename);

  await page.screenshot({ path: artifactTarget, fullPage: false });
  fs.copyFileSync(artifactTarget, repoTarget);
  console.log(`[SCREENSHOT] Saved: ${filename} -> ${artifactTarget}`);
}

async function captureAllPreviews() {
  let serverProc: ChildProcess | null = null;
  let browser: Browser | null = null;

  try {
    serverProc = await startServer();
    browser = await chromium.launch({ channel: 'msedge', headless: true });

    // 1. Model Selector Preview
    console.log('Capturing: Model Selector...');
    {
      const { context, page } = await createBrowserSession(browser, {
        userTier: 'free',
        onboardingState: { completed: true, currentStage: 'plans', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });
      try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);

        const modelBtn = page.locator('button[aria-haspopup="listbox"]');
        await modelBtn.waitFor({ state: 'visible', timeout: 10000 });
        await modelBtn.click();
        await page.waitForTimeout(600);

        await saveScreenshot(page, '01_model_selector_truthful.png');
      } finally {
        await context.close();
      }
    }

    // 2. Settings Modal - General & Personalization
    console.log('Capturing: Settings General & Personalization...');
    {
      const { context, page } = await createBrowserSession(browser, {
        userTier: 'free',
        onboardingState: { completed: true, currentStage: 'plans', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });
      try {
        await page.goto(`${BASE_URL}/?tab=general`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);

        const dialog = page.getByTestId('settings-dialog');
        await dialog.waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForTimeout(600);

        await saveScreenshot(page, '02_settings_general_personalization.png');
      } finally {
        await context.close();
      }
    }

    // 3. Settings Modal - Models & Reasoning
    console.log('Capturing: Settings Models & Reasoning...');
    {
      const { context, page } = await createBrowserSession(browser, {
        userTier: 'free',
        onboardingState: { completed: true, currentStage: 'plans', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });
      try {
        await page.goto(`${BASE_URL}/?tab=reasoning`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);

        const dialog = page.getByTestId('settings-dialog');
        await dialog.waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForTimeout(600);

        await saveScreenshot(page, '03_settings_reasoning_calibrated.png');
      } finally {
        await context.close();
      }
    }

    // 4. Settings Modal - Account & Privacy / Storage
    console.log('Capturing: Settings Account & Privacy...');
    {
      const { context, page } = await createBrowserSession(browser, {
        userTier: 'free',
        onboardingState: { completed: true, currentStage: 'plans', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });
      try {
        await page.goto(`${BASE_URL}/?tab=data`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);

        const dialog = page.getByTestId('settings-dialog');
        await dialog.waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForTimeout(600);

        await saveScreenshot(page, '04_settings_account_privacy_safeguard.png');
      } finally {
        await context.close();
      }
    }

    // 5. Settings Modal - My Plan & Usage
    console.log('Capturing: Settings My Plan & Usage...');
    {
      const { context, page } = await createBrowserSession(browser, {
        userTier: 'free',
        onboardingState: { completed: true, currentStage: 'plans', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });
      try {
        await page.goto(`${BASE_URL}/?tab=plan`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);

        const dialog = page.getByTestId('settings-dialog');
        await dialog.waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForTimeout(600);

        await saveScreenshot(page, '05_settings_plan_truthful.png');
      } finally {
        await context.close();
      }
    }

    // 6. Onboarding Walkthrough
    console.log('Capturing: Onboarding Walkthrough...');
    {
      const { context, page } = await createBrowserSession(browser, {
        userTier: 'free',
        onboardingState: { completed: false, currentStage: 'welcome', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });
      try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1500);

        await saveScreenshot(page, '06_onboarding_walkthrough_truthful.png');
      } finally {
        await context.close();
      }
    }

    console.log('All screenshots captured successfully!');
  } finally {
    if (browser) await browser.close();
    killProcessTree(serverProc);
    killPort(TEST_PORT);
  }
}

captureAllPreviews().catch((err) => {
  console.error('Error capturing previews:', err);
  process.exit(1);
});
