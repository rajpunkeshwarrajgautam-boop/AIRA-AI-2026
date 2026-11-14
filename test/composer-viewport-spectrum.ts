import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

/**
 * Read-only Edge visual acceptance, across real CSS breakpoint transitions.
 * Uses a fresh guest page; never starts a chat, opens billing or writes data.
 * Screenshots & a JSON matrix are uploaded as CI workflow artifacts.
 */
const baseUrl = process.env.AIRA_RESPONSIVE_URL || process.env.AIRA_FRONTEND_TEST_URL || 'http://127.0.0.1:5173/';
const url = new URL(baseUrl);
const isProduction = url.hostname === 'aira-ai-2026.vercel.app';
if (isProduction && process.env.AIRA_ALLOW_PRODUCTION_READONLY !== '1') {
  throw new Error('Production read-only browser acceptance needs explicit AIRA_ALLOW_PRODUCTION_READONLY=1');
}
if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
  throw new Error('Refusing untrusted visual acceptance origin');
}
const expectedSha = process.env.AIRA_EXPECTED_SHA || '';
const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';
const evidenceDir = path.resolve(process.env.AIRA_RESPONSIVE_EVIDENCE_DIR || 'artifacts/responsive-viewport-spectrum/local');
mkdirSync(evidenceDir, { recursive: true });

const viewports = [
  [320, 568], [360, 640], [375, 812], [390, 844], [414, 896],
  [430, 932], [527, 733], [640, 360], [768, 1024], [820, 1180],
  [911, 701], [1024, 768], [1280, 720], [1440, 900], [1537, 861],
  [1600, 900], [1920, 1080], [2560, 1440],
] as const;

const channel = process.env.PLAYWRIGHT_CHANNEL || 'msedge';
let browser;
try {
  browser = await chromium.launch({ headless: true, channel });
} catch (error) {
  console.warn('Edge unavailable, running Chromium fallback: ' + String(error));
  browser = await chromium.launch({ headless: true });
}
const results: Array<{ width: number; height: number; theme: string; status: string; composerHeight?: number; message?: string; file?: string }> = [];
const failures: string[] = [];
const persist = () => writeFileSync(path.join(evidenceDir, 'results.json'),
  JSON.stringify({ baseUrl: url.origin, expectedSha, results, failures }, null, 2) + '\n');

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  if (secret) {
    await context.route('**/*', route => {
      const target = new URL(route.request().url());
      if (target.origin === url.origin) {
        return route.continue({ headers: {
          ...route.request().headers(),
          'x-vercel-protection-bypass': secret,
        } });
      }
      return route.continue();
    });
  }
  const page = await context.newPage();
  try {
    if (expectedSha) {
      assert.match(expectedSha, /^[a-f0-9]{40}$/);
      const response = await page.request.get(new URL('/api/version', url).toString(), {
        headers: secret ? { 'x-vercel-protection-bypass': secret } : {},
      });
      assert.equal(response.status(), 200, 'Deployed version API must be accessible');
      const version = await response.json();
      assert.equal(version.commitSha, expectedSha, 'Live deploy SHA must match exact Git SHA');
    }
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const textarea = page.getByRole('textbox', { name: 'Message Aira' });
    await textarea.waitFor({ state: 'visible', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const composerCard = page.locator('.aira-composer-card');
    const group = page.getByRole('group', { name: 'Execution Mode' });
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      for (const dark of [false, true]) {
        const theme = dark ? 'dark' : 'light';
        await page.evaluate(value => {
          document.documentElement.classList.toggle('dark', value);
          document.documentElement.dataset.theme = 'default';
        }, dark);
        const result = { width, height, theme, status: 'PASS', composerHeight: 0, message: '', file: '' };
        try {
          const geometry = await page.evaluate(() => {
            const card = document.querySelector('.aira-composer-card') as HTMLElement;
            const box = card.getBoundingClientRect();
            return {
              height: card.offsetHeight,
              left: box.left, right: box.right, bottom: box.bottom,
              documentWidth: document.documentElement.scrollWidth,
              viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
            };
          });
          result.composerHeight = geometry.height;
          assert.ok(geometry.left >= -1 && geometry.right <= width + 1, 'Composer escapes horizontal viewport');
          assert.ok(geometry.bottom <= height + 1, 'Composer escapes vertical viewport');
          assert.ok(geometry.documentWidth <= width + 1, 'Root has horizontal scroll');
          if (width < 640) assert.ok(geometry.height <= 145,
            'Empty mobile composer exceeds 145px: ' + geometry.height);

          const targets = [
            page.getByRole('button', { name: 'Attach documents or images' }),
            group.getByRole('button', { name: /^Chat/ }),
            group.getByRole('button', { name: /^Agent/ }),
            page.getByRole('button', { name: 'Send message' }),
          ];
          if (width >= 640) targets.push(page.getByRole('button', { name: /^Normal/ }));
          for (const button of targets) {
            const rect = await button.boundingBox();
            assert.ok(rect, 'Required composer control is missing');
            assert.ok(rect.width >= 39.5 && rect.height >= 39.5,
              'Composer control hit target is smaller than 40x40: ' + JSON.stringify(rect));
            assert.ok(rect.x >= -1 && rect.x + rect.width <= width + 1,
              'Composer control lies outside viewport');
          }
          const imageName = 'composer-' + width + 'x' + height + '-' + theme + '.png';
          await page.screenshot({ path: path.join(evidenceDir, imageName), fullPage: false, animations: 'disabled' });
          result.file = imageName;
          console.log('PASS ' + width + 'x' + height + ' ' + theme + ': composer=' + geometry.height + 'px, targets>=40px');
        } catch (error) {
          result.status = 'FAIL';
          result.message = String(error);
          failures.push(width + 'x' + height + ' ' + theme + ': ' + String(error));
          console.error('FAIL ' + failures[failures.length - 1]);
          const imageName = 'failed-' + width + 'x' + height + '-' + theme + '.png';
          await page.screenshot({ path: path.join(evidenceDir, imageName), fullPage: false }).catch(() => undefined);
          result.file = imageName;
        }
        results.push(result);
        persist();
      }
    }
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}
if (failures.length) {
  throw new Error(failures.length + ' / ' + results.length + ' viewport/theme checks failed; evidence retained');
}
console.log('PASS responsive viewport spectrum: ' + results.length + ' desktop/mobile/tablet/theme cases, evidence in ' + evidenceDir);
