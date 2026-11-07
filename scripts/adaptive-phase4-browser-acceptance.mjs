import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const port = Number(process.env.PHASE4_PORT || 4176);
const base = process.env.PHASE4_URL || `http://127.0.0.1:${port}`;
const externalServer = Boolean(process.env.PHASE4_URL);
const baseline = process.env.PHASE4_FLAG_OFF === 'true';
const artifactDir = 'C:/Users/WORKSTATION/.gemini/antigravity/brain/4692c5e1-8fc6-437f-8dc1-b5e0ba492b84';

async function ready(url) {
  for (let count = 0; count < 80; count++) {
    try { if ((await fetch(url)).ok) return; } catch { /* booting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`No local Vite response at ${url}`);
}

async function launchBrowser() {
  if (process.platform === 'win32' && process.env.PHASE4_BROWSER !== 'chromium') {
    return chromium.launch({ channel: 'msedge', headless: true });
  }
  const chromiumBundle = (await import('@sparticuz/chromium')).default;
  return chromium.launch({ executablePath: await chromiumBundle.executablePath(), args: chromiumBundle.args, headless: true });
}

const codeV1 = '<!doctype html><html><body style="font-family:sans-serif;padding:24px;background:#0d1117;color:#c9d1d9;"><h1>Orbit version one</h1></body></html>';
const codeV2 = '<!doctype html><html><body style="font-family:sans-serif;padding:24px;background:#0d1117;color:#c9d1d9;"><h1>Orbit version two</h1><button id="raise" onclick="Promise.reject(new Error(\'Phase4 test\'))">Raise error</button></body></html>';
const codeStyles = 'body { background: #0d1117; color: #58a6ff; font-family: monospace; } h1 { border-bottom: 1px solid #30363d; }';

function seedFixture({ v1, v2, styles }) {
  if (window.top !== window) return;
  const timestamp = Date.now();
  const artifact1 = {
    id: 'phase4-orbit-artifact', title: 'Orbit prototype', type: 'text/html', language: 'html',
    version: 2, content: v2,
    versions: [{ version: 1, content: v1, timestamp: timestamp - 3000 }, { version: 2, content: v2, timestamp }],
  };
  const artifact2 = {
    id: 'phase4-styles-artifact', title: 'Solar Stylesheet', type: 'text/css', language: 'css',
    version: 1, content: styles,
    versions: [{ version: 1, content: styles, timestamp }],
  };
  const conversation = {
    id: 'phase4-fixture-conversation', title: 'Phase 4 verification', createdAt: timestamp - 6000, updatedAt: timestamp,
    messages: [
      { id: 'user-demo', role: 'user', content: 'Create solar simulation with stylesheet', timestamp: timestamp - 5000 },
      { 
        id: 'agent-demo', 
        role: 'assistant', 
        content: 'I generated the simulation and external stylesheet.', 
        timestamp, 
        artifacts: [artifact1, artifact2], 
        agentEvents: [
          { id: 'tool:write-orbit', kind: 'tool', label: 'Tool write_file: orbit.html', status: 'completed', occurredAt: timestamp - 1000 },
          { id: 'tool:approval-deploy', kind: 'approval', label: 'Approval required for deploy_site', status: 'waiting', occurredAt: timestamp }
        ] 
      },
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
      env: { ...process.env, VITE_ADAPTIVE_STUDIO_PREVIEW: baseline ? 'false' : 'true' },
      cwd: 'D:/AIRA-PHASE4-WORKTREE',
      stdio: 'ignore',
    });
  }
  await ready(base);
  browser = await launchBrowser();

  const viewports = baseline
    ? [{ width: 1600, height: 1000 }]
    : [{ width: 1600, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 700 }];

  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(seedFixture, { v1: codeV1, v2: codeV2, styles: codeStyles });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(`${base}/?c=phase4-fixture-conversation`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="artifact-card"]').first().waitFor({ timeout: 12000 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    assert.equal(overflow, false, `${viewport.width} viewport has horizontal document overflow`);

    if (baseline) {
      assert.equal(await page.locator('.aira-adaptive-shell').count(), 0);
      assert.equal(await page.locator('[data-testid="hitl-approval-card"]').count(), 0);
      await page.locator('[data-testid="artifact-card"]').first().click();
      await page.locator('[data-testid="artifact-studio"]').waitFor();
      assert.equal(await page.locator('[data-testid="artifact-canvas-controls"]').count(), 0);
      assert.equal(await page.locator('[data-testid="artifact-carousel"]').count(), 0);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(artifactDir, 'phase4-edge-default-off-baseline.png') });
      console.log('PASS 1600x1000: default-off legacy layout and controls verified');
      break;
    }

    // Adaptive Mode Checks
    await page.locator('.aira-adaptive-shell').waitFor();

    // 1. HITL Tool Approval Card in timeline
    await page.locator('[data-testid="agent-execution-timeline"]').waitFor();
    await page.locator('[data-testid="agent-execution-timeline"] summary').click();
    await page.locator('[data-testid="hitl-approval-card"]').waitFor();
    assert.equal(await page.locator('[data-testid="hitl-approve-btn"]').count(), 1);
    assert.equal(await page.locator('[data-testid="hitl-reject-btn"]').count(), 1);

    // 2. Open ArtifactStudio
    await page.locator('[data-testid="artifact-card"]').first().click();
    await page.locator('[data-testid="artifact-studio"]').waitFor();

    if (viewport.width === 1600) {
      await page.screenshot({ path: path.join(artifactDir, 'phase4-edge-desktop-1600x1000-studio.png') });
      await page.screenshot({ path: path.join(artifactDir, 'phase4-edge-desktop-1600x1000-hitl-approval-card.png') });

      // 3. Multi-Artifact Carousel
      await page.locator('[data-testid="artifact-carousel"]').waitFor();
      assert.match(await page.locator('[data-testid="artifact-carousel-indicator"]').innerText(), /1 of 2/);
      
      // Click next artifact -> Solar Stylesheet
      await page.locator('[data-testid="artifact-next"]').click();
      await page.waitForTimeout(400);
      assert.match(await page.locator('[data-testid="artifact-carousel-indicator"]').innerText(), /2 of 2/);
      await page.screenshot({ path: path.join(artifactDir, 'phase4-edge-desktop-1600x1000-multi-artifact-carousel.png') });

      // Return to first artifact
      await page.locator('[data-testid="artifact-prev"]').click();
      await page.waitForTimeout(400);
      assert.match(await page.locator('[data-testid="artifact-carousel-indicator"]').innerText(), /1 of 2/);

      // 4. Canvas Zoom & Device Emulation Controls
      await page.locator('[data-testid="artifact-canvas-controls"]').waitFor();

      // Test Zoom In
      await page.locator('[data-testid="zoom-in"]').click();
      await page.waitForTimeout(300);
      assert.match(await page.locator('[data-testid="zoom-reset"]').innerText(), /125%/);
      await page.screenshot({ path: path.join(artifactDir, 'phase4-edge-desktop-1600x1000-canvas-controls-zoom.png') });

      // Test Zoom Reset
      await page.locator('[data-testid="zoom-reset"]').click();
      await page.waitForTimeout(300);
      assert.match(await page.locator('[data-testid="zoom-reset"]').innerText(), /100%/);

      // Test Device Preset Mobile (375px frame)
      await page.locator('[data-testid="device-preset-mobile"]').click();
      await page.waitForTimeout(300);
      const frameWidth = await page.locator('[data-testid="artifact-device-frame"]').evaluate(el => el.style.width);
      assert.equal(frameWidth, '375px');
      await page.screenshot({ path: path.join(artifactDir, 'phase4-edge-desktop-1600x1000-device-frame-mobile.png') });

      // Reset to Desktop
      await page.locator('[data-testid="device-preset-desktop"]').click();
      await page.waitForTimeout(300);
      const deskWidth = await page.locator('[data-testid="artifact-device-frame"]').evaluate(el => el.style.width);
      assert.equal(deskWidth, '100%');
    } else if (viewport.width === 768) {
      await page.screenshot({ path: path.join(artifactDir, 'phase4-edge-tablet-768x1024.png') });
    } else if (viewport.width === 390) {
      await page.screenshot({ path: path.join(artifactDir, 'phase4-edge-mobile-390x844.png') });
    } else if (viewport.width === 320) {
      await page.screenshot({ path: path.join(artifactDir, 'phase4-edge-small-mobile-320x700.png') });
    }

    assert.deepEqual(errors, [], `${viewport.width} viewport produced unexpected console errors`);
    console.log(`PASS ${viewport.width}x${viewport.height}: overflow, canvas controls, multi-artifact, HITL approval`);
    await context.close();
  }

  console.log(baseline ? 'PHASE4_DEFAULT_OFF_BROWSER_PASS' : 'PHASE4_EDGE_BROWSER_ACCEPTANCE_PASS');
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}
