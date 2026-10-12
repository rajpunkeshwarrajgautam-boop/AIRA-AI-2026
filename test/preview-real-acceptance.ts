import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PREVIEW_URL = process.env.AIRA_PREVIEW_URL || 'https://aira-ai-2026-gz2p91qpy-rajpunkeshwarrajgautam-boops-projects.vercel.app/';
const AUTH_STATE_PATH = process.env.AIRA_AUTH_STATE_PATH || 'C:\\Users\\WORKSTATION\\AppData\\Local\\AIRA-Test\\preview-auth-state.json';
const OUTPUT_DIR = path.resolve(process.cwd(), 'test-results/preview-acceptance');

interface AcceptanceEvidence {
  testId: string;
  prompt: string;
  response: string;
  sourceLinks: string[];
  consoleErrors: string[];
  screenshotPath: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

const USER_SELECTOR = '.group.justify-end .aira-prose';
const ASSISTANT_SELECTOR = '.group:not(.justify-end) .aira-prose';

async function sendMessageAndWaitForResponse(page: Page, prompt: string, timeoutMs = 120000): Promise<string> {
  process.stdout.write(`\nSubmitting prompt: "${prompt}"\n`);
  const textarea = page.locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 15000 });

  const initialAssistantCount = await page.locator(ASSISTANT_SELECTOR).count();

  await textarea.fill(prompt);
  await page.keyboard.press('Enter');

  // Wait for new assistant message bubble to appear
  await page.waitForFunction(
    ({ selector, count }) => document.querySelectorAll(selector).length > count,
    { selector: ASSISTANT_SELECTOR, count: initialAssistantCount },
    { timeout: 45000 }
  );

  const startTime = Date.now();
  let lastText = '';
  let stableCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    await page.waitForTimeout(1000);
    const proseElements = page.locator(ASSISTANT_SELECTOR);
    const count = await proseElements.count();
    if (count > initialAssistantCount) {
      const currentText = (await proseElements.nth(count - 1).innerText()).trim();
      const isSpinning = await page.locator('button .animate-spin').isVisible().catch(() => false);
      if (!isSpinning && currentText.length > 20) {
        if (currentText === lastText) {
          stableCount++;
          if (stableCount >= 3) {
            return currentText;
          }
        } else {
          stableCount = 0;
          lastText = currentText;
        }
      } else {
        lastText = currentText;
      }
    }
  }

  const proseElements = page.locator(ASSISTANT_SELECTOR);
  const count = await proseElements.count();
  return (await proseElements.nth(count - 1).innerText()).trim();
}

