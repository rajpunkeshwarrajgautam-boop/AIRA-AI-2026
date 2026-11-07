import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const port = Number(process.env.TEST_PORT || 4192);
const targetUrl = process.env.TEST_URL || `http://127.0.0.1:${port}`;
const externalServer = Boolean(process.env.TEST_URL);
const artifactDir = process.env.TEST_ARTIFACT_DIR || 'C:/Users/WORKSTATION/.gemini/antigravity/brain/5ef6a26c-9a24-46a2-8c8b-ffeeb356edb4/screenshots';

async function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      // waiting for server
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Server did not respond at ${url} within ${timeoutMs}ms`);
}

async function launchEdge() {
  if (process.platform === 'win32') {
    try {
      return await chromium.launch({ channel: 'msedge', headless: true });
    } catch (err) {
      console.warn('Could not launch system msedge channel, falling back to default chromium:', err.message);
    }
  }
  return await chromium.launch({ headless: true });
}

function seedFullFixture() {
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

  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#1e293b"/><circle cx="100" cy="100" r="60" fill="#38bdf8"/><text x="100" y="105" font-family="sans-serif" font-size="14" font-weight="bold" fill="#0f172a" text-anchor="middle">AIRA PORTAL</text></svg>`;
  const pngPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAE3wH3B+H8LAAAAABJRU5ErkJggg==';
  const wavAudio = createWavDataUri(1.5, 440);

  const files = {
    'index.html': {
      id: 'file_index',
      path: 'index.html',
      name: 'index.html',
      kind: 'html',
      content: `<!DOCTYPE html><html><head><title>Adaptive Studio Suite</title></head><body style="background:#0b1120;color:#f8f9fc;font-family:sans-serif;padding:24px;"><h1>AIRA Adaptive Studio</h1><p>Sandbox Isolated Environment</p></body></html>`
    },
    'assets/branding.svg': {
      id: 'file_svg',
      path: 'assets/branding.svg',
      name: 'branding.svg',
      kind: 'svg',
      content: svgContent
    },
    'assets/hero-banner.png': {
      id: 'file_png',
      path: 'assets/hero-banner.png',
      name: 'hero-banner.png',
      kind: 'image',
      content: pngPixel
    },
    'audio/notification.wav': {
      id: 'file_wav',
      path: 'audio/notification.wav',
      name: 'notification.wav',
      kind: 'audio',
      content: wavAudio
    }
  };

  const artifact1 = {
    id: 'art-adaptive-unified',
    title: 'AIRA Multi-Modal Adaptive Suite',
    type: 'text/html',
    language: 'html',
    version: 2,
    content: files['index.html'].content,
    versions: [
      { version: 1, content: '<html><body><h1>Initial v1</h1></body></html>', timestamp: timestamp - 3000 },
      { version: 2, content: files['index.html'].content, timestamp }
    ],
    metadata: {
      isMultiFile: true,
      entryFile: 'index.html',
      files
    }
  };

  const artifact2 = {
    id: 'art-vector-portal',
    title: 'Portal Vector Identity',
    type: 'image/svg+xml',
    language: 'svg',
    version: 1,
    content: svgContent,
    versions: [{ version: 1, content: svgContent, timestamp }]
  };

  const executionGraph = {
    graphId: 'graph-production-adaptive',
    runId: 'run-production-adaptive',
    title: 'Autonomous System Mission',
    nodes: {
      task_plan: {
        id: 'task_plan',
        name: 'Architecture Planning',
        type: 'PLAN',
        state: 'SUCCESS',
        description: 'Verify system topology and contracts',
        dependencies: [],
        startedAt: timestamp - 5000,
        completedAt: timestamp - 4000
      },
      task_exec: {
        id: 'task_exec',
        name: 'Sandbox Artifact Compilation',
        type: 'EXECUTE',
        state: 'SUCCESS',
        description: 'Generate sandboxed multi-modal assets',
        dependencies: ['task_plan'],
        startedAt: timestamp - 4000,
        completedAt: timestamp - 2000,
        artifactId: 'art-adaptive-unified'
      },
      task_verify: {
        id: 'task_verify',
        name: 'Dual Verification Gate',
        type: 'VERIFY',
        state: 'SUCCESS',
        description: 'Automated Playwright acceptance',
        dependencies: ['task_exec'],
        startedAt: timestamp - 2000,
        completedAt: timestamp
      }
    },
    waves: [['task_plan'], ['task_exec'], ['task_verify']],
    state: 'SUCCESS',
    totalTasks: 3,
    completedTasks: 3,
    failedTasks: 0
  };

  const conversation = {
    id: 'adaptive-acceptance-conversation',
    title: 'Adaptive Studio Acceptance Conversation',
    createdAt: timestamp - 6000,
    updatedAt: timestamp,
    messages: [
      {
        id: 'user-msg-01',
        role: 'user',
        content: 'Design and verify the AIRA Adaptive Studio experience with multi-modal assets and execution graph',
        timestamp: timestamp - 5000
      },
      {
        id: 'agent-msg-01',
        role: 'assistant',
        content: 'I have compiled the multi-modal assets, verified execution graph checkpoints, and docked the Artifact Studio.',
        timestamp,
        artifacts: [artifact1, artifact2],
        executionGraph,
        agentEvents: [
          { id: 'event-1', kind: 'plan', label: 'Architecture Planning', status: 'completed', occurredAt: timestamp - 4500 },
          { id: 'event-2', kind: 'tool', label: 'Tool: artifact_compiler', status: 'completed', occurredAt: timestamp - 3000 },
          { id: 'event-3', kind: 'verification', label: 'Verification: Dual release gate verified', status: 'completed', occurredAt: timestamp - 1000 }
        ]
      }
    ]
  };

  localStorage.setItem('aira_conversations_v1', JSON.stringify([conversation]));
  sessionStorage.setItem('aira_active_chat_session', conversation.id);
  window.__AIRA_PHASE3_INITIAL_GRAPH__ = executionGraph;
}

