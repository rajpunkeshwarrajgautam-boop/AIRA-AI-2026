import { chromium } from 'playwright';

async function runE2E() {
  process.stdout.write('Starting Playwright E2E UI Verification...\n');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigate to frontend
    process.stdout.write('Navigating to http://localhost:5173/...\n');
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 15000 });

    // Verify Title or header elements
    const title = await page.title();
    process.stdout.write(`Page Title: "${title}"\n`);

    // Verify main interactive elements
    const textarea = page.locator('textarea');
    await textarea.waitFor({ state: 'visible', timeout: 5000 });
    process.stdout.write('Verified: Chat input textarea is visible.\n');

    // Type a prompt and submit
    const mathPrompt = String.raw`Display \[n_s = \frac{120f}{P}\] and inline $s=\frac{n_s-n_r}{n_s}$`;
    await textarea.fill(mathPrompt);
    await page.keyboard.press('Enter');

    // Wait for message rendering
    await page.waitForTimeout(2000);
    process.stdout.write('Verified: Message submitted successfully and processed.\n');
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('.aira-prose')).some(el =>
        el.textContent?.includes('Display') &&
        el.querySelector('.aira-math-embedded .katex-display')
      );
    }, undefined, { timeout: 10000 });
    process.stdout.write('Verified: embedded display math rendered in user message.\n');

    process.stdout.write('\nPLAYWRIGHT E2E UI VERIFICATION PASSED.\n');
  } catch (err: any) {
    process.stderr.write(`E2E test error: ${err.message}\n`);
    throw err;
  } finally {
    await browser.close();
  }
}

runE2E().catch(err => {
  process.stderr.write(`E2E failure: ${err}\n`);
  process.exit(1);
});
