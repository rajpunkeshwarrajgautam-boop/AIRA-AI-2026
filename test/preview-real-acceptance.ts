import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TARGET_COMMIT = process.env.AIRA_TARGET_COMMIT || execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();

function resolveTargetDeployment(targetCommit: string) {
  if (process.env.AIRA_TARGET_DEPLOYMENT_ID && process.env.AIRA_PREVIEW_URL) {
    return {
      deploymentId: process.env.AIRA_TARGET_DEPLOYMENT_ID,
      previewUrl: process.env.AIRA_PREVIEW_URL
    };
  }
  try {
    const rawStatuses = execSync(`gh api repos/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/commits/${targetCommit}/statuses`, { encoding: 'utf-8' });
    const statuses = JSON.parse(rawStatuses);
    const vercelStatus = statuses.find((s: any) =>
      s.context === 'Vercel' &&
      (s.state === 'success' || s.description?.toLowerCase().includes('completed'))
    );
    if (vercelStatus?.target_url) {
      const match = vercelStatus.target_url.match(/aira-ai-2026\/([a-zA-Z0-9]+)/);
      if (match) {
        const shortId = match[1];
        const deploymentId = shortId.startsWith('dpl_') ? shortId : `dpl_${shortId}`;
        const inspectOut = execSync(`npx vercel inspect ${deploymentId} --json`, { encoding: 'utf-8' });
        const jsonStart = inspectOut.indexOf('{');
        const inspectData = JSON.parse(jsonStart >= 0 ? inspectOut.slice(jsonStart) : inspectOut);
        if (inspectData?.url) {
          const previewUrl = `https://${inspectData.url}/`;
          return { deploymentId, previewUrl };
        }
      }
    }
  } catch {
    // fallback
  }
  return {
    deploymentId: process.env.AIRA_TARGET_DEPLOYMENT_ID || 'dpl_9sEKkjVbifyBWNTcfkpqA9okRpjt',
    previewUrl: process.env.AIRA_PREVIEW_URL || 'https://aira-ai-2026-aqxcupqs0-rajpunkeshwarrajgautam-boops-projects.vercel.app/'
  };
}

const resolvedDep = resolveTargetDeployment(TARGET_COMMIT);
const TARGET_DEPLOYMENT_ID = resolvedDep.deploymentId;
const PREVIEW_URL = resolvedDep.previewUrl;
const AUTH_STATE_PATH = process.env.AIRA_AUTH_STATE_PATH || 'C:\\Users\\WORKSTATION\\AppData\\Local\\AIRA-Test\\preview-auth-state.json';
const OUTPUT_DIR = path.resolve(process.cwd(), 'test-results/preview-acceptance');
const ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts/preview-acceptance');

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

interface AcceptanceReport {
  targetCommit: string;
  targetDeploymentId: string;
  previewUrl: string;
  timestamp: string;
  overallStatus: 'PASS' | 'FAIL';
  fontCorsErrors: string[];
  tests: AcceptanceEvidence[];
}

const USER_SELECTOR = '.group.justify-end .aira-prose';
const ASSISTANT_SELECTOR = '.group:not(.justify-end) .aira-prose';

