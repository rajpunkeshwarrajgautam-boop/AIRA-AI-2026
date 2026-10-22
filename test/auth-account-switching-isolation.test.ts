import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chromium, type Browser } from 'playwright';

const STAGING_AUTH_BASE = process.env.NEON_AUTH_BASE_URL || 'https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';
const STAGING_JWKS_URL = process.env.NEON_AUTH_JWKS_URL || 'https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth/.well-known/jwks.json';
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
  console.log('  AIRA AI 2026 — SAME-BROWSER ACCOUNT SWITCHING & ISOLATION  ');
  console.log('=============================================================\n');

  killPort(3001);
  killPort(5173);

  const stagingDbUrl = process.env.STAGING_DATABASE_URL || process.env.DATABASE_URL;
  if (!stagingDbUrl) {
    console.error('\n❌ ERROR: Staging database credentials not provided.');
    console.error('Set STAGING_DATABASE_URL or DATABASE_URL before running account switching tests.');
    console.error('Refusing to run with fallback or production database.\n');
    process.exit(1);
  }
  if (stagingDbUrl.includes('prod') || stagingDbUrl.includes('production')) {
    console.error('\n❌ SECURITY GUARD: Staging tests cannot run against production database.\n');
    process.exit(1);
  }

  console.log('[1/7] Starting API Server on port 3001...');
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

  console.log('[2/7] Starting Vite Frontend on port 5173...');
  const viteProc: ChildProcess = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', String(VITE_PORT), '--strictPort'], {
    env: {
      ...process.env,
      VITE_NEON_AUTH_URL: STAGING_AUTH_BASE
    },
    shell: true,
    stdio: 'pipe'
  });

  let browser: Browser | null = null;

  try {
    console.log('[3/7] Waiting for API Server and Vite Frontend readiness...');
    await waitForHttp(`${API_URL}/api/health`, 30000);
    await waitForHttp(VITE_URL, 30000);
    console.log('  ✓ API Server and Vite Frontend are ready');

    try {
      browser = await chromium.launch({ headless: true, channel: 'msedge' });
    } catch {
      browser = await chromium.launch({ headless: true });
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const ts = Date.now();
    const emailA = `switch_uA_${ts}@example.com`;
    const emailB = `switch_uB_${ts}@example.com`;
    const password = `SwitchSecure!2026_${ts}`;
    const tokenA = `Account-A-Exclusive-Secret-${ts}`;
    const tokenB = `Account-B-Exclusive-Secret-${ts}`;

    // -------------------------------------------------------------
    // STEP 4: Initial visit and Register Account A in page
    // -------------------------------------------------------------
    console.log('[4/7] Step 1: Register Account A and persist confidential data...');
    await page.goto(VITE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('main textarea', { timeout: 20000 });

    // Open Auth modal & register Account A
    await page.locator('button[aria-label*="Sign in"], button[aria-label*="account"]').click();
    await page.waitForSelector('#auth-modal-title', { timeout: 10000 });
    await page.getByRole('button', { name: 'Create Account' }).click();

    await page.locator('input[placeholder="Jane Doe"]').fill(`User A ${ts}`);
    await page.locator('input[placeholder="name@example.com"]').fill(emailA);
    const passA = page.locator('input[placeholder="••••••••"]');
    await passA.nth(0).fill(password);
    await passA.nth(1).fill(password);

    const guestCheckbox = page.locator('input[type="checkbox"]');
    if (await guestCheckbox.isChecked()) {
      await guestCheckbox.uncheck();
    }
    await page.getByRole('button', { name: /Create Account & Sync/i }).click();
    await page.getByText('Verified Neon Account').waitFor({ state: 'visible', timeout: 20000 });
    await page.keyboard.press('Escape');
    await sleep(500);

    // Create Account A confidential message and wait for sync
    const textarea = page.locator('main textarea');
    const syncPromiseA = page.waitForResponse(
      res => res.url().includes('/api/conversations/sync') &&
             res.status() === 200 &&
             (res.request().postData() || '').includes(tokenA),
      { timeout: 35000 }
    );
    await textarea.fill(tokenA);
    await textarea.press('Enter');
    await page.getByText(tokenA).first().waitFor({ state: 'visible', timeout: 15000 });
    await syncPromiseA;
    console.log('  ✓ Account A created and secret payload synced to PostgreSQL');

    // -------------------------------------------------------------
    // STEP 5: Switch to Account B in the SAME browser page
    // -------------------------------------------------------------
    console.log('[5/7] Step 2: Switch to Account B in the same browser session...');
    await page.locator('button[aria-label*="account"]').click();
    const isBilling = await page.getByText('Account & Billing Center').isVisible({ timeout: 3000 }).catch(() => false);
    if (isBilling) {
      await page.getByRole('button', { name: /Security/i }).click();
      await page.getByRole('button', { name: /Sign Out/i }).click();
      await sleep(1000);
      await page.locator('button[aria-label*="account"]').click();
      await page.waitForSelector('#auth-modal-title', { timeout: 10000 });
    } else {
      await page.waitForSelector('#auth-modal-title', { timeout: 10000 });
      await page.getByRole('button', { name: 'Sign Out' }).click();
      await sleep(500);
    }

    // Immediately register Account B
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.locator('input[placeholder="Jane Doe"]').fill(`User B ${ts}`);
    await page.locator('input[placeholder="name@example.com"]').fill(emailB);
    const passB = page.locator('input[placeholder="••••••••"]');
    await passB.nth(0).fill(password);
    await passB.nth(1).fill(password);
    if (await guestCheckbox.isChecked()) {
      await guestCheckbox.uncheck();
    }
    await page.getByRole('button', { name: /Create Account & Sync/i }).click();
    await page.getByText('Verified Neon Account').waitFor({ state: 'visible', timeout: 20000 });
    await page.keyboard.press('Escape');
    await sleep(1000);

    // CRITICAL ASSERTION: Account A's secret MUST NOT exist in DOM or Account B's storage
    const leakedDOMCountB = await page.getByText(tokenA).count();
    assert.equal(leakedDOMCountB, 0, 'Account B DOM must NEVER contain Account A data');

    const storageLeakage = await page.evaluate(({ tokenA }) => {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        if (key.includes('aira_conversations_user_')) {
          const val = localStorage.getItem(key) || '';
          if (val.includes(tokenA)) return key;
        }
      }
      return null;
    }, { tokenA });
    // Any Account B storage key must not contain tokenA
    const userBKey = await page.evaluate(() => {
      const sessionRaw = localStorage.getItem('aira_neon_auth_session_v1');
      const userId = sessionRaw ? JSON.parse(sessionRaw)?.user?.id : null;
      return userId ? localStorage.getItem(`aira_conversations_user_${userId}`) : null;
    });
    assert.equal(userBKey?.includes(tokenA) || false, false, 'Account B localStorage must not contain Account A data');
    console.log('  ✓ Strict isolation verified: Account B DOM and storage have ZERO Account A traces');

    // Create Account B confidential message
    const syncPromiseB = page.waitForResponse(
      res => res.url().includes('/api/conversations/sync') &&
             res.status() === 200 &&
             (res.request().postData() || '').includes(tokenB),
      { timeout: 35000 }
    );
    await textarea.fill(tokenB);
    await textarea.press('Enter');
    await page.getByText(tokenB).first().waitFor({ state: 'visible', timeout: 15000 });
    await syncPromiseB;
    console.log('  ✓ Account B created and secret payload synced to PostgreSQL');

    // -------------------------------------------------------------
    // STEP 6: Sign out to Guest
    // -------------------------------------------------------------
    console.log('[6/7] Step 3: Sign out to Guest workspace...');
    await page.locator('button[aria-label*="account"]').click();
    const isBillingGuest = await page.getByText('Account & Billing Center').isVisible({ timeout: 3000 }).catch(() => false);
    if (isBillingGuest) {
      await page.getByRole('button', { name: /Security/i }).click();
      await page.getByRole('button', { name: /Sign Out/i }).click();
      await sleep(1000);
    } else {
      await page.waitForSelector('#auth-modal-title', { timeout: 10000 });
      await page.getByRole('button', { name: 'Sign Out' }).click();
      await page.keyboard.press('Escape');
      await sleep(1000);
    }

    // Neither Account A nor Account B secret in guest DOM
    assert.equal(await page.getByText(tokenA).count(), 0, 'Guest DOM must not show Account A data');
    assert.equal(await page.getByText(tokenB).count(), 0, 'Guest DOM must not show Account B data');
    const guestFooter = page.locator('[data-testid="sidebar-footer"]');
    await guestFooter.getByText('Guest Workspace').waitFor({ state: 'visible', timeout: 10000 });
    console.log('  ✓ Guest state verified: Clean workspace with zero account data visible');

    // -------------------------------------------------------------
    // STEP 7: Switch back to Account A and verify hydration
    // -------------------------------------------------------------
    console.log('[7/7] Step 4: Re-authenticate into Account A and assert exact hydration...');
    await page.locator('button[aria-label*="Sign in"]').click();
    await page.waitForSelector('#auth-modal-title', { timeout: 10000 });

    await page.locator('input[placeholder="name@example.com"]').fill(emailA);
    await page.locator('input[placeholder="••••••••"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.getByText('Verified Neon Account').waitFor({ state: 'visible', timeout: 20000 });
    await page.keyboard.press('Escape');
    await sleep(1000);

    // Wait for Account A's secret to hydrate from PostgreSQL into DOM
    try {
      await page.getByText(tokenA).first().waitFor({ state: 'visible', timeout: 12000 });
    } catch {
      const convSidebarItem = page.locator('[data-testid="sidebar-scroll-region"]').getByText(/Welcome|Cross-device|token|Account/i).first();
      if (await convSidebarItem.count() > 0) {
        await convSidebarItem.click();
      }
      await page.getByText(tokenA).first().waitFor({ state: 'visible', timeout: 15000 });
    }

    assert.equal(await page.getByText(tokenB).count(), 0, 'Account A must NEVER contain Account B data');
    console.log('  ✓ Account A successfully restored from PostgreSQL with zero Account B pollution!');

    console.log('\n=============================================================');
    console.log('ALL SAME-BROWSER ACCOUNT SWITCHING CHECKS PASSED [4/4]');
    console.log('=============================================================\n');

    await browser.close();
    killProcessTree(apiProc);
    killProcessTree(viteProc);
    killPort(3001);
    killPort(5173);
    process.exit(0);
  } catch (err) {
    console.error('\nAccount switching test failed:', err);
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
  killPort(3001);
  killPort(5173);
  process.exit(1);
});
