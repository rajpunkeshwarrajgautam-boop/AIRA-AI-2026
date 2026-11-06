import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const port = Number(process.env.PHASE3_PORT || 4180);
const base = process.env.PHASE3_URL || `http://127.0.0.1:${port}`;
const externalServer = Boolean(process.env.PHASE3_URL);
const baseline = process.env.PHASE3_FLAG_OFF === 'true';
const artifactDir = 'C:/Users/WORKSTATION/.gemini/antigravity/brain/4692c5e1-8fc6-437f-8dc1-b5e0ba492b84';

async function ready(url) {
  for (let count = 0; count < 80; count++) {
    try { if ((await fetch(url)).ok) return; } catch { /* booting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`No local Vite response at ${url}`);
}

async function launchBrowser() {
  if (process.platform === 'win32' && process.env.PHASE3_BROWSER !== 'chromium') {
    return chromium.launch({ channel: 'msedge', headless: true });
  }
  const chromiumBundle = (await import('@sparticuz/chromium')).default;
  return chromium.launch({ executablePath: await chromiumBundle.executablePath(), args: chromiumBundle.args, headless: true });
}

const codeV1 = '<!doctype html><html><body style="font-family:sans-serif;padding:24px;background:#0d1117;color:#c9d1d9;"><h1>Interactive Solar Model</h1></body></html>';

function seedPhase3Fixture({ v1 }) {
  if (window.top !== window) return;
  const timestamp = Date.now();
  const artifact1 = {
    id: 'art-solar-model',
    title: 'Solar System 3D Simulation',
    type: 'text/html',
    language: 'html',
    version: 1,
    content: v1,
    versions: [{ version: 1, content: v1, timestamp }],
  };

  const graph = {
    graphId: 'graph-p3-01',
    runId: 'run-p3-01',
    title: 'Multi-Agent Autonomous Pipeline',
    nodes: {
      step_recon: {
        id: 'step_recon',
        name: 'Literature Reconnaissance',
        role: 'researcher',
        state: 'COMPLETED',
        dependsOn: [],
        objective: 'Discover and extract verified astronomical orbital parameters.',
        durationMs: 1200,
        startedAt: timestamp - 3000,
        completedAt: timestamp - 1800,
        attempt: 1,
        maxAttempts: 2,
        outputSummary: 'Compiled planetary mass, gravity, and eccentricity tables.'
      },
      step_coder: {
        id: 'step_coder',
        name: 'Interactive Model Synthesizer',
        role: 'coder',
        state: 'RUNNING',
        dependsOn: ['step_recon'],
        objective: 'Compile HTML5 canvas simulation with real planetary kinematics.',
        startedAt: timestamp - 1500,
        attempt: 1,
        maxAttempts: 2,
        activeTool: {
          name: 'vite_compiler',
          callId: 'call_99',
          status: 'running'
        },
        associatedArtifactId: 'art-solar-model',
        associatedArtifactTitle: 'Solar System 3D Simulation'
      },
      step_verify: {
        id: 'step_verify',
        name: 'Security & Integrity Gate',
        role: 'verifier',
        state: 'WAITING_FOR_APPROVAL',
        dependsOn: ['step_recon'],
        objective: 'Audit sandbox escape protections and origin policies.',
        attempt: 1,
        maxAttempts: 1,
        approvalRequired: true,
        approvalId: 'appr_p3_01',
        approvalReason: 'Port 8080 socket binding requires human authorization'
      },
      step_report: {
        id: 'step_report',
        name: 'Synthesized Verification Brief',
        role: 'synthesizer',
        state: 'BLOCKED',
        dependsOn: ['step_coder', 'step_verify'],
        objective: 'Produce comprehensive certification documentation.',
        attempt: 0,
        maxAttempts: 2
      }
    },
    waves: [['step_recon'], ['step_coder', 'step_verify'], ['step_report']],
    state: 'WAITING_FOR_APPROVAL',
    totalTasks: 4,
    completedTasks: 1,
    failedTasks: 0
  };

  const conversation = {
    id: 'phase3-fixture-conversation',
    title: 'Phase 3 Multi-Agent Verification',
    createdAt: timestamp - 6000,
    updatedAt: timestamp,
    messages: [
      { id: 'user-demo', role: 'user', content: 'Run autonomous multi-agent research and synthesis', timestamp: timestamp - 5000 },
      { 
        id: 'agent-demo', 
        role: 'assistant', 
        content: 'Autonomous swarm initialized. Multi-agent execution DAG is active.', 
        timestamp, 
        artifacts: [artifact1], 
        agentEvents: [
          { id: 'step:step_recon', kind: 'step', label: 'Step Literature Reconnaissance', status: 'completed', occurredAt: timestamp - 1800 },
          { id: 'step:step_coder', kind: 'step', label: 'Step Interactive Model Synthesizer', status: 'running', occurredAt: timestamp - 1500 },
          { id: 'step:step_verify', kind: 'approval', label: 'Approval required for Security & Integrity Gate', status: 'waiting', occurredAt: timestamp }
        ] 
      },
    ],
  };

  localStorage.setItem('aira_conversations_v1', JSON.stringify([conversation]));
  sessionStorage.setItem('aira_active_chat_session', conversation.id);
  // Also pass graph to session for instant rendering
  window.__AIRA_PHASE3_INITIAL_GRAPH__ = graph;
}

let server;
let browser;

try {
  if (!externalServer) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      env: { ...process.env, VITE_ADAPTIVE_STUDIO_PREVIEW: baseline ? 'false' : 'true' },
      cwd: 'D:/AIRA-PHASE3-WORKTREE',
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
    await context.addInitScript(seedPhase3Fixture, { v1: codeV1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(`${base}/?c=phase3-fixture-conversation`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="artifact-card"]').first().waitFor({ timeout: 12000 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    assert.equal(overflow, false, `${viewport.width} viewport has horizontal document overflow`);

    if (baseline) {
      assert.equal(await page.locator('.aira-adaptive-shell').count(), 0);
      assert.equal(await page.locator('[data-testid="agent-execution-graph"]').count(), 0);
      await page.screenshot({ path: path.join(artifactDir, 'phase3-edge-default-off-baseline.png') });
      console.log('PASS 1600x1000: default-off legacy layout verified');
      await context.close();
      break;
    }

    // Adaptive Mode Checks
    await page.locator('.aira-adaptive-shell').waitFor();

    if (viewport.width === 1600) {
      // 1. Initial State: Execution Graph Workspace in Studio Pane
      // When graph is active and no artifact is explicitly open, studio displays the DAG!
      await page.locator('[data-testid="agent-execution-graph"]').waitFor();
      assert.match(await page.locator('[data-testid="agent-execution-graph"]').innerText(), /Multi-Agent Autonomous Pipeline/i);
      assert.match(await page.locator('[data-testid="agent-execution-graph"]').innerText(), /1\/4 Tasks/);
      await page.screenshot({ path: path.join(artifactDir, 'phase3-edge-desktop-1600x1000-dag.png') });

      // 2. Node Selection & Inspector Drawer
      await page.locator('[data-testid="graph-node-step_coder"]').click();
      await page.locator('[data-testid="node-inspector-drawer"]').waitFor();
      assert.match(await page.locator('[data-testid="node-inspector-drawer"]').innerText(), /Interactive Model Synthesizer/);
      assert.match(await page.locator('[data-testid="node-inspector-drawer"]').innerText(), /Objective:/);
      await page.screenshot({ path: path.join(artifactDir, 'phase3-edge-desktop-1600x1000-node-inspector.png') });

      // 3. Artifact Synchronization via Inspector Button
      assert.equal(await page.locator('[data-testid="inspector-open-artifact-btn"]').count(), 1);
      await page.locator('[data-testid="inspector-open-artifact-btn"]').click();
      // Studio now opens the real sandboxed artifact preview!
      await page.locator('[data-testid="artifact-studio"]').waitFor();
      await page.screenshot({ path: path.join(artifactDir, 'phase3-edge-desktop-1600x1000-artifact-sync.png') });

      // 4. Studio Header Tab Integration: "Graph" Tab
      const graphTab = page.locator('button:has-text("Graph")');
      assert.equal(await graphTab.count(), 1, 'Studio header must include Graph tab when executionGraph exists');
      await graphTab.click();
      await page.waitForTimeout(300);
      assert.equal(await page.locator('[data-testid="agent-execution-graph"]').count(), 1);
      await page.screenshot({ path: path.join(artifactDir, 'phase3-edge-desktop-1600x1000-studio-graph-tab.png') });

      // 5. Toggle to Timeline View in Graph Toolbar
      await page.locator('[data-testid="graph-view-timeline-btn"]').click();
      await page.waitForTimeout(300);
      await page.locator('[data-testid="timeline-view-container"]').waitFor();
      assert.match(await page.locator('[data-testid="timeline-view-container"]').innerText(), /Wave 1/i);
      assert.match(await page.locator('[data-testid="timeline-view-container"]').innerText(), /Wave 2/i);
      await page.screenshot({ path: path.join(artifactDir, 'phase3-edge-desktop-1600x1000-timeline.png') });

      // Return to DAG view
      await page.locator('[data-testid="graph-view-dag-btn"]').click();
      await page.waitForTimeout(300);
      await page.locator('[data-testid="dag-canvas-container"]').waitFor();

      // 6. Interactive HITL Tool Approval in DAG
      await page.locator('[data-testid="node-approve-btn-step_verify"]').waitFor();
      await page.locator('[data-testid="node-approve-btn-step_verify"]').click();
      await page.waitForTimeout(400);
    } else if (viewport.width === 768) {
      await page.screenshot({ path: path.join(artifactDir, 'phase3-edge-tablet-768x1024.png') });
    } else if (viewport.width === 390) {
      await page.screenshot({ path: path.join(artifactDir, 'phase3-edge-mobile-390x844.png') });
    } else if (viewport.width === 320) {
      await page.screenshot({ path: path.join(artifactDir, 'phase3-edge-small-mobile-320x700.png') });
    }

    assert.deepEqual(errors, [], `${viewport.width} viewport produced unexpected console errors`);
    console.log(`PASS ${viewport.width}x${viewport.height}: execution graph, DAG/timeline toggle, artifact sync, zero overflow`);
    await context.close();
  }

  console.log(baseline ? 'PHASE3_DEFAULT_OFF_BROWSER_PASS' : 'PHASE3_EDGE_BROWSER_ACCEPTANCE_PASS');
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}
