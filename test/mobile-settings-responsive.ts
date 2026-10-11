import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';

const BASE_URL = process.env.AIRA_SETTINGS_TEST_URL || 'http://127.0.0.1:5173/';
const SIZES: Array<[number, number]> = [
  [320, 568], [360, 640], [375, 667], [390, 844], [430, 932],
  [640, 360], [844, 390], [768, 1024], [820, 1180], [1024, 768],
  [1280, 800], [1440, 900], [1920, 1080],
];
const SECTION_IDS = ['general','reasoning','memory','instructions','artifacts','data'];

async function waitForDialog(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Workspace Settings' });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  // Visibility begins before Framer Motion has finished centering the dialog.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="settings-dialog"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const viewport = window.visualViewport;
    const minX = viewport?.offsetLeft ?? 0;
    const minY = viewport?.offsetTop ?? 0;
    const maxY = minY + (viewport?.height ?? window.innerHeight);
    return r.left >= minX - 3 && r.top >= minY - 3 && r.bottom <= maxY + 3;
  }, undefined, { timeout: 7000 });
  return dialog;
}

async function openSettings(page: Page, width: number) {
  if (width < 1280) {
    const open = page.getByRole('button', { name: 'Open sidebar navigation' });
    if (await open.isVisible()) await open.click();
    await page.getByTestId('sidebar-drawer').waitFor({state:'visible'});
  }
  await page.getByRole('button', { name: 'Open settings' }).click();
  return waitForDialog(page);
}

