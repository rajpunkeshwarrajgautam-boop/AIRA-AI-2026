import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = Number(process.env.PHASE5_PORT || 4185);
const base = process.env.PHASE5_URL || `http://127.0.0.1:${port}`;
const externalServer = Boolean(process.env.PHASE5_URL);
const baseline = process.env.PHASE5_FLAG_OFF === 'true';

async function ready(url) {
  for (let count = 0; count < 80; count++) {
    try { if ((await fetch(url)).ok) return; } catch { /* server booting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`No local Vite response at ${url}`);
}

async function launchBrowser() {
  if (process.platform === 'win32' && process.env.PHASE5_BROWSER !== 'chromium') {
    return chromium.launch({ channel: 'msedge', headless: true });
  }
  const chromiumBundle = (await import('@sparticuz/chromium')).default;
  return chromium.launch({ executablePath: await chromiumBundle.executablePath(), args: chromiumBundle.args, headless: true });
}

const codeV1 = '<!doctype html><html><body><h1>Orbit version one</h1></body></html>';
const codeV2 = '<!doctype html><html><body><h1>Orbit version two</h1><button id="raise" onclick="Promise.reject(new Error(\'Phase5 simulated rejection\'))">Raise error</button></body></html>';

function seedFixture({ v1, v2 }) {
  if (window.top !== window) return;
  const timestamp = Date.now();
  const artifact = {
    id: 'phase5-demo-artifact', title: 'Orbit prototype', type: 'text/html', language: 'html',
    version: 2, content: v2,
    versions: [{ version: 1, content: v1, timestamp: timestamp - 3000 }, { version: 2, content: v2, timestamp }],
  };
  const conversation = {
    id: 'phase5-fixture-conversation', title: 'Phase 5 verification', createdAt: timestamp - 6000, updatedAt: timestamp,
    messages: [
      { id: 'user-demo', role: 'user', content: 'Show my orbit artifact', timestamp: timestamp - 5000 },
      { id: 'agent-demo', role: 'assistant', content: 'I prepared a revisioned prototype.', timestamp, artifacts: [artifact], agentEvents: [{ id: 'tool:abc', kind: 'tool', label: 'Tool write_file', status: 'completed', occurredAt: timestamp }] },
    ],
  };
  localStorage.setItem('aira_conversations_v1', JSON.stringify([conversation]));
  sessionStorage.setItem('aira_active_chat_session', conversation.id);
}

let server;
let browser;
try {
  if (!externalServer) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      env: { ...process.env, VITE_ADAPTIVE_STUDIO_PREVIEW: baseline ? 'false' : 'true' }, stdio: 'ignore', detached: false,
    });
  }
  await ready(base);
  browser = await launchBrowser();

  const viewports = baseline ? [{ width: 1600, height: 1000 }] : [{ width: 1600, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 700 }];
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(seedFixture, { v1: codeV1, v2: codeV2 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/?c=phase5-fixture-conversation`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="artifact-card"]').waitFor({ timeout: 12000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    assert.equal(overflow, false, `${viewport.width} viewport has horizontal document overflow`);

    if (baseline) {
      assert.equal(await page.locator('.aira-adaptive-shell').count(), 0);
      assert.equal(await page.locator('[data-testid="agent-execution-timeline"]').count(), 0);
      await page.locator('[data-testid="artifact-card"]').first().click();
      await page.locator('[data-testid="artifact-studio"]').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Diff', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Repair with Aira Agent' }).count(), 0);
      assert.deepEqual(errors, []);
      console.log('PASS 1600x1000: default-off legacy layout and artifact controls unchanged');
      break;
    }

    await page.locator('.aira-adaptive-shell').waitFor();

    await page.locator('[data-testid="agent-execution-timeline"]').waitFor();
    await page.locator('[data-testid="agent-execution-timeline"] summary').click();
    assert.equal(await page.locator('[data-agent-status="completed"]').count(), 1);
    await page.locator('[data-testid="artifact-card"]').first().click();
    await page.locator('[data-testid="artifact-studio"]').waitFor();
    assert.equal(await page.locator('iframe[title="Orbit prototype"]').getAttribute('sandbox'), 'allow-scripts allow-modals allow-forms');

    // A forged event from the host window must fail source and nonce validation.
    await page.evaluate(() => window.postMessage({ type: 'AIRA_ARTIFACT_RUNTIME_ERROR', nonce: 'forged', error: { message: 'forged error' } }, '*'));
    assert.equal(await page.locator('[data-testid="artifact-runtime-error"]').count(), 0);

    // On small screens the studio may overlay the chat; all actions are still reachable.
    await page.getByRole('button', { name: 'Diff', exact: true }).click();
    await page.locator('[data-testid="artifact-code-diff"]').waitFor();
    assert.match(await page.locator('[data-testid="artifact-code-diff"]').innerText(), /Orbit version two/);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    assert.deepEqual(errors, [], `${viewport.width} viewport had errors before intentional sandbox rejection`);
    const frame = page.frameLocator('iframe[title="Orbit prototype"]');
    await frame.locator('#raise').click({ timeout: 12000 });
    await page.locator('[data-testid="artifact-runtime-error"]').waitFor();
    await page.getByRole('button', { name: 'Repair with Aira Agent' }).click();
    assert.match(await page.locator('main textarea').inputValue(), /Phase5 simulated rejection/);
    await page.locator('select[aria-label="Artifact revision"]').selectOption('1');
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    assert.equal(await page.locator('select[aria-label="Artifact revision"]').inputValue(), '3');
    assert.equal(await page.locator('select[aria-label="Artifact revision"] option').count(), 3);
    assert.deepEqual(errors.filter(message => !message.includes('Phase5 simulated rejection')), [], `${viewport.width} viewport produced unexpected console errors`);
    console.log(`PASS ${viewport.width}x${viewport.height}: layout, timeline, diff, error bridge, reviewable repair`);
    // Sparticuz single-process Chromium can exit on context teardown; closing
    // the whole browser below avoids a false negative on the next viewport.
  }
  console.log(baseline ? 'PHASE5_DEFAULT_OFF_BROWSER_PASS' : 'PHASE5_LOCAL_BROWSER_SMOKE_PASS');
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}
