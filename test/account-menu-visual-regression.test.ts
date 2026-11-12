import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const BASE_URL = process.env.AIRA_TEST_URL || 'http://localhost:5178/';
const ARTIFACTS_DIR = 'C:\\Users\\WORKSTATION\\.gemini\\antigravity\\brain\\1dd54ff3-647a-4431-9ff8-da538dc6f949';

function artifactPath(filename: string): string {
  return path.join(ARTIFACTS_DIR, filename);
}

const PRESETS = [
  'linear-precision',
  'warm-parchment',
  'liquid-glass',
  'industrial-brutalist',
  'nordic-moss',
  'solar-gold',
  'tokyo-neon',
  'vanguard-monolith',
] as const;

async function setupPageWithHistory(page: Page, count: number = 25, options: { authenticated?: boolean } = {}) {
  const errors: Error[] = [];
  page.on('pageerror', err => errors.push(err));

  // Mock BFF API routes
  await page.route('**/api/auth/**', async (route) => {
    if (options.authenticated) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'AUTHENTICATED',
          user: {
            id: 'usr_test_alex',
            name: 'Alex Rivera',
            email: 'alex.rivera@aira.ai',
            role: 'user',
            emailVerified: true,
          },
          session: {
            token: 'bff_session',
          },
          csrfToken: 'mock_csrf_token_123',
        }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ANONYMOUS', user: null }),
      });
    }
  });

  await page.route('**/api/billing/summary', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        principalId: 'usr_test_alex',
        planId: 'pro',
        planName: 'AIRA Pro Workspace',
        subscriptionStatus: 'active',
        availableCredits: 500,
        lifetimeGranted: 1000,
        lifetimeSpent: 500,
        dailyChatsUsed: 2,
        dailyChatLimit: 50,
        monthlyUnitsUsed: 20,
        monthlyUnitLimit: 500,
        reasoningBoostsUsed: 1,
        reasoningBoostLimit: 10,
      }),
    });
  });

  await page.addInitScript(({ count, auth }) => {
    const now = Date.now();
    const conversations = Array.from({ length: count }, (_, i) => ({
      id: 'chat-' + i,
      title: 'Conversation ' + (i + 1) + ': Analysis of Architecture and Systems',
      createdAt: now - i * 3600_000 * 4,
      updatedAt: now - i * 3600_000 * 4,
      isPinned: i === 0 || i === 3,
      messages: [],
    }));
    localStorage.setItem('aira_conversations_v1', JSON.stringify(conversations));
    localStorage.setItem('aira_active_chat_id_v1', conversations[0].id);

    if (auth) {
      localStorage.setItem('aira_neon_auth_session_v1', JSON.stringify({
        user: {
          id: 'usr_test_alex',
          name: 'Alex Rivera',
          email: 'alex.rivera@aira.ai',
          role: 'user',
          emailVerified: true,
        },
        token: 'bff_session',
      }));
      localStorage.setItem('aira_onboarding_usr_test_alex', JSON.stringify({
        completed: true,
        skipped: true,
        currentStage: 'finish',
      }));
      localStorage.setItem('aira_dismissed_announcements_usr_test_alex', JSON.stringify(['ann_entitlements_v2']));
    } else {
      localStorage.removeItem('aira_neon_auth_session_v1');
    }
  }, { count, auth: options.authenticated });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.locator('main textarea').waitFor({ state: 'visible', timeout: 15000 });
  return errors;
}

async function openSidebarIfMobile(page: Page) {
  const openBtn = page.getByRole('button', { name: 'Open sidebar navigation' });
  if (await openBtn.isVisible()) {
    await openBtn.click();
    await page.getByTestId('sidebar-drawer').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
  }
}

async function openAccountMenu(page: Page) {
  // Dismiss any lingering overlay dialogs if present
  const closeOverlayBtn = page.locator('[data-testid="whats-new-modal"] button[aria-label="Close"], [data-testid="onboarding-walkthrough"] button:has-text("Skip")').first();
  if (await closeOverlayBtn.isVisible().catch(() => false)) {
    await closeOverlayBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }
  await openSidebarIfMobile(page);
  const accountBtn = page.locator('[data-testid="sidebar-footer"] button[aria-haspopup="menu"]');
  const menu = page.locator('div[role="menu"][aria-label="Account and user settings menu"]');
  if (!(await menu.isVisible())) {
    await accountBtn.click();
    await menu.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(200);
  }
  return menu;
}

