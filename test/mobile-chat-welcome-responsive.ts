import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const URL = process.env.AIRA_FRONTEND_TEST_URL || 'http://127.0.0.1:5173/';
const sizes = [[320, 568], [390, 844], [430, 932], [640, 360], [820, 1180], [1440, 900]];
const presets = ['default', 'warm-parchment', 'liquid-glass', 'linear-precision',
  'industrial-brutalist', 'nordic-moss', 'nordic-earth', 'solar-gold', 'tokyo-neon', 'vanguard-monolith'];

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    for (const [width, height] of sizes) {
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
      await context.addInitScript(() => {
        if (sessionStorage.getItem('frontend-fixture')) return;
        sessionStorage.setItem('frontend-fixture', '1');
        const now = Date.now();
        const conversation = {
          id: 'preserved-history', title: 'Preserved frontend history', createdAt: now, updatedAt: now,
          messages: [{ id: 'saved-reply', role: 'assistant', timestamp: now,
            content: 'Saved response.\n\nSecond paragraph.\n\n- First item\n- Second item\n\n> Quotation\n\n| Column | Value |\n|---|---|\n| Test | $x^2$ |\n\n```js\nconst value = 1;\n```' }],
        };
        localStorage.setItem('aira_conversations_v1', JSON.stringify([conversation]));
        localStorage.setItem('aira_active_chat_id_v1', conversation.id);
        localStorage.setItem('aira_settings_v1', JSON.stringify({ theme: 'light', aestheticPreset: 'default' }));
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(URL);
      await page.locator('main textarea').waitFor();
      assert.equal(await page.locator('.aira-prose').count(), 0, 'Root must show welcome, not saved messages');
      assert.equal(await page.locator('main textarea').inputValue(), '');
      const history = await page.evaluate(() => localStorage.getItem('aira_conversations_v1'));
      const openHistory = async () => {
        if (width < 1280) await page.getByRole('button', { name: 'Open sidebar navigation' }).click();
        await page.getByRole('complementary').getByText('Preserved frontend history', { exact: true }).click();
        await page.locator('.aira-prose').waitFor();
      };
      await openHistory();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      assert.match(await page.locator('.aira-prose').innerText(), /Saved response/);
      assert.equal(await page.locator('.aira-prose table').count(), 1);
      assert.equal(await page.locator('.aira-prose pre code').count(), 1);
      assert.equal(await page.locator('.aira-prose blockquote').count(), 1);
      assert.equal(await page.locator('.aira-prose li').count(), 2);
      if (width < 640) {
        const reading = await page.locator('.aira-prose').evaluate(el => {
          const css = getComputedStyle(el);
          return { left: el.getBoundingClientRect().left, line: parseFloat(css.lineHeight) / parseFloat(css.fontSize) };
        });
        assert(reading.left <= 24, 'Mobile reply retains excessive avatar indentation');
        assert(reading.line <= 1.56, 'Mobile prose line spacing is excessive');
        // Measure layout height, independent of the preserved Framer layout transition.
        const composer = await page.locator('main textarea').evaluate(el => ({
          height: (el.parentElement as HTMLElement).offsetHeight,
          textarea: (el as HTMLElement).offsetHeight,
        }));
        assert(composer.height <= 145, `Empty mobile composer is too tall: ${JSON.stringify(composer)}`);
      }
      for (let visit = 0; visit < 2; visit++) {
        await page.reload();
        await page.locator('main textarea').waitFor();
        assert.equal(await page.locator('.aira-prose').count(), 0);
        assert.equal(await page.evaluate(() => localStorage.getItem('aira_conversations_v1')), history,
          'Reload changes history or creates an empty conversation');
      }
      await openHistory();

      const trigger = page.locator('[aria-haspopup="listbox"]');
      const menu = page.getByTestId('model-menu');
      for (const preset of presets) {
        for (const dark of [false, true]) {
          // Isolated DOM theme fixture exercises actual CSS, including translucent themes.
          await page.evaluate(({ preset, dark }) => {
            document.documentElement.dataset.theme = preset;
            document.documentElement.classList.toggle('dark', dark);
          }, { preset, dark });
          await trigger.click();
          await menu.waitFor();
          await page.waitForFunction(() => {
            const menu = document.querySelector('[data-testid="model-menu"]');
            return menu && getComputedStyle(menu).opacity === '1';
          });
          const geometry = await menu.evaluate(el => {
            const box = el.getBoundingClientRect();
            const css = getComputedStyle(el);
            return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
              background: css.backgroundColor, overflow: css.overflowY, scroll: el.scrollHeight, height: el.clientHeight };
          });
          assert(geometry.left >= 0 && geometry.right <= width + 1 && geometry.bottom <= height + 1 && geometry.top >= 0,
            `${preset}: menu leaves viewport: ${JSON.stringify(geometry)}`);
          assert(!geometry.background.includes('rgba') && geometry.background !== 'transparent', `${preset}: menu is translucent`);
          assert.equal(geometry.overflow, 'auto');
          if (height <= 568) assert(geometry.scroll > geometry.height, 'Short menu has no internal scroll range');
          const options = menu.getByRole('option');
          await options.first().focus();
          await page.keyboard.press('End');
          assert(await options.last().evaluate(el => el === document.activeElement));
          const last = await options.last().evaluate(el => {
            const row = el.getBoundingClientRect();
            const menu = el.closest('[data-testid="model-menu"]')!.getBoundingClientRect();
            return { rowTop: row.top, rowBottom: row.bottom, menuTop: menu.top, menuBottom: menu.bottom };
          });
          assert(last.rowTop >= last.menuTop - 1 && last.rowBottom <= last.menuBottom + 1,
            `Last model is unreachable: ${width}x${height} ${preset} dark=${dark} ${JSON.stringify(last)}`);
          await page.keyboard.press('Escape');
          await menu.waitFor({ state: 'hidden' });
          assert(await trigger.evaluate(el => el === document.activeElement), 'Escape does not return focus');
        }
      }
      await trigger.click();
      await page.setViewportSize({ width, height: 220 });
      await page.waitForFunction(() => {
        const box = document.querySelector('[data-testid="model-menu"]')?.getBoundingClientRect();
        return !!box && box.bottom <= window.innerHeight + 1;
      });
      await page.locator('header').click({ position: { x: 5, y: 5 } });
      await menu.waitFor({ state: 'hidden' });
      await page.setViewportSize({ width, height });
      await trigger.click();
      await menu.getByRole('option', { name: /Aira Fast/ }).click();
      await menu.waitFor({ state: 'hidden' });
      assert.match(await trigger.innerText(), /Aira Fast/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      assert.deepEqual(errors, []);
      console.log(`PASS welcome/history, compact chat, model menu themes/keyboard/resize ${width}x${height}`);
      await context.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exit(1); });
