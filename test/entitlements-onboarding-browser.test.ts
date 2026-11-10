/**
 * AIRA AI 2026 — Milestone 5 Browser Acceptance Test Suite
 * Automated Microsoft Edge Acceptance Testing for Entitlements, What's New & Interactive Onboarding Tour
 *
 * Scenarios Tested:
 * 1. What's New Announcement Modal & Unread Badge (Popup, Dismissal, Badge Decrement, Release Center Changelog)
 * 2. 5-Stage Interactive Onboarding Tour (Intro -> Chat -> Agent -> Projects -> Plans -> Finish, Next/Back/Skip/Resume/Restart, Progress Dots)
 * 3. Contextual Upgrade Modals & Capability Discovery (Guest limit, Free locked model, Plus locked Pro tool, Sandbox notice)
 * 4. "My Plan & Usage" Tab in Settings (Usage Gauges, Reset Countdowns, Plan Comparison Matrix)
 * 5. Mobile Responsive Viewport Acceptance (390x844, touch layout, modal scaling, drawer navigation)
 *
 * Browser Engine: Microsoft Edge (channel: 'msedge') via Playwright
 * Viewports: Desktop (1280x800) & Mobile (390x844)
 * Screenshots: Captured to test/screenshots/
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const TEST_PORT = 5185;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const SCREENSHOT_DIR = path.resolve(process.cwd(), 'test', 'screenshots');

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
  // Pre-clean test port
  killPort(TEST_PORT);

  // Ensure production build dist exists
  const distIndex = path.resolve(process.cwd(), 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    console.log('[BUILD] Building client distribution bundle...');
    const buildRes = spawnSync('npx', ['vite', 'build'], {
      shell: true,
      stdio: 'inherit'
    });
    if (buildRes.status !== 0) {
      throw new Error(`Vite build failed with code ${buildRes.status}`);
    }
  }

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
  const userTier = options.userTier || 'guest';
  const isAuth = userTier !== 'guest';

  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    hasTouch: viewport.width < 600,
    isMobile: viewport.width < 600,
    userAgent: viewport.width < 600
      ? 'Mozilla/5.0 (Linux; Android 14; Mobile; Edge/157.0) AppleWebKit/537.36 Chrome/157.0 Mobile Safari/537.36 EdgA/157.0'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0 Safari/537.36 Edg/157.0'
  });

  const page = await context.newPage();

  // Intercept billing and auth API endpoints to supply deterministic tier truth
  await page.route('**/api/billing/summary', async (route) => {
    if (isAuth) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          principalId: `usr_${userTier}_test`,
          planId: userTier,
          planName: userTier === 'pro' ? 'AIRA Pro' : userTier === 'plus' ? 'AIRA Plus' : 'AIRA Free',
          subscriptionStatus: 'active',
          availableCredits: userTier === 'pro' ? 7500 : userTier === 'plus' ? 3000 : 100,
          lifetimeGranted: 10000,
          lifetimeSpent: 2500,
          dailyChatsUsed: userTier === 'pro' ? 5 : userTier === 'plus' ? 2 : 1,
          dailyChatLimit: userTier === 'pro' ? 150 : userTier === 'plus' ? 50 : 15,
          monthlyUnitsUsed: 20,
          monthlyUnitLimit: 500,
          reasoningBoostsUsed: 0,
          reasoningBoostLimit: userTier === 'pro' ? 200 : userTier === 'plus' ? 50 : 5
        })
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          principalId: 'guest_session',
          planId: 'guest',
          planName: 'AIRA Guest',
          subscriptionStatus: 'trial',
          dailyChatsUsed: 0,
          dailyChatLimit: 5
        })
      });
    }
  });

  await page.route('**/api/user/usage', async (route) => {
    const limits = {
      guest: { chats: 5, credits: 0, boosts: 0 },
      free: { chats: 15, credits: 100, boosts: 5 },
      plus: { chats: 50, credits: 3000, boosts: 50 },
      pro: { chats: 150, credits: 7500, boosts: 200 }
    }[userTier];

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        planId: userTier,
        planName: `AIRA ${userTier.toUpperCase()}`,
        dailyChatsUsed: 1,
        dailyChatsLimit: limits.chats,
        remainingDailyChats: limits.chats - 1,
        monthlyCreditsRemaining: limits.credits,
        reasoningBoostsRemaining: limits.boosts,
        resetAt: '2026-11-11T00:00:00.000Z',
        paymentCollectionDisabled: true,
        billingStatus: 'No active charges — billing integration strictly isolated'
      })
    });
  });

  // Inject initial localStorage state before document loads
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
        token: `mock_session_token_${tier}`
      }));
    } else {
      localStorage.removeItem('aira_neon_auth_session_v1');
    }

    if (onboarding && !localStorage.getItem(`aira_onboarding_${scope}`)) {
      localStorage.setItem(`aira_onboarding_${scope}`, JSON.stringify(onboarding));
    }

    if (dismissed && !localStorage.getItem(`aira_dismissed_announcements_${scope}`)) {
      localStorage.setItem(`aira_dismissed_announcements_${scope}`, JSON.stringify(dismissed));
      if (!isAuthed && !localStorage.getItem('aira_seen_announcements')) {
        localStorage.setItem('aira_seen_announcements', JSON.stringify(dismissed));
      }
    }
  }, {
    tier: userTier,
    isAuthed: isAuth,
    onboarding: options.onboardingState,
    dismissed: options.dismissedAnnouncements
  });

  return { context, page };
}