function getAutomationBypassSecret(): string | undefined {
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    return process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  try {
    const out = execSync('npx vercel project protection --json --scope rajpunkeshwarrajgautam-boops-projects', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const jsonStart = out.indexOf('{');
    const data = JSON.parse(jsonStart >= 0 ? out.slice(jsonStart) : out);
    if (data.protectionBypass) {
      const secret = Object.keys(data.protectionBypass)[0];
      if (secret) return secret;
    }
  } catch {
    // fallback
  }
  return undefined;
}

function verifyTargetDeployment(): void {
  console.log('\n========================================================================');
  console.log('  VERIFYING TARGET COMMIT & DEPLOYMENT PRE-CONDITIONS                  ');
  console.log('========================================================================');
  
  const localHead = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  console.log('Local Git HEAD:       ', localHead);
  console.log('Required Target SHA:  ', TARGET_COMMIT);
  assert.strictEqual(localHead, TARGET_COMMIT, `Local git HEAD (${localHead}) must match target commit (${TARGET_COMMIT})`);
  console.log('✓ Local Git HEAD matches target commit exactly.');

  // PR #51 Head Check (Must strictly match; failure blocks certification)
  const prHead = execSync('gh pr view 51 --json headRefOid -q .headRefOid', { encoding: 'utf-8' }).trim();
  console.log('PR #51 Head SHA:      ', prHead);
  assert.strictEqual(prHead, TARGET_COMMIT, `PR #51 headRefOid (${prHead}) must match target commit (${TARGET_COMMIT})`);
  console.log('✓ PR #51 Head SHA matches target commit exactly.');

  // Vercel Deployment Metadata Check (Must strictly match; failure blocks certification)
  let deploymentMeta: any;
  try {
    const apiOutput = execSync(`npx vercel api /v13/deployments/${TARGET_DEPLOYMENT_ID}`, { encoding: 'utf-8' });
    deploymentMeta = JSON.parse(apiOutput);
  } catch (err: any) {
    const inspectOutput = execSync(`npx vercel inspect ${TARGET_DEPLOYMENT_ID} --json`, { encoding: 'utf-8' });
    const jsonStart = inspectOutput.indexOf('{');
    deploymentMeta = JSON.parse(jsonStart >= 0 ? inspectOutput.slice(jsonStart) : inspectOutput);
  }

  assert.ok(deploymentMeta, `Must successfully retrieve Vercel deployment metadata for ${TARGET_DEPLOYMENT_ID}`);
  console.log('Deployment ID:        ', deploymentMeta.id);
  assert.strictEqual(deploymentMeta.id, TARGET_DEPLOYMENT_ID, `Deployment ID (${deploymentMeta.id}) must match target deployment ID (${TARGET_DEPLOYMENT_ID})`);
  assert.strictEqual(deploymentMeta.readyState, 'READY', `Vercel deployment ${TARGET_DEPLOYMENT_ID} must be READY (found: ${deploymentMeta.readyState})`);
  console.log('✓ Target deployment exists and is READY.');

  const deployedGitSha = deploymentMeta.meta?.githubCommitSha || deploymentMeta.meta?.gitCommitSha || deploymentMeta.gitSource?.sha;
  console.log('Deployed Git SHA:     ', deployedGitSha);
  assert.ok(deployedGitSha, `Vercel deployment ${TARGET_DEPLOYMENT_ID} must report a deployed Git commit SHA in metadata`);
  assert.strictEqual(deployedGitSha, TARGET_COMMIT, `Deployed Git commit SHA (${deployedGitSha}) must match target commit (${TARGET_COMMIT})`);
  console.log('✓ Deployed Git SHA matches target commit exactly.');

  const expectedHost = new URL(PREVIEW_URL).hostname.toLowerCase();
  const actualHost = String(deploymentMeta.url || '').replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase();
  console.log('Target Preview Host:  ', expectedHost);
  console.log('Deployed Host:        ', actualHost);
  assert.strictEqual(actualHost, expectedHost, `Deployed host (${actualHost}) must match target preview host (${expectedHost})`);
  console.log('✓ Deployed host matches target preview URL host exactly.');

  // GitHub Commit Status Cross-Reference (Must confirm Vercel deployment for TARGET_COMMIT)
  const rawStatuses = execSync(`gh api repos/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/commits/${TARGET_COMMIT}/statuses`, { encoding: 'utf-8' });
  const statuses = JSON.parse(rawStatuses);
  const shortId = TARGET_DEPLOYMENT_ID.replace('dpl_', '');
  const vercelStatus = statuses.find((s: any) =>
    s.context === 'Vercel' &&
    (s.state === 'success' || s.description?.toLowerCase().includes('completed')) &&
    (s.target_url?.includes(TARGET_DEPLOYMENT_ID) || s.target_url?.includes(shortId))
  );
  assert.ok(
    vercelStatus,
    `GitHub commit status for ${TARGET_COMMIT} must confirm successful Vercel deployment matching ${TARGET_DEPLOYMENT_ID}`
  );
  console.log(`✓ GitHub commit status confirms Vercel deployment ${TARGET_DEPLOYMENT_ID} on commit ${TARGET_COMMIT}.`);
}

async function clickNewChat(page: Page): Promise<void> {
  console.log('\n[TRANSITION] Starting new conversation for next scenario...');
  
  // 1. Try keyboard shortcut Ctrl+N
  await page.keyboard.press('Control+n');
  await page.waitForTimeout(600);
  let count = await page.locator(ASSISTANT_SELECTOR).count();
  if (count === 0) {
    console.log('✓ Reset conversation via keyboard shortcut (Ctrl+N).');
    return;
  }

  // 2. Try clicking "Start new chat" button in sidebar if already open
  const startNewChatBtn = page.locator('button:has-text("Start new chat"), button:has-text("New chat"), button[aria-label="New chat"]').first();
  if (await startNewChatBtn.isVisible()) {
    await startNewChatBtn.click();
    await page.waitForTimeout(600);
    count = await page.locator(ASSISTANT_SELECTOR).count();
    if (count === 0) {
      console.log('✓ Reset conversation via sidebar button.');
      return;
    }
  }

  // 3. Try opening sidebar drawer if collapsed, then click
  const openSidebarBtn = page.locator('button[aria-label="Open sidebar navigation"], button[title="Open sidebar"]').first();
  if (await openSidebarBtn.isVisible()) {
    await openSidebarBtn.click();
    await page.waitForTimeout(400);
    if (await startNewChatBtn.isVisible()) {
      await startNewChatBtn.click();
      await page.waitForTimeout(600);
      count = await page.locator(ASSISTANT_SELECTOR).count();
      if (count === 0) {
        console.log('✓ Reset conversation via opened sidebar drawer.');
        return;
      }
    }
  }

  // 4. Fallback: navigate to clean root URL
  console.log('Navigating to root URL to reset conversation...');
  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  const textarea = page.locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 15000 });
}

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

