import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const widths = [320, 360, 375, 390, 430, 640, 768, 1024, 1280, 1440, 1920, 2560];
const processOutput: string[] = [];

async function waitForVite(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Vite did not start: ${processOutput.slice(-15).join(' ')}`);
}

async function main() {
  await mkdir('artifacts/workspace-v3-ui', { recursive: true });
  const child: ChildProcess = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    env: { ...process.env, VITE_ADAPTIVE_STUDIO_PREVIEW: 'true' },
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', chunk => processOutput.push(String(chunk)));
  child.stderr?.on('data', chunk => processOutput.push(String(chunk)));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForVite();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="chat-scroll-region"]', { timeout: 20000 });
    if (await page.locator('.aira-adaptive-mode-toggle').count()) {
      throw new Error('Duplicate header mode selector must not appear in Workspace V3');
    }
    if (await page.locator('.aira-composer [aria-label="Execution Mode"] button').count() !== 2) {
      throw new Error('Both Chat and Agent controls must remain available in the composer');
    }
    if (await page.locator('[data-testid="aira-v3-header-context"]').count() !== 1) {
      throw new Error('Conversation context must replace the duplicate header switch');
    }
    const lightSidebarBackground = await page.locator('.aira-sidebar-shell').first()
      .evaluate(element => getComputedStyle(element).backgroundColor);
    for (const width of widths) {
      await page.setViewportSize({ width, height: width <= 430 ? 740 : 900 });
      await page.waitForTimeout(200);
      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        composer: document.querySelector('.aira-composer')?.getBoundingClientRect().toJSON(),
        feed: document.querySelector('[data-testid="chat-scroll-region"]')?.getBoundingClientRect().toJSON(),
        mark: document.querySelector('.aira-v3-intro-mark')?.getBoundingClientRect().toJSON(),
        tones: document.querySelector('.aira-v3-intro-tones')?.getBoundingClientRect().toJSON(),
      }));
      if (!geometry.composer || !geometry.feed) throw new Error(`Composer/feed absent at ${width}px`);
      if (geometry.overflow > 2) throw new Error(`Horizontal overflow ${geometry.overflow}px at ${width}px`);
      if (geometry.composer.width > width + 1 || geometry.composer.x < -1) throw new Error(`Composer clipped at ${width}px`);
      if (width <= 359) {
        const textarea = await page.locator('textarea[aria-label="Message Aira"]').evaluate(element => {
          const input = element as HTMLTextAreaElement;
          return { clientHeight: input.clientHeight, scrollHeight: input.scrollHeight };
        });
        if (textarea.scrollHeight > textarea.clientHeight + 2) {
          throw new Error(`Composer placeholder is vertically clipped at ${width}px: ${JSON.stringify(textarea)}`);
        }
      }
      if (width <= 359 && geometry.mark && geometry.tones) {
        if (geometry.mark.top < geometry.feed.top - 1 || geometry.tones.bottom > geometry.feed.bottom + 1) {
          throw new Error(`Intro mark or tone selector clipped at ${width}px: ${JSON.stringify(geometry)}`);
        }
      }
      const controls = await page.locator('.aira-composer button:visible').evaluateAll(elements =>
        elements.map(element => {
          const rect = element.getBoundingClientRect();
          return { label: element.getAttribute('aria-label') || element.textContent?.trim() || 'button', w: rect.width, h: rect.height };
        }));
      const invalid = controls.filter(control => control.w < 39.5 || control.h < 39.5);
      if (invalid.length) throw new Error(`Composer touch targets below 40px at ${width}px: ${JSON.stringify(invalid)}`);
      await page.screenshot({ path: `artifacts/workspace-v3-ui/${width}-light.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    const darkSidebarBackground = await page.locator('.aira-sidebar-shell').first()
      .evaluate(element => getComputedStyle(element).backgroundColor);
    if (lightSidebarBackground === darkSidebarBackground) {
      throw new Error('Desktop sidebar background did not respond to dark mode');
    }
    await page.screenshot({ path: 'artifacts/workspace-v3-ui/1440-dark.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 740 });
    await page.screenshot({ path: 'artifacts/workspace-v3-ui/390-dark.png', fullPage: true });
    console.log(`Workspace V3 responsive smoke: ${widths.length} widths, reduced-motion and dark-mode capture passed`);
    await page.close();
  } finally {
    await browser?.close();
    child.kill('SIGTERM');
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
