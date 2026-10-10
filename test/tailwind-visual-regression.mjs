import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

// Deterministic UI fixtures only: this is not live provider/auth certification.
const baseline = path.resolve(process.argv[2] || '.visual-baseline/dist');
const candidate = path.resolve('dist');
const artifacts = path.resolve('test-results/tailwind-visual');
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
const failures = [];
const metrics = [];
async function capture(root, width, theme, filled) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
  try {
    await context.addInitScript(({ theme }) => {
      Math.random = () => 0.5;
      localStorage.setItem('aira_settings_v1', JSON.stringify({ theme, userName: 'Certification' }));
    }, { theme });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://visual.aira.test') return route.abort();
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Visual fixture: backend unavailable' }) });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep)) return route.abort();
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
      try { await route.fulfill({ body: await fs.readFile(file), contentType: types[path.extname(file)] || 'application/octet-stream' }); }
      catch { await route.abort(); }
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-10-10T12:00:00Z') });
    await page.goto('https://visual.aira.test', { waitUntil: 'networkidle' });
    const composer = page.locator('textarea').first();
    await composer.waitFor({ state: 'visible' });
    if (filled) await composer.fill('Verify accessible composition and the established Aira workspace layout.');
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.addStyleTag({ content: '*,::before,::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    assert.deepEqual(errors, [], 'UI must render without JavaScript errors');
    const geometry = await composer.boundingBox();
    assert.ok(geometry && geometry.width > 100 && geometry.y >= 0 && geometry.y + geometry.height <= 900, 'composer must remain usable in viewport');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'document must not overflow horizontally');
    return { screenshot: await page.screenshot({ animations: 'disabled' }), geometry };
  } finally { await context.close(); }
}
try {
  for (const width of [390, 1024, 1440]) for (const theme of ['light', 'dark']) for (const filled of [false, true]) {
    const name = `${width}-${theme}-${filled ? 'composer' : 'home'}`;
    const before = await capture(baseline, width, theme, filled);
    const after = await capture(candidate, width, theme, filled);
    const a = PNG.sync.read(before.screenshot), b = PNG.sync.read(after.screenshot);
    assert.equal(a.width, b.width); assert.equal(a.height, b.height);
    const diff = new PNG({ width: a.width, height: a.height });
    const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    const ratio = pixels / (a.width * a.height);
    await fs.writeFile(path.join(artifacts, `${name}-before.png`), before.screenshot);
    await fs.writeFile(path.join(artifacts, `${name}-after.png`), after.screenshot);
    await fs.writeFile(path.join(artifacts, `${name}-diff.png`), PNG.sync.write(diff));
    metrics.push({ name, ratio, before: before.geometry, after: after.geometry });
    if (ratio > 0.01) failures.push(`${name}: ${(ratio * 100).toFixed(3)}% pixels differ (maximum 1%)`);
    for (const key of ['x', 'y', 'width', 'height']) if (Math.abs(before.geometry[key] - after.geometry[key]) > 2) failures.push(`${name}: composer ${key} changed more than 2px`);
  }
  await fs.writeFile(path.join(artifacts, 'metrics.json'), JSON.stringify(metrics, null, 2));
  assert.deepEqual(failures, [], failures.join('\n'));
  console.log('PASS: 12 desktop/mobile light/dark visual comparisons');
} finally { await browser.close(); }