async function saveEvidenceScreenshot(page: Page, filename: string): Promise<string> {
  const p1 = path.join(OUTPUT_DIR, filename);
  const p2 = path.join(ARTIFACTS_DIR, filename);
  await page.screenshot({ path: p1, fullPage: true });
  try {
    fs.copyFileSync(p1, p2);
  } catch (err: any) {
    console.warn(`[WARN] Could not copy screenshot to ${p2}: ${err.message}`);
  }
  return p1;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const consoleErrors: string[] = [];
  const results: AcceptanceEvidence[] = [];

  // Enforce pre-conditions
  verifyTargetDeployment();

  const bypassSecret = getAutomationBypassSecret();
  console.log('Bypass Secret:     ', bypassSecret ? 'CONFIGURED (Active)' : 'NOT PRESENT');
  console.log('Auth Storage:      ', fs.existsSync(AUTH_STATE_PATH) ? `FOUND (${AUTH_STATE_PATH})` : 'NOT FOUND');
  console.log('Target URL:        ', PREVIEW_URL);
  console.log('Deployment ID:     ', TARGET_DEPLOYMENT_ID);
  console.log('Browser Channel:    Microsoft Edge (channel: msedge)');

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
    const screenshotA = await saveEvidenceScreenshot(page, 'test_a_avatar_box_office.png');

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
    await clickNewChat(page);

    const promptB = "What is today's weather forecast for Tokyo, Japan? Use date-specific evidence, not monthly climate averages.";
    const startB = Date.now();
    const responseB = await sendMessageAndWaitForResponse(page, promptB);
    const durationB = Date.now() - startB;
    const sourcesB = await extractSourceLinks(page);
    const screenshotB = await saveEvidenceScreenshot(page, 'test_b_tokyo_weather.png');

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
    await clickNewChat(page);

    const promptC = "What is NVIDIA's latest share price? Distinguish the previous close and premarket quote, with timestamps.";
    const startC = Date.now();
    const responseC = await sendMessageAndWaitForResponse(page, promptC);
    const durationC = Date.now() - startC;
    const sourcesC = await extractSourceLinks(page);
    const screenshotC = await saveEvidenceScreenshot(page, 'test_c_nvidia_financial.png');

    console.log(`Test C Response Length: ${responseC.length} chars (took ${(durationC/1000).toFixed(1)}s)`);
    console.log('Test C Sources Found:', sourcesC);
    assert.ok(responseC.length > 50, 'Test C response must not be empty');
    if (/9:30\s*AM/i.test(responseC)) {
      assert.doesNotMatch(responseC, /9:30\s*AM[^\n]*(?:is\s+pre-?market|\(pre-?market\)|session:\s*pre-?market|classified as pre-?market)/i, '9:30 AM Eastern must never be called premarket');
    }
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
    await clickNewChat(page);

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

    const screenshotD = await saveEvidenceScreenshot(page, 'test_d_multi_turn_persistence.png');

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

    // -------------------------------------------------------------------------
    // TEST E1: Explicit NVIDIA Nemotron Selection (Authoritative Provenance)
    // -------------------------------------------------------------------------
    console.log('\n========================================================================');
    console.log('  TEST E1: Explicit NVIDIA Nemotron Selection (No Fallback)             ');
    console.log('========================================================================');
    await clickNewChat(page);

    // Switch model to NVIDIA Nemotron 3 Super 120B-A12B via role="option" in model-menu
    const modelSelectorTrigger = page.locator('header button[aria-haspopup="listbox"]').first();
    await modelSelectorTrigger.waitFor({ state: 'visible', timeout: 10000 });
    await modelSelectorTrigger.click();
    await page.waitForSelector('[data-testid="model-menu"]', { state: 'visible', timeout: 5000 });

    const nemotronOption = page.locator('[data-testid="model-menu"] [role="option"]:has-text("Nemotron")').first();
    await nemotronOption.click();
    await page.waitForTimeout(500);

    // Verify selector trigger text now reflects explicit Nemotron
    const triggerTextAfterNemotron = (await modelSelectorTrigger.innerText()).trim();
    console.log('Trigger after Nemotron selection:', triggerTextAfterNemotron);
    assert.match(triggerTextAfterNemotron, /Nemotron/i, 'Trigger button must show Nemotron when explicitly selected');

    const promptE1 = 'HOW CAPABLE ARE YOU';
    const startE1 = Date.now();
    const responseE1 = await sendMessageAndWaitForResponse(page, promptE1);
    const durationE1 = Date.now() - startE1;
    const screenshotE1 = await saveEvidenceScreenshot(page, 'test_e1_explicit_nemotron.png');

    console.log(`Test E1 Response Length: ${responseE1.length} chars (took ${(durationE1/1000).toFixed(1)}s)`);
    console.log('Test E1 Response snippet:', responseE1.slice(0, 300));
    assert.ok(responseE1.length > 50, 'Test E1 response must not be empty');
    assert.doesNotMatch(responseE1, /Claude 3\.7/i, 'Must NEVER claim to be powered by Claude 3.7');
    assert.doesNotMatch(responseE1, /Claude 3\.5/i, 'Must NEVER claim to be powered by Claude 3.5');

    // Verify explicit Nemotron provenance badge
    const badgeE1 = page.locator('[data-testid="model-provenance-badge"]').last();
    await badgeE1.waitFor({ state: 'visible', timeout: 10000 });
    const badgeTextE1 = (await badgeE1.innerText()).trim();
    console.log('Test E1 Provenance Badge Text:', badgeTextE1);
    assert.match(badgeTextE1, /NVIDIA/i, 'Badge must indicate NVIDIA provider');
    assert.match(badgeTextE1, /NEMOTRON/i, 'Badge must indicate Nemotron model');
    assert.doesNotMatch(badgeTextE1, /fallback/i, 'Explicit Nemotron must NOT be labeled as fallback');
    assert.doesNotMatch(badgeTextE1, /failed/i, 'Successful response must NOT be labeled as failed');

    results.push({
      testId: 'TEST_E1_EXPLICIT_NVIDIA_NEMOTRON',
      prompt: promptE1,
      response: responseE1,
      sourceLinks: await extractSourceLinks(page),
      consoleErrors: [...consoleErrors],
      screenshotPath: screenshotE1,
      durationMs: durationE1,
      metadata: { badgeText: badgeTextE1 }
    });

    // -------------------------------------------------------------------------
    // TEST E2: AIRA Auto Selection (Dynamic Routing with Preview Fallback)
    // -------------------------------------------------------------------------
    console.log('\n========================================================================');
    console.log('  TEST E2: AIRA Auto Selection (Intent Routing & Preview Notice)        ');
    console.log('========================================================================');
    await clickNewChat(page);

    // Switch model back to Aira Auto
    await modelSelectorTrigger.click();
    await page.waitForSelector('[data-testid="model-menu"]', { state: 'visible', timeout: 5000 });
    const autoOption = page.locator('[data-testid="model-menu"] [role="option"]:has-text("Aira Auto")').first();
    await autoOption.click();
    await page.waitForTimeout(500);

    const triggerTextAfterAuto = (await modelSelectorTrigger.innerText()).trim();
    console.log('Trigger after Aira Auto selection:', triggerTextAfterAuto);
    assert.match(triggerTextAfterAuto, /Aira Auto/i, 'Trigger button must show Aira Auto');

    const promptE2 = 'HOW CAPABLE ARE YOU';
    const startE2 = Date.now();
    const responseE2 = await sendMessageAndWaitForResponse(page, promptE2);
    const durationE2 = Date.now() - startE2;
    const screenshotE2 = await saveEvidenceScreenshot(page, 'test_e2_aira_auto.png');

    console.log(`Test E2 Response Length: ${responseE2.length} chars (took ${(durationE2/1000).toFixed(1)}s)`);
    assert.ok(responseE2.length > 50, 'Test E2 response must not be empty');
    assert.doesNotMatch(responseE2, /Claude 3\.7/i, 'Must NEVER claim to be powered by Claude 3.7');

    const badgeE2 = page.locator('[data-testid="model-provenance-badge"]').last();
    await badgeE2.waitFor({ state: 'visible', timeout: 10000 });
    const badgeTextE2 = (await badgeE2.innerText()).trim();
    console.log('Test E2 Provenance Badge Text:', badgeTextE2);
    assert.match(badgeTextE2, /NVIDIA/i, 'Badge must indicate routed NVIDIA execution');
    assert.match(badgeTextE2, /Fallback/i, 'Aira Auto on Preview must show fallback notice because Anthropic key is absent');
    assert.doesNotMatch(badgeTextE2, /failed/i, 'Successful response must NOT be labeled as failed');

    results.push({
      testId: 'TEST_E2_AIRA_AUTO_ROUTING',
      prompt: promptE2,
      response: responseE2,
      sourceLinks: await extractSourceLinks(page),
      consoleErrors: [...consoleErrors],
      screenshotPath: screenshotE2,
      durationMs: durationE2,
      metadata: { badgeText: badgeTextE2 }
    });

    // Write acceptance report artifact
    const reportPath = path.join(OUTPUT_DIR, 'acceptance-evidence.json');
    const finalReport: AcceptanceReport = {
      targetCommit: TARGET_COMMIT,
      targetDeploymentId: TARGET_DEPLOYMENT_ID,
      previewUrl: PREVIEW_URL,
      timestamp: new Date().toISOString(),
      overallStatus: 'PASS',
      fontCorsErrors: fontErrors,
      tests: results
    };
    fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2));
    try {
      fs.writeFileSync(path.join(ARTIFACTS_DIR, 'acceptance-evidence.json'), JSON.stringify(finalReport, null, 2));
    } catch (err: any) {
      console.warn(`[WARN] Could not copy report to artifacts dir: ${err.message}`);
    }
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
