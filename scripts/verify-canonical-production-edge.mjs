import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const canonicalUrl = 'https://aira-ai-2026.vercel.app';
const artifactDir = 'C:/Users/WORKSTATION/.gemini/antigravity/brain/5ef6a26c-9a24-46a2-8c8b-ffeeb356edb4/screenshots/canonical-production';

function seedPhase1Fixture() {
  if (window.top !== window) return;
  const timestamp = Date.now();

  function createWavDataUri(durationSec = 1.0, freq = 523.25, sampleRate = 11025) {
    const numSamples = Math.floor(durationSec * sampleRate);
    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    function writeString(offset, string) {
      for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
    }
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const envelope = Math.exp(-2.5 * t);
      const sample = Math.sin(2 * Math.PI * freq * t) * envelope * 0.7 * 32767;
      view.setInt16(44 + i * 2, Math.floor(sample), true);
    }
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return 'data:audio/wav;base64,' + btoa(binary);
  }

  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <defs>
    <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#D97757"/>
      <stop offset="100%" stop-color="#4B72C2"/>
    </linearGradient>
  </defs>
  <rect width="200" height="200" rx="30" fill="#18181B"/>
  <circle cx="100" cy="100" r="60" fill="url(#g1)" fill-opacity="0.25" stroke="#D97757" stroke-width="4"/>
  <circle cx="100" cy="100" r="35" fill="none" stroke="#4B72C2" stroke-width="3" stroke-dasharray="6,6"/>
  <polygon points="100,65 130,120 70,120" fill="#ECEAE4"/>
  <text x="100" y="170" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#ECEAE4">AIRA PORTAL</text>
