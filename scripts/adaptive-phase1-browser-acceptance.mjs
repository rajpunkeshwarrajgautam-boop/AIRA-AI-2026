import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const port = Number(process.env.PHASE1_PORT || 4186);
const base = process.env.PHASE1_URL || `http://127.0.0.1:${port}`;
const externalServer = Boolean(process.env.PHASE1_URL);
const baseline = process.env.PHASE1_FLAG_OFF === 'true';
const artifactDir = 'C:/Users/WORKSTATION/.gemini/antigravity/brain/4692c5e1-8fc6-437f-8dc1-b5e0ba492b84';

async function ready(url) {
  for (let count = 0; count < 80; count++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* booting */
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`No local Vite response at ${url}`);
}

async function launchBrowser() {
  if (process.platform === 'win32' && process.env.PHASE1_BROWSER !== 'chromium') {
    return chromium.launch({ channel: 'msedge', headless: true });
  }
  const chromiumBundle = (await import('@sparticuz/chromium')).default;
  return chromium.launch({
    executablePath: await chromiumBundle.executablePath(),
    args: chromiumBundle.args,
    headless: true
  });
}

function seedPhase1Fixture() {
  if (window.top !== window) return;
  const timestamp = Date.now();

  const files = {
    'index.html': {
      id: 'file_index',
      path: 'index.html',
      name: 'index.html',
      kind: 'html',
      content: `<!DOCTYPE html>
<html>
  <head>
    <title>AIRA Unified Adaptive Studio</title>
    <link rel="stylesheet" href="./src/styles.css">
  </head>
  <body class="bg-stone-900 text-stone-100 p-6 font-sans">
    <div class="max-w-4xl mx-auto">
      <header class="flex items-center justify-between border-b border-stone-800 pb-4 mb-6">
        <h1 class="text-xl font-bold text-amber-500">AIRA Unified Multi-Modal Suite</h1>
        <span class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-xs">PHASE 1 CERTIFIED</span>
      </header>
      <div class="grid grid-cols-2 gap-4">
        <div class="p-4 bg-stone-800/80 rounded-xl border border-stone-700">
          <div class="text-xs text-stone-400">Sandbox Isolation</div>
          <div class="text-2xl font-bold font-mono text-emerald-400 mt-1">100% Enforced</div>
        </div>
        <div class="p-4 bg-stone-800/80 rounded-xl border border-stone-700">
          <div class="text-xs text-stone-400">Multi-Modal Previews</div>
          <div class="text-2xl font-bold font-mono text-cyan-400 mt-1">Active & Isolated</div>
        </div>
      </div>
    </div>
  </body>
</html>`,
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
      content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
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
</svg>`,
      sizeBytes: 742,
      lastModified: timestamp - 1800,
      version: 1
    },
    'assets/hero-banner.png': {
      id: 'file_png',
      path: 'assets/hero-banner.png',
      name: 'hero-banner.png',
      kind: 'image',
      content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FAAhKDveksOjuAAAAAElFTkSuQmCC',
      sizeBytes: 124,
      lastModified: timestamp - 1600,
      version: 1
    },
    'audio/notification.mp3': {
      id: 'file_audio',
      path: 'audio/notification.mp3',
      name: 'notification.mp3',
      kind: 'audio',
      content: 'data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhACfn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fAAAA',
      sizeBytes: 256,
      lastModified: timestamp - 1400,
      version: 1
    },
    'src/styles.css': {
      id: 'file_css',
      path: 'src/styles.css',
      name: 'styles.css',
      kind: 'css',
      content: 'body { margin: 0; background-color: #141413; color: #ECEAE4; }',
      sizeBytes: 64,
      lastModified: timestamp - 1200,
      version: 1
    }
  };

  const manifest = {
    manifestVersion: '1.0.0',
    projectId: 'art-phase1-unified',
    title: 'AIRA Multi-Modal Unified Project',
    entryPoint: 'index.html',
    createdAt: timestamp - 3000,
    updatedAt: timestamp,
    files: Object.values(files).map(f => ({
      path: f.path,
      sizeBytes: f.sizeBytes,
      kind: f.kind,
      checksumSha256: 'sha-p1-verified',
      lastModified: f.lastModified
    }))
  };

  const dependencies = [
    {
      sourcePath: 'index.html',
      targetPath: 'src/styles.css',
      rawSpecifier: './src/styles.css',
      type: 'stylesheet',
      isResolved: true
    },
    {
      sourcePath: 'index.html',
      targetPath: 'assets/branding.svg',
      rawSpecifier: './assets/branding.svg',
      type: 'asset_link',
      isResolved: true
    }
  ];

  const bundle = {
    id: 'art-phase1-unified',
    title: 'AIRA Multi-Modal Unified Project',
    entryPoint: 'index.html',
    files,
    manifest,
    dependencies
  };

  const executionGraph = {
    graphId: 'graph_phase1_certified',
    runId: 'run_phase1_certified',
    title: 'Multi-Modal Unified Studio Orchestration',
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
        maxAttempts: 2,
        outputSummary: 'Architecture contract established for Phase 1.'
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
        associatedArtifactId: 'art-phase1-unified',
        associatedArtifactTitle: 'AIRA Multi-Modal Unified Project'
      },
      step_security: {
        id: 'step_security',
        name: 'Cross-Phase Security Audit',
        role: 'verifier',
        state: 'COMPLETED',
        dependsOn: ['step_implement'],
        objective: 'Audit SVG sanitization, Windows device names, and memory safety.',
        startedAt: timestamp - 1900,
        completedAt: timestamp - 1000,
        attempt: 1,
        maxAttempts: 1,
        outputSummary: 'Zero security vulnerabilities detected.'
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
    id: 'art-phase1-unified',
    title: 'AIRA Multi-Modal Unified Project',
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
    id: 'art-phase1-vector',
    title: 'Portal Vector Identity',
    type: 'image/svg+xml',
    language: 'svg',
    version: 1,
    content: files['assets/branding.svg'].content,
    versions: [{ version: 1, content: files['assets/branding.svg'].content, timestamp }]
  };

  const conversation = {
    id: 'phase1-fixture-conversation',
    title: 'Phase 1 Unified Multi-Modal Studio Verification',
    createdAt: timestamp - 6000,
    updatedAt: timestamp,
    messages: [
      {
        id: 'user-p1',
        role: 'user',
        content: 'Unify the Adaptive Studio experience with multi-modal assets and execution graph',
        timestamp: timestamp - 5000
      },
      {
        id: 'agent-p1',
        role: 'assistant',
        content: 'I have finalized Phase 1 with multi-modal asset previews, universal keyboard shortcuts, and full studio unification.',
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

let server;
let browser;

try {
  if (!externalServer) {
    server = spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        env: { ...process.env, VITE_ADAPTIVE_STUDIO_PREVIEW: baseline ? 'false' : 'true' },
        cwd: 'D:/AIRA-PHASE1-WORKTREE',
        stdio: 'ignore'
      }
    );
  }
  await ready(base);
  browser = await launchBrowser();

  const viewports = baseline
    ? [{ width: 1600, height: 1000 }]
    : [
        { width: 1600, height: 1000 },
        { width: 768, height: 1024 },
        { width: 390, height: 844 },
        { width: 320, height: 700 }
      ];

  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(seedPhase1Fixture);
    const page = await context.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.error('PAGE ERROR:', err));
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(`${base}/?c=phase1-fixture-conversation`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="artifact-card"]').first().waitFor({ timeout: 12000 });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 2
    );
    assert.equal(overflow, false, `${viewport.width} viewport has horizontal document overflow`);

    if (baseline) {
      assert.equal(await page.locator('.aira-adaptive-shell').count(), 0);
      assert.equal(await page.locator('[data-testid="workspace-file-explorer"]').count(), 0);
      await page.screenshot({ path: path.join(artifactDir, 'phase1-edge-default-off-baseline.png') });
      console.log('PASS 1600x1000: default-off legacy layout verified');
      await context.close();
      break;
    }

    // Adaptive Mode Checks
    await page.locator('.aira-adaptive-shell').waitFor();

    // Open Artifact Studio by clicking the artifact card
    await page.locator('[data-testid="artifact-card"]').first().click();
    await page.locator('[data-testid="artifact-studio"]').waitFor();

    if (viewport.width === 1600) {
      // 1. Initial State: Verify Unified Studio & Toolbar
      const carouselIndicator = page.locator('[data-testid="artifact-carousel-indicator"]');
      assert.ok(await carouselIndicator.isVisible(), 'Carousel indicator must be visible');
      assert.match(await carouselIndicator.textContent(), /1 of 2/, 'Carousel must show 1 of 2 artifacts');

      // Verify WAI-ARIA tablist
      const tablist = page.locator('[role="tablist"]');
      assert.ok(await tablist.isVisible(), 'Tablist must have role="tablist"');

      // 2. Keyboard Navigation: Alt+2 (Code), Alt+1 (Preview), Alt+3 (Diff), Alt+4 (Graph)
      await page.keyboard.press('Alt+2');
      await page.locator('[data-testid="code-file-indicator"]').waitFor();
      console.log('PASS 1600x1000: Alt+2 keyboard shortcut switched to Code view');

      await page.keyboard.press('Alt+4');
      await page.locator('[data-testid="agent-execution-graph"]').waitFor();
      console.log('PASS 1600x1000: Alt+4 keyboard shortcut switched to Graph view');

      await page.keyboard.press('Alt+3');
      await page.locator('[data-testid="artifact-code-diff"]').waitFor();
      console.log('PASS 1600x1000: Alt+3 keyboard shortcut switched to Diff view');

      await page.keyboard.press('Alt+1');
      await page.locator('text=Live Execution Sandbox').waitFor();
      console.log('PASS 1600x1000: Alt+1 keyboard shortcut switched to Preview view');

      // 3. Test Ctrl+P shortcut to toggle Workspace File Explorer and focus search
      await page.keyboard.press('Control+p');
      await page.locator('[data-testid="workspace-file-explorer"]').waitFor();
      const searchInput = page.locator('[data-testid="file-search-input"]');
      assert.ok(await searchInput.isVisible(), 'File search input must be visible on Ctrl+P');

      // Take Unified Desktop Screenshot with File Explorer and Carousel open
      await page.screenshot({ path: path.join(artifactDir, 'phase1-edge-desktop-1600x1000-unified.png') });
      console.log('PASS 1600x1000: Unified Studio desktop layout certified');

      // 4. Test Multi-Modal SVG Asset Preview
      await searchInput.fill('branding.svg');
      await page.locator('[data-testid="search-result-assets-branding.svg"]').waitFor();
      await page.locator('[data-testid="search-result-assets-branding.svg"]').click();
      await page.locator('[data-testid="svg-preview-stage"]').waitFor();

      // Test Visual / Source toggle
      await page.locator('[data-testid="svg-toggle-code"]').click();
      await page.locator('code:has-text("AIRA PORTAL")').waitFor();
      await page.locator('[data-testid="svg-toggle-visual"]').click();
      await page.locator('[data-testid="svg-preview-stage"]').waitFor();

      await page.screenshot({ path: path.join(artifactDir, 'phase1-edge-desktop-1600x1000-multimodal-svg.png') });
      console.log('PASS 1600x1000: Multi-Modal SVG preview & toggle certified');

      // 5. Test Multi-Modal PNG Image Preview with Zoom
      await searchInput.fill('hero-banner');
      await page.locator('[data-testid="search-result-assets-hero-banner.png"]').waitFor();
      await page.locator('[data-testid="search-result-assets-hero-banner.png"]').click();
      await page.locator('[data-testid="image-preview-stage"]').waitFor();

      await page.locator('[data-testid="multimodal-zoom-in"]').click();
      assert.equal(await page.locator('[data-testid="multimodal-zoom-reset"]').textContent(), '125%');

      await page.screenshot({ path: path.join(artifactDir, 'phase1-edge-desktop-1600x1000-multimodal-image.png') });
      console.log('PASS 1600x1000: Multi-Modal Image preview & zoom controls certified');

      // 6. Test Multi-Modal Audio Preview
      await searchInput.fill('notification');
      await page.locator('[data-testid="search-result-audio-notification.mp3"]').waitFor();
      await page.locator('[data-testid="search-result-audio-notification.mp3"]').click();
      await page.locator('[data-testid="audio-preview-stage"]').waitFor();
      assert.ok(await page.locator('[data-testid="audio-play-pause-btn"]').isVisible());

      await page.screenshot({ path: path.join(artifactDir, 'phase1-edge-desktop-1600x1000-multimodal-audio.png') });
      console.log('PASS 1600x1000: Multi-Modal Audio preview & player certified');

      await searchInput.fill('');

      // 7. Verify ZIP Export and Sync Workspace buttons
      assert.ok(await page.locator('[data-testid="export-zip-btn"]').isVisible());
      assert.ok(await page.locator('[data-testid="sync-workspace-btn"]').isVisible());
    } else if (viewport.width === 768) {
      await page.screenshot({ path: path.join(artifactDir, 'phase1-edge-tablet-768x1024.png') });
      console.log('PASS 768x1024: tablet layout certified');
    } else if (viewport.width === 390) {
      await page.screenshot({ path: path.join(artifactDir, 'phase1-edge-mobile-390x844.png') });
      console.log('PASS 390x844: mobile layout certified');
    } else if (viewport.width === 320) {
      await page.screenshot({ path: path.join(artifactDir, 'phase1-edge-small-mobile-320x700.png') });
      console.log('PASS 320x700: small mobile layout certified');
    }

    assert.equal(errors.length, 0, `Browser errors on ${viewport.width}px: ${errors.join('; ')}`);
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill();
    await new Promise(r => setTimeout(r, 500));
  }
}
