import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ARTIFACT_DIR = 'C:/Users/WORKSTATION/.gemini/antigravity/brain/54535eac-2ffc-4e85-9f79-8c6d60034f9f/audit-screenshots';
const REPO_DIR = path.resolve('test/screenshots/audit');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
fs.mkdirSync(REPO_DIR, { recursive: true });

async function saveScreenshot(page, filename) {
  const artPath = path.join(ARTIFACT_DIR, filename);
  const repoPath = path.join(REPO_DIR, filename);
  await page.screenshot({ path: artPath, fullPage: false });
  fs.copyFileSync(artPath, repoPath);
  console.log(`[SAVED] ${filename}`);
}

async function run() {
  console.log('[AUDIT] Launching Edge to inspect canonical production: https://aira-ai-2026.vercel.app');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  });

  const page = await context.newPage();

  // 1. Visit live production home
  console.log('Navigating to canonical production...');
  await page.goto('https://aira-ai-2026.vercel.app', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await saveScreenshot(page, '01_live_production_greeting.png');

  // 2. Open Model Selector
  console.log('Opening Model Selector...');
  const modelBtn = page.locator('button[aria-haspopup="listbox"]').first();
  if (await modelBtn.isVisible()) {
    await modelBtn.click();
    await page.waitForTimeout(600);
    await saveScreenshot(page, '02_live_model_selector.png');
    // Close it
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // 3. Click Agent mode toggle to observe upgrade trigger
  console.log('Testing Agent mode button trigger...');
  const agentBtn = page.locator('[data-testid="chat-mode-agent-btn"]');
  if (await agentBtn.isVisible()) {
    await agentBtn.click();
    await page.waitForTimeout(1000);
    await saveScreenshot(page, '03_live_agent_mode_upgrade_modal.png');

    // Close upgrade modal if open
    const closeBtn = page.locator('button[aria-label="Close modal"], button:has-text("Close"), button[aria-label="Close"]').first();
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await page.waitForTimeout(500);
    } else {
      await page.keyboard.press('Escape');
    }
  }

  // 4. Open Motion Studio
  console.log('Opening Motion Studio at /?view=video-studio...');
  await page.goto('https://aira-ai-2026.vercel.app/?view=video-studio', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await saveScreenshot(page, '04_live_motion_studio_player.png');

  // Switch to Storyboard tab
  const storyboardBtn = page.locator('button:has-text("Scenes")');
  if (await storyboardBtn.isVisible()) {
    await storyboardBtn.click();
    await page.waitForTimeout(800);
    await saveScreenshot(page, '05_live_motion_studio_storyboard.png');
  }

  // Switch to Remotion Code tab
  const codeBtn = page.locator('button:has-text("Remotion")');
  if (await codeBtn.isVisible()) {
    await codeBtn.click();
    await page.waitForTimeout(800);
    await saveScreenshot(page, '06_live_motion_studio_code.png');
  }

  // 5. Open Account menu dropdown
  console.log('Navigating back to main view and opening Account menu...');
  await page.goto('https://aira-ai-2026.vercel.app', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  const accountTrigger = page.locator('[data-testid="account-menu-trigger"]');
  if (await accountTrigger.isVisible()) {
    await accountTrigger.click();
    await page.waitForTimeout(600);
    await saveScreenshot(page, '07_live_account_menu_guest.png');
  }

  await browser.close();
  console.log('[AUDIT] Live inspection finished successfully.');
}

run().catch(err => {
  console.error('[AUDIT ERROR]', err);
  process.exit(1);
});
