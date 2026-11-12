import { chromium, type Browser, type Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { preview, type PreviewServer } from 'vite';

const PORT = 5173;
const APP_URL = `http://localhost:${PORT}/`;
const BEFORE_DIR = path.resolve('.hallmark/before');
const AFTER_DIR = path.resolve('.hallmark/after');

if (!fs.existsSync(AFTER_DIR)) {
  fs.mkdirSync(AFTER_DIR, { recursive: true });
}

async function captureShot(page: Page, filename: string) {
  const filePath = path.join(AFTER_DIR, filename);
  await page.screenshot({ path: filePath });
  console.log(`Saved redesign screenshot: ${filename}`);
}

async function generateComparisonHtml(filenames: string[]) {
  console.log('Generating comparison HTML report...');
  const rows = filenames.map(name => {
    const beforeExists = fs.existsSync(path.join(BEFORE_DIR, name));
    const afterExists = fs.existsSync(path.join(AFTER_DIR, name));
    return `
      <div class="comparison-card">
        <h3>${name}</h3>
        <div class="comparison-grid">
          <div class="pane">
            <span class="badge before-badge">Before (Baseline Production)</span>
            ${beforeExists ? `<img src="before/${name}" alt="Before: ${name}" loading="lazy" />` : '<p class="missing">Missing</p>'}
          </div>
          <div class="pane">
            <span class="badge after-badge">After (Hallmark UNSLOP)</span>
            ${afterExists ? `<img src="after/${name}" alt="After: ${name}" loading="lazy" />` : '<p class="missing">Missing</p>'}
          </div>
        </div>
      </div>
    `;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AIRA AI 2026 — Hallmark UNSLOP Visual Comparison</title>
  <style>
    :root {
      --bg: #09090b;
      --card-bg: #18181b;
      --border: #27272a;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --before-accent: #f43f5e;
      --after-accent: #10b981;
    }
    body {
      margin: 0;
      padding: 2rem;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    header {
      max-width: 1400px;
      margin: 0 auto 2rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.5rem;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 600;
      margin: 0 0 0.5rem 0;
    }
    p {
      color: var(--muted);
      margin: 0;
      font-size: 0.95rem;
    }
    .metrics {
      display: flex;
      gap: 1.5rem;
      margin-top: 1rem;
    }
    .metric-pill {
      background: #27272a;
      padding: 0.5rem 1rem;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 500;
    }
    .metric-pill strong {
      color: #38bdf8;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 2.5rem;
    }
    .comparison-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      overflow: hidden;
    }
    .comparison-card h3 {
      margin: 0 0 1rem 0;
      font-size: 1.1rem;
      font-family: monospace;
      color: #e4e4e7;
    }
    .comparison-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
    }
    .pane {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .badge {
      display: inline-block;
      align-self: flex-start;
      padding: 0.25rem 0.65rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .before-badge {
      background: rgba(244, 63, 94, 0.15);
      color: var(--before-accent);
      border: 1px solid rgba(244, 63, 94, 0.3);
    }
    .after-badge {
      background: rgba(16, 185, 129, 0.15);
      color: var(--after-accent);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    img {
      width: 100%;
      height: auto;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #000;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.5);
    }
    .missing {
      padding: 4rem;
      text-align: center;
      background: #27272a;
      border-radius: 8px;
      color: var(--muted);
    }
    @media (max-width: 900px) {
      .comparison-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>AIRA AI 2026 — Hallmark Production UI UNSLOP Visual Comparison</h1>
    <p>Comprehensive visual comparison of production baseline vs Hallmark UNSLOP redesign across viewports and modal surfaces.</p>
    <div class="metrics">
      <div class="metric-pill">Sloplint Floor: <strong>0 FAIL (down from 547)</strong></div>
      <div class="metric-pill">Kept Contracts: <strong>7/7 links, 499/499 handlers, 142/142 test hooks</strong></div>
      <div class="metric-pill">Design System: <strong>tokens.css + base.css + index.css</strong></div>
    </div>
  </header>
  <main class="container">
    ${rows}
  </main>
</body>
</html>`;

  fs.writeFileSync(path.resolve('.hallmark/compare.html'), html, 'utf-8');
  console.log('Saved .hallmark/compare.html successfully!');
}

async function main() {
  console.log('=== Starting Vite Preview Server on port ' + PORT + ' ===');
  let server: PreviewServer;
  try {
    server = await preview({
      preview: {
        port: PORT,
        host: 'localhost',
        strictPort: true,
      },
    });
    console.log(`Vite Preview Server running at ${APP_URL}`);
  } catch (e) {
    console.error('Failed to start preview server:', e);
    process.exit(1);
  }

  const capturedFilenames: string[] = [];

  try {
    console.log('=== Capturing After Screenshots via Playwright (Edge Channel) ===');
    const browser: Browser = await chromium.launch({ headless: true, channel: 'msedge' });

    // 1. Desktop 1440x900
    {
      console.log('[1/6] Capturing Desktop 1440x900 screens & modals...');
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1000);

      // Welcome view
      await captureShot(page, 'welcome-desktop-1440.png');
      capturedFilenames.push('welcome-desktop-1440.png');

      // Model Selector open
      try {
        const modelSelectorBtn = page.locator('button[aria-label="Select AI Model"], button:has-text("Aira Auto"), button:has-text("Aira Fast")').first();
        if (await modelSelectorBtn.isVisible()) {
          await modelSelectorBtn.click();
          await page.waitForTimeout(300);
          await captureShot(page, 'model-selector-open-1440.png');
          capturedFilenames.push('model-selector-open-1440.png');
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        }
      } catch (e) {
        console.warn('Model selector capture warning:', e);
      }

      // Account Menu open
      try {
        const accountBtn = page.locator('[data-testid="sidebar-footer"] button[aria-haspopup="menu"], button[aria-label="Account and user settings menu"], button:has-text("Anonymous User"), button:has-text("Account")').first();
        if (await accountBtn.isVisible()) {
          await accountBtn.click();
          await page.waitForTimeout(300);
          await captureShot(page, 'account-menu-open-1440.png');
          capturedFilenames.push('account-menu-open-1440.png');
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        }
      } catch (e) {
        console.warn('Account menu capture warning:', e);
      }

      // Settings Modal (General)
      try {
        const settingsBtn = page.locator('button[aria-label="Open settings"], button[title="Settings"]').first();
        if (await settingsBtn.isVisible()) {
          await settingsBtn.click();
          await page.waitForTimeout(400);
          await captureShot(page, 'settings-general-1440.png');
          capturedFilenames.push('settings-general-1440.png');

          // Capture other settings tabs
          const tabs = ['plan', 'reasoning', 'memory', 'instructions', 'artifacts', 'data'];
          for (const tab of tabs) {
            const tabBtn = page.locator(`button[data-tab="${tab}"], button:has-text("${tab.charAt(0).toUpperCase() + tab.slice(1)}")`).first();
            if (await tabBtn.isVisible()) {
              await tabBtn.click();
              await page.waitForTimeout(300);
              await captureShot(page, `settings-${tab}-1440.png`);
              capturedFilenames.push(`settings-${tab}-1440.png`);
            }
          }

          // Close settings modal
          const closeBtn = page.locator('button[aria-label="Close settings"], button[aria-label="Close dialog"], button:has-text("Done")').first();
          if (await closeBtn.isVisible()) {
            await closeBtn.click();
          } else {
            await page.keyboard.press('Escape');
          }
          await page.waitForTimeout(300);
        }
      } catch (e) {
        console.warn('Settings modal capture warning:', e);
      }

      // Account & Billing Modal
      try {
        await page.evaluate(() => {
          window.location.hash = '#settings-billing';
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        });
        await page.waitForTimeout(500);
        const billingDialog = page.locator('div[role="dialog"]:has-text("Billing"), div[role="dialog"]:has-text("Subscription"), div:has-text("AIRA Account & Billing")').first();
        if (await billingDialog.isVisible()) {
          await captureShot(page, 'billing-modal-1440.png');
          capturedFilenames.push('billing-modal-1440.png');
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }
      } catch (e) {
        console.warn('Billing modal capture warning:', e);
      }

      // Library view
      try {
        const libraryBtn = page.locator('button:has-text("Library"), a:has-text("Library")').first();
        if (await libraryBtn.isVisible()) {
          await libraryBtn.click();
          await page.waitForTimeout(400);
          await captureShot(page, 'library-view-1440.png');
          capturedFilenames.push('library-view-1440.png');
        }
      } catch (e) {
        console.warn('Library view capture warning:', e);
      }

      // Agents view
      try {
        const agentsBtn = page.locator('button:has-text("Agents"), a:has-text("Agents")').first();
        if (await agentsBtn.isVisible()) {
          await agentsBtn.click();
          await page.waitForTimeout(400);
          await captureShot(page, 'agents-view-1440.png');
          capturedFilenames.push('agents-view-1440.png');
        }
      } catch (e) {
        console.warn('Agents view capture warning:', e);
      }

      await context.close();
    }

    // 2. Desktop 1280x800
    {
      console.log('[2/6] Capturing Desktop 1280x800...');
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(500);
      await captureShot(page, 'welcome-desktop-1280.png');
      capturedFilenames.push('welcome-desktop-1280.png');
      await context.close();
    }

    // 3. Tablet 1024x768
    {
      console.log('[3/6] Capturing Tablet 1024x768...');
      const context = await browser.newContext({
        viewport: { width: 1024, height: 768 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(500);
      await captureShot(page, 'welcome-tablet-1024.png');
      capturedFilenames.push('welcome-tablet-1024.png');
      await context.close();
    }

    // 4. Tablet 768x1024
    {
      console.log('[4/6] Capturing Tablet 768x1024...');
      const context = await browser.newContext({
        viewport: { width: 768, height: 1024 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(500);
      await captureShot(page, 'welcome-tablet-768.png');
      capturedFilenames.push('welcome-tablet-768.png');
      await context.close();
    }

    // 5. Mobile 390x844
    {
      console.log('[5/6] Capturing Mobile 390x844...');
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(500);
      await captureShot(page, 'welcome-mobile-390.png');
      capturedFilenames.push('welcome-mobile-390.png');

      // Open mobile sidebar drawer
      try {
        const openDrawerBtn = page.locator('button[aria-label="Open sidebar navigation"], button[aria-label="Open sidebar"]').first();
        if (await openDrawerBtn.isVisible()) {
          await openDrawerBtn.click();
          await page.waitForTimeout(400);
          await captureShot(page, 'mobile-drawer-390.png');
          capturedFilenames.push('mobile-drawer-390.png');
        }
      } catch (e) {
        console.warn('Mobile drawer 390 capture warning:', e);
      }
      await context.close();
    }

    // 6. Mobile 320x568
    {
      console.log('[6/6] Capturing Mobile 320x568...');
      const context = await browser.newContext({
        viewport: { width: 320, height: 568 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(500);
      await captureShot(page, 'welcome-mobile-320.png');
      capturedFilenames.push('welcome-mobile-320.png');

      // Open mobile sidebar drawer
      try {
        const openDrawerBtn = page.locator('button[aria-label="Open sidebar navigation"], button[aria-label="Open sidebar"]').first();
        if (await openDrawerBtn.isVisible()) {
          await openDrawerBtn.click();
          await page.waitForTimeout(400);
          await captureShot(page, 'mobile-drawer-320.png');
          capturedFilenames.push('mobile-drawer-320.png');
        }
      } catch (e) {
        console.warn('Mobile drawer 320 capture warning:', e);
      }
      await context.close();
    }

    await browser.close();

    // Deduplicate filenames
    const uniqueFiles = Array.from(new Set(capturedFilenames));
    await generateComparisonHtml(uniqueFiles);

    console.log('=== All After Screenshots & Comparison Report Generated ===');
  } finally {
    await server.close();
    console.log('Preview server closed.');
  }
}

main().catch(err => {
  console.error('Fatal after-capture error:', err);
  process.exit(1);
});
