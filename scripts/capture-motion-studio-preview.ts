import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const TEST_PORT = 5192;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const ARTIFACTS_DIR = 'C:\\Users\\WORKSTATION\\.gemini\\antigravity\\brain\\37882de1-40fa-4894-902d-dcb2e7b28583';
const REPO_SCREENSHOTS_DIR = path.resolve(process.cwd(), 'test', 'screenshots');
const PUBLIC_PREVIEWS_DIR = path.resolve(process.cwd(), 'public', 'previews');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function killPort(port: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`
      ], { stdio: 'ignore' });
    } catch {}
  }
}

function killProcessTree(proc: ChildProcess | null): void {
  if (proc && proc.pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { shell: true, stdio: 'ignore' });
      } else {
        proc.kill('SIGKILL');
      }
    } catch {}
  }
}

async function waitForHttp(url: string, timeoutMs = 25000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Server at ${url} failed to respond within ${timeoutMs}ms`);
}

async function startServer(): Promise<ChildProcess> {
  killPort(TEST_PORT);

  console.log(`[SERVER] Launching Vite preview on http://127.0.0.1:${TEST_PORT}...`);
  const serverProc: ChildProcess = spawn(
    'npx',
    ['vite', 'preview', '--host', '127.0.0.1', '--port', String(TEST_PORT), '--strictPort'],
    {
      shell: true,
      stdio: 'pipe'
    }
  );

  await waitForHttp(BASE_URL, 20000);
  console.log(`[SERVER] Vite preview server is ready on ${BASE_URL}`);
  return serverProc;
}

async function saveScreenshot(page: Page, filename: string) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.mkdirSync(REPO_SCREENSHOTS_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_PREVIEWS_DIR, { recursive: true });

  const artifactTarget = path.join(ARTIFACTS_DIR, filename);
  const repoTarget = path.join(REPO_SCREENSHOTS_DIR, filename);
  const publicTarget = path.join(PUBLIC_PREVIEWS_DIR, filename);

  await page.screenshot({ path: artifactTarget, fullPage: false });
  fs.copyFileSync(artifactTarget, repoTarget);
  fs.copyFileSync(artifactTarget, publicTarget);
  console.log(`[SCREENSHOT] Saved: ${filename} -> ${artifactTarget} & ${publicTarget}`);
}

async function captureMotionStudioPreviews() {
  let serverProc: ChildProcess | null = null;
  let browser: Browser | null = null;

  try {
    serverProc = await startServer();
    browser = await chromium.launch({ channel: 'msedge', headless: true });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1
    });

    const page = await context.newPage();

    // Mock auth & init script
    await page.addInitScript(() => {
      localStorage.setItem('aira_neon_auth_session_v1', JSON.stringify({
        user: {
          id: 'usr_pro_showcase',
          name: 'AIRA Showcase Director',
          email: 'director@aira.ai',
          role: 'user',
          emailVerified: true
        },
        token: 'mock_session_token_pro',
        jwt: 'mock_jwt_token_pro',
        jwtExpiresAt: Date.now() + 86400000
      }));
      localStorage.setItem('aira_onboarding_usr_pro_showcase', JSON.stringify({
        completed: true,
        currentStage: 'plans',
        skipped: false
      }));
      localStorage.setItem('aira_dismissed_announcements_usr_pro_showcase', JSON.stringify([
        'ann_entitlements_v2',
        'ann_onboarding_walkthrough',
        'ann_model_routing_v3'
      ]));
    });

    console.log('Navigating to http://127.0.0.1:5192/?view=video-studio...');
    await page.goto(`${BASE_URL}/?view=video-studio`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Wait for Motion Studio container
    const studioDialog = page.locator('.studio-shell');
    await studioDialog.waitFor({ state: 'visible', timeout: 8000 });
    console.log('Motion Studio modal is open and visible.');

    // Screenshot 1: Player View (Scene 1)
    await page.waitForTimeout(1000);
    await saveScreenshot(page, '07_motion_studio_player.png');

    // Switch to Storyboard View
    const storyboardBtn = page.locator('button:has-text("Scenes")');
    if (await storyboardBtn.isVisible()) {
      await storyboardBtn.click();
      await page.waitForTimeout(1000);
      console.log('Switched to Storyboard mode.');
      await saveScreenshot(page, '08_motion_studio_storyboard.png');
    }

    // Switch to Remotion Code View
    const codeBtn = page.locator('button:has-text("Remotion")');
    if (await codeBtn.isVisible()) {
      await codeBtn.click();
      await page.waitForTimeout(1000);
      console.log('Switched to Remotion Code mode.');
      await saveScreenshot(page, '09_motion_studio_remotion_code.png');
    }

    await context.close();
    console.log('[SUCCESS] All Motion Studio screenshots captured successfully.');
  } catch (err) {
    console.error('[ERROR] Failed capturing Motion Studio preview:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (serverProc) killProcessTree(serverProc);
    killPort(TEST_PORT);
  }
}

captureMotionStudioPreviews();
