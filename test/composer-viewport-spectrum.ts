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
      // Framer layout transitions can briefly retain the old viewport position.
      // Require the composer to settle back inside the new viewport promptly,
      // then assert its geometry below. This is not a relaxed size threshold.
      await page.waitForFunction(() => {
        const card = document.querySelector('.aira-composer-card');
        if (!card) return false;
        const bounds = card.getBoundingClientRect();
        return bounds.left >= -1 && bounds.right <= window.innerWidth + 1 &&
          bounds.bottom <= window.innerHeight + 1;
      }, undefined, { timeout: 1200 });
      for (const dark of [false, true]) {
        const theme = dark ? 'dark' : 'light';
        await page.evaluate(value => {
          document.documentElement.classList.toggle('dark', value);
          document.documentElement.dataset.theme = 'default';
        }, dark);
        const result = { width, height, theme, status: 'PASS', composerHeight: 0, message: '', file: '' };
        try {
          // String-evaluated browser JS prevents esbuild's injected __name helper
          // from leaking into a serialized Playwright page callback.
          const geometry = await page.evaluate(`(() => {
            const card = document.querySelector('.aira-composer-card');
            const rectangle = (selector) => {
              const element = document.querySelector(selector);
              if (!element) return null;
              const r = element.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
            };
            const greetingScroll = document.querySelector('[data-testid="chat-scroll-region"]');
            if (window.innerHeight <= 480 && greetingScroll) greetingScroll.scrollTop = 0;
            const box = card.getBoundingClientRect();
            return {
              height: card.offsetHeight,
              left: box.left, right: box.right, bottom: box.bottom,
              documentWidth: document.documentElement.scrollWidth,
              viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
              header: rectangle('.aira-editorial-header'),
              headerParts: {
                brand: rectangle('.aira-header-brand'),
                mode: rectangle('.aira-header-mode'),
                model: rectangle('[data-testid="model-selector-button"]'),
                actions: rectangle('.aira-header-actions'),
              },
              composerParts: {
                modes: rectangle('.aira-composer-mode-group'),
                send: rectangle('button[aria-label="Send message"]'),
              },
              greetingTop: rectangle('.aira-editorial-greeting .claude-fade-up')?.top,
              scrollTop: rectangle('[data-testid="chat-scroll-region"]')?.top,
            };
          })()`);
          result.composerHeight = geometry.height;
          assert.ok(geometry.left >= -1 && geometry.right <= width + 1, 'Composer escapes horizontal viewport');
          assert.ok(geometry.bottom <= height + 1, 'Composer escapes vertical viewport: ' + JSON.stringify(geometry));
          assert.ok(geometry.documentWidth <= width + 1, 'Root has horizontal scroll');
          if (width < 640) assert.ok(geometry.height <= 145,
            'Empty mobile composer exceeds 145px: ' + geometry.height);
          // A global no-horizontal-scroll assertion alone misses clipped and
          // interleaved flex children in an overflow-hidden header.
          const intersects = (a: {left:number;right:number;top:number;bottom:number},
                              b: {left:number;right:number;top:number;bottom:number}) =>
            Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          assert.ok(geometry.header, 'Application header missing');
          const parts = Object.entries(geometry.headerParts)
            .filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== null);
          for (let i = 0; i < parts.length; i++) {
            const [name, rect] = parts[i];
            assert.ok(rect.left >= -1 && rect.right <= width + 1,
              'Header ' + name + ' clipped at ' + width + ': ' + JSON.stringify(rect));
            for (let j = i + 1; j < parts.length; j++) {
              assert.ok(intersects(rect, parts[j][1]) < 1,
                'Header interleaving: ' + name + ' / ' + parts[j][0] + ' at ' + width +
                ': ' + JSON.stringify(geometry.headerParts));
            }
          }
          if (geometry.composerParts.modes && geometry.composerParts.send) {
            assert.ok(intersects(geometry.composerParts.modes, geometry.composerParts.send) < 1,
              'Composer mode toggle overlaps send button: ' + JSON.stringify(geometry.composerParts));
          }
          if (height <= 480 && geometry.greetingTop !== undefined && geometry.scrollTop !== undefined) {
            assert.ok(geometry.greetingTop >= geometry.scrollTop - 1,
              'Greeting clipped above scroll region in short landscape viewport');
          }

          const headerButtons = page.locator('.aira-editorial-header button:visible');
          for (const button of await headerButtons.all()) {
            const rect = await button.boundingBox();
            assert.ok(rect && rect.width >= 39.5 && rect.height >= 39.5,
              'Visible header button smaller than 40x40: ' + JSON.stringify(rect));
          }

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

    // Verify actual interactive overlays as well as their closed-state geometry.
    // Opening Studio here is read-only: no chat, billing or persisted data changes.
    for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1280, 720], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.getByTestId('model-selector-button').click();
      const menu = page.getByTestId('model-menu');
      await menu.waitFor({ state: 'visible' });
      const menuBox = await menu.boundingBox();
      assert.ok(menuBox && menuBox.x >= -1 && menuBox.x + menuBox.width <= width + 1,
        'Model dropdown escapes viewport at ' + width);
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      await page.getByTestId('artifact-studio-launcher').click();
      const studio = page.getByTestId('unified-workspace');
      await studio.waitFor({ state: 'visible' });
      const studioBox = await studio.boundingBox();
      assert.ok(studioBox && studioBox.x >= -1 && studioBox.x + studioBox.width <= width + 1,
        'Artifact Studio escapes viewport at ' + width);
      if (width >= 1280) {
        await studio.getByTitle('Expand width').click();
        await page.waitForTimeout(120);
        const intersections = await page.evaluate(() => {
          const selectors = ['.aira-header-brand', '.aira-header-mode',
            '[data-testid="model-selector-button"]', '.aira-header-actions'];
          const boxes = selectors.map(selector => document.querySelector(selector)?.getBoundingClientRect())
            .filter((rect): rect is DOMRect => Boolean(rect));
          const conflicts: string[] = [];
          for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const area = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
              Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            if (area > 1) conflicts.push(selectors[i] + ' and ' + selectors[j] + ': ' + area);
          }
          return conflicts;
        });
        const layoutDiagnostic = await page.evaluate(`(() => {
          const rect = (selector) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
              width: r.width, height: r.height, display: style.display, position: style.position };
          };
          return {
            main: rect('.aira-main-content'), header: rect('.aira-editorial-header'),
            brand: rect('.aira-header-brand'), mode: rect('.aira-header-mode'),
            model: rect('[data-testid="model-selector-button"]'),
            actions: rect('.aira-header-actions'), studio: rect('[data-testid="unified-workspace"]')
          };
        })()`);
        console.log('EXPANDED STUDIO GEOMETRY ' + width + ': ' + JSON.stringify(layoutDiagnostic));
        const evidenceFile = 'studio-expanded-' + width + 'x' + height + '.png';
        await page.screenshot({ path: path.join(evidenceDir, evidenceFile), fullPage: false, animations: 'disabled' });
        assert.deepEqual(intersections, [], 'Expanded Studio interleaves header controls at ' + width
          + ': ' + JSON.stringify(layoutDiagnostic));
      }
      const imageName = 'studio-open-' + width + 'x' + height + '.png';
      await page.screenshot({ path: path.join(evidenceDir, imageName), fullPage: false, animations: 'disabled' });
      await studio.getByTestId('workspace-close').click();
      await studio.waitFor({ state: 'hidden' });
      console.log('PASS interactive model menu and Studio layout at ' + width + 'x' + height);
    }

    // A long draft must grow and scroll within the available workspace height.
    await page.setViewportSize({ width: 390, height: 844 });
    await textarea.fill(('Long message and formatting details.\n').repeat(45));
    const longComposer = await composerCard.boundingBox();
    assert.ok(longComposer && longComposer.y >= -1 && longComposer.y + longComposer.height <= 845,
      'Multiline composer pushes controls outside mobile viewport');
    await page.screenshot({ path: path.join(evidenceDir, 'composer-long-draft-390x844.png'),
      fullPage: false, animations: 'disabled' });
    await textarea.fill('');
    console.log('PASS long-draft mobile composer containment');
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
