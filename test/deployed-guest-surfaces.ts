import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

/** Read-only guest UI acceptance against exact deployed SHA, using real Edge. */
const url = new URL(process.env.AIRA_RESPONSIVE_URL || 'http://127.0.0.1:5173/');
const expectedSha = process.env.AIRA_EXPECTED_SHA || '';
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';
const directory = path.resolve(process.env.AIRA_SURFACE_EVIDENCE_DIR || 'artifacts/deployed-guest-surfaces');
assert(['https:', 'http:'].includes(url.protocol));
assert(url.protocol === 'https:' || ['localhost','127.0.0.1'].includes(url.hostname));
assert.match(expectedSha, /^[a-f0-9]{40}$/);
mkdirSync(directory, { recursive: true });

const viewports = [[320,568], [360,640], [375,812], [390,844], [414,896],
  [640,360], [768,1024], [1280,720], [1440,900], [1920,1080], [2560,1440]];
const results = [];
const errors = [];
let index = 0;
const persist = () => writeFileSync(path.join(directory, 'results.json'),
  JSON.stringify({ url: url.origin, expectedSha, browser: 'msedge',
    results, errors, excluded: ['Library (authenticated)', 'Agents (authenticated)',
      'Automations (authenticated)', 'Native browser-toolbar 200% zoom'] }, null, 2));
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const requestContext = await browser.newContext();
  const version = await requestContext.request.get(new URL('/api/version', url).toString(),
    { headers: bypass ? { 'x-vercel-protection-bypass': bypass } : {} });
  assert.equal(version.status(), 200, 'Exact deployed preview SHA endpoint unavailable');
  assert.equal((await version.json()).commitSha, expectedSha, 'Wrong deployed preview SHA');
  await requestContext.close();

  for (const [width,height] of viewports) for (const theme of ['light','dark']) {
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: 'reduce',
      colorScheme: theme
    });
    if (bypass) await context.route('**/*', route => {
      const destination = new URL(route.request().url());
      if (destination.origin !== url.origin) return route.continue();
      return route.continue({ headers: {
        ...route.request().headers(), 'x-vercel-protection-bypass': bypass
      } });
    });
    const page = await context.newPage();
    const jsErrors = [];
    page.on('pageerror', error => jsErrors.push(error.message));

    const record = async (surface, action) => {
      const item = { viewport: width + 'x' + height, theme, zoom: '100%',
        page: surface, result: 'PASS', screenshot: '', issue: '' };
      try {
        await action();
        const overflow = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth
        }));
        assert(overflow.documentWidth <= overflow.viewportWidth + 2,
          surface + ' overflows document horizontally: ' + JSON.stringify(overflow));
        if (jsErrors.length) throw new Error('JavaScript errors: ' + jsErrors.join(' | '));
      } catch (error) {
        item.result = 'FAIL';
        item.issue = String(error);
        errors.push(item.viewport + ' ' + theme + ' ' + surface + ': ' + item.issue);
      }
      const name = String(++index).padStart(3,'0') + '-' +
        surface.toLowerCase().replace(/[^a-z0-9]+/g,'-') + '-' +
        width + 'x' + height + '-' + theme + '.png';
      await page.screenshot({ path: path.join(directory,name),
        animations: 'disabled', timeout: 10000 }).then(() => {
        item.screenshot = name;
      }).catch(e => { item.issue += ' Screenshot: ' + String(e); item.result = 'FAIL'; });
      results.push(item);
      persist();
      console.log(item.result + ' ' + item.viewport + ' ' + theme + ' ' + surface +
        (item.issue ? ' ' + item.issue : ''));
    };

    try {
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.getByRole('textbox', { name: 'Message Aira' })
        .waitFor({ state: 'visible', timeout: 25000 });
      await page.evaluate(() => document.fonts.ready);
      await record('Greeting', async () => {
        const greeting = page.locator('.aira-editorial-greeting');
        assert(await greeting.isVisible(), 'Greeting not rendered');
        if (height <= 400) {
          const scroll = page.getByTestId('chat-scroll-region');
          const metrics = await scroll.evaluate(el => ({
            scrollHeight: el.scrollHeight, clientHeight: el.clientHeight
          }));
          assert(metrics.scrollHeight > metrics.clientHeight + 2,
            'Short-screen greeting cannot scroll: ' + JSON.stringify(metrics));
          await scroll.evaluate(el => el.scrollTop = el.scrollHeight);
        }
      });
      await record('Model selector', async () => {
        await page.getByTestId('model-selector-button').click();
        await page.getByRole('listbox', { name: 'Available Aira models' })
          .waitFor({ state: 'visible', timeout: 7000 });
      });
      await page.keyboard.press('Escape');
      await record('Artifact Studio', async () => {
        await page.getByTestId('artifact-studio-launcher').click();
        await page.getByTestId('unified-workspace')
          .waitFor({ state: 'visible', timeout: 9000 });
        const studio = await page.getByTestId('unified-workspace').boundingBox();
        assert(studio && studio.left >= -2 && studio.right <= width + 2,
          'Studio escapes horizontal viewport: ' + JSON.stringify(studio));
      });
      const closeWorkspace = page.getByTestId('workspace-close');
      if (await closeWorkspace.isVisible()) await closeWorkspace.click();
      await record('Sidebar', async () => {
        const open = page.getByRole('button',{ name: 'Open sidebar navigation' });
        if (await open.isVisible()) await open.click();
        await page.getByTestId('sidebar-drawer')
          .waitFor({ state: 'visible', timeout: 9000 });
      });
      await record('Projects', async () => {
        await page.getByRole('button', { name: /^Projects/ }).first().click();
        const dialog = page.getByRole('dialog', { name: 'Aira Projects' });
        await dialog.waitFor({ state: 'visible', timeout: 8000 });
        const box = await dialog.boundingBox();
        assert(box && box.x >= -2 && box.x + box.width <= width + 2 &&
          box.y >= -2 && box.y + box.height <= height + 2,
          'Projects dialog clipped: ' + JSON.stringify(box));
        const foreground = await dialog.evaluate(el => {
          const rect = el.getBoundingClientRect();
          const point = document.elementFromPoint(rect.left + rect.width / 2,
            rect.top + Math.min(rect.height / 2, 75));
          return Boolean(point && el.contains(point));
        });
        assert(foreground, 'Projects dialog is underneath a sidebar or another overlay');
      });
      const closeProjects = page.getByRole('button',{name:'Close projects'});
      if (await closeProjects.isVisible()) await closeProjects.click({ timeout: 3500 });
      const reopen = page.getByRole('button', { name: 'Open sidebar navigation' });
      if (await reopen.isVisible()) await reopen.click();
      await record('Settings', async () => {
        await page.getByRole('button', { name: 'Open settings' }).click();
        await page.getByRole('dialog', { name: 'Workspace Settings' })
          .waitFor({ state: 'visible', timeout: 9000 });
      });
      await page.keyboard.press('Escape');
      await record('Account menu', async () => {
        await page.getByTestId('account-button').click();
        await page.getByRole('menu', { name: 'Account and user settings menu' })
          .waitFor({ state: 'visible', timeout: 9000 });
        const menu = await page.getByRole('menu', { name: 'Account and user settings menu' }).boundingBox();
        assert(menu && menu.x >= -2 && menu.x + menu.width <= width + 2 &&
          menu.y >= -2 && menu.y + menu.height <= height + 2,
          'Account menu clipped: ' + JSON.stringify(menu));
      });
      await page.keyboard.press('Escape');
      if (width <= 414) await record('Long composer', async () => {
        const drawerClose = page.getByRole('button',{name:'Close sidebar navigation'});
        if (await drawerClose.isVisible()) await drawerClose.click();
        await page.getByRole('textbox', {name:'Message Aira'}).fill(
          'Long composer content to test wrapping and scrolling. '.repeat(35));
        const composer = await page.locator('.aira-composer-card').boundingBox();
        assert(composer && composer.x >= -2 && composer.x + composer.width <= width + 2 &&
          composer.y >= -2 && composer.y + composer.height <= height + 2,
          'Expanded composer is clipped: ' + JSON.stringify(composer));
      });
    } catch (error) {
      errors.push(width + 'x' + height + ' ' + theme + ' setup: ' + String(error));
      persist();
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  persist();
}
if (errors.length) throw new Error(errors.length + ' deployed guest-surface failures; evidence saved to ' + directory);
console.log('PASS Edge deployed guest-surface audit: ' + results.length + ' checks');
