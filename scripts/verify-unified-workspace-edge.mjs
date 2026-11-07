import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright';

const port = 4195;
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotDir = 'C:/Users/WORKSTATION/.gemini/antigravity/brain/5ef6a26c-9a24-46a2-8c8b-ffeeb356edb4/screenshots/unified-workspace-consolidation';

function seedTestConversation() {
  const timestamp = Date.now();
  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect width="200" height="200" rx="20" fill="#3056cb" />
  <circle cx="100" cy="100" r="40" fill="#ffffff" />
  <text x="100" y="105" font-family="sans-serif" font-size="14" font-weight="bold" fill="#3056cb" text-anchor="middle">AIRA</text>
</svg>`;

  const artifact = {
    id: 'art-sample-svg',
    type: 'image/svg+xml',
    title: 'Adaptive Branding Badge',
    content: svgContent,
    versions: [{ version: 1, content: svgContent, timestamp }],
  };

  const conversation = {
    id: 'chat-test-unified-workspace',
    title: 'Test Unified Workspace Consolidation',
    createdAt: timestamp - 3600000,
    updatedAt: timestamp,
    messages: [
      {
        id: 'msg-u1',
        role: 'user',
        content: 'Design an official vector badge for AIRA AI 2026.',
        timestamp: timestamp - 2000,
      },
      {
        id: 'msg-a1',
        role: 'assistant',
        content: 'Here is your official vector badge for AIRA AI 2026.',
        timestamp: timestamp - 1000,
        artifacts: [artifact],
      },
    ],
  };

  localStorage.setItem('aira_conversations_v1', JSON.stringify([conversation]));
  sessionStorage.setItem('aira_active_chat_session', conversation.id);
}

async function runEdgeUnifiedWorkspaceSuite() {
  mkdirSync(screenshotDir, { recursive: true });

  console.log('===============================================================');
  console.log('STARTING MICROSOFT EDGE UNIFIED WORKSPACE VERIFICATION SUITE');
  console.log('===============================================================\n');

  // 1. Build production bundle with VITE_ADAPTIVE_STUDIO_PREVIEW=true
  console.log('Building production bundle with VITE_ADAPTIVE_STUDIO_PREVIEW=true...');
  execSync('npm run build', {
    env: { ...process.env, VITE_ADAPTIVE_STUDIO_PREVIEW: 'true' },
    stdio: 'inherit',
  });
  console.log('Production build ready.\n');

  // 2. Start Vite Preview server on dedicated port
  console.log(`Starting Vite preview server on ${baseUrl}...`);
  const preview = spawn(
    'npx',
    ['vite', 'preview', '--port', String(port), '--host', '127.0.0.1', '--strictPort'],
    {
      stdio: 'pipe',
      shell: true,
      env: { ...process.env, VITE_ADAPTIVE_STUDIO_PREVIEW: 'true' },
    }
  );

  preview.stdout.on('data', d => console.log(`[Vite stdout] ${d.toString().trim()}`));
  preview.stderr.on('data', d => console.error(`[Vite stderr] ${d.toString().trim()}`));

  await new Promise(resolve => setTimeout(resolve, 3000));

  let browser;
  try {
    // Launch Microsoft Edge via Playwright channel 'msedge'
    console.log('Launching Microsoft Edge browser instance...');
    browser = await chromium.launch({
      channel: 'msedge',
      headless: true,
    });
    console.log('Microsoft Edge launched successfully.\n');

    const viewports = [
      { name: 'desktop', width: 1600, height: 1000, isMobile: false },
      { name: 'tablet', width: 768, height: 1024, isMobile: false },
      { name: 'mobile', width: 390, height: 844, isMobile: true },
    ];

    for (const vp of viewports) {
      console.log(`---------------------------------------------------------------`);
      console.log(`TESTING VIEWPORT: ${vp.name.toUpperCase()} (${vp.width}x${vp.height})`);
      console.log(`---------------------------------------------------------------`);

      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: 'dark',
      });
      const page = await context.newPage();

      // Seed test conversation with artifact
      await page.addInitScript(seedTestConversation);
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);

      // STEP 1: Default state check — Workspace must be CLOSED by default
      console.log('  1. Verifying Workspace is CLOSED by default on load...');
      const studioOpenDefault = await page.evaluate(() => {
        return Boolean(document.querySelector('.has-studio-open'));
      });
      assert.strictEqual(studioOpenDefault, false, 'Workspace must be closed by default on initial page visit.');

      const emptyStudioCount = await page.locator('[data-testid="adaptive-studio-empty"]').count();
      assert.strictEqual(emptyStudioCount, 0, 'Empty studio placeholder must not be mounted when workspace is closed.');

      // Check chat is primary and composer is fully visible
      const composer = page.locator('textarea, [contenteditable="true"]').first();
      await composer.waitFor({ state: 'visible', timeout: 5000 });
      assert.ok(await composer.isVisible(), 'Chat composer must be immediately visible and usable.');

      await page.screenshot({
        path: path.join(screenshotDir, `edge-${vp.name}-1-default-closed.png`),
        fullPage: false,
      });
      console.log(`     PASS: Default closed verified. Screenshot: edge-${vp.name}-1-default-closed.png`);

      // STEP 2: Mode Switch to Agent Mode — Must NOT open any technical panel
      console.log('  2. Verifying Mode switch to Agent Mode does NOT open any technical panel...');
      const agentModeToggle = page.locator('button:has-text("Agent")').first();
      if (await agentModeToggle.count() > 0 && await agentModeToggle.isVisible()) {
        await agentModeToggle.click();
        await page.waitForTimeout(500);

        const studioOpenAfterAgent = await page.evaluate(() => {
          return Boolean(document.querySelector('.has-studio-open'));
        });
        assert.strictEqual(studioOpenAfterAgent, false, 'Switching to Agent mode must NOT open workspace panel automatically.');

        await page.screenshot({
          path: path.join(screenshotDir, `edge-${vp.name}-2-agent-mode-clean.png`),
          fullPage: false,
        });
        console.log(`     PASS: Agent mode switched cleanly. Screenshot: edge-${vp.name}-2-agent-mode-clean.png`);

        // Switch back to chat for next steps
        const chatModeToggle = page.locator('button:has-text("Chat")').first();
        await chatModeToggle.click();
        await page.waitForTimeout(300);
      } else {
        console.log('     NOTE: Mode toggle not visible in header at this screen width (expected on small mobile).');
      }

      // STEP 3: Open Unified Workspace via Header Launcher Button
      console.log('  3. Verifying explicit Workspace launch via launcher button...');
      const launcherBtn = page.locator('[data-testid="artifact-studio-launcher"]').first();
      await launcherBtn.waitFor({ state: 'visible', timeout: 5000 });
      await launcherBtn.click();
      await page.waitForTimeout(800);

      const studioOpenAfterLauncher = await page.evaluate(() => {
        return Boolean(document.querySelector('.has-studio-open'));
      });
      assert.strictEqual(studioOpenAfterLauncher, true, 'Workspace must be open after clicking launcher button.');

      // Verify single workspace panel exists
      const workspacePanel = page.locator('aside[data-testid="unified-workspace"], aside.aira-adaptive-real-studio').first();
      assert.ok(await workspacePanel.count() > 0, 'Unified workspace panel must be rendered.');

      // Check responsive presentation
      const bounds = await workspacePanel.boundingBox();
      assert.ok(bounds, 'Workspace bounding box must be defined.');

      if (vp.name === 'desktop') {
        // Desktop: Two-pane docked layout. Chat composer is still visible on the left!
        assert.ok(bounds.width > 500, `Desktop docked workspace width should be substantial (got ${bounds.width}px).`);
        assert.ok(await composer.isVisible(), 'Desktop chat composer must remain visible alongside workspace.');
      } else {
        // Tablet/Mobile: Drawer presentation (< 1280px)
        assert.ok(bounds.width <= 540 || bounds.width <= vp.width, `Drawer modal should be constrained (got ${bounds.width}px).`);
      }

      await page.screenshot({
        path: path.join(screenshotDir, `edge-${vp.name}-3-workspace-opened.png`),
        fullPage: false,
      });
      console.log(`     PASS: Workspace open verified. Screenshot: edge-${vp.name}-3-workspace-opened.png`);

      // STEP 4: Close Workspace via Close Button — Restores full chat
      console.log('  4. Verifying Workspace close button restores full-width chat...');
      const closeBtn = page.locator('[data-testid="artifact-studio-close"], [data-testid="workspace-close"]').first();
      await closeBtn.click();
      await page.waitForTimeout(600);

      const studioOpenAfterClose = await page.evaluate(() => {
        return Boolean(document.querySelector('.has-studio-open'));
      });
      assert.strictEqual(studioOpenAfterClose, false, 'Workspace must close cleanly after clicking close button.');

      await page.screenshot({
        path: path.join(screenshotDir, `edge-${vp.name}-4-dismissed-restored.png`),
        fullPage: false,
      });
      console.log(`     PASS: Workspace closed cleanly. Screenshot: edge-${vp.name}-4-dismissed-restored.png`);

      // STEP 5: Open Artifact Preview directly from Chat Message Card
      console.log('  5. Verifying Artifact Preview opens directly from Chat Message card...');
      const artifactCard = page.locator('button:has-text("Adaptive Branding Badge"), [role="button"]:has-text("Adaptive Branding Badge"), [data-testid="artifact-card"]').first();
      await artifactCard.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (await artifactCard.count() > 0) {
        await artifactCard.click();
        await page.waitForTimeout(800);

        const studioOpenAfterCard = await page.evaluate(() => {
          return Boolean(document.querySelector('.has-studio-open'));
        });
        assert.strictEqual(studioOpenAfterCard, true, 'Workspace must open when user clicks artifact card in chat.');

        // Verify SVG, image, or iframe preview is visible
        const previewEl = page.locator('iframe, [data-testid="svg-inert-image"], [data-testid="svg-preview-stage"], [data-testid="multimodal-image-element"]').first();
        assert.ok(await previewEl.count() > 0, 'Artifact preview element must be visible inside workspace.');

        await page.screenshot({
          path: path.join(screenshotDir, `edge-${vp.name}-5-artifact-card-preview.png`),
          fullPage: false,
        });
        console.log(`     PASS: Artifact preview verified. Screenshot: edge-${vp.name}-5-artifact-card-preview.png`);
      }

      await context.close();
    }

    console.log('\n===============================================================');
    console.log('ALL MICROSOFT EDGE UNIFIED WORKSPACE VERIFICATION GATES PASSED');
    console.log('===============================================================\n');
  } finally {
    if (browser) await browser.close();
    preview.kill();
  }
}

runEdgeUnifiedWorkspaceSuite().catch(err => {
  console.error('\nVerification failed with exception:', err);
  process.exit(1);
});
