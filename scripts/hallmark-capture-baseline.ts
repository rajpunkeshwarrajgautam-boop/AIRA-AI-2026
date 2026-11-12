import { chromium, type Browser, type Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const PROD_URL = 'https://aira-ai-2026.vercel.app/';
const OUT_DIR = path.resolve('.hallmark/before');

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

async function captureShot(page: Page, filename: string) {
  const filePath = path.join(OUT_DIR, filename);
  await page.screenshot({ path: filePath });
  console.log(`Saved screenshot: ${filename}`);
}

async function main() {
  console.log('=== Capturing Baseline Production Screenshots via Playwright (Edge Channel) ===');
  const browser: Browser = await chromium.launch({ headless: true, channel: 'msedge' });

  // 1. Desktop 1440x900
  {
    console.log('[1/6] Capturing Desktop 1440x900 screens & modals...');
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(PROD_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);

    // Welcome view
    await captureShot(page, 'welcome-desktop-1440.png');

    // Model Selector open
    try {
      const modelSelectorBtn = page.locator('button[aria-label="Select AI Model"], button:has-text("Aira Auto"), button:has-text("Aira Fast")').first();
      if (await modelSelectorBtn.isVisible()) {
        await modelSelectorBtn.click();
        await page.waitForTimeout(300);
        await captureShot(page, 'model-selector-open-1440.png');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      }
    } catch (e) {
      console.warn('Model selector capture warning:', e);
    }

    // Account Menu open
    try {
      const accountBtn = page.locator('[data-testid="sidebar-footer"] button[aria-haspopup="menu"], button[aria-label="Account and user settings menu"], button:has-text("Anonymous User"), button:has-text("Account")').first();
      if (await accountBtn.isVisible()) {
        await accountBtn.click();
        await page.waitForTimeout(300);
        await captureShot(page, 'account-menu-open-1440.png');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      }
    } catch (e) {
      console.warn('Account menu capture warning:', e);
    }

    // Settings Modal (General)
    try {
      const settingsBtn = page.locator('button[aria-label="Open settings"], button[title="Settings"]').first();
      if (await settingsBtn.isVisible()) {
        await settingsBtn.click();
        await page.waitForTimeout(400);
        await captureShot(page, 'settings-general-1440.png');

        // Capture other settings tabs
        const tabs = ['plan', 'reasoning', 'memory', 'instructions', 'artifacts', 'data'];
        for (const tab of tabs) {
          const tabBtn = page.locator(`button[data-tab="${tab}"], button:has-text("${tab.charAt(0).toUpperCase() + tab.slice(1)}")`).first();
          if (await tabBtn.isVisible()) {
            await tabBtn.click();
            await page.waitForTimeout(300);
            await captureShot(page, `settings-${tab}-1440.png`);
          }
        }

        // Close settings modal
        const closeBtn = page.locator('button[aria-label="Close settings"], button[aria-label="Close dialog"], button:has-text("Done")').first();
        if (await closeBtn.isVisible()) {
          await closeBtn.click();
        } else {
          await page.keyboard.press('Escape');
        }
        await page.waitForTimeout(300);
      }
    } catch (e) {
      console.warn('Settings modal capture warning:', e);
    }

    // Account & Billing Modal
    try {
      await page.evaluate(() => {
        window.location.hash = '#settings-billing';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await page.waitForTimeout(500);
      const billingDialog = page.locator('div[role="dialog"]:has-text("Billing"), div[role="dialog"]:has-text("Subscription"), div:has-text("AIRA Account & Billing")').first();
      if (await billingDialog.isVisible()) {
        await captureShot(page, 'billing-modal-1440.png');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    } catch (e) {
      console.warn('Billing modal capture warning:', e);
    }

    // Library view
    try {
      const libraryBtn = page.locator('button:has-text("Library"), a:has-text("Library")').first();
      if (await libraryBtn.isVisible()) {
        await libraryBtn.click();
        await page.waitForTimeout(400);
        await captureShot(page, 'library-view-1440.png');
      }
    } catch (e) {
      console.warn('Library view capture warning:', e);
    }

    // Agents view
    try {
      const agentsBtn = page.locator('button:has-text("Agents"), a:has-text("Agents")').first();
      if (await agentsBtn.isVisible()) {
        await agentsBtn.click();
        await page.waitForTimeout(400);
        await captureShot(page, 'agents-view-1440.png');
      }
    } catch (e) {
      console.warn('Agents view capture warning:', e);
    }

    await context.close();
  }

  // 2. Desktop 1280x800
  {
    console.log('[2/6] Capturing Desktop 1280x800...');
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(PROD_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);
    await captureShot(page, 'welcome-desktop-1280.png');
    await context.close();
  }

  // 3. Tablet 1024x768
  {
    console.log('[3/6] Capturing Tablet 1024x768...');
    const context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(PROD_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);
    await captureShot(page, 'welcome-tablet-1024.png');
    await context.close();
  }

  // 4. Tablet 768x1024
  {
    console.log('[4/6] Capturing Tablet 768x1024...');
    const context = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(PROD_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);
    await captureShot(page, 'welcome-tablet-768.png');
    await context.close();
  }

  // 5. Mobile 390x844
  {
    console.log('[5/6] Capturing Mobile 390x844...');
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(PROD_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);
    await captureShot(page, 'welcome-mobile-390.png');

    // Open mobile sidebar drawer
    try {
      const openDrawerBtn = page.locator('button[aria-label="Open sidebar navigation"], button[aria-label="Open sidebar"]').first();
      if (await openDrawerBtn.isVisible()) {
        await openDrawerBtn.click();
        await page.waitForTimeout(400);
        await captureShot(page, 'mobile-drawer-390.png');
      }
    } catch (e) {
      console.warn('Mobile drawer 390 capture warning:', e);
    }
    await context.close();
  }

  // 6. Mobile 320x568
  {
    console.log('[6/6] Capturing Mobile 320x568...');
    const context = await browser.newContext({
      viewport: { width: 320, height: 568 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(PROD_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);
    await captureShot(page, 'welcome-mobile-320.png');

    // Open mobile sidebar drawer
    try {
      const openDrawerBtn = page.locator('button[aria-label="Open sidebar navigation"], button[aria-label="Open sidebar"]').first();
      if (await openDrawerBtn.isVisible()) {
        await openDrawerBtn.click();
        await page.waitForTimeout(400);
        await captureShot(page, 'mobile-drawer-320.png');
      }
    } catch (e) {
      console.warn('Mobile drawer 320 capture warning:', e);
    }
    await context.close();
  }

  await browser.close();
  console.log('=== All Baseline Screenshots Captured Successfully ===');
}

main().catch(err => {
  console.error('Fatal capture error:', err);
  process.exit(1);
});
