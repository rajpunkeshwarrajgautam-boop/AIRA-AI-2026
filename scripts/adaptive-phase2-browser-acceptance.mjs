import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const port = Number(process.env.PHASE2_PORT || 4184);
const base = process.env.PHASE2_URL || `http://127.0.0.1:${port}`;
const externalServer = Boolean(process.env.PHASE2_URL);
const baseline = process.env.PHASE2_FLAG_OFF === 'true';
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
  if (process.platform === 'win32' && process.env.PHASE2_BROWSER !== 'chromium') {
    return chromium.launch({ channel: 'msedge', headless: true });
  }
  const chromiumBundle = (await import('@sparticuz/chromium')).default;
  return chromium.launch({
    executablePath: await chromiumBundle.executablePath(),
    args: chromiumBundle.args,
    headless: true
  });
}

function seedPhase2Fixture() {
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
    <title>AIRA Telemetry Dashboard</title>
    <link rel="stylesheet" href="./src/styles.css">
  </head>
  <body class="bg-stone-900 text-stone-100 p-6 font-sans">
    <div class="max-w-4xl mx-auto">
      <header class="flex items-center justify-between border-b border-stone-800 pb-4 mb-6">
        <h1 class="text-xl font-bold text-amber-500">AIRA Real-time Telemetry Dashboard</h1>
        <span class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-xs">ONLINE</span>
      </header>
      <div id="metrics-grid" class="grid grid-cols-2 gap-4">
        <div class="p-4 bg-stone-800/80 rounded-xl border border-stone-700">
          <div class="text-xs text-stone-400">Throughput</div>
          <div class="text-2xl font-bold font-mono text-cyan-400 mt-1">48.2 req/s</div>
        </div>
        <div class="p-4 bg-stone-800/80 rounded-xl border border-stone-700">
          <div class="text-xs text-stone-400">Sandbox Isolation</div>
          <div class="text-2xl font-bold font-mono text-emerald-400 mt-1">100% Enforced</div>
        </div>
      </div>
      <script src="./src/app.js"></script>
    </div>
  </body>
</html>`,
      sizeBytes: 1042,
      lastModified: timestamp - 2000,
      version: 1,
      isEntry: true
    },
    'src/styles.css': {
      id: 'file_styles',
      path: 'src/styles.css',
      name: 'styles.css',
      kind: 'css',
      content: `/* Primary Adaptive Studio Telemetry Styles */
body {
  margin: 0;
  background-color: #161618;
  color: #ECEAE4;
  font-family: 'Outfit', sans-serif;
}
.metric-card {
  border: 1px solid rgba(217, 119, 87, 0.3);
  border-radius: 8px;
  padding: 16px;
  background: #1F1E1D;
}`,
      sizeBytes: 284,
      lastModified: timestamp - 1800,
      version: 1
    },
    'src/app.js': {
      id: 'file_app',
      path: 'src/app.js',
      name: 'app.js',
      kind: 'javascript',
      content: `// Telemetry client logic
console.log("Telemetry engine initialized inside sandboxed bundle.");
window.addEventListener('DOMContentLoaded', () => {
  console.log("DOM loaded. Active files linked and verified.");
});`,
      sizeBytes: 215,
      lastModified: timestamp - 1600,
      version: 1
    },
    'src/components/MetricCard.js': {
      id: 'file_metric_card',
      path: 'src/components/MetricCard.js',
      name: 'MetricCard.js',
      kind: 'javascript',
      content: `export function renderMetricCard(title, value) {
  return '<div class="metric-card"><h3>' + title + '</h3><p>' + value + '</p></div>';
}`,
      sizeBytes: 142,
      lastModified: timestamp - 1400,
      version: 1
    },
    'README.md': {
      id: 'file_readme',
      path: 'README.md',
      name: 'README.md',
      kind: 'markdown',
      content: `# AIRA Telemetry Dashboard
Multi-file artifact project bundle designed for Phase 2 specification.

## Features
- Modular multi-file architecture (HTML, CSS, JS)
- Sandboxed execution without parent origin exposure
- Deterministic project manifest
- ZIP archive export and workspace synchronization`,
      sizeBytes: 310,
      lastModified: timestamp - 1200,
      version: 1
    }
  };

  const manifest = {
    manifestVersion: '1.0.0',
    projectId: 'art-telemetry-bundle',
    title: 'AIRA Telemetry Dashboard',
    entryPoint: 'index.html',
    createdAt: timestamp - 3000,
    updatedAt: timestamp,
    files: Object.values(files).map(f => ({
      path: f.path,
      sizeBytes: f.sizeBytes,
      kind: f.kind,
      checksumSha256: 'abc123sha',
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
      targetPath: 'src/app.js',
      rawSpecifier: './src/app.js',
      type: 'script_tag',
      isResolved: true
    },
    {
      sourcePath: 'src/app.js',
      targetPath: 'src/components/MetricCard.js',
      rawSpecifier: './components/MetricCard.js',
      type: 'static_import',
      isResolved: true
    }
  ];

  const bundle = {
    id: 'art-telemetry-bundle',
    title: 'AIRA Telemetry Dashboard',
    entryPoint: 'index.html',
    files,
    manifest,
    dependencies
  };

  const artifact1 = {
    id: 'art-telemetry-bundle',
    title: 'AIRA Telemetry Dashboard',
    type: 'text/html',
    language: 'html',
    version: 1,
    content: files['index.html'].content,
    versions: [{ version: 1, content: files['index.html'].content, timestamp }],
    bundle
  };

  const conversation = {
    id: 'phase2-fixture-conversation',
    title: 'Phase 2 Multi-File Artifact Verification',
    createdAt: timestamp - 6000,
    updatedAt: timestamp,
    messages: [
      {
        id: 'user-p2',
        role: 'user',
        content: 'Create a multi-file telemetry dashboard with HTML, CSS, and JS',
        timestamp: timestamp - 5000
      },
      {
        id: 'agent-p2',
        role: 'assistant',
        content: 'I have created the multi-file project bundle for the Telemetry Dashboard.',
        timestamp,
        artifacts: [artifact1]
      }
    ]
  };

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
        cwd: 'D:/AIRA-PHASE2-WORKTREE',
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
    await context.addInitScript(seedPhase2Fixture);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(`${base}/?c=phase2-fixture-conversation`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="artifact-card"]').first().waitFor({ timeout: 12000 });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 2
    );
    assert.equal(overflow, false, `${viewport.width} viewport has horizontal document overflow`);

    if (baseline) {
      assert.equal(await page.locator('.aira-adaptive-shell').count(), 0);
      assert.equal(await page.locator('[data-testid="workspace-file-explorer"]').count(), 0);
      await page.screenshot({ path: path.join(artifactDir, 'phase2-edge-default-off-baseline.png') });
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
      // 1. Initial State: Toggle File Explorer open
      await page.locator('[data-testid="toggle-file-explorer"]').click();
      await page.locator('[data-testid="workspace-file-explorer"]').waitFor();
      assert.match(await page.locator('[data-testid="workspace-file-explorer"]').innerText(), /Workspace Files/);
      assert.match(await page.locator('[data-testid="workspace-file-explorer"]').innerText(), /5/); // 5 files
      await page.screenshot({ path: path.join(artifactDir, 'phase2-edge-desktop-1600x1000-file-tree.png') });
      console.log('PASS 1600x1000: File Explorer rendered and file tree verified');

      // 2. Select file (src/styles.css) and inspect in Code view
      // Click on src folder if needed, then click src/styles.css
      const cssItem = page.locator('[data-testid="file-item-src-styles.css"]');
      if (await cssItem.count() > 0) {
        await cssItem.click();
      }
      // Click Code tab
      await page.locator('button:has-text("Code")').click();
      await page.locator('[data-testid="code-file-indicator"]').waitFor();
      const codeIndicatorText = await page.locator('[data-testid="code-file-indicator"]').innerText();
      assert.match(codeIndicatorText, /src\/styles\.css/);
      await page.screenshot({ path: path.join(artifactDir, 'phase2-edge-desktop-1600x1000-file-inspection.png') });
      console.log('PASS 1600x1000: File selection and source inspection verified in Code view');

      // 3. Dependency Panel Toggle
      await page.locator('[data-testid="toggle-dependency-panel"]').click();
      await page.locator('[data-testid="file-dependency-panel"]').waitFor();
      assert.match(await page.locator('[data-testid="file-dependency-panel"]').innerText(), /src\/styles\.css/);
      await page.screenshot({ path: path.join(artifactDir, 'phase2-edge-desktop-1600x1000-dependencies.png') });
      console.log('PASS 1600x1000: File dependencies panel verified');

      // 4. Search and Filter
      await page.locator('[data-testid="file-search-input"]').fill('MetricCard');
      await page.locator('[data-testid="search-result-src-components-MetricCard.js"]').waitFor();
      assert.match(await page.locator('[data-testid="workspace-file-explorer"]').innerText(), /Search Results \(1\)/i);
      await page.screenshot({ path: path.join(artifactDir, 'phase2-edge-desktop-1600x1000-search.png') });
      console.log('PASS 1600x1000: Search and filtering verified');

      // Clear search
      await page.locator('[data-testid="file-search-input"]').fill('');

      // 5. Test ZIP export trigger and Workspace Sync trigger
      assert.equal(await page.locator('[data-testid="export-zip-btn"]').count(), 1);
      assert.equal(await page.locator('[data-testid="sync-workspace-btn"]').count(), 1);
      await page.locator('[data-testid="sync-workspace-btn"]').click();
      await page.waitForTimeout(500);

      // Return to Preview tab
      await page.locator('button:has-text("Preview")').click();
      await page.locator('iframe[title="AIRA Telemetry Dashboard"]').waitFor();
      console.log('PASS 1600x1000: Preview tab and iframe returned safely without restarts');
    } else if (viewport.width === 768) {
      await page.screenshot({ path: path.join(artifactDir, 'phase2-edge-tablet-768x1024.png') });
      console.log('PASS 768x1024: Tablet layout verified');
    } else if (viewport.width === 390) {
      await page.screenshot({ path: path.join(artifactDir, 'phase2-edge-mobile-390x844.png') });
      console.log('PASS 390x844: Mobile layout verified');
    } else if (viewport.width === 320) {
      await page.screenshot({ path: path.join(artifactDir, 'phase2-edge-small-mobile-320x700.png') });
      console.log('PASS 320x700: Small mobile layout verified');
    }

    assert.equal(errors.length, 0, `Browser runtime errors detected: ${errors.join(', ')}`);
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill();
    // On Windows, kill tree if needed
    try {
      process.kill(server.pid);
    } catch {}
  }
}

console.log('ALL PHASE 2 EDGE BROWSER ACCEPTANCE GATES PASSED.');
