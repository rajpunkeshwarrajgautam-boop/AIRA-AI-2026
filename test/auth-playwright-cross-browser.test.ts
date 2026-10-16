import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const STAGING_AUTH_BASE = 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';
const STAGING_JWKS_URL = 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/.well-known/jwks.json';
const API_PORT = 3001;
const VITE_PORT = 5173;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const VITE_URL = `http://localhost:${VITE_PORT}`;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function killPort(port: number) {
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

function killProcessTree(proc: ChildProcess) {
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
  throw new Error(`Endpoint ${url} failed to become available within ${timeoutMs}ms`);
}

async function main() {
  console.log('\n=============================================================');
  console.log('  AIRA AI 2026 — PLAYWRIGHT CROSS-BROWSER AUTH & PERSISTENCE');
  console.log('=============================================================\n');

  // Pre-cleanup ports 3001 and 5173
  killPort(3001);
  killPort(5173);

  const stagingDbUrl = process.env.STAGING_DATABASE_URL || process.env.DATABASE_URL;
  if (!stagingDbUrl) {
    console.error('\n❌ ERROR: Staging database credentials not provided.');
    console.error('Set STAGING_DATABASE_URL or DATABASE_URL before running Playwright auth tests.');
    console.error('Refusing to run with fallback or production database.\n');
    process.exit(1);
  }
  if (stagingDbUrl.includes('prod') || stagingDbUrl.includes('production')) {
    console.error('\n❌ SECURITY GUARD: Staging tests cannot run against production database.\n');
    process.exit(1);
  }

  // 1. Start API Server on port 3001
  console.log('[1/10] Starting API Server on port 3001...');
  const apiProc: ChildProcess = spawn('npx', ['tsx', 'apps/api/src/index.ts'], {
    env: {
      ...process.env,
      PORT: String(API_PORT),
      DATABASE_URL: stagingDbUrl,
      AIRA_EXTERNAL_AUTH_ENABLED: 'true',
      NEON_AUTH_BASE_URL: STAGING_AUTH_BASE,
      NEON_AUTH_JWKS_URL: STAGING_JWKS_URL,
      NODE_ENV: 'test'
    },
    shell: true,
    stdio: 'pipe'
  });

  // 2. Start Vite Dev Server on port 5173 bound to 0.0.0.0 (supporting localhost)
  console.log('[2/10] Starting Vite Frontend on port 5173...');
  const viteProc: ChildProcess = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', String(VITE_PORT), '--strictPort'], {
    env: {
      ...process.env,
      VITE_NEON_AUTH_URL: STAGING_AUTH_BASE
    },
    shell: true,
    stdio: 'pipe'
  });

  apiProc.stdout?.on('data', d => {
    process.stdout.write(`  [API] ${d.toString().trim()}\n`);
  });
  apiProc.stderr?.on('data', d => {
    process.stderr.write(`  [API ERR] ${d.toString().trim()}\n`);
  });

  viteProc.stdout?.on('data', d => {
    const s = d.toString();
    if (s.includes('Local:') || s.includes('ready')) process.stdout.write(`  [Vite] ${s.trim()}\n`);
  });

  let browser: Browser | null = null;

  try {
    console.log('[3/10] Waiting for API Server and Vite Frontend readiness...');
    await waitForHttp(`${API_URL}/api/health`, 30000);
    await waitForHttp(VITE_URL, 30000);
    console.log('  ✓ API Server and Vite Frontend are ready');

    // Launch Playwright browser
    console.log('[4/10] Launching headless browser with dual isolated contexts...');
    try {
      browser = await chromium.launch({ headless: true, channel: 'msedge' });
    } catch {
      browser = await chromium.launch({ headless: true });
    }

    const ts = Date.now();
    const email1 = `playwright_u1_${ts}@example.com`;
    const email2 = `playwright_u2_${ts}@example.com`;
    const password = `PlaywrightSecure!2026_${ts}`;
    const user1Name = `Browser User One ${ts}`;

    // -----------------------------------------------------------------------
    // BROWSER CONTEXT A: Register Account 1, Verify Identity & Create Sync Data
    // -----------------------------------------------------------------------
    console.log('[5/10] Browser Context A: Account 1 registration and conversation creation...');
    const contextA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pageA = await contextA.newPage();
    pageA.on('console', msg => console.log('  [Browser A Log]', msg.text()));
    pageA.on('pageerror', err => console.log('  [Browser A Error]', err.message));
    pageA.on('response', res => {
      if (res.status() >= 400) console.log('  [Browser A HTTP >= 400]', res.status(), res.url());
    });

    await pageA.goto(VITE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pageA.waitForSelector('main textarea', { timeout: 20000 });

    // Open Auth Modal via sidebar footer
    const authBtnA = pageA.locator('button[aria-label*="Sign in"], button[aria-label*="account"]');
    await authBtnA.click();
    await pageA.waitForSelector('#auth-modal-title', { timeout: 10000 });

    // Switch to Create Account tab
    await pageA.getByRole('button', { name: 'Create Account' }).click();
    await sleep(400);

    // Fill Sign Up form
    await pageA.locator('input[placeholder="Jane Doe"]').fill(user1Name);
    await pageA.locator('input[placeholder="name@example.com"]').fill(email1);
    const passwordInputs = pageA.locator('input[placeholder="••••••••"]');
    await passwordInputs.nth(0).fill(password);
    await passwordInputs.nth(1).fill(password);

    // Uncheck preserveGuestData for clean test isolation
    const guestCheckbox = pageA.locator('#signup-preserve-guest');
    if (await guestCheckbox.isChecked()) {
      await guestCheckbox.uncheck();
    }

    // Submit Sign Up
    const submitBtn = pageA.getByRole('button', { name: /Create Account & Sync/i });
    await submitBtn.click();

    // If an error alert appears, log it
    try {
      await pageA.getByText('Verified Neon Account').waitFor({ state: 'visible', timeout: 20000 });
    } catch (e) {
      const banner = await pageA.locator('.text-red-600, .text-red-400').textContent().catch(() => '');
      if (banner) console.error('  [Browser A Registration Banner Error]:', banner);
      throw e;
    }
    console.log('  ✓ Account 1 registered and profile verified in Browser A');

    // Test live server principal probe button
    try {
      await pageA.getByRole('button', { name: 'Verify Live Server Principal' }).click();
      await pageA.getByText('Live Server Principal Verified').waitFor({ state: 'visible', timeout: 15000 });
      console.log('  ✓ Live server principal verified against /api/auth/identity in Browser A');
    } catch (e) {
      const banner = await pageA.locator('.text-red-600, .text-red-400').textContent().catch(() => '');
      if (banner) console.error('  [Browser A Verification Banner Error]:', banner);
      throw e;
    }

    // Close Auth modal
    await pageA.keyboard.press('Escape');
    await sleep(500);

    // Create a new conversation and message in Browser A
    const textareaA = pageA.locator('main textarea');
    const secretMessageText = `Cross-device durable persistence verification token: ${ts}`;

    // Set up listener specifically for the Postgres sync containing this message
    const syncPromise = pageA.waitForResponse(
      res => res.url().includes('/api/conversations/sync') &&
             res.status() === 200 &&
             (res.request().postData() || '').includes(secretMessageText),
      { timeout: 35000 }
    );

    await textareaA.fill(secretMessageText);
    await textareaA.press('Enter');

    // Wait for the user message rendered in Browser A
    await pageA.getByText(secretMessageText).waitFor({ state: 'visible', timeout: 15000 });
    console.log('  ✓ Conversation created and message rendered in Browser A');

    // Ensure the message sync containing secretMessageText to PostgreSQL has completed
    await syncPromise;
    console.log('  ✓ Verified PostgreSQL server conversation sync with secret payload from Browser A');

    // Wait for the assistant streaming run to fully finish before moving to Browser B
    await pageA.waitForSelector('main textarea:not([disabled])', { timeout: 30000 });
    await sleep(1000);

    // -----------------------------------------------------------------------
    // BROWSER CONTEXT B: Separate context logs into Account 1 and verifies sync
    // -----------------------------------------------------------------------
    console.log('[6/10] Browser Context B: Independent context signs in to Account 1...');
    const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pageB = await contextB.newPage();
    pageB.on('console', msg => console.log('  [Browser B Log]', msg.text()));
    pageB.on('pageerror', err => console.log('  [Browser B Error]', err.message));
    pageB.on('response', res => {
      if (res.status() >= 400) console.log('  [Browser B HTTP >= 400]', res.status(), res.url());
    });

    await pageB.goto(VITE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pageB.waitForSelector('main textarea', { timeout: 20000 });

    // Verify Browser B starts in isolated Guest state
    const footerB = pageB.locator('[data-testid="sidebar-footer"]');
    await footerB.getByText('Guest Workspace').waitFor({ state: 'visible', timeout: 10000 });
    console.log('  ✓ Browser B cleanly initialized in isolated guest workspace');

    // Open Auth Modal and sign in as Account 1
    const authBtnB = pageB.locator('button[aria-label*="Sign in"], button[aria-label*="account"]');
    await authBtnB.click();
    await pageB.waitForSelector('#auth-modal-title', { timeout: 10000 });

    await pageB.locator('input[placeholder="name@example.com"]').fill(email1);
    await pageB.locator('input[placeholder="••••••••"]').fill(password);
    await pageB.locator('button[type="submit"]').click();

    // Verify verified status
    await pageB.getByText('Verified Neon Account').waitFor({ state: 'visible', timeout: 20000 });
    console.log('  ✓ Account 1 sign-in succeeded in Browser B');

    // Close modal
    await pageB.keyboard.press('Escape');
    await sleep(1000);

    // Verify Browser B hydrated Account 1's conversation from PostgreSQL
    console.log('[7/10] Verifying cross-device conversation hydration in Browser B...');

    // Wait for the secret message text from Browser A to be present in Browser B's view
    try {
      await pageB.getByText(secretMessageText).first().waitFor({ state: 'visible', timeout: 12000 });
    } catch {
      // In case activeChatId was pointing to an older guest chat, select from sidebar
      const convSidebarItem = pageB.locator('[data-testid="sidebar-scroll-region"]').getByText(/Welcome|Cross-device|token/i).first();
      if (await convSidebarItem.count() > 0) {
        await convSidebarItem.click();
      }
      await pageB.getByText(secretMessageText).first().waitFor({ state: 'visible', timeout: 15000 });
    }
    console.log('  ✓ Conversation and messages successfully retrieved across independent browser contexts!');

    // -----------------------------------------------------------------------
    // BROWSER CONTEXT C: Account 2 registration & Cross-Account Isolation
    // -----------------------------------------------------------------------
    console.log('[8/10] Browser Context C: Account 2 isolation verification...');
    const contextC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pageC = await contextC.newPage();

    await pageC.goto(VITE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pageC.waitForSelector('main textarea', { timeout: 20000 });

    // Register Account 2
    const authBtnC = pageC.locator('button[aria-label*="Sign in"], button[aria-label*="account"]');
    await authBtnC.click();
    await pageC.waitForSelector('#auth-modal-title', { timeout: 10000 });
    await pageC.getByRole('button', { name: 'Create Account' }).click();

    await pageC.locator('input[placeholder="Jane Doe"]').fill(`Account Two ${ts}`);
    await pageC.locator('input[placeholder="name@example.com"]').fill(email2);
    const passC = pageC.locator('input[placeholder="••••••••"]');
    await passC.nth(0).fill(password);
    await passC.nth(1).fill(password);
    await pageC.locator('button[type="submit"]').click();

    await pageC.getByText('Verified Neon Account').waitFor({ state: 'visible', timeout: 20000 });
    await pageC.keyboard.press('Escape');
    await sleep(1000);

    // Assert Account 2 CANNOT see Account 1's secret message
    const leakedMessageCount = await pageC.getByText(secretMessageText).count();
    assert.equal(leakedMessageCount, 0, 'Account 2 must NEVER see Account 1 secret conversation');
    console.log('  ✓ Horizontal isolation verified: Account 2 cannot view Account 1 data');

    // -----------------------------------------------------------------------
    // ACCOUNT SWITCHING / LOGOUT TEST
    // -----------------------------------------------------------------------
    console.log('[9/10] Testing account logout and session cleanup in Browser A...');
    await pageA.locator('button[aria-label*="account"]').click();
    await pageA.waitForSelector('#auth-modal-title', { timeout: 10000 });
    await pageA.getByRole('button', { name: 'Sign Out' }).click();

    // Verify modal resets to signin tab and footer returns to Guest Workspace
    await pageA.keyboard.press('Escape');
    await sleep(1000);

    const footerAfterSignout = pageA.locator('[data-testid="sidebar-footer"]');
    await footerAfterSignout.getByText('Guest Workspace').waitFor({ state: 'visible', timeout: 10000 });

    const messagesAfterSignout = await pageA.getByText(secretMessageText).count();
    assert.equal(messagesAfterSignout, 0, 'Signed-out workspace must immediately purge authenticated user history');
    console.log('  ✓ Logout completely cleared private user conversation from browser view');

    // -----------------------------------------------------------------------
    // MOBILE VIEWPORT RESPONSIVE CHECK
    // -----------------------------------------------------------------------
    console.log('[10/10] Verifying mobile responsive signup/login/profile UX...');
    await pageC.setViewportSize({ width: 375, height: 667 });
    await pageC.waitForSelector('main textarea', { timeout: 10000 });

    // Open mobile sidebar drawer
    await pageC.getByRole('button', { name: 'Open sidebar navigation' }).click();
    const drawer = pageC.getByTestId('sidebar-drawer');
    await drawer.waitFor({ state: 'visible', timeout: 10000 });

    // Click account details button in mobile drawer
    const mobileAuthBtn = drawer.locator('button[aria-label*="account"], button[aria-label*="Sign in"]');
    await mobileAuthBtn.waitFor({ state: 'visible', timeout: 10000 });
    await mobileAuthBtn.click();

    // Modal must open and be completely visible without clipping
    const mobileModal = pageC.locator('#auth-modal-title');
    await mobileModal.waitFor({ state: 'visible', timeout: 10000 });
    console.log('  ✓ Mobile auth navigation and profile view verified on 375x667 viewport');

    console.log('\n=============================================================');
    console.log('ALL PLAYWRIGHT CROSS-BROWSER ACCEPTANCE CHECKS PASSED [10/10]');
    console.log('=============================================================\n');

    await browser.close();
    killProcessTree(apiProc);
    killProcessTree(viteProc);
    killPort(3001);
    killPort(5173);
    process.exit(0);
  } catch (err) {
    console.error('\nPlaywright cross-browser acceptance test failed:', err);
    if (browser) await browser.close();
    killProcessTree(apiProc);
    killProcessTree(viteProc);
    killPort(3001);
    killPort(5173);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