async function runTests() {
  console.log('--- Account Menu Dropdown Visual Regression & Stacking Suite ---');
  const browser: Browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();
  const pageErrors = await setupPageWithHistory(page, 25, { authenticated: false });

  try {
    // ------------------------------------------------------------------
    // TEST 1: Stacking Context & Collision Verification (Desktop 1440x900)
    // ------------------------------------------------------------------
    console.log('[Test 1/6] Verifying Stacking Context and Zero History Collisions...');
    const menu = await openAccountMenu(page);

    // Save authoritative "AFTER" screenshot at identical 1440x900 dimensions
    await page.screenshot({ path: artifactPath('account-menu-overlap-after.png') });
    console.log('  Saved account-menu-overlap-after.png');

    const menuBox = (await menu.boundingBox())!;
    assert.ok(menuBox, 'AccountMenuDropdown must have a bounding box');
    assert.ok(menuBox.width >= 280 && menuBox.width <= 340, `Width should be ~320px, got ${menuBox.width}`);

    // Test elementFromPoint across a grid inside the account menu
    const overlapAudit = await page.evaluate(() => {
      const menu = document.querySelector('div[role="menu"][aria-label="Account and user settings menu"]');
      if (!menu) return { success: false, reason: 'Menu not found' };
      const rect = menu.getBoundingClientRect();

      // Check points spanning the top, middle, and bottom of the menu
      const testCoordinates = [
        { x: rect.left + 24, y: rect.top + 20 },
        { x: rect.left + 60, y: rect.top + 50 },
        { x: rect.left + 60, y: rect.top + 90 },
        { x: rect.left + 60, y: rect.top + 130 },
        { x: rect.left + 60, y: rect.top + 170 },
        { x: rect.left + 60, y: rect.top + 210 },
        { x: rect.left + 60, y: rect.bottom - 20 },
      ];

      const collisions: Array<{ point: { x: number; y: number }; hitTag: string; hitText: string }> = [];

      for (const pt of testCoordinates) {
        const el = document.elementFromPoint(pt.x, pt.y);
        if (!el || !menu.contains(el)) {
          collisions.push({
            point: pt,
            hitTag: el?.tagName || 'null',
            hitText: el?.textContent?.slice(0, 50) || '',
          });
        }
      }

      const style = window.getComputedStyle(menu);
      const isPortaled = menu.parentElement === document.body;

      return {
        success: collisions.length === 0,
        isPortaled,
        position: style.position,
        zIndex: style.zIndex,
        collisions,
      };
    });

    assert.equal(overlapAudit.isPortaled, true, 'AccountMenuDropdown must be portaled directly to document.body');
    assert.equal(overlapAudit.position, 'fixed', 'AccountMenuDropdown must have fixed positioning');
    assert.equal(overlapAudit.zIndex, '100', 'AccountMenuDropdown must have z-index 100');
    assert.equal(overlapAudit.collisions.length, 0, `Detected collisions with underlying elements: ${JSON.stringify(overlapAudit.collisions)}`);
    console.log('  PASS: Account menu renders above all conversation items with zero element overlap.');

    // ------------------------------------------------------------------
    // TEST 2: Submenu Navigation (Help & Resources)
    // ------------------------------------------------------------------
    console.log('[Test 2/6] Verifying Submenu Transition & Bounds...');
    const helpTrigger = menu.locator('button:has-text("Help & Resources")');
    await helpTrigger.click();

    const helpHeader = menu.locator('span:has-text("Help & Resources")');
    await helpHeader.waitFor({ state: 'visible', timeout: 3000 });

    const submenuItems = ['Help Center', 'Privacy Center', 'Release Notes', 'Download Apps', 'Keyboard Shortcuts', 'Terms of Service', 'Privacy Policy', 'Report a Bug'];
    for (const itemText of submenuItems) {
      const itemBtn = menu.locator(`button:has-text("${itemText}")`);
      await itemBtn.waitFor({ state: 'visible' });
    }

    // Go back to main
    const backBtn = menu.locator('button[aria-label="Back to main account menu"]');
    await backBtn.click();
    await menu.locator('button:has-text("Personalization")').waitFor({ state: 'visible', timeout: 3000 });
    console.log('  PASS: Help & Resources submenu transitions smoothly with full item visibility.');

    // ------------------------------------------------------------------
    // TEST 3: Keyboard Accessibility (Arrow cycling & Escape)
    // ------------------------------------------------------------------
    console.log('[Test 3/6] Verifying Keyboard Navigation & Focus Return...');
    // Test ArrowDown navigation
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    const activeText1 = await page.evaluate(() => document.activeElement?.textContent);
    assert.ok(activeText1, 'An element must be focused on ArrowDown');

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    const activeText2 = await page.evaluate(() => document.activeElement?.textContent);
    assert.notEqual(activeText1, activeText2, 'Focus should advance to next item');

    // Press Escape to close
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden', timeout: 3000 });

    // Focus must return to the trigger button
    const focusedTag = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    assert.ok(
      focusedTag?.includes('workspace and help menu') ||
      focusedTag?.includes('account and help menu') ||
      focusedTag?.includes('account and workspace menu'),
      `Expected focus on account button, got ${focusedTag}`
    );
    console.log('  PASS: Keyboard navigation (Arrow keys, Escape, focus return) verified.');

    // ------------------------------------------------------------------
    // TEST 4: Viewport Adaptability (Desktop, Tablet, Mobile, Short)
    // ------------------------------------------------------------------
    console.log('[Test 4/6] Verifying Multi-Viewport Responsiveness...');
    const testViewports = [
      { name: 'Tablet Portrait', width: 768, height: 1024 },
      { name: 'Mobile Phone', width: 390, height: 844 },
      { name: 'Compact Landscape', width: 640, height: 360 },
    ];

    for (const vp of testViewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(200);

      const m = await openAccountMenu(page);
      const box = (await m.boundingBox())!;
      assert.ok(box, `Menu must have bounding box at ${vp.name}`);
      const left = box.x;
      const right = box.x + box.width;
      const top = box.y;
      const bottom = box.y + box.height;

      assert.ok(left >= 0, `Menu left (${left}) must not be negative on ${vp.name}`);
      assert.ok(right <= vp.width + 1, `Menu right (${right}) must not overflow viewport (${vp.width}) on ${vp.name}`);
      assert.ok(top >= 0, `Menu top (${top}) must not be off-screen on ${vp.name}`);
      assert.ok(bottom <= vp.height + 1, `Menu bottom (${bottom}) must not overflow viewport (${vp.height}) on ${vp.name}`);

      // Close menu
      await page.keyboard.press('Escape');
      await m.waitFor({ state: 'hidden', timeout: 3000 });
    }
    console.log('  PASS: Viewport adaptability verified across Tablet, Mobile, and Compact Landscape.');

    // Reset viewport to desktop
    await page.setViewportSize({ width: 1440, height: 900 });

    // ------------------------------------------------------------------
    // TEST 5: Aesthetic Presets & Themes Integrity
    // ------------------------------------------------------------------
    console.log('[Test 5/6] Verifying All 8 Aesthetic Presets and Dark/Light Modes...');
    for (const preset of PRESETS) {
      await page.evaluate((themePreset) => {
        document.documentElement.dataset.theme = themePreset;
      }, preset);
      await page.waitForTimeout(100);

      const m = await openAccountMenu(page);
      assert.equal(await m.isVisible(), true, `Menu should open under preset ${preset}`);
      await page.keyboard.press('Escape');
      await m.waitFor({ state: 'hidden', timeout: 3000 });
    }

    // Test Light Mode
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      delete document.documentElement.dataset.theme;
    });
    await page.waitForTimeout(100);
    const lightMenu = await openAccountMenu(page);
    assert.equal(await lightMenu.isVisible(), true, 'Menu should open cleanly in light mode');
    await page.keyboard.press('Escape');
    await lightMenu.waitFor({ state: 'hidden', timeout: 3000 });
    console.log('  PASS: All 8 aesthetic presets and light/dark modes render correctly.');

    // ------------------------------------------------------------------
    // TEST 6: Authenticated User State & Billing Badge
    // ------------------------------------------------------------------
    console.log('[Test 6/6] Verifying Authenticated State and Profile Details...');
    const authPage = await context.newPage();
    await setupPageWithHistory(authPage, 10, { authenticated: true });
    const authMenu = await openAccountMenu(authPage);

    await authMenu.locator('span:has-text("Alex Rivera")').waitFor({ state: 'visible' });
    await authMenu.getByText('alex.rivera@aira.ai', { exact: true }).waitFor({ state: 'visible' });
    await authMenu.locator('button:has-text("Account & Billing")').waitFor({ state: 'visible' });
    await authMenu.locator('button:has-text("Log out")').waitFor({ state: 'visible' });
    console.log('  PASS: Authenticated user profile, billing access, and session actions verified.');

    assert.equal(pageErrors.length, 0, `Page errors encountered: ${pageErrors.join(', ')}`);
    console.log('\n--- ALL ACCOUNT MENU VISUAL REGRESSION & PORTAL TESTS PASSED ---');
  } finally {
    await browser.close();
  }
}

runTests().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
