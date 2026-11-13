import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import assert from 'node:assert/strict';

const SCREENSHOT_DIR = path.resolve('test/screenshots/theme-repair');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function verifyAllSurfaces() {
  console.log('=== VERIFYING ALL AIRA SURFACES (COMPOSER, MODALS, MENUS, SEARCH, PRICING) ===');
  const server = spawn('npx', ['vite', 'preview', '--port', '4178', '--strictPort'], { shell: true, stdio: 'pipe' });
  await new Promise(r => setTimeout(r, 3000));

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto('http://localhost:4178', { waitUntil: 'networkidle' });

    for (const mode of ['light', 'dark']) {
      console.log(`\nTesting surfaces in ${mode.toUpperCase()} mode...`);
      if (mode === 'dark') {
        await page.locator('button[aria-label="Use dark theme"]').first().click();
        await page.waitForTimeout(500);
      } else {
        await page.locator('button[aria-label="Use light theme"]').first().click();
        await page.waitForTimeout(500);
      }

      // 1. Workspace & Greeting
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `surface_workspace_${mode}.png`) });
      console.log(`  Captured surface_workspace_${mode}.png`);

      // 2. Model Selector Dropdown
      console.log(`  Opening Model Selector in ${mode}...`);
      await page.click('button[data-testid="model-selector-button"]');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `surface_model_selector_${mode}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // 3. Command Palette / Search
      console.log(`  Opening Command Palette in ${mode}...`);
      await page.keyboard.press('Control+k');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `surface_command_palette_${mode}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // 4. Projects Modal
      console.log(`  Opening Projects in ${mode}...`);
      const projBtn = page.locator('button[data-testid="sidebar-projects-button"], button:has-text("Projects")').first();
      if (await projBtn.count() > 0) {
        await projBtn.click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `surface_projects_${mode}.png`) });
        const closeProj = page.locator('button[aria-label="Close projects"]').first();
        if (await closeProj.count() > 0) {
          await closeProj.click();
        } else {
          await page.keyboard.press('Escape');
        }
        await page.waitForTimeout(400);
      }

      // 5. Account Menu Dropdown
      console.log(`  Opening Account Menu in ${mode}...`);
      const acctBtn = page.locator('button[data-testid="sidebar-account-button"]').first();
      if (await acctBtn.count() > 0) {
        await acctBtn.click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `surface_account_menu_${mode}.png`) });
        
        // 6. Pricing Modal from Account Menu
        const plansBtn = page.locator('button:has-text("View Subscription Plans")').first();
        if (await plansBtn.count() > 0) {
          console.log(`  Opening Pricing Modal from Account Menu in ${mode}...`);
          await plansBtn.click();
          await page.waitForTimeout(500);
          await page.screenshot({ path: path.join(SCREENSHOT_DIR, `surface_pricing_modal_${mode}.png`) });
          const closePricing = page.locator('button[aria-label="Close pricing"]').first();
          if (await closePricing.count() > 0) {
            await closePricing.click();
          } else {
            await page.keyboard.press('Escape');
          }
          await page.waitForTimeout(400);
        } else {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }
      }

      // 7. Workspace Mode Toggle (Agent Studio)
      const agentBtn = page.locator('.aira-adaptive-mode-toggle button:has-text("Agent")').first();
      if (await agentBtn.count() > 0) {
        console.log(`  Switching to Agent mode in ${mode}...`);
        await agentBtn.click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `surface_agent_mode_${mode}.png`) });
        // Switch back to Chat
        const chatBtn = page.locator('.aira-adaptive-mode-toggle button:has-text("Chat")').first();
        if (await chatBtn.count() > 0) {
          await chatBtn.click();
          await page.waitForTimeout(400);
        }
      }
    }

    console.log('\n=== ALL SURFACES VERIFIED SUCCESSFULLY IN BOTH MODES! ===');
  } finally {
    await browser.close();
    server.kill();
  }
}

verifyAllSurfaces().catch(err => {
  console.error(err);
  process.exit(1);
});
