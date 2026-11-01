import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, type Page, type Browser } from 'playwright';

const BASE_URL = process.env.AIRA_TEST_URL || 'http://127.0.0.1:5176/';
const ARTIFACTS_DIR = 'C:\\Users\\WORKSTATION\\.gemini\\antigravity\\brain\\b9c0a1ba-6046-4fb1-9227-065e99bec80e';

function artifactPath(filename: string): string {
  return path.join(ARTIFACTS_DIR, filename);
}

async function setupPage(page: Page, options: { authenticated?: boolean } = {}) {
  // Mock API routes to prevent external network failures and provide deterministic responses
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

  // Inject session into localStorage before initial React render
  await page.addInitScript((auth) => {
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
    } else {
      localStorage.removeItem('aira_neon_auth_session_v1');
    }
  }, options.authenticated);

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.locator('main textarea').waitFor({ state: 'visible', timeout: 15000 });
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
  const accountBtn = page.locator('[data-testid="sidebar-footer"] button[aria-haspopup="menu"]');
  const menu = page.locator('div[role="menu"][aria-label="Account and user settings menu"]');
  if (!(await menu.isVisible())) {
    await accountBtn.click();
    await menu.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
  }
  return menu;
}

async function openHelpSubmenu(page: Page) {
  const menu = await openAccountMenu(page);
  const helpTrigger = menu.locator('button:has-text("Help & Resources")');
  if (await helpTrigger.isVisible()) {
    await helpTrigger.click();
    await menu.locator('button:has-text("Help Center")').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
  }
  return menu;
}

