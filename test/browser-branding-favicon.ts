import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const URL = process.env.AIRA_FRONTEND_TEST_URL || 'http://127.0.0.1:5173/';

async function testBrandingAndFavicon() {
  console.log('[TDD] Starting Browser Branding & Animated Favicon Test Suite...');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });

  try {
    // -------------------------------------------------------------
    // Test Case 1: Browser Title Strictly Exactly 'Aira AI'
    // -------------------------------------------------------------
    console.log('[TDD] Testing browser title on root and interactions...');
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      // Seed a test conversation in localStorage for navigation checks
      const now = Date.now();
      const conversation = {
        id: 'test-branding-convo',
        title: 'Project Branding Discussion',
        createdAt: now,
        updatedAt: now,
        messages: [{ id: 'msg-1', role: 'assistant', timestamp: now, content: 'Welcome to Aira.' }],
      };
      localStorage.setItem('aira_conversations_v1', JSON.stringify([conversation]));
    });

    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    const initialTitle = await page.title();
    console.log(`[TDD] Initial Title: "${initialTitle}"`);
    assert.strictEqual(initialTitle, 'Aira AI', `Title must be exactly 'Aira AI', got: "${initialTitle}"`);
    assert.strictEqual(await page.evaluate(() => document.title), 'Aira AI');

    // Reload test
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    assert.strictEqual(await page.title(), 'Aira AI', 'Title must remain "Aira AI" after page reload');

    // Navigation / conversation switch test
    const convoButton = page.getByText('Project Branding Discussion');
    if (await convoButton.count() > 0) {
      await convoButton.first().click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.title(), 'Aira AI', 'Title must remain "Aira AI" when opening a saved conversation');
    }

    // New conversation test
    const newChatBtn = page.getByRole('button', { name: /New Chat/i });
    if (await newChatBtn.count() > 0) {
      await newChatBtn.first().click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.title(), 'Aira AI', 'Title must remain "Aira AI" when starting a new chat');
    }

    // Settings modal open test
    const settingsBtn = page.getByTitle('Settings');
    if (await settingsBtn.count() > 0) {
      await settingsBtn.first().click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.title(), 'Aira AI', 'Title must remain "Aira AI" when opening settings');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    console.log('PASS: Browser tab title is strictly "Aira AI" across all states.');

    // -------------------------------------------------------------
    // Test Case 2: Static Favicon Fallback & Asset Integrity
    // -------------------------------------------------------------
    console.log('[TDD] Testing static favicon fallback asset...');
    const faviconHref = await page.evaluate(() => {
      const link = document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null;
      return link ? link.href : null;
    });

    assert(faviconHref, 'Favicon link element must exist in document head');
    assert(
      faviconHref.startsWith('data:image/svg+xml') || faviconHref.includes('.svg') || faviconHref.includes('.ico'),
      `Favicon href must be a valid SVG or image asset, got: ${faviconHref.slice(0, 60)}`
    );

    // -------------------------------------------------------------
    // Test Case 3: Animated Favicon Loop under Normal Motion
    // -------------------------------------------------------------
    console.log('[TDD] Testing animated favicon frame progression...');
    // Capture favicon href samples over 800ms
    const samples: string[] = [];
    for (let i = 0; i < 6; i++) {
      const currentHref = await page.evaluate(() => {
        const link = document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null;
        return link ? link.href : '';
      });
      samples.push(currentHref);
      await page.waitForTimeout(160);
    }

    const uniqueFrames = new Set(samples);
    console.log(`[TDD] Captured ${samples.length} favicon samples, unique frames: ${uniqueFrames.size}`);
    assert(
      uniqueFrames.size >= 2,
      `Favicon must animate and change frames over time; expected >= 2 unique frames, got ${uniqueFrames.size}`
    );

    // Verify frames contain recognizable AIRA knot elements
    for (const frame of uniqueFrames) {
      if (frame.startsWith('data:image/svg+xml')) {
        const decoded = decodeURIComponent(frame);
        assert(
          decoded.includes('viewBox="0 0 64 64"') || decoded.includes('viewBox=\'0 0 64 64\''),
          'Favicon frame must contain AIRA 64x64 viewBox'
        );
        assert(
          decoded.includes('D97757') || decoded.includes('terracotta') || decoded.includes('circle'),
          'Favicon frame must preserve AIRA terracotta/orbital branding'
        );
      }
    }
    console.log('PASS: Favicon animates smoothly with valid AIRA neural knot frames.');

    // -------------------------------------------------------------
    // Test Case 4: Reduced-Motion Accessibility
    // -------------------------------------------------------------
    console.log('[TDD] Testing reduced-motion compliance (prefers-reduced-motion: reduce)...');
    const reducedMotionContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    const reducedPage = await reducedMotionContext.newPage();
    await reducedPage.goto(URL, { waitUntil: 'domcontentloaded' });
    await reducedPage.waitForTimeout(400);

    const rmSamples: string[] = [];
    for (let i = 0; i < 5; i++) {
      const href = await reducedPage.evaluate(() => {
        const link = document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null;
        return link ? link.href : '';
      });
      rmSamples.push(href);
      await reducedPage.waitForTimeout(160);
    }

    const rmUnique = new Set(rmSamples);
    console.log(`[TDD] Reduced motion unique favicon frames: ${rmUnique.size}`);
    assert.strictEqual(
      rmUnique.size,
      1,
      `Favicon must remain static when prefers-reduced-motion: reduce is enabled; got ${rmUnique.size} frames`
    );
    console.log('PASS: Reduced motion pauses favicon animation and serves static icon.');
    await reducedMotionContext.close();

    // -------------------------------------------------------------
    // Test Case 5: Background Tab Visibility (Pause on Hidden)
    // -------------------------------------------------------------
    console.log('[TDD] Testing tab visibility pause behavior...');
    // Simulate tab hiding via document.dispatchEvent of visibilitychange
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);

    const hiddenHref1 = await page.evaluate(() => (document.querySelector('link[rel~="icon"]') as HTMLLinkElement)?.href);
    await page.waitForTimeout(300);
    const hiddenHref2 = await page.evaluate(() => (document.querySelector('link[rel~="icon"]') as HTMLLinkElement)?.href);
    assert.strictEqual(hiddenHref1, hiddenHref2, 'Favicon animation must pause when tab is hidden');

    // Simulate tab visible again
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(400);

    const resumedHref = await page.evaluate(() => (document.querySelector('link[rel~="icon"]') as HTMLLinkElement)?.href);
    // Over time it should continue
    await page.waitForTimeout(200);
    const resumedHref2 = await page.evaluate(() => (document.querySelector('link[rel~="icon"]') as HTMLLinkElement)?.href);
    assert(
      resumedHref !== resumedHref2 || resumedHref !== hiddenHref1,
      'Favicon animation must resume when tab becomes visible'
    );
    console.log('PASS: Favicon animation correctly pauses when hidden and resumes when visible.');

    assert.deepStrictEqual(errors, [], `No browser console errors expected: ${errors.join(', ')}`);
    await context.close();
    console.log('ALL BROWSER BRANDING & ANIMATED FAVICON TESTS PASSED.');
  } finally {
    await browser.close();
  }
}

testBrandingAndFavicon().catch(err => {
  console.error('[TDD] FAILED:', err);
  process.exit(1);
});