</svg>`;

  const pngPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAE3wH3B+H8LAAAAABJRU5ErkJggg==';

  const files = {
    'index.html': {
      id: 'file_index',
      path: 'index.html',
      name: 'index.html',
      kind: 'html',
      content: `<!DOCTYPE html><html><head><title>AIRA Adaptive Studio</title></head><body style="background:#0b1120;color:#f8f9fc;font-family:sans-serif;padding:24px;"><h1>AIRA Adaptive Studio Live</h1><p>Production Verified Environment</p></body></html>`,
      sizeBytes: 980,
      lastModified: timestamp - 2000,
      version: 1,
      isEntry: true
    },
    'assets/branding.svg': {
      id: 'file_svg',
      path: 'assets/branding.svg',
      name: 'branding.svg',
      kind: 'svg',
      content: svgContent,
      sizeBytes: 742,
      lastModified: timestamp - 1800,
      version: 1
    },
    'assets/hero-banner.png': {
      id: 'file_png',
      path: 'assets/hero-banner.png',
      name: 'hero-banner.png',
      kind: 'image',
      content: pngPixel,
      sizeBytes: 154,
      lastModified: timestamp - 1700,
      version: 1
    },
    'audio/notification.wav': {
      id: 'file_audio_valid',
      path: 'audio/notification.wav',
      name: 'notification.wav',
      kind: 'audio',
      content: createWavDataUri(1.2, 587.33),
      sizeBytes: 26460,
      lastModified: timestamp - 1600,
      version: 1
    }
  };

  const manifest = [
    { path: 'index.html', kind: 'html', sizeBytes: 980, lastModified: timestamp - 2000, isEntry: true },
    { path: 'assets/branding.svg', kind: 'svg', sizeBytes: 742, lastModified: timestamp - 1800 },
    { path: 'assets/hero-banner.png', kind: 'image', sizeBytes: 154, lastModified: timestamp - 1700 },
    { path: 'audio/notification.wav', kind: 'audio', sizeBytes: 26460, lastModified: timestamp - 1600 }
  ];

  const dependencies = [
    { sourcePath: 'index.html', targetPath: 'assets/branding.svg', rawSpecifier: './assets/branding.svg', type: 'asset_link', isResolved: true }
  ];

  const bundle = {
    id: 'art-prod-unified',
    title: 'AIRA Multi-Modal Production Suite',
    entryPoint: 'index.html',
    files,
    manifest,
    dependencies
  };

  const executionGraph = {
    graphId: 'graph_prod_live',
    runId: 'run_prod_live',
    title: 'Adaptive Studio Live Production Suite',
    nodes: {
      step_architect: {
        id: 'step_architect',
        name: 'Architecture Planning',
        role: 'planner',
        state: 'COMPLETED',
        dependsOn: [],
        objective: 'Define multi-modal asset rendering and universal keyboard contracts.',
        startedAt: timestamp - 5000,
        completedAt: timestamp - 3800,
        attempt: 1,
        maxAttempts: 2
      },
      step_implement: {
        id: 'step_implement',
        name: 'Multi-Modal Asset Implementation',
        role: 'coder',
        state: 'COMPLETED',
        dependsOn: ['step_architect'],
        objective: 'Implement MultiModalAssetViewer and universal keyboard navigation.',
        startedAt: timestamp - 3700,
        completedAt: timestamp - 2000,
        attempt: 1,
        maxAttempts: 2,
        associatedArtifactId: 'art-prod-unified',
        associatedArtifactTitle: 'AIRA Multi-Modal Production Suite'
      },
      step_security: {
        id: 'step_security',
        name: 'Production Release Gate',
        role: 'verifier',
        state: 'COMPLETED',
        dependsOn: ['step_implement'],
        objective: 'Verify live production deployment and Edge rendering.',
        startedAt: timestamp - 1900,
        completedAt: timestamp - 1000,
        attempt: 1,
        maxAttempts: 1
      }
    },
    waves: [
      ['step_architect'],
      ['step_implement'],
      ['step_security']
    ],
    state: 'COMPLETED',
    totalTasks: 3,
    completedTasks: 3,
    failedTasks: 0
  };

  const artifact1 = {
    id: 'art-prod-unified',
    title: 'AIRA Multi-Modal Production Suite',
    type: 'text/html',
    language: 'html',
    version: 2,
    content: files['index.html'].content,
    versions: [
      { version: 1, content: '<h1>Initial Draft</h1>', timestamp: timestamp - 4000 },
      { version: 2, content: files['index.html'].content, timestamp }
    ],
    bundle
  };

  const artifact2 = {
    id: 'art-prod-vector',
    title: 'Portal Vector Identity',
    type: 'image/svg+xml',
    language: 'svg',
    version: 1,
    content: files['assets/branding.svg'].content,
    versions: [{ version: 1, content: files['assets/branding.svg'].content, timestamp }]
  };

  const conversation = {
    id: 'canonical-prod-conversation',
    title: 'Canonical Production Adaptive Studio',
    createdAt: timestamp - 6000,
    updatedAt: timestamp,
    messages: [
      {
        id: 'user-p1',
        role: 'user',
        content: 'Verify Adaptive Studio live on canonical production aira-ai-2026.vercel.app',
        timestamp: timestamp - 5000
      },
      {
        id: 'agent-p1',
        role: 'assistant',
        content: 'I have verified that Adaptive Studio is live on canonical production with full multi-modal assets, execution graph, and responsive layouts.',
        timestamp,
        artifacts: [artifact1, artifact2],
        executionGraph
      }
    ]
  };

  window.__AIRA_PHASE3_INITIAL_GRAPH__ = executionGraph;
  localStorage.setItem('aira_conversations_v1', JSON.stringify([conversation]));
  sessionStorage.setItem('aira_active_chat_session', conversation.id);
}

async function verifyCanonicalProduction() {
  mkdirSync(artifactDir, { recursive: true });

  console.log(`\n======================================================`);
  console.log(`VERIFYING CANONICAL PRODUCTION: ${canonicalUrl}`);
  console.log(`======================================================\n`);

  // 1. Health and Readiness Checks
  const healthRes = await fetch(`${canonicalUrl}/api/health`);
  const healthJson = await healthRes.json();
  console.log('Production /api/health:', healthRes.status, healthJson.status, healthJson.version);
  assert.equal(healthRes.status, 200);
  assert.equal(healthJson.status, 'HEALTHY');
  assert.equal(healthJson.productionMockFallback, 'DISABLED');

  const readyRes = await fetch(`${canonicalUrl}/api/ready`);
  const readyJson = await readyRes.json();
  console.log('Production /api/ready:', readyRes.status, readyJson.status);
  assert.equal(readyRes.status, 200);
  assert.equal(readyJson.status, 'READY');

  // 2. Launch Microsoft Edge
  console.log('Launching Microsoft Edge browser channel...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const browserVersion = await browser.version();
  console.log(`Microsoft Edge version: ${browserVersion}`);

  // Test matrix
  const tests = [
    { name: 'edge-desktop-1600x1000-dark', viewport: { width: 1600, height: 1000 }, theme: 'dark' },
    { name: 'edge-desktop-1600x1000-light', viewport: { width: 1600, height: 1000 }, theme: 'light' },
    { name: 'edge-desktop-1280x800-dark', viewport: { width: 1280, height: 800 }, theme: 'dark' },
    { name: 'edge-tablet-768x1024-dark', viewport: { width: 768, height: 1024 }, theme: 'dark' },
    { name: 'edge-mobile-390x844-dark', viewport: { width: 390, height: 844 }, theme: 'dark' }
  ];

  try {
    for (const test of tests) {
      console.log(`\nTesting ${test.name} (${test.viewport.width}x${test.viewport.height}, ${test.theme})...`);
      const context = await browser.newContext({
        viewport: test.viewport,
        colorScheme: test.theme
      });

      await context.addInitScript(seedPhase1Fixture);
      const page = await context.newPage();

      const pageErrors = [];
      page.on('pageerror', err => {
        console.error(`Page error on ${test.name}:`, err.message);
        pageErrors.push(err.message);
      });

      await page.goto(`${canonicalUrl}/?c=canonical-prod-conversation`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Verify Adaptive Shell presence
      const shellCount = await page.locator('.aira-adaptive-shell').count();
      assert.ok(shellCount > 0, `Expected .aira-adaptive-shell to be active on ${test.name}`);

      // Theme toggle for light mode
      if (test.theme === 'light') {
        await page.evaluate(() => {
          document.documentElement.classList.remove('dark');
        });
        await page.waitForTimeout(300);
      }

      // Check horizontal overflow
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 2
      );
      assert.equal(overflow, false, `Horizontal overflow detected on ${test.name}`);

      // Verify Mode Toggle in header and/or composer
      const chatBtn = page.locator('button[aria-pressed]:has-text("Chat")');
      const agentBtn = page.locator('button[aria-pressed]:has-text("Agent")');
      assert.ok(await chatBtn.count() > 0, `Chat mode toggle missing on ${test.name}`);
      assert.ok(await agentBtn.count() > 0, `Agent mode toggle missing on ${test.name}`);

      // Capture initial view with docked empty/graph studio
      const initialScreenshot = path.join(artifactDir, `${test.name}-initial.png`);
      await page.screenshot({ path: initialScreenshot });
      console.log(`Captured screenshot: ${initialScreenshot}`);

      // Click artifact card to open Artifact Studio
      const artifactCard = page.locator('[data-testid="artifact-card"]').first();
      await artifactCard.waitFor({ timeout: 12000 });
      await artifactCard.click();
      await page.locator('[data-testid="artifact-studio"]').waitFor({ timeout: 10000 });
      assert.ok(await page.locator('[data-testid="artifact-studio"]').isVisible());

      if (test.viewport.width >= 1280) {
        // Test tab switching
        await page.keyboard.press('Alt+2'); // Code
        await page.locator('[data-testid="code-file-indicator"]').waitFor({ timeout: 5000 });

        await page.keyboard.press('Alt+4'); // Graph
        await page.locator('[data-testid="agent-execution-graph"]').waitFor({ timeout: 5000 });

        await page.keyboard.press('Alt+3'); // Diff
        await page.locator('[data-testid="artifact-code-diff"]').waitFor({ timeout: 5000 });

        await page.keyboard.press('Alt+1'); // Preview
        await page.locator('text=Live Execution Sandbox').waitFor({ timeout: 5000 });

        // Open Workspace File Explorer
        await page.keyboard.press('Control+p');
        await page.locator('[data-testid="workspace-file-explorer"]').waitFor({ timeout: 5000 });

        // Search for SVG
        const searchInput = page.locator('[data-testid="file-search-input"]');
        await searchInput.fill('branding.svg');
        await page.locator('[data-testid="search-result-assets-branding.svg"]').click();
        await page.locator('[data-testid="svg-preview-stage"]').waitFor({ timeout: 5000 });

        // Search for PNG
        await searchInput.fill('hero-banner');
        await page.locator('[data-testid="search-result-assets-hero-banner.png"]').click();
        await page.locator('[data-testid="image-preview-stage"]').waitFor({ timeout: 5000 });

        // Search for Audio
        await searchInput.fill('notification');
        await page.locator('[data-testid="search-result-audio-notification.wav"]').click();
        await page.locator('[data-testid="audio-preview-stage"]').waitFor({ timeout: 5000 });

        // Back to index.html
        await searchInput.fill('index.html');
        await page.locator('[data-testid="search-result-index.html"]').click();
        await page.locator('text=Live Execution Sandbox').waitFor({ timeout: 5000 });

        // Capture docked studio screenshot
        const dockedScreenshot = path.join(artifactDir, `${test.name}-docked-studio.png`);
        await page.screenshot({ path: dockedScreenshot });
        console.log(`Captured screenshot: ${dockedScreenshot}`);

      } else {
        // Mobile / Tablet: Capture modal studio screenshot
        const modalScreenshot = path.join(artifactDir, `${test.name}-studio-modal.png`);
        await page.screenshot({ path: modalScreenshot });
        console.log(`Captured screenshot: ${modalScreenshot}`);
      }

      assert.equal(pageErrors.length, 0, `Page errors on ${test.name}: ${pageErrors.join('; ')}`);
      console.log(`PASS: ${test.name} verified`);
      await context.close();
    }

    console.log(`\n======================================================`);
    console.log(`CANONICAL PRODUCTION VERIFICATION COMPLETE: ALL PASS`);
    console.log(`======================================================\n`);

  } finally {
    await browser.close();
  }
}

verifyCanonicalProduction().catch(err => {
  console.error('Production verification failed:', err);
  process.exit(1);
});
