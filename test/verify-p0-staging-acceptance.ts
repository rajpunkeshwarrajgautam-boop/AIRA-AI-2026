import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

async function runAcceptance() {
  const stagingUrl = 'https://staging.virexaaiventures.com';
  const outDir = 'C:/Users/WORKSTATION/.gemini/antigravity/brain/06c49d69-e845-4487-8e76-ca7bafeb96fc/p0-acceptance';
  fs.mkdirSync(outDir, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
  } catch (e) {
    browser = await chromium.launch({ headless: true });
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  console.log(`Navigating to ${stagingUrl}...`);
  await page.goto(stagingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('load');
  await page.waitForTimeout(2000);

  // Click on the Guest Workspace Usage button to open Settings / Plan modal
  console.log('Clicking on Guest Workspace / Usage button...');
  const usageBtn = page.locator('button:has-text("Usage")').first();
  if (await usageBtn.isVisible()) {
    await usageBtn.click();
    console.log('Clicked Usage button. Waiting for plan verification to resolve...');
    await page.waitForTimeout(5000);
    const screenshotModal = path.join(outDir, '04_staging_settings_plan_usage.png');
    await page.screenshot({ path: screenshotModal });
    console.log(`Captured Settings Modal: ${screenshotModal}`);

    const modalLocator = page.locator('[role="dialog"]').first();
    if (await modalLocator.isVisible()) {
      const modalText = await modalLocator.innerText();
      console.log('--- MODAL TEXT ---');
      console.log(modalText);
      console.log('------------------');
    } else {
      console.log('Dialog not matched with role="dialog", checking entire page text for modal markers...');
      const bodyText = await page.locator('body').innerText();
      console.log('Body text sample:', bodyText.slice(0, 500).replace(/\n+/g, ' '));
    }
  } else {
    console.log('Could not find Usage button. Checking button text matching "Guest"...');
    const guestBtn = page.locator('button:has-text("Guest Workspace")').first();
    await guestBtn.click();
    await page.waitForTimeout(2000);
    const screenshotMenu = path.join(outDir, '04_guest_menu.png');
    await page.screenshot({ path: screenshotMenu });
  }

  await browser.close();
}

runAcceptance().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
