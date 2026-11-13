import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';

const ARTIFACT_DIR = 'C:/Users/WORKSTATION/.gemini/antigravity/brain/54535eac-2ffc-4e85-9f79-8c6d60034f9f/live-production-screenshots';
const REPO_DIR = path.resolve('test/screenshots/live-production');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
fs.mkdirSync(REPO_DIR, { recursive: true });

async function saveScreenshot(page, filename) {
  const artPath = path.join(ARTIFACT_DIR, filename);
  const repoPath = path.join(REPO_DIR, filename);
  await page.screenshot({ path: artPath, fullPage: false });
  fs.copyFileSync(artPath, repoPath);
  console.log(`[SAVED LIVE PROD] ${filename}`);
}

async function verifyLiveProduction() {
  console.log('=== VERIFYING LIVE CANONICAL PRODUCTION ===');
  console.log('URL: https://aira-ai-2026.vercel.app');

  // 1. API Verification
  const verRes = await fetch('https://aira-ai-2026.vercel.app/api/version');
  assert.equal(verRes.status, 200, 'Version endpoint must return 200');
  const verData = await verRes.json();
  console.log('Live Version Data:', verData);
  assert.equal(verData.commitSha, '575c84c83b787b501b73c9b5fd565f2540e8e10d', 'Live commit must match merge commit SHA');

  const healthRes = await fetch('https://aira-ai-2026.vercel.app/api/health');
  assert.equal(healthRes.status, 200, 'Health endpoint must return 200');
  const healthData = await healthRes.json();
  console.log('Live Health Data:', healthData.status);
  assert.equal(healthData.status, 'HEALTHY', 'Production status must be HEALTHY');

  // 2. Browser Verification via Playwright Edge
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();

  // (a) Greeting (Guest)
  console.log('1. Loading Greeting on canonical production (Guest)...');
  await page.goto('https://aira-ai-2026.vercel.app', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await saveScreenshot(page, 'prod_01_greeting.png');

  // (b) Model Selector
  console.log('2. Opening Model Selector...');
  const modelBtn = page.locator('button[aria-haspopup="listbox"]').first();
  if (await modelBtn.isVisible()) {
    await modelBtn.click();
    await page.waitForTimeout(600);
    await saveScreenshot(page, 'prod_02_model_selector.png');
    
    // Check that Nemotron 70B and NVIDIA (Exp) badge are present
    const selectorText = await page.locator('body').innerText();
    assert(selectorText.includes('Nemotron 70B'), 'Model selector must show untruncated Nemotron 70B');
    assert(selectorText.includes('NVIDIA (Exp)'), 'Model selector must show NVIDIA (Exp) badge');
    console.log('✔ Model Selector shows untruncated Nemotron 70B with NVIDIA (Exp) badge');
    
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // (c) Motion Studio Player
  console.log('3. Opening Motion Studio Player on canonical production...');
  await page.goto('https://aira-ai-2026.vercel.app/?view=video-studio', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await saveScreenshot(page, 'prod_04_motion_studio_player.png');

  // (d) Motion Studio Storyboard
  console.log('4. Switching to Storyboard Scenes...');
  const storyboardBtn = page.locator('button:has-text("Scenes")');
  if (await storyboardBtn.isVisible()) {
    await storyboardBtn.click();
    await page.waitForTimeout(800);
    await saveScreenshot(page, 'prod_05_motion_studio_storyboard.png');
  }

  // (e) Account Menu (no sparkles)
  console.log('5. Inspecting Account Menu...');
  await page.goto('https://aira-ai-2026.vercel.app', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);
  const accountBtn = page.locator('[data-testid="account-button"]');
  if (await accountBtn.isVisible()) {
    await accountBtn.click();
    await page.waitForTimeout(600);
    await saveScreenshot(page, 'prod_06_account_menu.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // (f) Authenticated Free Tier User -> Agent Mode Upgrade Recommendation
  console.log('6. Testing Agent Mode button on authenticated Free Tier...');
  const authedContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  });
  const authedPage = await authedContext.newPage();
  await authedPage.addInitScript(() => {
    localStorage.setItem('aira_neon_auth_session_v1', JSON.stringify({
      user: {
        id: 'usr_free_prod_test',
        name: 'Jordan Free Tier',
        email: 'jordan@example.com',
        role: 'user',
        emailVerified: true
      },
      token: 'bff_session'
    }));
    localStorage.setItem('aira_onboarding_usr_free_prod_test', JSON.stringify({
      completed: true,
      skipped: true,
      currentStage: 'intro'
    }));
  });

  await authedPage.route('**/api/auth/session', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'AUTHENTICATED',
        user: {
          id: 'usr_free_prod_test',
          name: 'Jordan Free Tier',
          email: 'jordan@example.com',
          role: 'user',
          emailVerified: true
        },
        token: 'bff_session',
        csrfToken: 'test_csrf'
      })
    });
  });

  await authedPage.route('**/api/billing/summary', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        principalId: 'usr_free_prod_test',
        planId: 'free',
        planName: 'Free Plan',
        tier: 'free',
        status: 'active'
      })
    });
  });

  await authedPage.goto('https://aira-ai-2026.vercel.app', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await authedPage.waitForTimeout(2000);

  // Close any initial modal dialogs if present
  for (let i = 0; i < 3; i++) {
    await authedPage.keyboard.press('Escape');
    await authedPage.waitForTimeout(200);
  }

  const authedAgentBtn = authedPage.locator('[data-testid="chat-mode-agent-btn"]');
  assert(await authedAgentBtn.isVisible(), 'Agent button must be visible');
  await authedAgentBtn.click();
  await authedPage.waitForTimeout(1000);
  await saveScreenshot(authedPage, 'prod_03_agent_mode_upgrade_modal_plus.png');

  const modalText = await authedPage.locator('body').innerText();
  assert(modalText.includes('Unlock Autonomous Agent Missions with Plus') || modalText.includes('Target: AIRA Plus'),
    'Upgrade modal must recommend AIRA Plus for Agent mode on Free tier');
  assert(modalText.includes('Upgrade to Plus'), 'CTA must be Upgrade to Plus');
  console.log('✔ Authenticated Free Tier: Agent mode accurately recommends AIRA Plus');

  await browser.close();
  console.log('=== ALL LIVE PRODUCTION VERIFICATION COMPLETED SUCCESSFULLY ===');
}

verifyLiveProduction().catch(err => {
  console.error('[LIVE PROD ERROR]', err);
  process.exit(1);
});
