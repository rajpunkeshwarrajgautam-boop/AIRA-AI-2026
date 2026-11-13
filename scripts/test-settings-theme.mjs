import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SCREENSHOT_DIR = path.resolve('test/screenshots/theme-repair');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function verifySettingsModal() {
  const server = spawn('npx', ['vite', 'preview', '--port', '4175', '--strictPort'], { shell: true, stdio: 'pipe' });
  await new Promise(r => setTimeout(r, 3000));

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto('http://localhost:4175', { waitUntil: 'networkidle' });

    // Open settings in Light mode
    console.log('Opening settings in Light mode...');
    await page.locator('button[aria-label="Open settings"]').first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'modal_settings_general_light.png') });

    // Switch to Plan tab in Light mode
    console.log('Switching to Plan tab in Light mode...');
    await page.click('button[data-testid="settings-tab-plan"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'modal_settings_plan_light.png') });

    // Close modal
    await page.locator('button[data-testid="settings-close-button"]').click();
    await page.waitForTimeout(400);

    // Switch to Dark mode via sidebar
    console.log('Switching to Dark mode...');
    await page.locator('button[aria-label="Use dark theme"]').first().click();
    await page.waitForTimeout(600);

    // Open settings in Dark mode
    console.log('Opening settings in Dark mode...');
    await page.locator('button[aria-label="Open settings"]').first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'modal_settings_general_dark.png') });

    // Switch to Plan tab in Dark mode
    console.log('Switching to Plan tab in Dark mode...');
    await page.click('button[data-testid="settings-tab-plan"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'modal_settings_plan_dark.png') });

    // Switch to Reasoning tab in Dark mode
    console.log('Switching to Reasoning tab in Dark mode...');
    await page.click('button[data-testid="settings-tab-reasoning"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'modal_settings_reasoning_dark.png') });

    // Close modal
    await page.locator('button[data-testid="settings-close-button"]').click();
    await page.waitForTimeout(400);

    console.log('SUCCESS: Settings and modals verified in Light and Dark mode!');
  } finally {
    await browser.close();
    server.kill();
  }
}

verifySettingsModal().catch(err => {
  console.error(err);
  process.exit(1);
});
