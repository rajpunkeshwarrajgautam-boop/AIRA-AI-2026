import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SCREENSHOT_DIR = path.resolve('test/screenshots/theme-repair');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function verifyAllTabs() {
  const server = spawn('npx', ['vite', 'preview', '--port', '4176', '--strictPort'], { shell: true, stdio: 'pipe' });
  await new Promise(r => setTimeout(r, 3000));

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const tabList = ['general', 'plan', 'reasoning', 'memory', 'instructions', 'artifacts', 'data'];

  try {
    await page.goto('http://localhost:4176', { waitUntil: 'networkidle' });

    for (const mode of ['light', 'dark']) {
      console.log(`\n=== Verifying Tabs in ${mode.toUpperCase()} MODE ===`);
      if (mode === 'dark') {
        await page.locator('button[aria-label="Use dark theme"]').first().click();
        await page.waitForTimeout(500);
      } else {
        await page.locator('button[aria-label="Use light theme"]').first().click();
        await page.waitForTimeout(500);
      }

      // Open settings
      await page.locator('button[aria-label="Open settings"]').first().click();
      await page.waitForTimeout(500);

      for (const tab of tabList) {
        console.log(`  Clicking tab [${tab}] in ${mode}...`);
        await page.click(`button[data-testid="settings-tab-${tab}"]`);
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `settings_${tab}_${mode}.png`) });
      }

      // Close settings modal
      await page.locator('button[aria-label="Close settings"]').click();
      await page.waitForTimeout(400);
    }

    console.log('\n=== ALL SETTINGS TABS VERIFIED IN BOTH LIGHT AND DARK MODES! ===');
  } finally {
    await browser.close();
    server.kill();
  }
}

verifyAllTabs().catch(err => {
  console.error(err);
  process.exit(1);
});
