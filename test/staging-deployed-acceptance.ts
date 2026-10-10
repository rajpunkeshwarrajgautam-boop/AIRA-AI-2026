import assert from 'node:assert/strict';
import { chromium } from 'playwright';

/**
 * Deployed Preview acceptance. Runs against an immutable Vercel Preview URL,
 * NEVER a production alias. Does not make external model/provider API calls:
 * fixture data is injected into the browser's local conversation cache.
 * CI orchestration must separately attest expected git SHA via Vercel metadata.
 */
const url = process.env.STAGING_BASE_URL ?? '';
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '';
const parsed = new URL(url);
if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.vercel.app') ||
    /^aira-ai-2026\.vercel\.app$/.test(parsed.hostname)) {
  throw new Error('Staging acceptance requires an immutable HTTPS Vercel Preview URL, never production.');
}
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      if (bypass) {
        await page.route('**/*', route => {
          const destination = new URL(route.request().url());
          if (destination.origin === parsed.origin) {
            return route.continue({ headers: {
              ...route.request().headers(),
              'x-vercel-protection-bypass': bypass
            } });
          }
          return route.continue();
        });
      }
      await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      if ((await page.title()).includes('Login – Vercel')) {
        throw new Error('Staging authentication required: missing/invalid Vercel bypass credential');
      }
      const input = page.locator('main textarea').first();
      await input.waitFor({ state: 'visible', timeout: 25000 });
      const now = Date.now();
      await page.evaluate(`(() => {
        const messages = Array.from({ length: 48 }, (_, i) => ({
          id: 'stage-scroll-' + i,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: i === 47
            ? 'Final display math: \\[n_s=\\frac{120f}{P}\\]'
            : 'Staging fixture ' + i + ' ' + 'Content for long chat scroll. '.repeat(25),
          timestamp: Date.now() + i
        }));
        const chat = { id:'staging-deployed-fixture', title:'Deployed staging acceptance',
          createdAt:Date.now(), updatedAt:Date.now(), messages };
        localStorage.setItem('aira_conversations_v1', JSON.stringify([chat]));
        localStorage.setItem('aira_active_chat_id_v1', chat.id);
      })()`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('Final display math', { exact:false }).waitFor({timeout:25000});
      const region = page.locator('[data-testid="chat-scroll-region"]');
      await region.waitFor({ state:'visible', timeout:15000 });
      const before = await region.evaluate(el => ({height:el.clientHeight, scrollHeight:el.scrollHeight}));
      assert.ok(before.scrollHeight > before.height + 100, 'Long chat must overflow in staging');
      await region.evaluate(el => { el.scrollTop=0; });
      await region.evaluate(el => { el.scrollTop=el.scrollHeight; });
      const bounds = await page.evaluate(() => {
        const header = document.querySelector('main header')?.getBoundingClientRect();
        const composer = document.querySelector('main textarea')?.getBoundingClientRect();
        const scroller = document.querySelector('[data-testid="chat-scroll-region"]');
        return {documentY:window.scrollY, rootY:document.documentElement.scrollTop,
          scrollerY:scroller?.scrollTop, headerY:header?.top, composerY:composer?.bottom,
          viewportHeight:window.innerHeight};
      });
      assert.equal(bounds.documentY,0,'Window must not scroll');
      assert.equal(bounds.rootY,0,'Root document must not scroll');
      assert.ok((bounds.scrollerY??0)>0,'Only chat scroller should move');
      assert.ok((bounds.headerY??-1)>=-1,'Header must stay visible');
      assert.ok((bounds.composerY??Infinity)<=bounds.viewportHeight+1,'Composer must stay visible');
      assert.ok(await page.locator('.katex').count()>0,'Math must render inside chat');
      await region.evaluate(el => { el.scrollTop=0; });
      const upward=await region.evaluate(el=>el.scrollTop);
      assert.ok(upward<(bounds.scrollerY??0),'Chat must also scroll upwards');
      console.log('PASS '+viewport.width+'x'+viewport.height+': deployed staging chat, math, scroll and viewport');
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