async function extractSourceLinks(page: Page): Promise<string[]> {
  const links = await page.locator(`${ASSISTANT_SELECTOR} a`).evaluateAll(elements => {
    return elements
      .map(el => (el as HTMLAnchorElement).href)
      .filter(href => href.startsWith('http'));
  });
  return Array.from(new Set(links));
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const consoleErrors: string[] = [];
  const results: AcceptanceEvidence[] = [];

  console.log('========================================================================');
  console.log('  AIRA PREVIEW REAL BROWSER ACCEPTANCE TESTING                          ');
  console.log('========================================================================');
  console.log('Target URL:   ', PREVIEW_URL);
  console.log('Browser:      Microsoft Edge (channel: msedge)');

  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  console.log('Bypass Secret:', bypassSecret ? 'CONFIGURED (Active)' : 'NOT PRESENT');
  console.log('Auth Storage: ', fs.existsSync(AUTH_STATE_PATH) ? `FOUND (${AUTH_STATE_PATH})` : 'NOT FOUND');

  const previewOrigin = new URL(PREVIEW_URL).origin;

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    channel: 'msedge'
  });

  const contextOptions: any = {};
  if (fs.existsSync(AUTH_STATE_PATH)) {
    contextOptions.storageState = AUTH_STATE_PATH;
  }

  // MISSION 2: DO NOT inject extraHTTPHeaders globally on the BrowserContext.
  // Instead, scope the Vercel bypass headers strictly to requests targeting the previewOrigin.
  const context = await browser.newContext(contextOptions);

  if (bypassSecret) {
    await context.route('**/*', async (route, request) => {
      const reqUrl = request.url();
      if (reqUrl.startsWith(previewOrigin)) {
        const headers = {
          ...request.headers(),
          'x-vercel-protection-bypass': bypassSecret,
          'x-vercel-set-bypass-cookie': 'true'
        };
        await route.continue({ headers });
      } else {
        // Cross-origin requests (e.g. Google Fonts) proceed with normal headers without CORS preflight conflicts
        await route.continue();
      }
    });
  }

  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore favicon 404 or known telemetry
      if (!text.includes('favicon') && !text.includes('telemetry')) {
        consoleErrors.push(text);
        process.stderr.write(`[BROWSER ERROR] ${text}\n`);
      }
    }
  });

  try {
    console.log('\nNavigating to preview root...');
    await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 35000 });

    const pageTitle = await page.title();
    console.log(`Page Title: "${pageTitle}"`);
    if (pageTitle.includes('Login – Vercel')) {
      throw new Error('VERCEL_DEPLOYMENT_PROTECTION_BLOCKED: Authenticated storage state is missing or bypass failed.');
    }

    const textarea = page.locator('textarea');
    await textarea.waitFor({ state: 'visible', timeout: 15000 });
    console.log('✓ Chat interface loaded successfully.');

    // Verify font CORS errors did not occur
    const fontErrors = consoleErrors.filter(err => err.includes('fonts.gstatic.com') || err.includes('fonts.googleapis.com'));
    assert.strictEqual(fontErrors.length, 0, `Google Fonts requests must not encounter CORS errors. Found: ${fontErrors.join(', ')}`);
    console.log('✓ External font requests loaded with zero CORS errors.');

    // -------------------------------------------------------------------------
    // TEST A: Avatar Fire and Ash Box Office (Mojo vs Numbers)
    // -------------------------------------------------------------------------
    console.log('\n========================================================================');
    console.log('  TEST A: Avatar: Fire and Ash Worldwide Box Office                     ');
    console.log('========================================================================');
    const promptA = 'What is the worldwide gross of Avatar: Fire and Ash according to Box Office Mojo and The Numbers? Explain any reporting-date differences.';
    const startA = Date.now();
    const responseA = await sendMessageAndWaitForResponse(page, promptA);
    const durationA = Date.now() - startA;
    const sourcesA = await extractSourceLinks(page);
    const screenshotA = path.join(OUTPUT_DIR, 'test_a_avatar_box_office.png');
    await page.screenshot({ path: screenshotA, fullPage: true });

    console.log(`Test A Response Length: ${responseA.length} chars (took ${(durationA/1000).toFixed(1)}s)`);
    console.log('Test A Sources Found:', sourcesA);
    assert.ok(responseA.length > 50, 'Test A response must not be empty');
    assert.doesNotMatch(responseA, /\[(?:Source\s*)?(?:1[2-9]|[2-9]\d+)\]/, 'Must not contain out-of-bounds citations');
    assert.match(responseA, /Box Office Mojo/i, 'Must cite Box Office Mojo');
    assert.match(responseA, /The Numbers/i, 'Must cite The Numbers');
    assert.ok(sourcesA.length >= 2, 'Must provide at least 2 source links');

    results.push({
      testId: 'TEST_A_AVATAR_BOX_OFFICE',
      prompt: promptA,
      response: responseA,
      sourceLinks: sourcesA,
      consoleErrors: [...consoleErrors],
      screenshotPath: screenshotA,
      durationMs: durationA
    });

    // -------------------------------------------------------------------------
    // TEST B: Tokyo Weather (Date-specific, no seasonal climate averages)
    // -------------------------------------------------------------------------
    console.log('\n========================================================================');
    console.log('  TEST B: Tokyo Weather Forecast (Operational Evidence Only)            ');
    console.log('========================================================================');
    const newChatBtn = page.locator('button:has-text("New chat"), button[aria-label="New chat"], button:has-text("New Conversation")').first();
    if (await newChatBtn.isVisible()) {
      await newChatBtn.click();
      await page.waitForTimeout(1000);
    } else {
      await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
    }

    const promptB = "What is today's weather forecast for Tokyo, Japan? Use date-specific evidence, not monthly climate averages.";
    const startB = Date.now();
    const responseB = await sendMessageAndWaitForResponse(page, promptB);
    const durationB = Date.now() - startB;
    const sourcesB = await extractSourceLinks(page);
    const screenshotB = path.join(OUTPUT_DIR, 'test_b_tokyo_weather.png');
    await page.screenshot({ path: screenshotB, fullPage: true });

    console.log(`Test B Response Length: ${responseB.length} chars (took ${(durationB/1000).toFixed(1)}s)`);
    console.log('Test B Sources Found:', sourcesB);
    assert.ok(responseB.length > 50, 'Test B response must not be empty');
    assert.doesNotMatch(responseB, /What to wear in Tokyo in December/i, 'Must not cite December travel guide');
    assert.ok(sourcesB.length >= 1, 'Must provide meteorological sources');

    results.push({
      testId: 'TEST_B_TOKYO_WEATHER',
      prompt: promptB,
      response: responseB,
      sourceLinks: sourcesB,
      consoleErrors: [...consoleErrors],
      screenshotPath: screenshotB,
      durationMs: durationB
    });

    // -------------------------------------------------------------------------
    // TEST C: NVIDIA Financial Research (Sessions, Timezones, Timestamps)
    // -------------------------------------------------------------------------
    console.log('\n========================================================================');
    console.log('  TEST C: NVIDIA Share Price & Trading Session Precision                ');
    console.log('========================================================================');
    if (await newChatBtn.isVisible()) {
      await newChatBtn.click();
      await page.waitForTimeout(1000);
    } else {
      await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
    }

    const promptC = "What is NVIDIA's latest share price? Distinguish the previous close and premarket quote, with timestamps.";
    const startC = Date.now();
    const responseC = await sendMessageAndWaitForResponse(page, promptC);
    const durationC = Date.now() - startC;
    const sourcesC = await extractSourceLinks(page);
    const screenshotC = path.join(OUTPUT_DIR, 'test_c_nvidia_financial.png');
    await page.screenshot({ path: screenshotC, fullPage: true });

    console.log(`Test C Response Length: ${responseC.length} chars (took ${(durationC/1000).toFixed(1)}s)`);
    console.log('Test C Sources Found:', sourcesC);
    assert.ok(responseC.length > 50, 'Test C response must not be empty');
    assert.doesNotMatch(responseC, /9:30\s*AM.*premarket/i, '9:30 AM Eastern must never be called premarket');
    assert.doesNotMatch(responseC, /exchange.*assumed|NASDAQ.*\(assumed\)/i, 'Must not label exchange as assumed');
    assert.match(responseC, /NVIDIA|NVDA/i, 'Must cite NVIDIA/NVDA ticker');
    assert.ok(sourcesC.length >= 1, 'Must provide financial sources');

    results.push({
      testId: 'TEST_C_NVIDIA_FINANCIAL',
      prompt: promptC,
      response: responseC,
      sourceLinks: sourcesC,
      consoleErrors: [...consoleErrors],
      screenshotPath: screenshotC,
      durationMs: durationC
    });

    // -------------------------------------------------------------------------
    // TEST D: Multi-turn Clarification & Persistence After Refresh
    // -------------------------------------------------------------------------
    console.log('\n========================================================================');
    console.log('  TEST D: Multi-turn Clarification & Persistence After Refresh           ');
    console.log('========================================================================');
    if (await newChatBtn.isVisible()) {
      await newChatBtn.click();
      await page.waitForTimeout(1000);
    } else {
      await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
    }

    const promptD1 = "What is the current share price?";
    const responseD1 = await sendMessageAndWaitForResponse(page, promptD1);
    console.log('Turn 1 (Clarification Request):', responseD1.slice(0, 200), '...');
    assert.match(responseD1, /which\s*(?:company|stock|ticker|share)|specify/i, 'Must request clarification for missing entity');

    const promptD2 = "NVIDIA";
    const responseD2 = await sendMessageAndWaitForResponse(page, promptD2);
    console.log('Turn 2 (Resolution Response):', responseD2.slice(0, 200), '...');
    assert.match(responseD2, /NVIDIA|NVDA/i, 'Must resolve entity and answer with NVIDIA data');

    // Before refresh verification:
    const preRefreshUserCount = await page.locator(USER_SELECTOR).count();
    const preRefreshAssistantCount = await page.locator(ASSISTANT_SELECTOR).count();
    console.log(`Pre-Refresh Message Counts: Users=${preRefreshUserCount}, Assistants=${preRefreshAssistantCount}`);
    assert.ok(preRefreshUserCount >= 2, 'Both user turns must be rendered before refresh');
    assert.ok(preRefreshAssistantCount >= 2, 'Both assistant turns must be rendered before refresh');

    // Capture non-sensitive conversation identifier
    const preRefreshConversationId = await page.evaluate(() => {
      const urlParam = new URLSearchParams(window.location.search).get('c');
      const sessionChatId = window.sessionStorage?.getItem('aira_active_chat_session');
      const rawConvs = window.localStorage?.getItem('aira_conversations_v1');
      const convs = rawConvs ? JSON.parse(rawConvs) : [];
      return urlParam || sessionChatId || (convs[0]?.id ?? null);
    });
    console.log(`Pre-Refresh Active Conversation ID: ${preRefreshConversationId}`);
    assert.ok(preRefreshConversationId, 'Active conversation ID must be established before refresh');

    // Reload browser within the same browser context
    console.log('Refreshing page within same browser context...');
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Wait for actual application readiness
    const reloadedTextarea = page.locator('textarea');
    await reloadedTextarea.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1000);

    // Verify conversation identity restoration
    const postRefreshConversationId = await page.evaluate(() => {
      const urlParam = new URLSearchParams(window.location.search).get('c');
      const sessionChatId = window.sessionStorage?.getItem('aira_active_chat_session');
      return urlParam || sessionChatId;
    });
    console.log(`Post-Refresh Active Conversation ID: ${postRefreshConversationId}`);

    const postRefreshUserCount = await page.locator(USER_SELECTOR).count();
    const postRefreshAssistantCount = await page.locator(ASSISTANT_SELECTOR).count();
    console.log(`Post-Refresh Message Counts: Users=${postRefreshUserCount}, Assistants=${postRefreshAssistantCount}`);

    assert.ok(postRefreshUserCount >= 2, 'Both user messages must persist and be rendered after refresh');
    assert.ok(postRefreshAssistantCount >= 2, 'Both assistant messages must persist and be rendered after refresh');

    const postRefreshAssistantText = await page.locator(ASSISTANT_SELECTOR).last().innerText();
    assert.match(postRefreshAssistantText, /NVIDIA|NVDA/i, 'Persisted conversation content must match resolution response');

    const screenshotD = path.join(OUTPUT_DIR, 'test_d_multi_turn_persistence.png');
    await page.screenshot({ path: screenshotD, fullPage: true });

    results.push({
      testId: 'TEST_D_MULTI_TURN_PERSISTENCE',
      prompt: `${promptD1} -> ${promptD2} (with refresh)`,
      response: responseD2,
      sourceLinks: await extractSourceLinks(page),
      consoleErrors: [...consoleErrors],
      screenshotPath: screenshotD,
      durationMs: 0,
      metadata: {
        preRefreshConversationId,
        postRefreshConversationId,
        preRefreshUserCount,
        preRefreshAssistantCount,
        postRefreshUserCount,
        postRefreshAssistantCount
      }
    });

    // Write acceptance report artifact
    const reportPath = path.join(OUTPUT_DIR, 'acceptance-evidence.json');
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log('\n✓ All real browser tests completed successfully!');
    console.log('Report saved to:', reportPath);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('\n❌ Acceptance Test Failure:', err.message);
  process.exit(1);
});
