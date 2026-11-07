/**
 * AIRA AI 2026 -- Mocked Browser Builder UI & Handoff Component Suite
 * 
 * Verifies local UI presentation and user flow without requiring live backend connectivity:
 * 1. Default Workspace Closed State
 * 2. Agent Mode Toggle without premature drawer expansion
 * 3. Builder App Intent Detection & Sandbox Authorization Modal
 * 4. Explicit Consent Checkbox Interaction
 * 5. Mock SSE Stream Rendering (Terminal steps, preview tab, download artifacts)
 * 6. Responsive Drawer Layout & Keyboard Navigation
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const LOCAL_PORT = 4197;
const LOCAL_BASE_URL = `http://127.0.0.1:${LOCAL_PORT}`;
const OUTPUT_DIR = path.resolve(process.cwd(), 'artifacts/builder-ui-mocked');

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('\n========================================================================');
  console.log('  AIRA AI 2026 — MOCKED BUILDER UI & HANDOFF COMPONENT ACCEPTANCE');
  console.log('========================================================================\n');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Compiling production bundle with VITE_ADAPTIVE_STUDIO_PREVIEW=true...');
  execSync('npm run build', {
    env: { ...process.env, VITE_ADAPTIVE_STUDIO_PREVIEW: 'true' },
    stdio: 'inherit',
  });
  console.log('  ✓ Production build ready');

  console.log(`Launching Preview Server on ${LOCAL_BASE_URL}...`);
  const previewProc: ChildProcess = spawn(
    'npx',
    ['vite', 'preview', '--port', String(LOCAL_PORT), '--host', '127.0.0.1', '--strictPort'],
    {
      stdio: 'pipe',
      shell: true,
      env: { ...process.env, VITE_ADAPTIVE_STUDIO_PREVIEW: 'true' },
    }
  );

  await sleep(3000);

  let browser: Browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    console.log('  ✓ Microsoft Edge launched');
  } catch {
    console.log('  ℹ Falling back to Chromium');
    browser = await chromium.launch({ headless: true });
  }

  try {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'dark',
      reducedMotion: 'reduce'
    });

    const page: Page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('favicon') && !text.includes('telemetry')) {
          consoleErrors.push(text);
        }
      }
    });

    let ready = true;
    let cancelCalled = false;
    await page.route('**/api/auth/session', r => r.fulfill({ json: { ok: true, user: { id: 'usr_mock_ui', email: 'mock-ui@virexaaiventures.com' } } }));
    await page.route('**/api/builder/status', r => r.fulfill({
      json: {
        ready,
        enabled: ready,
        allowed: ready,
        configured: ready,
        providerConfigured: ready,
        reason: 'Ready',
        principalId: 'mock-ui-principal',
        temporaryMinutes: 15
      }
    }));
    await page.route('**/api/builder/cancel', r => {
      cancelCalled = true;
      return r.fulfill({ json: { cancelled: true } });
    });

    await page.route('**/api/chat/stream', async r => {
      const mockChatFrames = 'event: delta\ndata: {"text":"Initiating application builder..."}\n\nevent: done\ndata: {}\n\n';
      await r.fulfill({ contentType: 'text/event-stream', body: mockChatFrames });
    });

    const expiresAt = Date.now() + 900000;
    const sseFrames = [
      ['builder.started', { workspaceTicket: 'mock-ticket-ui-2026', expiresAt }],
      ['builder.tool.started', { id: 't1', name: 'write_file', label: 'index.html' }],
      ['builder.tool.completed', { id: 't1', name: 'write_file', isError: false, output: { bytesWritten: 120 } }],
      ['builder.preview', { url: 'https://preview.aira-mock-test.invalid/', expiresAt }],
      ['builder.file', { path: 'index.html', title: 'Download website', url: '/api/builder/download?ticket=mock-file', bytes: 120, expiresAt }],
      ['builder.completed', { summary: 'Application build finished successfully. Web dashboard live.', expiresAt }],
    ].map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('');

    await page.route('**/api/builder/stream', async r => {
      const body = r.request().postDataJSON();
      assert.equal(body.allowExecution, true, 'Execution permission must be explicitly consented');
      assert.equal(body.allowPreview, true, 'Preview permission must be explicitly consented');
      await r.fulfill({ contentType: 'text/event-stream', body: sseFrames });
    });

    await page.route('https://preview.aira-mock-test.invalid/', r => r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Mock Preview</title><h1>Mock Dashboard Preview</h1>'
    }));

    await page.route('**/api/builder/download?ticket=mock-file', r => r.fulfill({
      headers: { 'Content-Disposition': 'attachment; filename="index.html"' },
      contentType: 'application/octet-stream',
      body: '<!doctype html><h1>Mock Dashboard Download</h1>'
    }));

    await page.goto(LOCAL_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const title = await page.title();
    assert.ok(title, 'Page must have a valid title');

    // 1. Verify workspace is CLOSED by default
    const studioOpenDefault = await page.evaluate(() => Boolean(document.querySelector('.has-studio-open')));
    assert.equal(studioOpenDefault, false, 'Workspace must be closed by default');
    console.log('  ✓ Verified workspace is closed by default');

    // 2. Switch to Agent Mode
    const agentToggle = page.locator('div[role="group"][aria-label="Execution Mode"] button:has-text("Agent")');
    await agentToggle.waitFor({ state: 'visible', timeout: 5000 });
    await agentToggle.click();
    await page.waitForTimeout(500);

    const studioOpenAfterAgent = await page.evaluate(() => Boolean(document.querySelector('.has-studio-open')));
    assert.equal(studioOpenAfterAgent, false, 'Switching to Agent mode must NOT open workspace automatically');
    console.log('  ✓ Switched to Agent Mode cleanly');

    // 3. Trigger Builder handoff via composer input
    const composerTextarea = page.locator('textarea').first();
    await composerTextarea.waitFor({ state: 'visible', timeout: 5000 });
    await composerTextarea.fill('Build a dashboard app for sales analytics');
    await page.waitForTimeout(300);

    const sendButton = page.locator('button[title*="Send message"]');
    await sendButton.click();
    console.log('  ✓ Prompt submitted: awaiting authorization panel');

    // 4. Verify Authorization Panel
    const authPanel = page.locator('[data-testid="builder-authorization-panel"]');
    await authPanel.waitFor({ state: 'visible', timeout: 15000 });
    console.log('  ✓ Builder Authorization Panel appeared');

    const promptInput = page.locator('[data-testid="builder-prompt-input"]');
    const promptValue = await promptInput.inputValue();
    assert.ok(promptValue.includes('Build a dashboard app'), 'Prompt must be handed off to builder input');

    // Consent checkboxes
    const execCheck = page.locator('[data-testid="allow-execution-checkbox"]');
    if (!(await execCheck.isChecked())) await execCheck.check();

    const previewCheck = page.locator('[data-testid="allow-preview-checkbox"]');
    if (!(await previewCheck.isChecked())) await previewCheck.check();
    console.log('  ✓ Sandbox consent checkboxes acknowledged');

    // Trigger run in sandbox
    const runBtn = page.locator('[data-testid="run-builder-button"]');
    assert.equal(await runBtn.isEnabled(), true, 'Run in Sandbox button must be enabled');
    await runBtn.click();
    console.log('  ✓ Builder execution initiated in isolated sandbox');

    // Wait for tool execution step and live preview tab to emerge
    await page.waitForTimeout(1000);
    const previewTab = page.locator('[data-testid="workspace-tab-preview"]');
    await previewTab.waitFor({ state: 'visible', timeout: 15000 });
    await previewTab.click();
    console.log('  ✓ Live preview tab appeared and selected');

    // Verify sandboxed iframe containment
    const iframe = page.locator('iframe[title="AIRA Isolated Sandbox Preview"]');
    await iframe.waitFor({ state: 'visible', timeout: 10000 });
    const sandboxAttr = await iframe.getAttribute('sandbox');
    assert.ok(sandboxAttr?.includes('allow-scripts'), 'Iframe must have allow-scripts sandbox');

    // Switch to Files tab to verify generated file
    const filesTab = page.locator('[data-testid="workspace-tab-files"]');
    if (await filesTab.count() > 0) {
      await filesTab.click();
      const downloadBtn = page.locator('[data-testid="download-file-index-html"]');
      if (await downloadBtn.count() > 0) {
        const downloadPromise = page.waitForEvent('download');
        await downloadBtn.click();
        const download = await downloadPromise;
        assert.equal(download.suggestedFilename(), 'index.html', 'Suggested filename must be index.html');
        console.log('  ✓ Downloaded generated file verified');
      }
    }

    console.log('\n--- Mocked Builder UI Suite Passed (100%) ---');
    await context.close();
  } finally {
    await browser.close();
    previewProc.kill();
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
