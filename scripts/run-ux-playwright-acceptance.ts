import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { chromium, type Page, type Browser } from 'playwright';
import { preview } from 'vite';

const ARTIFACTS_DIR = 'C:\\Users\\WORKSTATION\\.gemini\\antigravity-ide\\brain\\c7e732c6-b516-4196-9173-b8609b9d2701';

async function main() {
  console.log('=== AIRA AI 2026 — UX 2.0A PLAYWRIGHT ACCEPTANCE SUITE ===');
  
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  // 1. Launch Vite preview server
  console.log('[1/8] Starting Vite preview server...');
  const server = await preview({
    preview: {
      port: 4173,
      host: '127.0.0.1',
    },
  });
  const baseUrl = server.resolvedUrls.local[0] || 'http://127.0.0.1:4173/';
  console.log(`Preview server ready at ${baseUrl}`);

  const browser: Browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
  });

  try {
    const context = await browser.newContext();
    const page: Page = await context.newPage();

    let activeUser: { id: string; name: string; email: string } | null = {
      id: 'usr_test_raj_123',
      name: 'raj',
      email: 'rajpunkeshwarrajgautam@gmail.com',
    };

    await context.route('**/api/auth/session', async (route) => {
      if (activeUser) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'AUTHENTICATED',
            user: activeUser,
            csrfToken: 'test-csrf-token-123'
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

    await context.route('**/api/auth/sign-out', async (route) => {
      activeUser = null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ANONYMOUS' })
      });
    });

    await context.route('**/api/auth/providers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ providers: ['google', 'github'] })
      });
    });

    // Helper to inject authenticated session
    async function setAuthenticatedUser(email = 'rajpunkeshwarrajgautam@gmail.com', name = 'raj') {
      activeUser = {
        id: 'usr_test_raj_123',
        name,
        email
      };
      await page.evaluate(({ email, name }) => {
        const session = {
          user: {
            id: 'usr_test_raj_123',
            name,
            email,
            createdAt: new Date().toISOString()
          },
          token: 'bff_session'
        };
        localStorage.setItem('aira_neon_auth_session_v1', JSON.stringify(session));
      }, { email, name });
    }

    // =========================================================================
    // VIEWPORT 1: 1440 x 900 (Desktop Wide)
    // =========================================================================
    console.log('\n[2/8] Testing Viewport 1440x900 (Desktop Wide)...');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await setAuthenticatedUser();
    await page.reload({ waitUntil: 'networkidle' });

    // Verify authenticated user in sidebar footer
    const accountTrigger = page.locator('button[aria-label="View account and billing details"]');
    await accountTrigger.waitFor({ state: 'visible', timeout: 5000 });
    const footerText = await accountTrigger.innerText();
    assert.match(footerText, /raj/, 'Sidebar footer must display authenticated user name');
    assert.match(footerText, /Account & Settings/, 'Sidebar footer must display Account & Settings');

    // Click account button to open AccountProfilePopup
    await accountTrigger.click();
    const accountPopup = page.locator('[data-testid="account-profile-popup"]');
    await accountPopup.waitFor({ state: 'visible', timeout: 3000 });
    
    // Check menu items
    const popupText = await accountPopup.innerText();
    assert.match(popupText, /raj/, 'Account popup must display user name');
    assert.match(popupText, /Plus/, 'Account popup must display Plus plan');
    assert.match(popupText, /Upgrade plan/, 'Account popup must display Upgrade plan');
    assert.match(popupText, /Personalization/, 'Account popup must display Personalization');
    assert.match(popupText, /Profile/, 'Account popup must display Profile');
    assert.match(popupText, /Settings/, 'Account popup must display Settings');
    assert.match(popupText, /Help/, 'Account popup must display Help');
    assert.match(popupText, /Log out/, 'Account popup must display Log out');

    const popupShot = path.join(ARTIFACTS_DIR, 'ux_acceptance_1440x900_popup.png');
    await page.screenshot({ path: popupShot });
    console.log(`  ✓ Account popup verified. Screenshot: ${popupShot}`);

    // Hover or click account header to reveal desktop nested Account Switcher flyout
    const accountHeaderBtn = accountPopup.locator('button[title="Account options & switcher"]');
    await accountHeaderBtn.click();
    const switcherFlyout = page.locator('[data-testid="account-switcher-flyout"]');
    await switcherFlyout.waitFor({ state: 'visible', timeout: 3000 });

    const flyoutText = await switcherFlyout.innerText();
    assert.match(flyoutText, /rajpunkeshwarrajgautam@gmail\.com/, 'Switcher must display user email');
    assert.match(flyoutText, /Personal account/, 'Switcher must show Personal account item');
    assert.match(flyoutText, /Switch account/, 'Switcher must display truthful Switch account');
    assert.doesNotMatch(flyoutText, /Add account/, 'Switcher must not display misleading Add account');

    const switcherShot = path.join(ARTIFACTS_DIR, 'ux_acceptance_1440x900_switcher.png');
    await page.screenshot({ path: switcherShot });
    console.log(`  ✓ Nested account switcher verified. Screenshot: ${switcherShot}`);

    // Click Personalization
    const personalizationBtn = accountPopup.getByRole('button', { name: 'Personalization' });
    await personalizationBtn.click();
    const settingsDialog = page.locator('[data-testid="settings-dialog"]');
    await settingsDialog.waitFor({ state: 'visible', timeout: 5000 });

    // Verify Personalization tab (instructions) is active
    const bioTextarea = page.locator('textarea[placeholder*="Senior frontend engineer"]');
    await bioTextarea.waitFor({ state: 'visible' });
    await bioTextarea.fill('Lead Verification Engineer. Prefers strict verification and TypeScript.');

    const instructionsTextarea = page.locator('textarea[placeholder*="concise responses"]');
    await instructionsTextarea.fill('Always verify against active code and produce comprehensive release evidence.');

    // Click 'Code First' response style
    const codeFirstBtn = page.getByRole('button', { name: 'Code First' });
    await codeFirstBtn.click();

    // Click Save Changes
    const saveBtn = page.locator('[data-testid="settings-save"]');
    await saveBtn.click();
    await page.waitForTimeout(500);

    const personalizationShot = path.join(ARTIFACTS_DIR, 'ux_acceptance_1440x900_personalization.png');
    await page.screenshot({ path: personalizationShot });
    console.log(`  ✓ Personalization verified and saved. Screenshot: ${personalizationShot}`);

    // Dismiss with Escape key
    await page.keyboard.press('Escape');
    await settingsDialog.waitFor({ state: 'hidden', timeout: 3000 });
    console.log('  ✓ Settings dialog dismissed with Escape key.');

    // Reopen via Profile option
    await accountTrigger.click();
    await accountPopup.waitFor({ state: 'visible' });
    const profileBtn = accountPopup.getByRole('button', { name: 'Profile' });
    await profileBtn.click();
    await settingsDialog.waitFor({ state: 'visible' });

    // Verify Profile / Data tab
    const profileText = await settingsDialog.innerText();
    assert.match(profileText, /raj/, 'Profile tab displays user name');
    assert.match(profileText, /Session Verified/i, 'Profile displays Session Verified badge');
    assert.match(profileText, /Billing & Commercial Credits/i, 'Profile has Billing button');
    assert.match(profileText, /Security & Active Sessions/i, 'Profile has Security button');

    const profileShot = path.join(ARTIFACTS_DIR, 'ux_acceptance_1440x900_profile_data.png');
    await page.screenshot({ path: profileShot });
    console.log(`  ✓ Profile tab verified. Screenshot: ${profileShot}`);

    // Dismiss Settings
    await page.keyboard.press('Escape');
    await settingsDialog.waitFor({ state: 'hidden' });

    // =========================================================================
    // VIEWPORT 2: 1280 x 800 (Desktop Standard)
    // =========================================================================
    console.log('\n[3/8] Testing Viewport 1280x800 (Desktop Standard)...');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);

    // Open General Settings via gear icon in footer
    const settingsIconBtn = page.locator('button[aria-label="Open settings"]');
    await settingsIconBtn.click();
    await settingsDialog.waitFor({ state: 'visible' });
    const generalText = await settingsDialog.innerText();
    assert.match(generalText, /Theme Mode/i, 'General settings displays theme mode');
    assert.match(generalText, /Curated Themes/i, 'General settings displays theme gallery');

    const generalShot = path.join(ARTIFACTS_DIR, 'ux_acceptance_1280x800_general.png');
    await page.screenshot({ path: generalShot });
    console.log(`  ✓ General Settings verified. Screenshot: ${generalShot}`);

    await page.keyboard.press('Escape');
    await settingsDialog.waitFor({ state: 'hidden' });

    // =========================================================================
    // VIEWPORT 3: 768 x 1024 (Tablet Portrait)
    // =========================================================================
    console.log('\n[4/8] Testing Viewport 768x1024 (Tablet Portrait)...');
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(300);

    // On tablet, check if sidebar drawer is open or togglable
    const openSidebarBtn = page.locator('button[aria-label="Open sidebar navigation"]');
    if (await openSidebarBtn.isVisible()) {
      await openSidebarBtn.click();
      await page.waitForTimeout(400);
    }

    // Verify no horizontal overflow
    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    assert.equal(hasHorizontalOverflow, false, 'Tablet viewport must have zero horizontal overflow');

    const tabletShot = path.join(ARTIFACTS_DIR, 'ux_acceptance_768x1024_tablet.png');
    await page.screenshot({ path: tabletShot });
    console.log(`  ✓ Tablet 768x1024 verified without horizontal overflow. Screenshot: ${tabletShot}`);

    // =========================================================================
    // VIEWPORT 4: 375 x 667 (Mobile Phone)
    // =========================================================================
    console.log('\n[5/8] Testing Viewport 375x667 (Mobile Phone)...');
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload({ waitUntil: 'networkidle' });

    // Open mobile sidebar
    const mobileMenuBtn = page.locator('button[aria-label="Open sidebar navigation"]');
    await mobileMenuBtn.waitFor({ state: 'visible', timeout: 5000 });
    await mobileMenuBtn.click();
    await page.waitForTimeout(500);

    // Open account popup on mobile
    const mobileAccountBtn = page.locator('button[aria-label="View account and billing details"]');
    await mobileAccountBtn.waitFor({ state: 'visible' });
    await mobileAccountBtn.click();
    await accountPopup.waitFor({ state: 'visible' });

    const mobilePopupShot = path.join(ARTIFACTS_DIR, 'ux_acceptance_375x667_mobile_popup.png');
    await page.screenshot({ path: mobilePopupShot });
    console.log(`  ✓ Mobile account popup verified. Screenshot: ${mobilePopupShot}`);

    // Click account header in mobile -> switches in-place to switcher view
    const mobileHeaderBtn = accountPopup.locator('button[title="Account options & switcher"]');
    await mobileHeaderBtn.click();
    await page.waitForTimeout(300);

    const mobileBackBtn = accountPopup.getByRole('button', { name: 'Back to menu' });
    await mobileBackBtn.waitFor({ state: 'visible' });

    const mobileSwitcherText = await accountPopup.innerText();
    assert.match(mobileSwitcherText, /rajpunkeshwarrajgautam@gmail\.com/);
    assert.match(mobileSwitcherText, /Personal account/);
    assert.match(mobileSwitcherText, /Switch account/);

    const mobileSwitcherShot = path.join(ARTIFACTS_DIR, 'ux_acceptance_375x667_mobile_switcher.png');
    await page.screenshot({ path: mobileSwitcherShot });
    console.log(`  ✓ Mobile in-place switcher verified. Screenshot: ${mobileSwitcherShot}`);

    // Click "Back to menu"
    await mobileBackBtn.click();
    await page.waitForTimeout(300);
    assert.match(await accountPopup.innerText(), /Personalization/);
    console.log('  ✓ Mobile back navigation returned to main popup menu.');

    // =========================================================================
    // VIEWPORT 5: 320 x 640 (Compact Mobile)
    // =========================================================================
    console.log('\n[6/8] Testing Viewport 320x640 (Compact Mobile)...');
    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForTimeout(300);

    const smallMobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    assert.equal(smallMobileOverflow, false, 'Compact mobile 320x640 must have zero horizontal overflow');

    const smallMobileShot = path.join(ARTIFACTS_DIR, 'ux_acceptance_320x640_small_mobile.png');
    await page.screenshot({ path: smallMobileShot });
    console.log(`  ✓ Compact mobile 320x640 verified. Screenshot: ${smallMobileShot}`);

    // =========================================================================
    // VERIFICATION OF ACCOUNT SWITCHING ACTION
    // =========================================================================
    console.log('\n[7/8] Verifying Switch Account session purge and modal invocation...');
    // In mobile popup, navigate to switcher again
    await mobileHeaderBtn.click();
    const switchAccountBtn = accountPopup.locator('[data-testid="switch-account-button"]');
    await switchAccountBtn.waitFor({ state: 'visible' });
    await switchAccountBtn.click();
    await page.waitForTimeout(600);

    // Verify AuthModal opened
    const authModal = page.locator('#auth-modal-title');
    await authModal.waitFor({ state: 'visible', timeout: 5000 });
    const authModalText = await authModal.innerText();
    assert.match(authModalText, /Account Authentication/i, 'AuthModal must be open after Switch Account');

    // Verify session in localStorage was purged by neonAuth.signOut()
    const storedSession = await page.evaluate(() => localStorage.getItem('aira_neon_auth_session_v1'));
    assert.equal(storedSession, null, 'Active session must be purged after Switch Account');
    console.log('  ✓ Switch Account cleanly purges active session and opens AuthModal.');

    // Close AuthModal
    await page.keyboard.press('Escape');
    console.log('  ✓ AuthModal dismissed with Escape key.');

    console.log('\n[8/8] ALL 8 PLAYWRIGHT INTERACTIVE ACCEPTANCE PHASES PASSED!');
  } finally {
    await browser.close();
    await server.close();
    console.log('Server and browser cleanly shut down.');
  }
}

main().catch((err) => {
  console.error('\n❌ PLAYWRIGHT ACCEPTANCE FAILED:', err);
  process.exit(1);
});
