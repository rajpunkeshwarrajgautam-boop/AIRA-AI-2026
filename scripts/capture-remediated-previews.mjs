import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';

const TEST_PORT = 5195;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const ARTIFACT_DIR = 'C:/Users/WORKSTATION/.gemini/antigravity/brain/54535eac-2ffc-4e85-9f79-8c6d60034f9f/remediated-screenshots';
const REPO_DIR = path.resolve('test/screenshots/remediated');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
fs.mkdirSync(REPO_DIR, { recursive: true });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function killPort(port) {
  try {
    spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`
    ], { stdio: 'ignore' });
  } catch {}
}

async function waitForHttp(url, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Server at ${url} failed to respond`);
}

async function saveScreenshot(page, filename) {
  const artPath = path.join(ARTIFACT_DIR, filename);
  const repoPath = path.join(REPO_DIR, filename);
  await page.screenshot({ path: artPath, fullPage: false });
  fs.copyFileSync(artPath, repoPath);
  console.log(`[SAVED] ${filename}`);
}

async function run() {
  killPort(TEST_PORT);
  console.log(`[SERVER] Starting Vite preview on ${BASE_URL}...`);
  const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(TEST_PORT), '--strictPort'], {
    shell: true,
    stdio: 'ignore'
  });

  await waitForHttp(BASE_URL, 20000);
  console.log('[SERVER] Preview server ready.');

  console.log('[BROWSER] Launching Edge...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  });

  const page = await context.newPage();

  // 1. Visit Motion Studio
  console.log('Navigating to Motion Studio...');
  await page.goto(`${BASE_URL}/?view=video-studio`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await saveScreenshot(page, 'remediated_01_motion_studio_player.png');

  // Storyboard tab
  const scenesTab = page.locator('button:has-text("Scenes")');
  if (await scenesTab.isVisible()) {
    await scenesTab.click();
    await page.waitForTimeout(600);
    await saveScreenshot(page, 'remediated_02_motion_studio_storyboard.png');
  }

  // Remotion code tab
  const codeTab = page.locator('button:has-text("Remotion")');
  if (await codeTab.isVisible()) {
    await codeTab.click();
    await page.waitForTimeout(600);
    await saveScreenshot(page, 'remediated_03_motion_studio_code.png');
  }

  // 2. Main Greeting & Model Selector
  console.log('Navigating to main view...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);
  await saveScreenshot(page, 'remediated_04_greeting_view.png');

  // Open Model Selector
  console.log('Opening Model Selector...');
  const modelBtn = page.locator('button[aria-haspopup="listbox"]').first();
  if (await modelBtn.isVisible()) {
    await modelBtn.click();
    await page.waitForTimeout(600);
    await saveScreenshot(page, 'remediated_05_model_selector_nemotron_exp.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // 3. Test Agent Mode trigger on Free Tier (seed authenticated free user)
  console.log('Testing Agent button on Free user...');
  await page.addInitScript(() => {
    localStorage.setItem('aira_neon_auth_session_v1', JSON.stringify({
      user: {
        id: 'usr_free_test',
        name: 'Jordan Free Tier',
        email: 'jordan@example.com',
        role: 'user',
        emailVerified: true
      },
      token: 'mock_token',
      jwt: 'mock_jwt',
      jwtExpiresAt: Date.now() + 86400000
    }));
    localStorage.setItem('aira_onboarding_usr_free_test', JSON.stringify({
      completed: true,
      currentStage: 'plans',
      skipped: false
    }));
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);

  const agentBtn = page.locator('[data-testid="chat-mode-agent-btn"]');
  if (await agentBtn.isVisible()) {
    await agentBtn.click();
    await page.waitForTimeout(800);
    await saveScreenshot(page, 'remediated_06_agent_upgrade_modal_plus_recommendation.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // 4. Open Account Menu (Free user)
  console.log('Opening Account Menu...');
  const accountBtn = page.locator('[data-testid="account-button"]');
  if (await accountBtn.isVisible()) {
    await accountBtn.click();
    await page.waitForTimeout(600);
    await saveScreenshot(page, 'remediated_07_account_menu_no_sparkles.png');
  }

  await browser.close();
  try {
    server.kill();
    killPort(TEST_PORT);
  } catch {}
  console.log('[BROWSER] Capture completed successfully.');
}

run().catch(err => {
  console.error('[ERROR]', err);
  killPort(TEST_PORT);
  process.exit(1);
});
