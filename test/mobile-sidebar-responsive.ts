import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const VIEWPORTS = [
  [320, 568], [360, 640], [375, 667], [390, 844], [430, 932],
  [640, 360], [768, 1024], [820, 1180], [1024, 768],
  [1280, 800], [1440, 900], [1920, 1080],
] as const;

const BASE_URL = process.env.AIRA_SIDEBAR_TEST_URL || 'http://127.0.0.1:5173/';

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({
    viewport: { width: 320, height: 568 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  // Seed actual app storage before React mounts; do not mock sidebar DOM.
  await context.addInitScript(() => {
    const now = Date.now();
    const conversations = Array.from({ length: 110 }, (_, i) => ({
      id: 'sidebar-fixture-' + i,
      title: 'Mobile sidebar fixture ' + String(i).padStart(3, '0') +
        ' - conversation history and long text '.repeat(i % 7 === 0 ? 3 : 1),
      createdAt: now - i * 86_400_000,
      updatedAt: now - i * 86_400_000,
      isPinned: i % 22 === 0,
      messages: [],
    }));
    localStorage.setItem('aira_conversations_v1', JSON.stringify(conversations));
    localStorage.setItem('aira_active_chat_id_v1', conversations[0].id);
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  try {
    for (const [width, height] of VIEWPORTS) {
      const label = width + 'x' + height;
      await page.setViewportSize({ width, height });
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.locator('main textarea').waitFor({ state: 'visible', timeout: 15_000 });
      if (width < 1280) {
        await page.getByRole('button', { name: 'Open sidebar navigation' }).click();
      }
      const drawer = page.getByTestId('sidebar-drawer');
      await drawer.waitFor({ state: 'visible', timeout: 10_000 });
      // Framer Motion can mark the drawer visible while its spring translation
      // still places the scroll target outside the viewport. Wait for arrival.
      await page.waitForFunction(() => {
        const drawer = document.querySelector('[data-testid="sidebar-drawer"]');
        if (!drawer) return false;
        const box = drawer.getBoundingClientRect();
        return box.left > -1 && box.right > Math.min(window.innerWidth, 150);
      }, undefined, { timeout: 5000 });
      const scroll = page.getByTestId('sidebar-scroll-region');
      const footer = page.getByTestId('sidebar-footer');
      const settings = page.getByRole('button', { name: 'Open settings' });
      const light = page.getByRole('button', { name: 'Use light theme' });
      const system = page.getByRole('button', { name: 'Use system theme' });
      const dark = page.getByRole('button', { name: 'Use dark theme' });
      const scrollSurface = height <= 460 ? drawer : scroll;
      const metrics = await scrollSurface.evaluate(el => ({
        scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
        overflowY: getComputedStyle(el).overflowY,
      }));
      assert(metrics.scrollHeight > metrics.clientHeight + 200,
        label + ' sidebar has no usable history scroll range: ' + JSON.stringify(metrics));

      const regionBounds = (await scrollSurface.boundingBox())!;
      assert(regionBounds?.height > 35, label + ' sidebar scroll region is too short');
      await page.mouse.move(
        regionBounds.x + Math.min(regionBounds.width / 2, 145),
        regionBounds.y + Math.min(regionBounds.height / 2, Math.max(12, regionBounds.height - 12)),
      );
      await page.mouse.wheel(0, 60_000);
      await page.waitForTimeout(200);
      let down = await scrollSurface.evaluate(el => el.scrollTop);
      if (down <= 100) {
        // Retry only as a user would: another wheel gesture after the animation settles.
        await page.waitForTimeout(500);
        await page.mouse.wheel(0, 60_000);
        await page.waitForTimeout(250);
        down = await scrollSurface.evaluate(el => el.scrollTop);
      }
      if (down <= 100) {
        const diagnostic = await page.evaluate(() => {
          const aside = document.querySelector('[data-testid="sidebar-drawer"]');
          const region = document.querySelector('[data-testid="sidebar-scroll-region"]');
          const rect = region?.getBoundingClientRect();
          const hit = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            aside: aside?.getBoundingClientRect().toJSON(),
            region: rect?.toJSON(),
            scrollTop: region?.scrollTop,
            scrollHeight: region?.scrollHeight,
            clientHeight: region?.clientHeight,
            hit: hit?.tagName + '.' + String(hit?.className).slice(0, 60),
          };
        });
        throw new Error(label + ' wheel scroll failed: ' + JSON.stringify(diagnostic));
      }

      // Verify the *actual* oldest conversation is on-screen, not merely in the DOM.
      const lastConversation = page.getByText('Mobile sidebar fixture 109', { exact: false });
      const lastBounds = await lastConversation.boundingBox();
      const area = await scrollSurface.boundingBox();
      assert(lastBounds && area && lastBounds.y < area.y + area.height &&
        lastBounds.y + lastBounds.height > area.y,
        label + ' oldest conversation inaccessible after scrolling');

      // Fixed footer must remain in view; short landscape may scroll the whole rail.
      const footerBounds = await footer.boundingBox();
      assert(footerBounds && footerBounds.y >= -2 &&
        footerBounds.y + footerBounds.height <= height + 2,
        label + ' sidebar Settings/Theme footer is outside viewport');

      for (const control of [settings, light, system, dark]) {
        const bounds = await control.boundingBox();
        assert(bounds && bounds.width >= 32 && bounds.height >= 28 &&
          bounds.x >= -2 && bounds.x + bounds.width <= width + 2 &&
          bounds.y >= -2 && bounds.y + bounds.height <= height + 2,
          label + ' essential sidebar control is clipped: ' + (await control.getAttribute('aria-label')));
      }

      await dark.click();
      assert(await page.evaluate(() => document.documentElement.classList.contains('dark')),
        label + ' dark theme did not apply');
      assert.equal(await dark.getAttribute('aria-pressed'), 'true');
      await light.click();
      assert(!(await page.evaluate(() => document.documentElement.classList.contains('dark'))),
        label + ' light theme did not apply');
      await system.click();
      assert.equal(await system.getAttribute('aria-pressed'), 'true');
      const savedTheme = await page.evaluate(() => JSON.parse(localStorage.getItem('aira_settings_v1') || '{}').theme);
      assert.equal(savedTheme, 'system', label + ' system theme did not persist');

      await settings.click();
      await page.getByText('Workspace Settings', { exact: true }).waitFor({ state: 'visible', timeout: 7000 });
      await page.locator('header').filter({ hasText: 'Workspace Settings' }).locator('button').last().click();
      await page.getByText('Workspace Settings', { exact: true }).waitFor({ state: 'hidden', timeout: 7000 });

      if (width < 1280) {
        // A conversation selection should close the temporary mobile drawer.
        await lastConversation.click();
        await drawer.waitFor({ state: 'hidden', timeout: 7000 });
        await page.getByRole('button', { name: 'Open sidebar navigation' }).click();
        await drawer.waitFor({ state: 'visible', timeout: 7000 });
        await page.keyboard.press('Escape');
        await drawer.waitFor({ state: 'hidden', timeout: 7000 });
      }

      const horizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 2
      );
      assert(!horizontalOverflow, label + ' document has unwanted horizontal overflow');
      assert.equal(errors.length, 0, label + ' unhandled errors: ' + errors.join(' | '));
      console.log('PASS sidebar responsive viewport ' + label +
        ' scrollTop=' + down + ' content=' + metrics.scrollHeight);
    }

    // Browser-native touch swipe, not a synthetic scrollTop mutation.
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Open sidebar navigation' }).click();
    // Touch scroll must target the drawer only after its translated entrance
    // animation has completed; offscreen touch events cannot scroll it.
    await page.waitForFunction(() => {
      const sidebar = document.querySelector('[data-testid="sidebar-drawer"]');
      if (!sidebar) return false;
      const r = sidebar.getBoundingClientRect();
      return r.left > -1 && r.right > 150;
    }, undefined, { timeout: 5000 });
    await page.waitForTimeout(300);
    const scroll = page.getByTestId('sidebar-scroll-region');
    const bounds = (await scroll.boundingBox())!;
    const x = bounds.x + bounds.width / 2;
    const from = bounds.y + bounds.height - 20;
    const to = bounds.y + 25;
    const client = await context.newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
    for (let i = 1; i <= 8; i++) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: from + (to - from) * i / 8 }],
      });
      await page.waitForTimeout(20);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(350);
    const touchTop = await scroll.evaluate(el => el.scrollTop);
    if (touchTop <= 10) {
      const geometry = await scroll.evaluate(el => ({
        clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
        overflowY: getComputedStyle(el).overflowY,
        touchAction: getComputedStyle(el).touchAction,
        box: el.getBoundingClientRect().toJSON(),
      }));
      throw new Error('Native touch swipe did not scroll sidebar: ' + JSON.stringify(geometry));
    }
    console.log('PASS native touch swipe scrollTop=' + touchTop);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('FAIL mobile sidebar regression:', error);
  process.exitCode = 1;
});