async function closeModal(page: Page, closeSelector?: string) {
  if (closeSelector) {
    const btn = page.locator(closeSelector).first();
    if (await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(400);
      return;
    }
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

async function run() {
  console.log('--- AIRA AI 2026: Account, Settings & Help Center Ecosystem Verification ---');
  const browser: Browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  try {
    // -------------------------------------------------------------
    // 1. Authenticated Account Menu & Profile Dropdown
    // -------------------------------------------------------------
    console.log('[1/12] Testing Authenticated Account Menu Dropdown...');
    await setupPage(page, { authenticated: true });
    await page.waitForSelector('[data-testid="sidebar-footer"]', { state: 'visible', timeout: 10000 });

    const menu = await openAccountMenu(page);

    // Assert user profile information
    const userName = menu.locator('span:has-text("Alex Rivera")').first();
    const userEmail = menu.getByText('alex.rivera@aira.ai', { exact: true });
    const proBadge = menu.getByText('Pro Workspace', { exact: true });
    await userName.waitFor({ state: 'visible' });
    await userEmail.waitFor({ state: 'visible' });
    await proBadge.waitFor({ state: 'visible' });

    // Assert main menu actions
    await menu.locator('button:has-text("Account & Billing")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Personalization")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Settings")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Help & Resources")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Log out")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-account-menu-authenticated.png') });
    console.log('  PASS: Authenticated account menu verified. Screenshot saved.');

    // -------------------------------------------------------------
    // 2. Help & Resources Submenu
    // -------------------------------------------------------------
    console.log('[2/12] Testing Help & Resources Submenu Navigation...');
    await openHelpSubmenu(page);

    // Verify submenu items
    await menu.locator('button:has-text("Help Center")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Privacy Center")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Release Notes")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Download Apps")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Keyboard Shortcuts")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Terms of Service")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Privacy Policy")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Report a Bug")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-account-menu-help-submenu.png') });
    console.log('  PASS: Help & Resources submenu verified with all 8 destinations. Screenshot saved.');

    // -------------------------------------------------------------
    // 3. Help Center Modal
    // -------------------------------------------------------------
    console.log('[3/12] Testing Help Center Modal...');
    await menu.locator('button:has-text("Help Center")').click();
    const helpModal = page.locator('div[role="dialog"][aria-labelledby="help-center-title"]');
    await helpModal.waitFor({ state: 'visible', timeout: 5000 });

    // Verify search input
    const searchInput = helpModal.locator('input[type="text"]');
    await searchInput.waitFor({ state: 'visible' });
    await searchInput.fill('reasoning');
    await page.waitForTimeout(300);

    // Expand first article
    const firstArticle = helpModal.locator('button:has-text("Adaptive Reasoning")').first();
    if (await firstArticle.isVisible()) {
      await firstArticle.click();
      await page.waitForTimeout(300);
    }

    await page.screenshot({ path: artifactPath('aira-help-center-modal.png') });
    await closeModal(page, 'button[aria-label="Close Help Center"]');
    console.log('  PASS: Help Center modal verified. Screenshot saved.');

    // -------------------------------------------------------------
    // 4. Privacy Center Modal
    // -------------------------------------------------------------
    console.log('[4/12] Testing Privacy Center Modal...');
    await openHelpSubmenu(page);
    await menu.locator('button:has-text("Privacy Center")').click();

    const privacyModal = page.locator('div[role="dialog"][aria-labelledby="privacy-center-title"]');
    await privacyModal.waitFor({ state: 'visible', timeout: 5000 });

    // Assert zero-training disclosure and export data button
    await page.locator('h3:has-text("Architectural Privacy Guarantees")').waitFor({ state: 'visible' });
    await page.locator('button:has-text("Download JSON Package")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-privacy-center-modal.png') });
    await closeModal(page, 'button[aria-label="Close Privacy Center"]');
    console.log('  PASS: Privacy Center modal verified. Screenshot saved.');

    // -------------------------------------------------------------
    // 5. Release Notes Modal
    // -------------------------------------------------------------
    console.log('[5/12] Testing Release Notes Modal...');
    await openHelpSubmenu(page);
    await menu.locator('button:has-text("Release Notes")').click();

    const releaseModal = page.locator('div[role="dialog"][aria-labelledby="release-notes-title"]');
    await releaseModal.waitFor({ state: 'visible', timeout: 5000 });

    // Verify v2.4.0 and earlier entries
    await page.locator('span:has-text("v2.4.0")').waitFor({ state: 'visible' });
    await page.locator('span:has-text("v2.3.0")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-release-notes-modal.png') });
    await closeModal(page, 'button[aria-label="Close Release Notes"]');
    console.log('  PASS: Release Notes modal verified. Screenshot saved.');

    // -------------------------------------------------------------
    // 6. Download Apps Modal
    // -------------------------------------------------------------
    console.log('[6/12] Testing Download Apps Modal...');
    await openHelpSubmenu(page);
    await menu.locator('button:has-text("Download Apps")').click();

    const downloadModal = page.locator('div[role="dialog"][aria-labelledby="download-apps-title"]');
    await downloadModal.waitFor({ state: 'visible', timeout: 5000 });

    // Verify PWA section & platform cards
    await page.locator('h3:has-text("Progressive Web App (PWA)")').waitFor({ state: 'visible' });
    await page.locator('h3:has-text("macOS Native App")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-download-apps-modal.png') });
    await closeModal(page, 'button[aria-label="Close dialog"]');
    console.log('  PASS: Download Apps modal verified. Screenshot saved.');

    // -------------------------------------------------------------
    // 7. Keyboard Shortcuts Modal (Triggered via `?` key)
    // -------------------------------------------------------------
    console.log('[7/12] Testing Keyboard Shortcuts Modal via `?` shortcut...');
    await page.locator('body').click({ position: { x: 500, y: 100 } });
    await page.keyboard.press('?');
    const shortcutsModal = page.locator('div[role="dialog"][aria-labelledby="shortcuts-title"]');
    await shortcutsModal.waitFor({ state: 'visible', timeout: 5000 });

    // Verify cheatsheet categories
    await page.locator('h3:has-text("Global Navigation")').waitFor({ state: 'visible' });
    await page.locator('h3:has-text("Chat & Composer")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-keyboard-shortcuts-modal.png') });
    await closeModal(page, 'button[aria-label="Close shortcuts"]');
    console.log('  PASS: Keyboard Shortcuts modal verified via `?`. Screenshot saved.');

    // -------------------------------------------------------------
    // 8. Legal Viewer Modal (Terms of Service & Privacy Policy)
    // -------------------------------------------------------------
    console.log('[8/12] Testing Legal Viewer Modal...');
    await openHelpSubmenu(page);
    await menu.locator('button:has-text("Terms of Service")').click();

    const legalModal = page.locator('div[role="dialog"][aria-labelledby="legal-viewer-title"]');
    await legalModal.waitFor({ state: 'visible', timeout: 5000 });

    // Verify document tabs and draft operational policy notice
    await page.locator('strong:has-text("Draft Operational Policy — Ratification Status")').waitFor({ state: 'visible' });
    await page.locator('h3:has-text("1. Acceptance of Terms")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-legal-viewer-terms.png') });
    await closeModal(page, 'button[aria-label="Close dialog"]');
    console.log('  PASS: Legal Viewer modal verified. Screenshot saved.');

    // -------------------------------------------------------------
    // 9. Report Bug Modal
    // -------------------------------------------------------------
    console.log('[9/12] Testing Report Bug Modal...');
    await openHelpSubmenu(page);
    await menu.locator('button:has-text("Report a Bug")').click();

    const reportModal = page.locator('div[role="dialog"][aria-labelledby="report-bug-title"]');
    await reportModal.waitFor({ state: 'visible', timeout: 5000 });

    // Fill out form
    await reportModal.locator('input[type="text"]').fill('Visual alignment check for Sheared Perspective Portal');
    await reportModal.locator('textarea').first().fill('Inspecting modal rendering consistency across high contrast and dark modes.');
    await reportModal.locator('textarea').nth(1).fill('1. Click user button\n2. Open modal\n3. Check theme swatches');

    await page.screenshot({ path: artifactPath('aira-report-bug-modal.png') });

    // Submit report
    await page.locator('button:has-text("Submit Bug Report")').click();
    await page.locator('h3:has-text("Bug Report Dispatched")').waitFor({ state: 'visible', timeout: 5000 });
    const ticketElement = page.locator('div:has-text("AIRA-BUG-")').first();
    assert.ok(await ticketElement.isVisible(), 'Ticket element must be visible upon submission');

    await closeModal(page, 'button:has-text("Return to AIRA")');
    console.log('  PASS: Report Bug modal form & ticket confirmation verified. Screenshot saved.');

    // -------------------------------------------------------------
    // 10. Settings Modal: 8 Aesthetic Presets & Appearance
    // -------------------------------------------------------------
    console.log('[10/12] Testing Settings Modal — 8 Aesthetic Presets & Accessibility...');
    await page.locator('button[aria-label="Open settings"]').click();
    const settingsDialog = page.locator('div[role="dialog"][aria-labelledby="aira-settings-title"]');
    await settingsDialog.waitFor({ state: 'visible', timeout: 5000 });

    // Verify 8 curated aesthetic presets exist
    const presetNames = [
      'Claude Editorial',
      'Warm Parchment',
      'Liquid Glass',
      'Industrial Brutalist',
      'Nordic Earth',
      'Solaris Gold',
      'Tokyo Cyber',
      'Vanguard Monolith'
    ];

    for (const name of presetNames) {
      const presetBtn = page.locator(`button:has-text("${name}")`);
      await presetBtn.waitFor({ state: 'visible' });
    }

    // Click 'Liquid Glass' preset
    await page.locator('button:has-text("Liquid Glass")').click();
    await page.waitForTimeout(300);

    // Verify reduced motion, font scale, and high contrast options
    const motionSelect = settingsDialog.getByLabel('Reduced Motion');
    await motionSelect.selectOption('always');
    await page.waitForTimeout(200);

    await page.screenshot({ path: artifactPath('aira-settings-appearance-presets.png') });
    console.log('  PASS: 8 Aesthetic Presets verified and selectable. Screenshot saved.');

    // -------------------------------------------------------------
    // 11. Settings Modal: Personalization & Account Tabs
    // -------------------------------------------------------------
    console.log('[11/12] Testing Settings Modal — Personalization & Data Tabs...');
    // Click instructions / personalization tab
    await page.locator('[data-testid="settings-tab-instructions"]').click();
    await page.locator('label:has-text("Custom System Directives")').waitFor({ state: 'visible' });
    await page.locator('label:has-text("User Context & Bio")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-settings-personalization.png') });

    // Click data & privacy tab
    await page.locator('[data-testid="settings-tab-data"]').click();
    await page.getByText('Workspace Backup & Portability', { exact: true }).waitFor({ state: 'visible' });
    await page.getByText('Telemetry Opt-Out', { exact: true }).waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-settings-account-privacy.png') });

    // Save and close settings
    await page.locator('button[data-testid="settings-save"]').click();
    await page.waitForTimeout(800);
    console.log('  PASS: Settings tabs verified & saved successfully. Screenshots saved.');

    // -------------------------------------------------------------
    // 12. Mobile Responsive Inspection (390x844)
    // -------------------------------------------------------------
    console.log('[12/12] Testing Mobile Responsive Ecosystem (390x844)...');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('main textarea').waitFor({ state: 'visible', timeout: 15000 });

    await openSidebarIfMobile(page);
    const mobileAccountBtn = page.locator('[data-testid="sidebar-footer"] button[aria-haspopup="menu"]');
    await mobileAccountBtn.waitFor({ state: 'visible' });
    await mobileAccountBtn.click();

    await page.locator('div[role="menu"]').waitFor({ state: 'visible' });
    await page.screenshot({ path: artifactPath('aira-mobile-account-menu.png') });

    // Open Settings on mobile
    await page.locator('div[role="menu"] button:has-text("Settings")').click();
    const mobileSettings = page.locator('div[role="dialog"][aria-labelledby="aira-settings-title"]');
    await mobileSettings.waitFor({ state: 'visible' });
    await page.screenshot({ path: artifactPath('aira-mobile-settings.png') });
    await closeModal(page);

    console.log('  PASS: Mobile account menu & settings modal responsive layout verified. Screenshots saved.');

    console.log('\nAll 12 ecosystem acceptance tests passed successfully!');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Ecosystem verification failure:', err);
  process.exit(1);
});