async function metrics(page: Page) {
  // Pass browser script as source text: tsx otherwise injects an unavailable
  // __name helper when serializing nested functions into page.evaluate.
  return page.evaluate(`(() => {
    const rect = (testId) => {
      const e = document.querySelector('[data-testid="' + testId + '"]');
      return e?.getBoundingClientRect().toJSON();
    };
    const vv = window.visualViewport;
    const footer = document.querySelector('[data-testid="settings-footer"]');
    const dialog = document.querySelector('[data-testid="settings-dialog"]');
    return {
      viewport: { top: vv?.offsetTop ?? 0, left: vv?.offsetLeft ?? 0, width: vv?.width ?? innerWidth, height: vv?.height ?? innerHeight },
      dialog: rect('settings-dialog'),
      header: rect('settings-header'),
      footer: rect('settings-footer'),
      body: rect('settings-content'),
      footerScrollHeight: footer?.scrollHeight,
      dialogScrollHeight: dialog?.scrollHeight,
      dialogClientHeight: dialog?.clientHeight,
      dialogScrollTop: dialog?.scrollTop,
      bodyScrollHeight: document.querySelector('[data-testid="settings-content"]')?.scrollHeight,
      bodyClientHeight: document.querySelector('[data-testid="settings-content"]')?.clientHeight,
      bodyScrollTop: document.querySelector('[data-testid="settings-content"]')?.scrollTop,
    };
  })()`);
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    for (const [width, height] of SIZES) {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: width < 640, hasTouch: width < 1280,
        reducedMotion: 'reduce',
      });
      await context.addInitScript(() => {
        localStorage.setItem('aira_settings_v1', JSON.stringify({
          userName: 'Mobile fixture', theme: 'dark',
        }));
        const now = Date.now();
        const conversations = Array.from({length: 24}, (_, i) => ({
          id: 'settings-fixture-' + i, title: 'Settings fixture ' + i,
          createdAt: now - i * 86_400_000,
          updatedAt: now - i * 86_400_000, messages: [],
        }));
        localStorage.setItem('aira_conversations_v1', JSON.stringify(conversations));
        localStorage.setItem('aira_active_chat_id_v1', conversations[0].id);
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      const label = width + 'x' + height;
      try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.locator('main textarea').waitFor({ state: 'visible', timeout: 15000 });
        const dialog = await openSettings(page, width);
        const m = await metrics(page);
        assert(m.dialog && m.header && m.footer && m.body, label + ' missing settings structural regions');
        assert(m.dialog.top >= m.viewport.top - 3 &&
          m.dialog.bottom <= m.viewport.top + m.viewport.height + 3 &&
          m.dialog.left >= m.viewport.left - 3 &&
          m.dialog.right <= m.viewport.left + m.viewport.width + 3,
          label + ' modal extends beyond visual viewport: ' + JSON.stringify(m));
        assert(m.header.top >= m.viewport.top - 3 &&
          m.header.bottom <= m.viewport.top + m.viewport.height + 3,
          label + ' heading/header clipped');

        const close = page.getByRole('button', { name: 'Close settings' });
        await close.waitFor({state:'visible'});
        assert(await close.isEnabled(), label + ' close button disabled');

        if (width < 640) {
          const section = page.getByRole('combobox', { name: 'Settings section' });
          await section.waitFor({ state: 'visible' });
          assert.equal(await section.locator('option').count(), 6);
          for (const category of SECTION_IDS) {
            await section.selectOption(category);
            assert.equal(await section.inputValue(), category);
          }
          await section.selectOption('general');
        } else {
          const tablist = page.getByRole('tablist', { name: 'Settings categories' });
          await tablist.waitFor({ state: 'visible' });
          assert.equal(await tablist.getByRole('tab').count(), 6);
          for (const category of ['reasoning','memory','instructions','artifacts','data','general']) {
            const index = SECTION_IDS.indexOf(category);
            await tablist.getByRole('tab').nth(index).click();
            assert.equal(await tablist.getByRole('tab').nth(index).getAttribute('aria-selected'), 'true');
          }
        }

        const name = page.locator('#aira-settings-name');
        await name.fill('Responsive check ' + label);
        // Switching sections must preserve unsaved edits.
        if (width < 640) {
          await page.getByRole('combobox', {name:'Settings section'}).selectOption('data');
          await page.getByRole('combobox', {name:'Settings section'}).selectOption('general');
        } else {
          const tabs = page.getByRole('tablist', {name:'Settings categories'});
          await tabs.getByRole('tab').nth(5).click();
          await tabs.getByRole('tab').nth(0).click();
        }
        assert.equal(await name.inputValue(), 'Responsive check ' + label);

        // Audit theme-specific foreground/background contrast on actual rendered
        // controls, including system color-scheme changes without a reload.
        if (width === 390) {
          const presets: Array<[string, string]> = [
            ['Claude Editorial', 'linear-precision'],
            ['Warm Parchment', 'warm-parchment'],
            ['Liquid Glass', 'liquid-glass'],
            ['Industrial Brutalist', 'industrial-brutalist'],
            ['Nordic Earth', 'nordic-moss'],
            ['Solaris Gold', 'solar-gold'],
            ['Tokyo Cyber', 'tokyo-neon'],
            ['Vanguard Monolith', 'vanguard-monolith'],
          ];
          const checkContrast = async (element: ReturnType<typeof dialog.getByRole>, description: string) => {
            // Using source text avoids tsx-injected __name dependencies inside
            // browser-evaluated functions.
            const ratio = await element.evaluate(`element => {
              const toLuminance = value => {
                const channels = (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
                if (channels.length !== 3) return null;
                return channels.map(channel => {
                  const v = channel / 255;
                  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
                }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
              };
              const css = getComputedStyle(element);
              const a = toLuminance(css.color);
              const b = toLuminance(css.backgroundColor);
              if (a === null || b === null) return 0;
              return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            }`);
            assert(ratio >= 4.5, description + ' contrast ' + ratio.toFixed(2) + ':1 below 4.5:1');
          };
          const saveButton = dialog.getByTestId('settings-save');
          for (const [name, id] of presets) {
            await dialog.getByText(name, { exact: true }).click();
            await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, id);
            for (const mode of ['light', 'dark', 'system'] as const) {
              if (mode === 'system') await page.emulateMedia({ colorScheme: 'dark' });
              const selectedMode = dialog.getByRole('button', { name: mode, exact: true });
              await selectedMode.click();
              await page.waitForFunction(expected => document.documentElement.classList.contains('dark') === expected, mode !== 'light');
              await checkContrast(saveButton, name + ' ' + mode + ' Save Changes');
              await checkContrast(selectedMode, name + ' ' + mode + ' selected mode');
              if (mode === 'system') {
                await page.emulateMedia({ colorScheme: 'light' });
                await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
                await checkContrast(saveButton, name + ' system/light Save Changes');
                await page.emulateMedia({ colorScheme: 'dark' });
                await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
              }
            }
          }
          await page.emulateMedia({ colorScheme: 'light' });
          await dialog.getByRole('button', { name: 'dark', exact: true }).click();
        }

        // Verify footer is actually reachable via wheel scrolling at short heights.
        const short = height < 430;
        if (short) {
          const region = page.getByTestId('settings-dialog');
          const r = (await region.boundingBox())!;
          await page.mouse.move(r.x + r.width/2, r.y + r.height/2);
          await page.mouse.wheel(0, 10000);
          await page.waitForTimeout(250);
          const measured = await metrics(page);
          assert((measured.dialogScrollTop ?? 0) > 0, label + ' short-screen settings cannot scroll');
        } else {
          // With normal-height screens the actions should remain accessible without scrolling.
          const measured = await metrics(page);
          assert(measured.footer!.top >= measured.viewport.top - 3 &&
            measured.footer!.bottom <= measured.viewport.top + measured.viewport.height + 3,
            label + ' Save/Cancel/footer below visible viewport');
        }
        const save = dialog.getByRole('button', {name: 'Save Changes'});
        const cancel = dialog.getByRole('button', {name: 'Cancel'});
        const footer = page.getByTestId('settings-footer');
        await footer.getByText('Product of Virexa AI Ventures').waitFor({ state: 'visible' });
        for (const control of [save,cancel]) {
          const box = await control.boundingBox();
          const mm = await metrics(page);
          assert(box && box.y >= mm.viewport.top-3 &&
            box.y+box.height <= mm.viewport.top+mm.viewport.height+3 &&
            box.x >= -3 && box.x+box.width <= width+3,
            label + ' action clipped: ' + JSON.stringify(box));
          const hit = await control.evaluate(element => {
            const r=element.getBoundingClientRect();
            const center=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
            return element===center || element.contains(center);
          });
          assert(hit,label+' action intercepted by application overlay');
        }

        // Form persists through the actual Save action, not just a state assertion.
        await save.click();
        await dialog.waitFor({state:'hidden',timeout:7000});
        const stored=await page.evaluate(() => JSON.parse(localStorage.getItem('aira_settings_v1')||'{}').userName);
        assert.equal(stored, 'Responsive check ' + label, label + ' save did not persist');
        assert.equal(errors.length,0,label+' page errors: '+errors.join(' | '));
        const overflow=await page.evaluate(() => document.documentElement.scrollWidth>window.innerWidth+2);
        assert(!overflow,label+' page horizontal overflow');
        console.log('PASS mobile settings ' + label + ' header/tabs/footer/actions/save');

        if (width===390) {
          // Shrinking the simulated visible screen (analogous to keyboard/browser
          // viewport changes) must keep the dialog within the new viewport.
          await openSettings(page,width);
          await page.setViewportSize({width,height:360});
          await page.waitForTimeout(150);
          const reduced=await metrics(page);
          assert(reduced.dialog && reduced.dialog.bottom <= 363,
            'settings modal escaped after viewport height reduction');
          await page.setViewportSize({width,height});
          await page.waitForTimeout(150);
          const restored=await metrics(page);
          assert(restored.dialog && restored.dialog.bottom<=restored.viewport.height+3,
            'settings modal did not recover after viewport restoration');
          await page.getByRole('button',{name:'Close settings'}).click();
        }
      } catch(err) {
        console.error('FAILED viewport '+label+' '+String(err));
        try{await page.screenshot({path:'/tmp/aira-settings-modal-failure.png',fullPage:false});}catch{}
        throw err;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode=1; });
