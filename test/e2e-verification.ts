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

    // Full rich-copy UI verification against a locally seeded assistant reply.
    const richExample = [
      '## Induction motor',
      '**Synchronous speed:** \\[N_s=\\frac{120f}{P}\\]',
      '',
      '| Quantity | Value |',
      '|---|---|',
      '| Slip | $s=\\frac{1500-1440}{1500}$ |',
    ].join('\n');
    await page.evaluate(`(() => {
      const markdown = ${JSON.stringify(richExample)};
      const conversation = {
        id: 'rich-clipboard-e2e',
        title: 'Rich clipboard certification',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [{
          id: 'rich-assistant-message',
          role: 'assistant',
          content: markdown,
          timestamp: Date.now(),
          modelUsed: 'nvidia/nemotron-3-super-120b-a12b'
        }]
      };
      localStorage.setItem('aira_conversations_v1', JSON.stringify([conversation]));
      localStorage.setItem('aira_active_chat_id_v1', conversation.id);
    })()`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Rich clipboard certification', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Copy as Rich Text' }).waitFor({ timeout: 10000 });

    await page.evaluate(`(() => {
      window.__richClipboardCapture = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          write: async (items) => {
            const entry = items[0];
            const [html, plain] = await Promise.all([
              entry.getType('text/html').then(blob => blob.text()),
              entry.getType('text/plain').then(blob => blob.text())
            ]);
            window.__richClipboardCapture = { html, plain, types: entry.types };
          },
          writeText: async () => { throw new Error('Unexpected Markdown fallback'); }
        }
      });
    })()`);
    await page.getByRole('button', { name: 'Copy as Rich Text' }).click();
    await page.getByText('Rich text copied', { exact: true }).waitFor({ timeout: 10000 });
    const copied = await page.evaluate('window.__richClipboardCapture');
    if (!copied?.types?.includes('text/html') || !copied?.types?.includes('text/plain')) {
      throw new Error('Rich clipboard missing HTML and plain MIME types');
    }
    if (!copied.html.includes('katex') || !copied.html.includes('katex-display') ||
        (!copied.html.includes('MathML') && !copied.html.includes('mathml')) ||
        !copied.html.includes('border:1px') || !copied.html.includes('Induction motor') ||
        !copied.html.includes('StartFragment')) {
      throw new Error('Rich clipboard did not preserve formatted equations, table or heading');
    }
    if (copied.plain !== richExample) throw new Error('Plain clipboard payload not preserved');

    await page.evaluate(`(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          write: async () => { throw new Error('NotAllowedError'); },
          writeText: async (text) => { window.__fallbackCopiedText = text; }
        }
      });
    })()`);
    await page.getByRole('button', { name: 'Copy as Rich Text' }).click();
    await page.getByText('Markdown copied (rich text unavailable)').waitFor({ timeout: 10000 });
    const fallbackText = await page.evaluate('window.__fallbackCopiedText');
    if (fallbackText !== richExample) throw new Error('Rich clipboard fallback did not copy Markdown');

    process.stdout.write('Verified: Rich clipboard MIME, KaTeX/table formatting and fallback.\n');

    // Regression: long chat must scroll *inside* the message region only.
    // Scrolling the document itself previously moved the entire workspace
    // (including sidebar and composer) out of view, leaving a blank page.
    await page.evaluate(`(() => {
      const now = Date.now();
      const messages = Array.from({ length: 48 }, (_, i) => ({
        id: 'scroll-message-' + i,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'Scroll regression message ' + i + '. ' +
          'Aira must keep its composer visible while scrolling. '.repeat(24),
        timestamp: now + i
      }));
      const conversation = {
        id: 'scroll-regression-conversation',
        title: 'Long scroll regression',
        createdAt: now,
        updatedAt: now,
        messages
      };
      localStorage.setItem('aira_conversations_v1', JSON.stringify([conversation]));
      localStorage.setItem('aira_active_chat_id_v1', conversation.id);
    })()`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Long scroll regression', { exact: true }).first().click();
    await page.getByText('Scroll regression message 47', { exact: false }).waitFor({ timeout: 15000 });
    const beforeScroll = await page.evaluate(`(() => {
      const region = document.querySelector('[data-testid="chat-scroll-region"]');
      return { contentHeight: region.scrollHeight, viewportHeight: region.clientHeight };
    })()`);
    if (beforeScroll.contentHeight <= beforeScroll.viewportHeight + 100) {
      throw new Error('Long chat regression fixture does not overflow');
    }
    await page.mouse.move(1050, 420);
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(150);
    const downward = await page.evaluate(`(() => {
      const region = document.querySelector('[data-testid="chat-scroll-region"]');
      const composer = document.querySelector('main textarea').getBoundingClientRect();
      const header = document.querySelector('main header').getBoundingClientRect();
      return {
        bodyScroll: window.scrollY,
        rootScroll: document.documentElement.scrollTop,
        chatTop: region.scrollTop,
        composerBottom: composer.bottom,
        composerTop: composer.top,
        headerTop: header.top,
        screenHeight: window.innerHeight
      };
    })()`);
    if (downward.bodyScroll !== 0 || downward.rootScroll !== 0 ||
      downward.headerTop < -1 || downward.composerTop < 0 ||
      downward.composerBottom > downward.screenHeight + 1 ||
      downward.chatTop <= 0) {
      throw new Error('Viewport displaced by chat scrolling: ' + JSON.stringify(downward));
    }
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(150);
    const upward = await page.evaluate(`(() => {
      const region = document.querySelector('[data-testid="chat-scroll-region"]');
      const composer = document.querySelector('main textarea').getBoundingClientRect();
      return { chatTop: region.scrollTop, bodyScroll: window.scrollY,
        composerBottom: composer.bottom, screenHeight: window.innerHeight };
    })()`);
    if (upward.chatTop >= downward.chatTop || upward.bodyScroll !== 0 ||
      upward.composerBottom > upward.screenHeight + 1) {
      throw new Error('Scroll up failed or displaced the composer: ' + JSON.stringify(upward));
    }
    process.stdout.write('Verified: long chat scroll stays internal; header, sidebar and composer remain visible.\n');

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