async function runSuite() {
  let serverProcess;
  let browser;

  mkdirSync(artifactDir, { recursive: true });

  try {
    if (!externalServer) {
      console.log(`Starting vite preview on port ${port}...`);
      serverProcess = spawn(
        process.execPath,
        ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        {
          cwd: process.cwd(),
          stdio: 'inherit'
        }
      );
    }

    console.log(`Waiting for ${targetUrl}...`);
    await waitForServer(targetUrl);
    console.log(`Target ${targetUrl} is online!`);

    browser = await launchEdge();
    const version = await browser.version();
    console.log(`Using browser: Microsoft Edge ${version}`);

    const scenarios = [
      { name: 'desktop-1600-dark', viewport: { width: 1600, height: 1000 }, theme: 'dark' },
      { name: 'desktop-1600-light', viewport: { width: 1600, height: 1000 }, theme: 'light' },
      { name: 'desktop-1280-dark', viewport: { width: 1280, height: 800 }, theme: 'dark' },
      { name: 'desktop-1280-light', viewport: { width: 1280, height: 800 }, theme: 'light' },
      { name: 'tablet-768-dark', viewport: { width: 768, height: 1024 }, theme: 'dark' },
      { name: 'tablet-768-light', viewport: { width: 768, height: 1024 }, theme: 'light' },
      { name: 'mobile-390-dark', viewport: { width: 390, height: 844 }, theme: 'dark' },
      { name: 'mobile-390-light', viewport: { width: 390, height: 844 }, theme: 'light' },
      { name: 'mobile-375-dark', viewport: { width: 375, height: 667 }, theme: 'dark' }
    ];

    for (const scenario of scenarios) {
      console.log(`\n--- Testing Scenario: ${scenario.name} (${scenario.viewport.width}x${scenario.viewport.height}, ${scenario.theme}) ---`);
      const context = await browser.newContext({
        viewport: scenario.viewport,
        colorScheme: scenario.theme
      });

      await context.addInitScript(seedFullFixture);
      const page = await context.newPage();

      const pageErrors = [];
      page.on('pageerror', err => {
        console.error('PAGE ERROR:', err);
        pageErrors.push(err.message);
      });
      page.on('console', msg => {
        if (msg.type() === 'error') console.error('CONSOLE ERROR:', msg.text());
        else console.log('CONSOLE:', msg.text());
      });

      await page.goto(`${targetUrl}/?c=adaptive-acceptance-conversation`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#root > div', { timeout: 10000 }).catch(async () => {
        console.log('ROOT HTML:', await page.locator('#root').innerHTML());
      });
      await page.waitForTimeout(600);

      // Verify Adaptive Shell presence
      const shellCount = await page.locator('.aira-adaptive-shell').count();
      assert.ok(shellCount > 0, `Expected .aira-adaptive-shell to be present on ${scenario.name}`);

      // Apply theme if light requested
      if (scenario.theme === 'light') {
        await page.evaluate(() => {
          document.documentElement.classList.remove('dark');
          const stored = localStorage.getItem('aira_settings_v1');
          if (stored) {
            const s = JSON.parse(stored);
            s.theme = 'light';
            localStorage.setItem('aira_settings_v1', JSON.stringify(s));
          }
        });
        await page.waitForTimeout(200);
      }

      // Check horizontal overflow
      const hasOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 2
      );
      assert.equal(hasOverflow, false, `Horizontal overflow detected on ${scenario.name}`);

      // Verify Chat Input Mode Toggle
      const chatModeBtn = page.locator('button[aria-pressed]:has-text("Chat")');
      const agentModeBtn = page.locator('button[aria-pressed]:has-text("Agent")');
      assert.ok(await chatModeBtn.count() > 0, `Chat mode toggle button missing on ${scenario.name}`);
      assert.ok(await agentModeBtn.count() > 0, `Agent mode toggle button missing on ${scenario.name}`);

      // Check Artifact Card
      const artifactCard = page.locator('[data-testid="artifact-card"]').first();
      await artifactCard.waitFor({ timeout: 10000 });
      assert.ok(await artifactCard.isVisible(), `Artifact card not visible on ${scenario.name}`);

      // On Desktop (>=1280px): Test Empty State vs Docked Studio
      if (scenario.viewport.width >= 1280) {
        // Capture initial conversation with empty studio docked
        const emptyStateScreenshot = path.join(artifactDir, `${scenario.name}-empty-studio.png`);
        await page.screenshot({ path: emptyStateScreenshot });
        console.log(`Saved screenshot: ${emptyStateScreenshot}`);

        // Click artifact card to dock Artifact Studio
        await artifactCard.click();
        await page.locator('[data-testid="artifact-studio"]').waitFor({ timeout: 8000 });
        assert.ok(await page.locator('[data-testid="artifact-studio"]').isVisible());

        // Verify carousel
        const carousel = page.locator('[data-testid="artifact-carousel-indicator"]');
        if (await carousel.count() > 0) {
          const text = await carousel.textContent();
          console.log(`Artifact carousel indicator: ${text}`);
          assert.match(text, /1 of 2/);
        }

        // Test Alt+2 (Code view)
        await page.keyboard.press('Alt+2');
        await page.locator('[data-testid="code-file-indicator"]').waitFor({ timeout: 5000 });

        // Test Alt+4 (Graph view)
        await page.keyboard.press('Alt+4');
        await page.locator('[data-testid="agent-execution-graph"]').waitFor({ timeout: 5000 });

        // Test Alt+3 (Diff view)
        await page.keyboard.press('Alt+3');
        await page.locator('[data-testid="artifact-code-diff"]').waitFor({ timeout: 5000 });

        // Test Alt+1 (Preview view)
        await page.keyboard.press('Alt+1');
        await page.locator('text=Live Execution Sandbox').waitFor({ timeout: 5000 });

        // Open Workspace File Explorer via Ctrl+P
        await page.keyboard.press('Control+p');
        const fileExplorer = page.locator('[data-testid="workspace-file-explorer"]');
        await fileExplorer.waitFor({ timeout: 5000 });
        assert.ok(await fileExplorer.isVisible());

        // Test multi-modal SVG preview
        const searchInput = page.locator('[data-testid="file-search-input"]');
        await searchInput.fill('branding.svg');
        await page.locator('[data-testid="search-result-assets-branding.svg"]').click();
        await page.locator('[data-testid="svg-preview-stage"]').waitFor({ timeout: 5000 });
        assert.ok(await page.locator('[data-testid="svg-preview-stage"]').isVisible());

        // Test multi-modal PNG preview
        await searchInput.fill('hero-banner');
        await page.locator('[data-testid="search-result-assets-hero-banner.png"]').click();
        await page.locator('[data-testid="image-preview-stage"]').waitFor({ timeout: 5000 });
        assert.ok(await page.locator('[data-testid="image-preview-stage"]').isVisible());

        // Test multi-modal Audio preview
        await searchInput.fill('notification');
        await page.locator('[data-testid="search-result-audio-notification.wav"]').click();
        await page.locator('[data-testid="audio-preview-stage"]').waitFor({ timeout: 5000 });
        assert.ok(await page.locator('[data-testid="audio-preview-stage"]').isVisible());

        // Reset to index.html preview
        await searchInput.fill('index.html');
        await page.locator('[data-testid="search-result-index.html"]').click();
        await page.locator('text=Live Execution Sandbox').waitFor({ timeout: 5000 });

        // Capture docked studio screenshot
        const dockedScreenshot = path.join(artifactDir, `${scenario.name}-docked-studio.png`);
        await page.screenshot({ path: dockedScreenshot });
        console.log(`Saved screenshot: ${dockedScreenshot}`);

      } else {
        // Mobile / Tablet: Capture chat view first
        const chatScreenshot = path.join(artifactDir, `${scenario.name}-chat.png`);
        await page.screenshot({ path: chatScreenshot });
        console.log(`Saved screenshot: ${chatScreenshot}`);

        // Click artifact card to open studio modal
        await artifactCard.click();
        await page.locator('[data-testid="artifact-studio"]').waitFor({ timeout: 8000 });
        assert.ok(await page.locator('[data-testid="artifact-studio"]').isVisible());

        const studioScreenshot = path.join(artifactDir, `${scenario.name}-studio.png`);
        await page.screenshot({ path: studioScreenshot });
        console.log(`Saved screenshot: ${studioScreenshot}`);

        // Close studio on small screens
        const closeBtn = page.locator('[title="Close artifact"]');
        if (await closeBtn.isVisible()) {
          await closeBtn.click();
          await page.waitForTimeout(300);
        }
      }

      // Test Mode Switching (Chat -> Agent)
      const agentBtn = page.locator('button[aria-pressed]:has-text("Agent")').last();
      await agentBtn.click();
      await page.waitForTimeout(200);

      // Verify composer placeholder in Agent mode
      const inputEl = page.locator('textarea');
      const placeholder = await inputEl.getAttribute('placeholder');
      assert.match(placeholder, /Describe a multi-step objective|automated routine/);

      // Verify timeline events in chat message
      const timelineCount = await page.locator('[data-testid="agent-execution-timeline"]').count();
      console.log(`Agent timeline count: ${timelineCount}`);

      assert.equal(pageErrors.length, 0, `Page errors in ${scenario.name}: ${pageErrors.join(', ')}`);
      console.log(`Scenario ${scenario.name}: PASS`);

      await context.close();
    }

    console.log('\n========================================');
    console.log('ALL ADAPTIVE STUDIO ACCEPTANCE TESTS PASSED!');
    console.log('========================================');

  } finally {
    if (browser) await browser.close();
    if (serverProcess) {
      serverProcess.kill();
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

runSuite().catch(err => {
  console.error('Acceptance suite failed:', err);
  process.exit(1);
});
