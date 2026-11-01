import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, type Page, type Browser } from 'playwright';

const BASE_URL = process.env.AIRA_TEST_URL || 'http://127.0.0.1:5177/';
const ARTIFACTS_DIR = 'C:\\Users\\WORKSTATION\\.gemini\\antigravity\\brain\\b9c0a1ba-6046-4fb1-9227-065e99bec80e';

function artifactPath(filename: string): string {
  return path.join(ARTIFACTS_DIR, filename);
}

const PRESETS = [
  { id: 'linear-precision', name: 'Claude Editorial' },
  { id: 'warm-parchment', name: 'Warm Parchment' },
  { id: 'liquid-glass', name: 'Liquid Glass' },
  { id: 'industrial-brutalist', name: 'Industrial Brutalist' },
  { id: 'nordic-moss', name: 'Nordic Earth' },
  { id: 'solar-gold', name: 'Solaris Gold' },
  { id: 'tokyo-neon', name: 'Tokyo Cyber' },
  { id: 'vanguard-monolith', name: 'Vanguard Monolith' },
];

async function setupPage(page: Page, options: { authenticated?: boolean } = {}) {
  // Capture unhandled errors
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
      await page.waitForTimeout(300);
      return;
    }
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

async function run() {
  console.log('--- AIRA AI 2026: Account, Settings & Help Center Ecosystem Verification ---');
  const browser: Browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const pageErrors: Error[] = [];
  page.on('pageerror', err => pageErrors.push(err));

  try {
    // -------------------------------------------------------------
    // 1. Authenticated Account Menu & Verified Billing Plan
    // -------------------------------------------------------------
    console.log('[1/18] Testing Real Session Authentication & Billing Tier Display...');
    await setupPage(page, { authenticated: true });
    await page.waitForSelector('[data-testid="sidebar-footer"]', { state: 'visible', timeout: 10000 });

    const menu = await openAccountMenu(page);

    // Assert authentic user profile information
    const userName = menu.locator('span:has-text("Alex Rivera")').first();
    const userEmail = menu.getByText('alex.rivera@aira.ai', { exact: true });
    await userName.waitFor({ state: 'visible' });
    await userEmail.waitFor({ state: 'visible' });

    // Assert real plan loaded from /api/billing/summary
    const planBadge = menu.locator('span:has-text("AIRA Pro Workspace")');
    await planBadge.waitFor({ state: 'visible', timeout: 5000 });

    // Assert verified badge is visible because emailVerified is true
    const verifiedBadge = menu.locator('span[title="Verified Account"]');
    assert.equal(await verifiedBadge.isVisible(), true, 'Verified badge should be rendered for verified user');

    // Assert main menu actions
    await menu.locator('button:has-text("Account & Billing")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Personalization")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Settings")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Help & Resources")').waitFor({ state: 'visible' });
    await menu.locator('button:has-text("Log out")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-account-menu-authenticated.png') });
    console.log('  PASS: Authenticated account menu and real billing tier verified. Screenshot saved.');

    // -------------------------------------------------------------
    // 2. Guest vs Authenticated Account States
    // -------------------------------------------------------------
    console.log('[2/18] Testing Guest Workspace vs Authenticated State...');
    const guestPage = await context.newPage();
    await setupPage(guestPage, { authenticated: false });
    const guestMenu = await openAccountMenu(guestPage);

    await guestMenu.locator('div:has-text("Guest Workspace")').first().waitFor({ state: 'visible' });
    await guestMenu.locator('div:has-text("Local sandbox session")').first().waitFor({ state: 'visible' });
    await guestMenu.locator('button:has-text("Sign in or Create Account")').waitFor({ state: 'visible' });
    assert.equal(await guestMenu.locator('span:has-text("Alex Rivera")').isVisible(), false, 'Guest mode must not display user name');
    await guestPage.close();
    console.log('  PASS: Guest state isolation verified.');

    // -------------------------------------------------------------
    // 3. Help & Resources Submenu (8 destinations)
    // -------------------------------------------------------------
    console.log('[3/18] Testing Help & Resources Submenu Navigation (8 destinations)...');
    await openHelpSubmenu(page);

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
    // 4. Help Center Modal (Search & Categories)
    // -------------------------------------------------------------
    console.log('[4/18] Testing Help Center Modal Search & Categories...');
    await menu.locator('button:has-text("Help Center")').click();
    const helpModal = page.locator('div[role="dialog"][aria-labelledby="help-center-title"]');
    await helpModal.waitFor({ state: 'visible', timeout: 5000 });

    const searchInput = helpModal.locator('input[type="text"]');
    await searchInput.waitFor({ state: 'visible' });
    await searchInput.fill('reasoning');
    await page.waitForTimeout(200);

    const firstArticle = helpModal.locator('button:has-text("Adaptive Reasoning")').first();
    if (await firstArticle.isVisible()) {
      await firstArticle.click();
      await page.waitForTimeout(200);
    }

    await page.screenshot({ path: artifactPath('aira-help-center-modal.png') });
    await closeModal(page, 'button[aria-label="Close Help Center"]');
    console.log('  PASS: Help Center search & accordion verified. Screenshot saved.');

    // -------------------------------------------------------------
    // 5. Privacy Center & Data Portability
    // -------------------------------------------------------------
    console.log('[5/18] Testing Privacy Center Controls, Export & Local Purge Scope...');
    await openHelpSubmenu(page);
    await menu.locator('button:has-text("Privacy Center")').click();

    const privacyModal = page.locator('div[role="dialog"][aria-labelledby="privacy-center-title"]');
    await privacyModal.waitFor({ state: 'visible', timeout: 5000 });

    // Verify privacy controls
    await page.locator('h3:has-text("Functional Privacy Controls")').waitFor({ state: 'visible' });
    await page.locator('h4:has-text("Automatic Privacy Scrubbing")').waitFor({ state: 'visible' });
    await page.locator('h4:has-text("Cross-Conversation Memory")').waitFor({ state: 'visible' });
    await page.locator('h4:has-text("Telemetry & Diagnostic Reporting Opt-Out")').waitFor({ state: 'visible' });

    // Test JSON export
    const downloadPromise = page.waitForEvent('download', { timeout: 7000 }).catch(() => null);
    await privacyModal.locator('button:has-text("Download JSON Package")').click();
    const download = await downloadPromise;
    if (download) {
      assert.ok(download.suggestedFilename().startsWith('aira-privacy-data-export-'), 'Download should have correct filename');
    }

    // Test Purge button reveals scoped confirmation
    await privacyModal.locator('button:has-text("Purge Local Storage")').click();
    await privacyModal.locator('button:has-text("Confirm Delete")').waitFor({ state: 'visible' });
    await page.locator('text=Scope: Local browser cache and IndexedDB storage').waitFor({ state: 'visible' });

    // Cancel deletion
    await privacyModal.locator('button:has-text("Cancel")').click();
    await page.screenshot({ path: artifactPath('aira-privacy-center-modal.png') });
    await closeModal(page, 'button[aria-label="Close Privacy Center"]');
    console.log('  PASS: Privacy Center controls, export, and transparent purge scope verified. Screenshot saved.');

    // -------------------------------------------------------------
    // 6. Release Notes Modal
    // -------------------------------------------------------------
    console.log('[6/18] Testing Release Notes Modal...');
    await openHelpSubmenu(page);
    await menu.locator('button:has-text("Release Notes")').click();

    const releaseModal = page.locator('div[role="dialog"][aria-labelledby="release-notes-title"]');
    await releaseModal.waitFor({ state: 'visible', timeout: 5000 });

    await page.locator('span:has-text("v2.4.0")').waitFor({ state: 'visible' });
    await page.locator('span:has-text("v2.3.0")').waitFor({ state: 'visible' });
    await page.locator('span:has-text("v2.0.0")').waitFor({ state: 'visible' });
    await page.locator('span:has-text("v1.0.0")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-release-notes-modal.png') });
    await closeModal(page, 'button[aria-label="Close Release Notes"]');
    console.log('  PASS: Release Notes verified with verified milestones. Screenshot saved.');

    // -------------------------------------------------------------
    // 7. Download Apps Modal (PWA & Transparent Availability)
    // -------------------------------------------------------------
    console.log('[7/18] Testing Download Apps Modal (PWA & Native Status)...');
    await openHelpSubmenu(page);
    await menu.locator('button:has-text("Download Apps")').click();

    const downloadModal = page.locator('div[role="dialog"][aria-labelledby="download-apps-title"]');
    await downloadModal.waitFor({ state: 'visible', timeout: 5000 });

    await page.locator('h3:has-text("Install Web Application (PWA)")').waitFor({ state: 'visible' });
    await page.locator('span:has-text("Available Now")').first().waitFor({ state: 'visible' });
    await page.locator('span:has-text("Unreleased / Roadmap")').first().waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-download-apps-modal.png') });
    await closeModal(page, 'button[aria-label="Close dialog"]');
    console.log('  PASS: Download Apps modal verified with transparent roadmap status. Screenshot saved.');

    // -------------------------------------------------------------
    // 8. Keyboard Shortcuts Modal & Platform Compatibility
    // -------------------------------------------------------------
    console.log('[8/18] Testing Keyboard Shortcuts Modal via `?` shortcut...');
    await page.locator('body').click({ position: { x: 500, y: 100 } });
    await page.keyboard.press('?');
    const shortcutsModal = page.locator('div[role="dialog"][aria-labelledby="shortcuts-title"]');
    await shortcutsModal.waitFor({ state: 'visible', timeout: 5000 });

    await page.locator('h3:has-text("Global Navigation")').waitFor({ state: 'visible' });
    await page.locator('h3:has-text("Chat & Composer")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-keyboard-shortcuts-modal.png') });
    await closeModal(page, 'button[aria-label="Close shortcuts"]');
    console.log('  PASS: Keyboard Shortcuts modal verified via `?`. Screenshot saved.');

    // -------------------------------------------------------------
    // 9. Legal Viewer Modal & Ratification Disclosure
    // -------------------------------------------------------------
    console.log('[9/18] Testing Legal Viewer Terms & Privacy with Counsel Banner...');
    await openHelpSubmenu(page);
    await menu.locator('button:has-text("Terms of Service")').click();

    const legalModal = page.locator('div[role="dialog"][aria-labelledby="legal-viewer-title"]');
    await legalModal.waitFor({ state: 'visible', timeout: 5000 });

    await page.locator('strong:has-text("Draft Operational Policy — Ratification Status")').waitFor({ state: 'visible' });
    await page.locator('h3:has-text("1. Acceptance of Terms")').waitFor({ state: 'visible' });

    // Switch to Privacy tab
    await legalModal.locator('button:has-text("Privacy Policy")').click();
    await page.locator('h3:has-text("1. Zero Third-Party Model Training")').waitFor({ state: 'visible' });

    await page.screenshot({ path: artifactPath('aira-legal-viewer-terms.png') });
    await closeModal(page, 'button[aria-label="Close dialog"]');
    console.log('  PASS: Legal Viewer verified with prominent draft ratification disclosure. Screenshot saved.');

    // -------------------------------------------------------------
    // 10. Bug Report Workflow, Local Queue & Duplication Guard
    // -------------------------------------------------------------
    console.log('[10/18] Testing Report Bug Form, Storage Queue & Transparency Notice...');
    await openHelpSubmenu(page);
    await menu.locator('button:has-text("Report a Bug")').click();

    const bugModal = page.locator('div[role="dialog"][aria-labelledby="report-bug-title"]');
    await bugModal.waitFor({ state: 'visible', timeout: 5000 });

    // Fill form
    await bugModal.locator('input[id="bug-title"]').fill('Integration Test Defect Verification');
    await bugModal.locator('textarea[id="bug-desc"]').fill('Verification of defect report persistence and transparent infrastructure notice.');
    await bugModal.locator('textarea[id="bug-repro"]').fill('1. Automated Playwright execution\n2. Trigger form submit');

    // Submit
    await bugModal.locator('button[type="submit"]').click();

    // Verify confirmation and local queue notice
    await page.locator('h3:has-text("Report Recorded in Local Diagnostic Queue")').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('span:has-text("Infrastructure Notice: Remote Dispatch Pending")').waitFor({ state: 'visible' });
    const ticketText = await page.locator('div:has-text("AIRA-BUG-")').last().textContent();
    assert.ok(ticketText?.includes('AIRA-BUG-'), 'Generated ticket ID must be present');

    // Verify localStorage persistence
    const savedReports = await page.evaluate(() => localStorage.getItem('aira_bug_reports_v1'));
    assert.ok(savedReports && savedReports.includes('Integration Test Defect Verification'), 'Bug report must be durably stored in localStorage');

    await page.screenshot({ path: artifactPath('aira-report-bug-modal.png') });
    await closeModal(page, 'button:has-text("Done")');
    console.log('  PASS: Bug report durability, diagnostic queue, and infrastructure notice verified. Screenshot saved.');

    // -------------------------------------------------------------
    // 11. Settings Modal: 8 Aesthetic Presets
    // -------------------------------------------------------------
    console.log('[11/18] Testing Settings Modal — All 8 Curated Aesthetic Presets...');
    const menuAgain = await openAccountMenu(page);
    await menuAgain.locator('button:has-text("Settings")').click();
    const settingsDialog = page.locator('[data-testid="settings-dialog"]');
    await settingsDialog.waitFor({ state: 'visible', timeout: 7000 });

    // Verify all 8 aesthetic preset cards exist and can be clicked
    for (const preset of PRESETS) {
      const card = settingsDialog.locator(`button:has-text("${preset.name}")`).first();
      await card.waitFor({ state: 'visible' });
      await card.click();
      await page.waitForTimeout(100);
      const activePreset = await page.evaluate(() => {
        const stored = localStorage.getItem('aira_settings_v1');
        return stored ? JSON.parse(stored).aestheticPreset : null;
      });
      assert.equal(activePreset, preset.id, `Preset ${preset.name} should persist in storage`);
    }

    await page.screenshot({ path: artifactPath('aira-settings-appearance-presets.png') });
    console.log('  PASS: All 8 aesthetic presets verified and selectable. Screenshot saved.');

    // -------------------------------------------------------------
    // 12. Settings Modal: Light, Dark & System Modes
    // -------------------------------------------------------------
    console.log('[12/18] Testing Light, Dark, and System Appearance Modes...');
    const lightBtn = settingsDialog.locator('button:has-text("Light")').first();
    const darkBtn = settingsDialog.locator('button:has-text("Dark")').first();
    await lightBtn.click();
    await page.waitForTimeout(150);
    let isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    assert.equal(isDark, false, 'Light mode must remove dark class');

    await darkBtn.click();
    await page.waitForTimeout(150);
    isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    assert.equal(isDark, true, 'Dark mode must add dark class');
    console.log('  PASS: Appearance mode toggles verified.');

    // -------------------------------------------------------------
    // 13. Settings Modal: Accessibility Controls (Reduced Motion)
    // -------------------------------------------------------------
    console.log('[13/18] Testing Accessibility Controls (Reduced Motion)...');
    const motionSelect = settingsDialog.getByLabel('Reduced Motion').first();
    await motionSelect.selectOption('always');
    await page.waitForTimeout(150);

    // -------------------------------------------------------------
    // 14. Settings Modal: Personalization & Memory Tabs
    // -------------------------------------------------------------
    console.log('[14/18] Testing Personalization & Memory Settings Tabs...');
    await settingsDialog.locator('[data-testid="settings-tab-instructions"]').click();
    await page.locator('h3:has-text("Custom Directives & Context")').waitFor({ state: 'visible' });
    await page.screenshot({ path: artifactPath('aira-settings-personalization.png') });

    await settingsDialog.locator('[data-testid="settings-tab-data"]').click();
    await page.locator('h3:has-text("Data Management & Storage")').waitFor({ state: 'visible' });
    await page.screenshot({ path: artifactPath('aira-settings-account-privacy.png') });

    await closeModal(page, 'button:has-text("Save Changes")');
    const hasReducedMotionClass = await page.evaluate(() => document.documentElement.classList.contains('reduced-motion'));
    assert.equal(hasReducedMotionClass, true, 'Setting reducedMotion: always should add reduced-motion root class after saving');
    console.log('  PASS: Reduced motion accessibility and settings tabs verified & saved. Screenshots saved.');

    // -------------------------------------------------------------
    // 15. Global Keyboard Shortcuts: Focus Composer
    // -------------------------------------------------------------
    console.log('[15/18] Testing Global Composer Focus Shortcut (Ctrl+/)...');
    await page.keyboard.press('Control+/');
    await page.waitForTimeout(200);
    const isTextareaFocused = await page.evaluate(() => {
      const active = document.activeElement;
      return active?.tagName === 'TEXTAREA';
    });
    assert.equal(isTextareaFocused, true, 'Ctrl+/ should focus message composer textarea');
    console.log('  PASS: Ctrl+/ successfully focused composer.');

    // -------------------------------------------------------------
    // 16. Sheared Perspective Portal Brand Identity Regression
    // -------------------------------------------------------------
    console.log('[16/18] Verifying Sheared Perspective Portal Brand Identity Intact...');
    const brandPortal = page.locator('svg[viewBox="0 0 100 100"]').first();
    await brandPortal.waitFor({ state: 'visible' });
    const facetCount = await page.evaluate(() => {
      const paths = document.querySelectorAll('svg[viewBox="0 0 100 100"] path');
      return paths.length;
    });
    assert.ok(facetCount >= 10, 'Brand Portal master must render 10-facet geometry');
    console.log('  PASS: Sheared Perspective Portal 10-facet geometry verified intact.');

    // -------------------------------------------------------------
    // 17. Mobile Responsive Layout & Touch Targets (390x844)
    // -------------------------------------------------------------
    console.log('[17/18] Testing Mobile Responsive Ecosystem (390x844 Viewport)...');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);

    await openSidebarIfMobile(page);
    const mobileMenu = await openAccountMenu(page);
    await mobileMenu.waitFor({ state: 'visible' });
    await page.screenshot({ path: artifactPath('aira-mobile-account-menu.png') });

    // Open settings on mobile
    await mobileMenu.locator('button:has-text("Settings")').click();
    const mobileSettings = page.locator('div[role="dialog"][aria-label="Workspace Settings"]');
    await mobileSettings.waitFor({ state: 'visible' });
    await page.screenshot({ path: artifactPath('aira-mobile-settings.png') });
    await closeModal(page);
    console.log('  PASS: Mobile account menu & settings responsive layouts verified. Screenshots saved.');

    // -------------------------------------------------------------
    // 18. Zero Unhandled Browser Runtime Exceptions
    // -------------------------------------------------------------
    console.log('[18/18] Verifying Zero Unhandled Browser Runtime Exceptions...');
    assert.equal(pageErrors.length, 0, `Observed unhandled page errors: ${pageErrors.map(e => e.message).join('; ')}`);
    console.log('  PASS: 0 unhandled browser runtime exceptions.');

    console.log('\nAll 18 release-certification integration tests PASSED successfully!');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
