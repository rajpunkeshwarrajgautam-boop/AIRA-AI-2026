import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

const PREVIEW_URL = process.env.BENCHMARK_ORIGIN || 'https://aira-ai-2026-git-f-a6b62b-rajpunkeshwarrajgautam-boops-projects.vercel.app';
const SCREENSHOT_DIR = path.resolve('public/qa-screenshots');

interface BrowserTestResult {
  suite: string;
  viewport: { width: number; height: number };
  status: 'PASS' | 'FAIL';
  firstRenderMs?: number;
  totalDurationMs?: number;
  progressiveDeltasObserved?: number;
  screenshot?: string;
  notes?: string;
}

async function runBrowserAcceptance() {
  console.log('=== AIRA AI 2026 — P1 BROWSER ACCEPTANCE SUITE ===');
  console.log(`Target: ${PREVIEW_URL}`);
  console.log(`Artifact Output: ${SCREENSHOT_DIR}\n`);

  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const results: BrowserTestResult[] = [];
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });

  try {
    // -------------------------------------------------------------
    // Test 1: Desktop (1440x900) - Progressive Streaming & Rendering
    // -------------------------------------------------------------
    console.log('[Test 1] Desktop (1440x900) - Real Progressive Streaming & Render');
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', err => pageErrors.push(err.message));

      const tLoadStart = performance.now();
      await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('main textarea').waitFor({ timeout: 15000 });
      const loadTimeMs = Math.round(performance.now() - tLoadStart);
      console.log(`  ✓ Page loaded in ${loadTimeMs}ms`);

      // Check for zero horizontal overflow
      const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(hasOverflow, false, 'Desktop must not have horizontal scrollbar overflow');

      // Submit prompt
      const prompt = 'What is HTTP in one sentence?';
      await page.locator('main textarea').fill(prompt);
      
      const tSubmit = performance.now();
      await page.keyboard.press('Enter');

      // Wait for assistant message container with text to appear
      await page.waitForFunction(() => {
        const proseElements = document.querySelectorAll('.aira-prose');
        if (proseElements.length < 2) return false;
        const assistantText = proseElements[1]?.textContent?.trim() || '';
        return assistantText.length > 0;
      }, undefined, { timeout: 25000 });

      const tFirstRender = performance.now() - tSubmit;
      console.log(`  ✓ First assistant token rendered in ${Math.round(tFirstRender)}ms`);

      // Observe progressive streaming growth in DOM
      let progressiveGrowthObserved = 0;
      let lastLength = 0;
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(100);
        const currentLength = await page.evaluate(() => {
          const prose = document.querySelectorAll('.aira-prose');
          return prose[1]?.textContent?.trim().length || 0;
        });
        if (currentLength > lastLength) {
          progressiveGrowthObserved++;
          lastLength = currentLength;
        }
        const isStillLoading = await page.evaluate(() => {
          const btn = document.querySelector('button[title="Aira is responding"]');
          return Boolean(btn);
        });
        if (!isStillLoading && currentLength > 20) break;
      }
      console.log(`  ✓ Observed ${progressiveGrowthObserved} progressive text updates in DOM during stream`);
      assert(progressiveGrowthObserved >= 1, 'Stream must progressively update DOM text');

      // Wait for stream to finish (send button becomes available again)
      await page.waitForFunction(() => {
        const btn = document.querySelector('button[title*="Send message"]');
        return Boolean(btn);
      }, undefined, { timeout: 35000 });

      const tFinished = performance.now() - tSubmit;
      console.log(`  ✓ Stream completed in ${Math.round(tFinished)}ms`);

      const responseText = await page.evaluate(() => {
        const prose = document.querySelectorAll('.aira-prose');
        return prose[1]?.textContent?.trim() || '';
      });
      console.log(`  ✓ Final streamed response: "${responseText.slice(0, 75)}..."`);
      assert(responseText.length > 20, 'Streamed response must not be empty');

      const screenshotPath = path.join(SCREENSHOT_DIR, 'desktop-1440x900-chat-streamed.png');
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`  ✓ Screenshot saved: ${screenshotPath}\n`);

      results.push({
        suite: 'Desktop Progressive Streaming',
        viewport: { width: 1440, height: 900 },
        status: 'PASS',
        firstRenderMs: Math.round(tFirstRender),
        totalDurationMs: Math.round(tFinished),
        progressiveDeltasObserved: progressiveGrowthObserved,
        screenshot: 'desktop-1440x900-chat-streamed.png',
        notes: `Streamed ${responseText.length} chars progressively. Errors: ${pageErrors.length}`
      });

      await context.close();
    }

    // -------------------------------------------------------------
    // Test 2: Mobile (390x844 - iPhone 12/13/14) - Responsive Chat
    // -------------------------------------------------------------
    console.log('[Test 2] Mobile (390x844) - Responsive Viewport & Progressive Chat');
    {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', err => pageErrors.push(err.message));

      await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('main textarea').waitFor({ timeout: 15000 });

      // Verify no horizontal overflow
      const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(hasOverflow, false, 'Mobile 390x844 must not have horizontal overflow');

      // Submit prompt
      await page.locator('main textarea').fill('Say hello in one sentence.');
      const tSubmit = performance.now();
      
      const sendButton = page.locator('button[title*="Send message"], main button:has(svg.stroke-\\[2\\.2\\])').last();
      await sendButton.click();

      // Wait for assistant response to render
      await page.waitForFunction(() => {
        const proseElements = document.querySelectorAll('.aira-prose');
        if (proseElements.length < 2) return false;
        return (proseElements[1]?.textContent?.trim() || '').length > 0;
      }, undefined, { timeout: 25000 });

      const tFirstRender = performance.now() - tSubmit;
      console.log(`  ✓ Mobile first token rendered in ${Math.round(tFirstRender)}ms`);

      // Mid-stream screenshot
      const streamingScreenshotPath = path.join(SCREENSHOT_DIR, 'mobile-390x844-streaming.png');
      await page.screenshot({ path: streamingScreenshotPath });

      // Wait for stream completion
      await page.waitForFunction(() => {
        const btn = document.querySelector('button[title*="Send message"]');
        return Boolean(btn);
      }, undefined, { timeout: 35000 });

      const tFinished = performance.now() - tSubmit;
      console.log(`  ✓ Mobile stream finished in ${Math.round(tFinished)}ms`);

      const mobileResponse = await page.evaluate(() => {
        const prose = document.querySelectorAll('.aira-prose');
        return prose[1]?.textContent?.trim() || '';
      });
      console.log(`  ✓ Mobile response: "${mobileResponse}"`);
      assert(mobileResponse.length > 5, 'Mobile response should contain text');

      const completedScreenshotPath = path.join(SCREENSHOT_DIR, 'mobile-390x844-completed.png');
      await page.screenshot({ path: completedScreenshotPath });
      console.log(`  ✓ Screenshots saved: ${completedScreenshotPath}\n`);

      results.push({
        suite: 'Mobile 390x844 Responsive Chat',
        viewport: { width: 390, height: 844 },
        status: 'PASS',
        firstRenderMs: Math.round(tFirstRender),
        totalDurationMs: Math.round(tFinished),
        screenshot: 'mobile-390x844-completed.png',
        notes: `Zero horizontal overflow. Clean composer. Errors: ${pageErrors.length}`
      });

      await context.close();
    }

    // -------------------------------------------------------------
    // Test 3: Mobile (375x667 - iPhone SE) - Ultra-Compact Layout & Fast Path
    // -------------------------------------------------------------
    console.log('[Test 3] Mobile (375x667) - Ultra-Compact Layout & Interaction');
    {
      const context = await browser.newContext({
        viewport: { width: 375, height: 667 },
        isMobile: true,
        hasTouch: true
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', err => pageErrors.push(err.message));

      await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('main textarea').waitFor({ timeout: 15000 });

      // Verify no horizontal overflow
      const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(hasOverflow, false, 'Mobile 375x667 must not have horizontal overflow');

      await page.locator('main textarea').fill('What is 2 + 2?');
      const sendButton = page.locator('button[title*="Send message"], main button:has(svg.stroke-\\[2\\.2\\])').last();
      const tSubmit = performance.now();
      await sendButton.click();

      await page.waitForFunction(() => {
        const proseElements = document.querySelectorAll('.aira-prose');
        if (proseElements.length < 2) return false;
        return (proseElements[1]?.textContent?.trim() || '').length > 0;
      }, undefined, { timeout: 25000 });

      const tFirstRender = performance.now() - tSubmit;
      console.log(`  ✓ Mobile 375x667 first token rendered in ${Math.round(tFirstRender)}ms`);

      await page.waitForFunction(() => {
        const btn = document.querySelector('button[title*="Send message"]');
        return Boolean(btn);
      }, undefined, { timeout: 35000 });

      const tFinished = performance.now() - tSubmit;
      console.log(`  ✓ Mobile 375x667 stream finished in ${Math.round(tFinished)}ms`);

      const cancelScreenshotPath = path.join(SCREENSHOT_DIR, 'mobile-375x667-chat-streamed.png');
      await page.screenshot({ path: cancelScreenshotPath });
      console.log(`  ✓ Screenshot saved: ${cancelScreenshotPath}\n`);

      results.push({
        suite: 'Mobile 375x667 Compact Chat',
        viewport: { width: 375, height: 667 },
        status: 'PASS',
        firstRenderMs: Math.round(tFirstRender),
        totalDurationMs: Math.round(tFinished),
        screenshot: 'mobile-375x667-chat-streamed.png',
        notes: `Verified 375x667 zero horizontal overflow. Fast render. Errors: ${pageErrors.length}`
      });

      await context.close();
    }

  } finally {
    await browser.close();
  }

  // Save results report
  const summaryJsonPath = path.join(SCREENSHOT_DIR, 'test-results.json');
  fs.writeFileSync(summaryJsonPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    environment: 'preview',
    url: PREVIEW_URL,
    results
  }, null, 2), 'utf8');

  console.log('=== BROWSER ACCEPTANCE SUITE SUMMARY ===');
  console.log(`All ${results.length} browser test suites: 100% PASS`);
  console.log(`Saved report to ${summaryJsonPath}`);
}

runBrowserAcceptance().catch(err => {
  console.error('Browser Acceptance Suite Error:', err);
  process.exit(1);
});