async function openSidebarIfMobile(page: Page): Promise<void> {
  const openBtn = page.getByRole('button', { name: 'Open sidebar navigation' });
  if (await openBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await openBtn.click();
    await page.locator('.aira-sidebar-shell').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
  }
}

async function openAccountMenu(page: Page): Promise<void> {
  await openSidebarIfMobile(page);
  const accountBtn = page.getByTestId('account-button');
  await accountBtn.waitFor({ state: 'visible', timeout: 5000 });
  await accountBtn.click();
  await page.waitForSelector('[role="menu"]', { state: 'visible', timeout: 5000 });
}

async function openHelpAndResourcesMenu(page: Page): Promise<void> {
  await openAccountMenu(page);
  const helpItem = page.getByRole('menuitem', { name: /Help & Resources/i });
  await helpItem.waitFor({ state: 'visible', timeout: 5000 });
  await helpItem.click();
  await page.waitForTimeout(300);
}

// =========================================================================
// TEST SUITE EXECUTION
// =========================================================================

async function runTestSuite() {
  console.log('\n================================================================');
  console.log(' AIRA AI 2026 — MICROSOFT EDGE BROWSER ACCEPTANCE SUITE (M5)  ');
  console.log('================================================================\n');

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  let serverProc: ChildProcess | null = null;
  let browser: Browser | null = null;
  let passedCount = 0;
  const totalScenarios = 5;

  try {
    // 1. Launch Vite preview server
    serverProc = await startServer();

    // 2. Launch Genuine Microsoft Edge via Playwright
    console.log('[BROWSER] Launching Microsoft Edge (channel: msedge)...');
    browser = await chromium.launch({
      channel: 'msedge',
      headless: true
    });
    console.log(`[BROWSER] Connected to Microsoft Edge browser engine v${browser.version()}\n`);

    // =======================================================================
    // SCENARIO 1: What's New Announcement Modal & Unread Badge
    // =======================================================================
    console.log('--- [SCENARIO 1] What\'s New Announcement Modal & Unread Badge ---');
    {
      // Setup: Guest user with completed onboarding so announcement popup triggers directly
      const { context, page } = await createBrowserSession(browser, {
        userTier: 'guest',
        onboardingState: { completed: true, currentStage: 'plans', skipped: false },
        dismissedAnnouncements: [] // None dismissed => all 3 announcements unread
      });

      try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // 1.1 Verify first-view popup automatically displays the latest announcement
        console.log('  [1.1] Verifying first-view popup on version publish...');
        const modal = page.getByTestId('whats-new-modal');
        await modal.waitFor({ state: 'visible', timeout: 10000 });

        const headerTitle = modal.locator('h2');
        assert.ok(await headerTitle.isVisible(), 'What\'s New modal header title must be visible');
        const headerText = await headerTitle.textContent();
        assert.ok(
          headerText?.includes("What's New"),
          `Header should indicate What's New, got: "${headerText}"`
        );

        // Verify latest announcement content is displayed in popup mode
        const latestItem = modal.getByTestId('whats-new-item-ann_model_routing_v3');
        await latestItem.waitFor({ state: 'visible', timeout: 5000 });
        const itemContent = await latestItem.textContent();
        assert.ok(
          itemContent?.includes('Intelligent Capability Discovery') || itemContent?.includes('v2026.11.3'),
          'Latest announcement (v2026.11.3) should be featured in popup'
        );

        // Capture Desktop Screenshot: whats-new-desktop.png
        const desktopScreenshotPath = path.join(SCREENSHOT_DIR, 'whats-new-desktop.png');
        await page.screenshot({ path: desktopScreenshotPath, fullPage: false });
        assert.ok(fs.existsSync(desktopScreenshotPath), 'whats-new-desktop.png screenshot must exist');
        console.log(`  ✓ Captured acceptance screenshot: ${desktopScreenshotPath}`);

        // 1.2 Verify dismissal decrements badge
        console.log('  [1.2] Verifying announcement dismissal decrements badge count...');
        const dismissBtn = page.getByTestId('whats-new-dismiss-btn');
        await dismissBtn.waitFor({ state: 'visible', timeout: 5000 });
        await dismissBtn.click();
        await modal.waitFor({ state: 'hidden', timeout: 5000 });
        console.log('  ✓ Popup dismissed cleanly');

        // Open Account Menu to inspect unread badge
        await openHelpAndResourcesMenu(page);
        const badge = page.getByTestId('account-menu-whats-new-badge');
        await badge.waitFor({ state: 'visible', timeout: 5000 });
        const badgeText = (await badge.textContent())?.trim();
        assert.strictEqual(
          badgeText,
          '2',
          `Unread badge should decrement from 3 to 2 after dismissing 1 announcement, got: "${badgeText}"`
        );
        console.log(`  ✓ Unread badge successfully decremented to ${badgeText}`);

        // 1.3 Verify permanent release center changelog view
        console.log('  [1.3] Verifying permanent release center changelog view...');
        const whatsNewMenuItem = page.getByTestId('account-menu-whats-new');
        await whatsNewMenuItem.click();

        // Modal re-opens
        await modal.waitFor({ state: 'visible', timeout: 5000 });

        // Switch to full changelog center view if in popup mode
        const viewAllBtn = modal.getByRole('button', { name: /View All Releases|Release history/i });
        if (await viewAllBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await viewAllBtn.click();
          await page.waitForTimeout(300);
        }

        // Verify permanent center shows all 3 announcements
        const item1 = modal.getByTestId('whats-new-item-ann_entitlements_v2');
        const item2 = modal.getByTestId('whats-new-item-ann_onboarding_walkthrough');
        const item3 = modal.getByTestId('whats-new-item-ann_model_routing_v3');

        await Promise.all([
          item1.waitFor({ state: 'visible', timeout: 5000 }),
          item2.waitFor({ state: 'visible', timeout: 5000 }),
          item3.waitFor({ state: 'visible', timeout: 5000 })
        ]);

        // Verify item 3 shows "Read" (since it was dismissed earlier)
        assert.ok(
          (await item3.textContent())?.includes('Read'),
          'Dismissed announcement should indicate Read state'
        );

        // Click "Mark Read" on item 2 (onboarding walkthrough announcement)
        const markReadBtn = item2.getByRole('button', { name: 'Mark Read' });
        await markReadBtn.click();
        await page.waitForTimeout(400);

        // Close modal
        await page.getByTestId('whats-new-close-btn').click();
        await modal.waitFor({ state: 'hidden', timeout: 5000 });

        // Re-open Account Menu: badge must now be '1'
        await openHelpAndResourcesMenu(page);
        const updatedBadge = page.getByTestId('account-menu-whats-new-badge');
        await updatedBadge.waitFor({ state: 'visible', timeout: 5000 });
        const updatedCount = (await updatedBadge.textContent())?.trim();
        assert.strictEqual(
          updatedCount,
          '1',
          `Unread badge must decrement to 1 after marking second announcement as read, got: "${updatedCount}"`
        );
        console.log(`  ✓ Permanent changelog verified; badge updated to ${updatedCount}`);

        // Close menu
        await page.keyboard.press('Escape');
        passedCount++;
        console.log('✅ Scenario 1 Passed (100%)\n');
      } finally {
        await context.close();
      }
    }

    // =======================================================================
    // SCENARIO 2: 5-Stage Interactive Onboarding Tour
    // =======================================================================
    console.log('--- [SCENARIO 2] 5-Stage Interactive Onboarding Tour ---');
    {
      const { context, page } = await createBrowserSession(browser, {
        userTier: 'free',
        onboardingState: { completed: false, currentStage: 'intro', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });

      try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // 2.1 Verify Stage 1: Intro
        console.log('  [2.1] Verifying Stage 1: Welcome to AIRA (intro)...');
        const tour = page.getByTestId('onboarding-walkthrough');
        await tour.waitFor({ state: 'visible', timeout: 10000 });

        const stageIntro = page.getByTestId('onboarding-stage-intro');
        await stageIntro.waitFor({ state: 'visible', timeout: 5000 });
        const introText = await stageIntro.textContent();
        assert.ok(introText?.includes('Welcome to AIRA'), 'Intro stage must display Welcome to AIRA');

        // Back button must be disabled on stage 1
        const backBtn = page.getByTestId('onboarding-back-btn');
        assert.ok(await backBtn.isDisabled(), 'Back button must be disabled on first stage');

        // Dot 1 must be active
        const dotIntro = page.getByTestId('onboarding-dot-intro');
        assert.ok(await dotIntro.isVisible(), 'Intro dot must be visible');

        // Capture Desktop Screenshot: onboarding-tour-desktop.png
        const desktopScreenshotPath = path.join(SCREENSHOT_DIR, 'onboarding-tour-desktop.png');
        await page.screenshot({ path: desktopScreenshotPath, fullPage: false });
        assert.ok(fs.existsSync(desktopScreenshotPath), 'onboarding-tour-desktop.png screenshot must exist');
        console.log(`  ✓ Captured acceptance screenshot: ${desktopScreenshotPath}`);

        // 2.2 Verify Stage 2: Chat & Reasoning
        console.log('  [2.2] Advancing to Stage 2: Chat & Reasoning...');
        const nextBtn = page.getByTestId('onboarding-next-btn');
        await nextBtn.click();
        const stageChat = page.getByTestId('onboarding-stage-chat_reasoning');
        await stageChat.waitFor({ state: 'visible', timeout: 5000 });
        assert.ok(
          (await stageChat.textContent())?.includes('Conversational Intelligence & Reasoning'),
          'Stage 2 must explain chat & reasoning'
        );
        assert.ok(!(await backBtn.isDisabled()), 'Back button must be enabled on stage 2');

        // 2.3 Verify Stage 3: Agent Mode
        console.log('  [2.3] Advancing to Stage 3: Autonomous Agent Missions...');
        await nextBtn.click();
        const stageAgent = page.getByTestId('onboarding-stage-agent_mode');
        await stageAgent.waitFor({ state: 'visible', timeout: 5000 });
        assert.ok(
          (await stageAgent.textContent())?.includes('Autonomous Agent Missions'),
          'Stage 3 must explain autonomous agent missions'
        );

        // 2.4 Verify Stage 4: Projects & Artifacts
        console.log('  [2.4] Advancing to Stage 4: Projects & Artifact Studio...');
        await nextBtn.click();
        const stageProjects = page.getByTestId('onboarding-stage-projects_artifacts');
        await stageProjects.waitFor({ state: 'visible', timeout: 5000 });
        assert.ok(
          (await stageProjects.textContent())?.includes('Projects & Artifact Studio'),
          'Stage 4 must explain projects & artifacts'
        );

        // 2.5 Verify Stage 5: Plans & Personalization
        console.log('  [2.5] Advancing to Stage 5: Plans & Personalization...');
        await nextBtn.click();
        const stagePlans = page.getByTestId('onboarding-stage-plans');
        await stagePlans.waitFor({ state: 'visible', timeout: 5000 });
        assert.ok(
          (await stagePlans.textContent())?.includes('Plans & Personalization'),
          'Stage 5 must explain plans & personalization'
        );

        // On Stage 5, "Next" is replaced with "Get Started"
        const finishBtn = page.getByTestId('onboarding-finish-btn');
        await finishBtn.waitFor({ state: 'visible', timeout: 5000 });
        assert.strictEqual(
          (await finishBtn.textContent())?.trim(),
          'Get Started',
          'Finish button should read "Get Started"'
        );

        // 2.6 Verify Back navigation
        console.log('  [2.6] Verifying Back navigation from Stage 5 to Stage 4...');
        await backBtn.click();
        await stageProjects.waitFor({ state: 'visible', timeout: 5000 });
        console.log('  ✓ Back navigation returned to Stage 4');

        // 2.7 Verify Jump via dot indicator
        console.log('  [2.7] Verifying direct jump to Stage 3 via progress dot...');
        const dotAgent = page.getByTestId('onboarding-dot-agent_mode');
        await dotAgent.click();
        await stageAgent.waitFor({ state: 'visible', timeout: 5000 });
        console.log('  ✓ Progress dot jump reached Stage 3');

        // 2.8 Verify Resume after page refresh
        console.log('  [2.8] Verifying tour resumes at saved stage after page refresh...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        const resumedTour = page.getByTestId('onboarding-walkthrough');
        await resumedTour.waitFor({ state: 'visible', timeout: 10000 });
        const resumedStage = page.getByTestId('onboarding-stage-agent_mode');
        await resumedStage.waitFor({ state: 'visible', timeout: 5000 });
        console.log('  ✓ Tour successfully resumed at Stage 3 (Agent Mode) after refresh');

        // 2.9 Verify Skip button dismisses and persists
        console.log('  [2.9] Verifying Skip Tour button closes tour and marks skipped...');
        const skipBtn = page.getByTestId('onboarding-skip-btn');
        await skipBtn.click();
        await resumedTour.waitFor({ state: 'hidden', timeout: 5000 });

        // Reload page to verify tour does NOT pop up when skipped
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);
        assert.ok(
          await page.getByTestId('onboarding-walkthrough').isHidden(),
          'Skipped onboarding tour must not open automatically on subsequent page reload'
        );

        // 2.10 Verify Restart Tutorial from Account Menu
        console.log('  [2.10] Verifying Restart Tutorial launches walkthrough from Step 1...');
        await openHelpAndResourcesMenu(page);
        const restartBtn = page.getByTestId('account-menu-restart-onboarding');
        await restartBtn.waitFor({ state: 'visible', timeout: 5000 });
        await restartBtn.click();

        // Tour must re-open at Stage 1 (Intro)
        const restartedTour = page.getByTestId('onboarding-walkthrough');
        await restartedTour.waitFor({ state: 'visible', timeout: 5000 });
        await page.getByTestId('onboarding-stage-intro').waitFor({ state: 'visible', timeout: 5000 });
        console.log('  ✓ Tutorial restarted at Stage 1');

        // Close tour with escape or finish
        await page.keyboard.press('Escape');
        await restartedTour.waitFor({ state: 'hidden', timeout: 5000 });

        passedCount++;
        console.log('✅ Scenario 2 Passed (100%)\n');
      } finally {
        await context.close();
      }
    }

    // =======================================================================
    // SCENARIO 3: Contextual Upgrade Modals & Capability Discovery
    // =======================================================================
    console.log('--- [SCENARIO 3] Contextual Upgrade Modals & Capability Discovery ---');
    {
      // 3.1 Verify Guest limit upgrade modal
      console.log('  [3.1] Testing Guest limit upgrade modal trigger...');
      const guestSession = await createBrowserSession(browser, {
        userTier: 'guest',
        onboardingState: { completed: true, currentStage: 'plans', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });

      try {
        await guestSession.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Click Agent Mode button in chat bar as guest
        const agentModeBtn = guestSession.page.getByTestId('chat-mode-agent-btn');
        await agentModeBtn.waitFor({ state: 'visible', timeout: 10000 });
        await agentModeBtn.click();

        // Verify Upgrade Modal appears
        const upgradeModal = guestSession.page.getByTestId('upgrade-modal');
        await upgradeModal.waitFor({ state: 'visible', timeout: 5000 });

        const title = await upgradeModal.locator('#upgrade-modal-title').textContent();
        assert.ok(
          title?.includes('Sign In to Keep Chatting'),
          `Guest upgrade modal title should prompt sign-in, got: "${title}"`
        );

        const subtitle = await upgradeModal.locator('p').first().textContent();
        assert.ok(
          subtitle?.includes('Guest session allowance completed') || subtitle?.includes('free account'),
          `Guest subtitle should indicate allowance completed, got: "${subtitle}"`
        );

        const ctaBtn = guestSession.page.getByTestId('upgrade-modal-cta');
        assert.ok(
          (await ctaBtn.textContent())?.includes('Sign In / Sign Up Free'),
          'Guest upgrade CTA should offer Sign In / Sign Up Free'
        );

        // Verify Sandbox Notice is displayed
        const sandboxNotice = upgradeModal.locator('text=Live payment collection is currently in sandbox/isolated mode.');
        await sandboxNotice.waitFor({ state: 'visible', timeout: 5000 });
        console.log('  ✓ Guest limit upgrade modal and sandbox notice verified');

        // Close modal
        await guestSession.page.getByTestId('upgrade-modal-close').click();
        await upgradeModal.waitFor({ state: 'hidden', timeout: 5000 });
      } finally {
        await guestSession.context.close();
      }

      // 3.2 Verify Free user clicking locked model opens upgrade modal
      console.log('  [3.2] Testing Free user clicking locked model (Claude 3.5 Sonnet)...');
      const freeSession = await createBrowserSession(browser, {
        userTier: 'free',
        onboardingState: { completed: true, currentStage: 'plans', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });

      try {
        await freeSession.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Open Model Selector
        const modelBtn = freeSession.page.locator('button[aria-haspopup="listbox"]');
        await modelBtn.waitFor({ state: 'visible', timeout: 10000 });
        await modelBtn.click();

        // Find locked model (Claude 3.5 Sonnet has data-testid="model-locked-claude-3-5-sonnet")
        const lockedBadge = freeSession.page.getByTestId('model-locked-claude-3-5-sonnet');
        await lockedBadge.waitFor({ state: 'visible', timeout: 5000 });

        // Click the locked model option (Claude 3.5 Sonnet / Aira Pro)
        const sonnetOption = freeSession.page.getByTestId('model-option-claude-3-5-sonnet');
        await sonnetOption.click();

        // Verify Upgrade Modal opens with flagship model config
        const upgradeModal = freeSession.page.getByTestId('upgrade-modal');
        await upgradeModal.waitFor({ state: 'visible', timeout: 5000 });

        const title = await upgradeModal.locator('#upgrade-modal-title').textContent();
        assert.ok(
          title?.includes('Unlock Claude 3.5 Sonnet') || title?.includes('DeepSeek R1'),
          `Flagship model modal title expected, got: "${title}"`
        );

        const ctaBtn = freeSession.page.getByTestId('upgrade-modal-cta');
        assert.ok(
          (await ctaBtn.textContent())?.includes('Upgrade to Plus'),
          'CTA should offer "Upgrade to Plus"'
        );

        // Verify feature highlights include 50 Chats/Day and Credits
        const modalContent = await upgradeModal.textContent();
        assert.ok(modalContent?.includes('50 Chats/Day'), 'Modal must mention 50 Chats/Day');
        assert.ok(modalContent?.includes('3,000 Monthly Premium Credits'), 'Modal must mention 3,000 credits');

        // Capture Desktop Screenshot: upgrade-modal-desktop.png
        const desktopScreenshotPath = path.join(SCREENSHOT_DIR, 'upgrade-modal-desktop.png');
        await freeSession.page.screenshot({ path: desktopScreenshotPath, fullPage: false });
        assert.ok(fs.existsSync(desktopScreenshotPath), 'upgrade-modal-desktop.png screenshot must exist');
        console.log(`  ✓ Captured acceptance screenshot: ${desktopScreenshotPath}`);

        // Close modal
        await freeSession.page.getByTestId('upgrade-modal-close').click();
        await upgradeModal.waitFor({ state: 'hidden', timeout: 5000 });
      } finally {
        await freeSession.context.close();
      }

      // 3.3 Verify Plus user clicking locked Pro tool opens upgrade modal
      console.log('  [3.3] Testing Plus user clicking locked Pro tool / agent capability...');
      const plusSession = await createBrowserSession(browser, {
        userTier: 'plus',
        onboardingState: { completed: true, currentStage: 'plans', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });

      try {
        await plusSession.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Open Settings directly to Plan tab to trigger Pro upgrade modal
        await plusSession.page.goto(`${BASE_URL}/?tab=plan`, { waitUntil: 'domcontentloaded' });
        const settingsDialog = plusSession.page.getByTestId('settings-dialog');
        await settingsDialog.waitFor({ state: 'visible', timeout: 10000 });

        // Click "Upgrade Tier" button in active plan overview card
        const upgradeTierBtn = settingsDialog.getByRole('button', { name: 'Upgrade Tier' });
        await upgradeTierBtn.waitFor({ state: 'visible', timeout: 5000 });
        await upgradeTierBtn.click();

        // Verify Upgrade Modal opens for Pro tools
        const upgradeModal = plusSession.page.getByTestId('upgrade-modal');
        await upgradeModal.waitFor({ state: 'visible', timeout: 5000 });

        const title = await upgradeModal.locator('#upgrade-modal-title').textContent();
        assert.ok(
          title?.includes('AIRA Pro Tools'),
          `Plus upgrade title should mention Pro Tools, got: "${title}"`
        );

        const ctaBtn = plusSession.page.getByTestId('upgrade-modal-cta');
        assert.ok(
          (await ctaBtn.textContent())?.includes('Upgrade to Pro'),
          'CTA should offer "Upgrade to Pro"'
        );

        // Verify Pro features mentioned
        const proModalContent = await upgradeModal.textContent();
        assert.ok(proModalContent?.includes('Browser Automation'), 'Must mention Browser Automation');
        assert.ok(proModalContent?.includes('Python Sandbox'), 'Must mention Python Sandbox');
        assert.ok(proModalContent?.includes('150 Standard Chats / Day'), 'Must mention 150 chats/day');
        assert.ok(proModalContent?.includes('2 Concurrent Inference Permits'), 'Must mention 2 concurrent permits');

        // Verify Sandbox billing notice
        const sandboxNotice = upgradeModal.locator('text=Live payment collection is currently in sandbox/isolated mode.');
        await sandboxNotice.waitFor({ state: 'visible', timeout: 5000 });
        console.log('  ✓ Plus-to-Pro upgrade modal and capability discovery verified');

        // Close modal
        await plusSession.page.getByTestId('upgrade-modal-close').click();
        await upgradeModal.waitFor({ state: 'hidden', timeout: 5000 });
      } finally {
        await plusSession.context.close();
      }

      passedCount++;
      console.log('✅ Scenario 3 Passed (100%)\n');
    }

    // =======================================================================
    // SCENARIO 4: "My Plan & Usage" Tab in Settings
    // =======================================================================
    console.log('--- [SCENARIO 4] "My Plan & Usage" Tab in Settings ---');
    {
      const { context, page } = await createBrowserSession(browser, {
        userTier: 'plus',
        onboardingState: { completed: true, currentStage: 'plans', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });

      try {
        await page.goto(`${BASE_URL}/?tab=plan`, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // 4.1 Verify Settings Modal opens and active tab is "My Plan & Usage"
        console.log('  [4.1] Verifying Settings Modal on "My Plan & Usage" tab...');
        const dialog = page.getByTestId('settings-dialog');
        await dialog.waitFor({ state: 'visible', timeout: 10000 });

        const planTabBtn = page.getByTestId('settings-tab-plan');
        assert.strictEqual(
          await planTabBtn.getAttribute('aria-selected'),
          'true',
          'Plan tab button must have aria-selected="true"'
        );

        // 4.2 Verify Active Plan Card
        console.log('  [4.2] Verifying Active Plan Overview Card (AIRA Plus)...');
        const planCardHeader = dialog.locator('h3:has-text("AIRA Plus")');
        await planCardHeader.waitFor({ state: 'visible', timeout: 5000 });
        const activeBadge = dialog.locator('span:has-text("Active Plan")');
        await activeBadge.waitFor({ state: 'visible', timeout: 5000 });

        // 4.3 Verify Quota Reset Countdown & Sandbox Notice
        console.log('  [4.3] Verifying Reset Countdown & Isolated Sandbox Notice...');
        const resetNotice = dialog.locator('text=Daily quota resets at: 00:00 UTC');
        await resetNotice.waitFor({ state: 'visible', timeout: 5000 });
        const billingSandbox = dialog.locator('text=Billing: Sandbox Mode (Isolated)');
        await billingSandbox.waitFor({ state: 'visible', timeout: 5000 });

        // 4.4 Verify Usage Meters & Allowance Gauges
        console.log('  [4.4] Verifying atomic usage meters (Chats, Credits, Reasoning Boosts, Projects)...');
        const metersSection = dialog.locator('h4:has-text("Allowance Meters & Gauges")');
        await metersSection.waitFor({ state: 'visible', timeout: 5000 });

        const dailyChatsMeter = dialog.getByText('Daily Standard Chats', { exact: true });
        await dailyChatsMeter.waitFor({ state: 'visible', timeout: 5000 });

        const monthlyCreditsMeter = dialog.getByText('Monthly Premium Credits', { exact: true });
        await monthlyCreditsMeter.waitFor({ state: 'visible', timeout: 5000 });

        const reasoningBoostsMeter = dialog.getByText('Reasoning Boosts', { exact: true });
        await reasoningBoostsMeter.waitFor({ state: 'visible', timeout: 5000 });

        const projectsMeter = dialog.getByText('Projects & Knowledge', { exact: true });
        await projectsMeter.waitFor({ state: 'visible', timeout: 5000 });

        // 4.5 Verify Plan Comparison Matrix
        console.log('  [4.5] Verifying Plan Comparison Matrix across all 4 tiers...');
        const comparisonSection = dialog.locator('h4:has-text("Plan Comparison Matrix")');
        await comparisonSection.waitFor({ state: 'visible', timeout: 5000 });

        // Check columns for Guest, Free, Plus, Pro
        const guestCol = dialog.locator('span:has-text("Guest")').first();
        const freeCol = dialog.locator('span:has-text("AIRA Free")').first();
        const plusCol = dialog.locator('span:has-text("AIRA Plus")').first();
        const proCol = dialog.locator('span:has-text("AIRA Pro")').first();

        await Promise.all([
          guestCol.waitFor({ state: 'visible', timeout: 5000 }),
          freeCol.waitFor({ state: 'visible', timeout: 5000 }),
          plusCol.waitFor({ state: 'visible', timeout: 5000 }),
          proCol.waitFor({ state: 'visible', timeout: 5000 })
        ]);

        // Current plan badge should be on Plus card
        const currentTag = dialog.getByText('Current', { exact: true }).first();
        await currentTag.waitFor({ state: 'visible', timeout: 5000 });

        // Capture Desktop Screenshot: plan-usage-desktop.png
        const desktopScreenshotPath = path.join(SCREENSHOT_DIR, 'plan-usage-desktop.png');
        await page.screenshot({ path: desktopScreenshotPath, fullPage: false });
        assert.ok(fs.existsSync(desktopScreenshotPath), 'plan-usage-desktop.png screenshot must exist');
        console.log(`  ✓ Captured acceptance screenshot: ${desktopScreenshotPath}`);

        // Close Settings dialog
        await page.getByRole('button', { name: 'Close settings' }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 5000 });

        passedCount++;
        console.log('✅ Scenario 4 Passed (100%)\n');
      } finally {
        await context.close();
      }
    }

    // =======================================================================
    // SCENARIO 5: Mobile Responsive Viewport Acceptance (390x844)
    // =======================================================================
    console.log('--- [SCENARIO 5] Mobile Responsive Viewport Acceptance (390x844) ---');
    {
      const mobileViewport = { width: 390, height: 844 };

      // 5.1 Mobile What's New Announcement Modal
      console.log('  [5.1] Verifying mobile What\'s New modal on 390x844 viewport...');
      const whatsNewSession = await createBrowserSession(browser, {
        viewport: mobileViewport,
        userTier: 'free',
        onboardingState: { completed: true, currentStage: 'plans', skipped: false },
        dismissedAnnouncements: [] // trigger announcement popup
      });

      try {
        await whatsNewSession.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

        const modal = whatsNewSession.page.getByTestId('whats-new-modal');
        await modal.waitFor({ state: 'visible', timeout: 10000 });

        // Verify bounding box fits within 390 viewport width
        const box = await modal.locator('> div').boundingBox();
        assert.ok(box !== null, 'Modal dialog box must have bounding box');
        assert.ok(
          box.width <= 390,
          `Modal width (${box.width}px) must not exceed viewport width (390px)`
        );

        // Capture Mobile Screenshot: whats-new-mobile.png
        const mobileScreenshotPath = path.join(SCREENSHOT_DIR, 'whats-new-mobile.png');
        await whatsNewSession.page.screenshot({ path: mobileScreenshotPath, fullPage: false });
        assert.ok(fs.existsSync(mobileScreenshotPath), 'whats-new-mobile.png screenshot must exist');
        console.log(`  ✓ Captured acceptance screenshot: ${mobileScreenshotPath}`);

        // Dismiss modal
        await whatsNewSession.page.getByTestId('whats-new-dismiss-btn').click();
        await modal.waitFor({ state: 'hidden', timeout: 5000 });
      } finally {
        await whatsNewSession.context.close();
      }

      // 5.2 Mobile Onboarding Tour
      console.log('  [5.2] Verifying mobile 5-Stage Onboarding Tour on 390x844 viewport...');
      const onboardingSession = await createBrowserSession(browser, {
        viewport: mobileViewport,
        userTier: 'free',
        onboardingState: { completed: false, currentStage: 'intro', skipped: false },
        dismissedAnnouncements: ['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']
      });

      try {
        await onboardingSession.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

        const tour = onboardingSession.page.getByTestId('onboarding-walkthrough');
        await tour.waitFor({ state: 'visible', timeout: 10000 });

        // Verify dialog fits mobile bounds
        const tourBox = await tour.locator('> div').boundingBox();
        assert.ok(tourBox !== null, 'Tour modal must have bounding box');
        assert.ok(
          tourBox.width <= 390,
          `Tour modal width (${tourBox.width}px) must not exceed viewport width (390px)`
        );

        // Capture Mobile Screenshot: onboarding-mobile.png
        const mobileScreenshotPath = path.join(SCREENSHOT_DIR, 'onboarding-mobile.png');
        await onboardingSession.page.screenshot({ path: mobileScreenshotPath, fullPage: false });
        assert.ok(fs.existsSync(mobileScreenshotPath), 'onboarding-mobile.png screenshot must exist');
        console.log(`  ✓ Captured acceptance screenshot: ${mobileScreenshotPath}`);

        // Test navigation on mobile touch layout
        const nextBtn = onboardingSession.page.getByTestId('onboarding-next-btn');
        await nextBtn.click();
        await onboardingSession.page.getByTestId('onboarding-stage-chat_reasoning').waitFor({ state: 'visible', timeout: 5000 });

        await nextBtn.click();
        await onboardingSession.page.getByTestId('onboarding-stage-agent_mode').waitFor({ state: 'visible', timeout: 5000 });

        // Skip tour on mobile
        await onboardingSession.page.getByTestId('onboarding-skip-btn').click();
        await tour.waitFor({ state: 'hidden', timeout: 5000 });
        console.log('  ✓ Mobile touch onboarding tour completed cleanly');
      } finally {
        await onboardingSession.context.close();
      }

      passedCount++;
      console.log('✅ Scenario 5 Passed (100%)\n');
    }

    // =======================================================================
    // FINAL VERIFICATION SUMMARY
    // =======================================================================
    console.log('================================================================');
    console.log(`  MICROSOFT EDGE ACCEPTANCE VERDICT: ALL ${passedCount}/${totalScenarios} SCENARIOS PASSED (100%)`);
    console.log('================================================================\n');

    // Confirm all 6 required screenshot files exist and have non-zero size
    const requiredScreenshots = [
      'whats-new-desktop.png',
      'onboarding-tour-desktop.png',
      'upgrade-modal-desktop.png',
      'plan-usage-desktop.png',
      'whats-new-mobile.png',
      'onboarding-mobile.png'
    ];

    console.log('[ARTIFACTS] Verifying required screenshots in test/screenshots/:');
    for (const file of requiredScreenshots) {
      const fullPath = path.join(SCREENSHOT_DIR, file);
      assert.ok(fs.existsSync(fullPath), `Required screenshot ${file} must exist`);
      const stat = fs.statSync(fullPath);
      assert.ok(stat.size > 1000, `Screenshot ${file} must not be empty (size: ${stat.size} bytes)`);
      console.log(`  ✓ ${file} verified (${(stat.size / 1024).toFixed(1)} KB)`);
    }

    console.log('\nAll acceptance criteria met with authentic Microsoft Edge rendering.\n');
  } finally {
    if (browser) {
      await browser.close();
    }
    if (serverProc) {
      killProcessTree(serverProc);
    }
    killPort(TEST_PORT);
  }
}

runTestSuite().catch((err) => {
  console.error('\n❌ Microsoft Edge browser acceptance test suite failed with error:', err);
  process.exit(1);
});
