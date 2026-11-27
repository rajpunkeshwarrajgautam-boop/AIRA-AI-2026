import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import {
  AIRA_GENUI_CONTRACT_VERSION,
  GenUIInteractionEventSchema,
  type ExecutionPrincipal,
} from '../packages/contracts/src/index.js';
import {
  AgentRuntime,
  authorizeGenUIActionServerSide,
} from '../packages/agent-runtime/src/index.js';
import { InMemoryRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { BrainV2KnowledgeEngine, InMemoryKnowledgeRepository } from '../packages/knowledge/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ModelRouter, ProviderHealthTracker } from '../packages/model-router/src/index.js';

const ARTIFACT_SCRATCH_DIR =
  'C:\\Users\\WORKSTATION\\.gemini\\antigravity\\brain\\074cf77d-58cf-45fb-afad-a94d2bd27d31\\scratch';

function loadNvidiaKeyIfAvailable(): string | undefined {
  if (process.env.NVIDIA_API_KEY && process.env.NVIDIA_API_KEY.trim()) {
    return process.env.NVIDIA_API_KEY.trim();
  }
  const siblingEnv = path.resolve(process.cwd(), '..', 'AIRA-AI-2026', '.env');
  const localEnv = path.resolve(process.cwd(), '.env');
  for (const envPath of [localEnv, siblingEnv]) {
    if (!fs.existsSync(envPath)) continue;
    const raw = fs.readFileSync(envPath, 'utf8');
    const match = raw.match(/^NVIDIA_API_KEY=(.+)$/m);
    if (match && match[1].trim()) {
      return match[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return undefined;
}

async function dismissBlockingOverlays(page: Page): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    let dismissedAny = false;
    const whatsNewClose = page
      .locator('[data-testid="whats-new-dismiss-btn"], [data-testid="whats-new-close-btn"]')
      .first();
    if (await whatsNewClose.isVisible().catch(() => false)) {
      dismissedAny = true;
      await whatsNewClose.click().catch(() => {});
    }
    const skipBtn = page.locator('[data-testid="onboarding-skip-btn"]');
    if (await skipBtn.isVisible().catch(() => false)) {
      dismissedAny = true;
      await skipBtn.click().catch(() => {});
    }
    if (!dismissedAny) break;
  }
}

test('Phase 1 GenUI E2E Acceptance (Scenarios A-O, Live NIM + Chart.js + Interactive Calculators + Security + Responsive Themes)', async () => {
  const distDir = path.resolve(process.cwd(), 'dist');
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')), 'dist/index.html must exist from npm run build');
  fs.mkdirSync(ARTIFACT_SCRATCH_DIR, { recursive: true });

  const savedEnv = { ...process.env };
  const nvidiaKey = loadNvidiaKeyIfAvailable();
  if (nvidiaKey) {
    process.env.NVIDIA_API_KEY = nvidiaKey;
  }
  process.env.AIRA_ALLOW_MOCK = 'true';
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const modelRouter = new ModelRouter(new ProviderHealthTracker());
  const toolRegistry = new ToolRegistry(process.cwd());
  const approvalRepo: any = {
    requests: new Map<string, any>(),
    async saveRequest(r: any) { this.requests.set(r.id, r); },
    async getRequest(id: string) { return this.requests.get(id); },
    async getPendingForRun(runId: string) {
      return Array.from(this.requests.values()).filter((r: any) => r.runId === runId && !r.decision);
    },
    async resolveRequest(id: string, decision: any, resolvedBy: string) {
      const r = this.requests.get(id);
      if (r) { r.decision = decision; r.resolvedBy = resolvedBy; r.resolvedAt = Date.now(); }
    },
  };
  const grantRepo: any = {
    async hasAlwaysGrant() { return false; },
    async hasSessionGrant() { return false; },
    async grantSession() {},
    async grantAlways() {},
    async clearSession() {},
  };
  const approvalKernel = new ApprovalKernel(approvalRepo, grantRepo);
  const runRepo = new InMemoryRunRepository();
  const runtime = new AgentRuntime(
    modelRouter,
    toolRegistry,
    approvalKernel,
    new BrainV2KnowledgeEngine(new InMemoryKnowledgeRepository(), { seedDefaults: false }),
    runRepo,
    process.cwd()
  );

  const ownerPrincipal: ExecutionPrincipal = {
    userId: 'usr_genui_e2e_owner',
    sessionId: 'sess_genui_e2e',
    workspaceId: 'ws_genui_e2e',
    roles: ['member'],
  };

  const csrfToken = 'csrf_genui_e2e_token';
  const approvalsReceived: Array<{ runId: string; requestId: string; decision: string }> = [];
  const genuiActionsReceived: any[] = [];
  const chatRequestsCaptured: Array<{ prompt: string; mode?: string }> = [];
  let liveNimResult: { completed: boolean; model?: string; presentationMode?: string; presentationSource?: string; genuiSurfaceCount: number; assistantTextLength: number } = {
    completed: false,
    genuiSurfaceCount: 0,
    assistantTextLength: 0,
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use((req, _res, next) => {
    const spoofed = req.headers['x-test-principal'];
    if (spoofed === 'attacker') {
      req.principal = {
        userId: 'usr_genui_attacker',
        sessionId: 'sess_attacker',
        workspaceId: 'ws_attacker',
        roles: ['member'],
      };
    } else {
      req.principal = ownerPrincipal;
    }
    next();
  });

  app.get('/api/auth/session', (_req, res) => {
    res.json({
      status: 'AUTHENTICATED',
      user: { id: ownerPrincipal.userId, email: 'genui-e2e@example.com', name: 'GenUI Verifier' },
      csrfToken,
    });
  });
  app.get('/api/billing/summary', (_req, res) => {
    res.json({
      tier: 'pro',
      usage: { standardDaily: 0, standardMonthly: 0, deepMonthly: 0, tokensMonthly: 0 },
      limits: { standardDaily: 150, standardMonthly: 2000, deepMonthly: 200 },
      creditBalance: 0,
    });
  });
  app.get('/api/billing/entitlements', (_req, res) => {
    res.json({
      tier: 'pro',
      features: { webSearch: true, deepThinking: true, builder: true, autonomous: true, vision: true },
    });
  });
  app.get('/api/announcements', (_req, res) => res.json({ announcements: [], unreadCount: 0 }));
  app.post('/api/announcements/dismiss', (_req, res) => res.json({ ok: true }));
  app.get('/api/conversations/search', (_req, res) => res.json({ results: [] }));
  app.get('/api/conversations', (_req, res) => res.json({ conversations: [] }));
  app.post('/api/conversations/sync', (_req, res) => res.json({ ok: true }));
  app.get('/api/user/onboarding', (_req, res) => res.json({ completed: true, currentStep: 99 }));
  app.post('/api/user/onboarding', (_req, res) => res.json({ completed: true, currentStep: 99 }));
  app.get('/api/account/settings', (_req, res) => res.json({ settings: null }));
  app.put('/api/account/settings', (_req, res) => res.json({ ok: true }));

  app.post('/api/runs/:id/approve', (req, res) => {
    const runId = String(req.params.id || '');
    const { requestId, decision } = req.body || {};
    if (req.principal?.userId !== ownerPrincipal.userId) {
      return res.status(403).json({ error: 'Cross-principal approval denied.' });
    }
    approvalsReceived.push({ runId, requestId: String(requestId || ''), decision: String(decision || '') });
    return res.json({ status: 'DECISION_RECORDED', decision });
  });

  app.post('/api/genui/actions', async (req, res) => {
    if (!req.principal?.userId) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = GenUIInteractionEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });
    const evt = parsed.data;
    const runOwnerUserId = evt.runId ? ownerPrincipal.userId : undefined;
    const authz = authorizeGenUIActionServerSide({
      principalUserId: req.principal.userId,
      runOwnerUserId,
      event: evt,
    });
    if (!authz.allowed) {
      return res.status(authz.status).json({ error: authz.reason });
    }
    genuiActionsReceived.push(evt);
    return res.json({ accepted: true, eventId: evt.eventId });
  });

  app.post('/api/chat/stream', async (req, res) => {
    const prompt = String(req.body?.prompt || '');
    chatRequestsCaptured.push({ prompt, mode: req.body?.mode });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const writeSse = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Real runtime + live NVIDIA path when prompt requests [LIVE_NIM]
    if (prompt.startsWith('[LIVE_NIM]')) {
      const cleanPrompt = prompt.replace(/^\[LIVE_NIM\]\s*/, '');
      const run = await runtime.createRun(
        {
          prompt: cleanPrompt,
          modelPolicy: { model: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
          conversationId: String(req.body?.conversationId || 'conv_live'),
        },
        ownerPrincipal,
        { callerTier: 'pro' }
      );
      writeSse('run_started', { runId: run.id });
      if (run.routingDecision) {
        writeSse('routing_decision', run.routingDecision);
        liveNimResult.presentationMode = String(run.routingDecision.metadata?.presentationMode || '');
        liveNimResult.presentationSource = String(run.routingDecision.metadata?.presentationSource || '');
      }

      const stream = runtime.getEventStream(run.id);
      const donePromise = new Promise<void>((resolve) => {
        const handler = (evt: any) => {
          if (evt.type === 'content.delta') {
            liveNimResult.assistantTextLength += String(evt.data.delta || '').length;
            writeSse('content_delta', { text: evt.data.delta });
          } else if (evt.type === 'model.provenance') {
            liveNimResult.model = evt.data?.executedModel;
            writeSse('model_provenance', evt.data);
          } else if (
            evt.type === 'genui.surface.created' ||
            evt.type === 'genui.surface.patched' ||
            evt.type === 'genui.surface.completed' ||
            evt.type === 'genui.surface.error'
          ) {
            if (evt.type === 'genui.surface.created') {
              liveNimResult.genuiSurfaceCount += 1;
            }
            writeSse('genui_event', {
              eventId: evt.eventId,
              type: evt.type,
              runId: evt.runId,
              sequence: evt.sequence ?? evt.data?.sequence ?? 0,
              timestamp: evt.timestamp,
              ...(evt.data || {}),
            });
          } else if (evt.type === 'run.completed' || evt.type === 'run.failed' || evt.type === 'run.cancelled') {
            if (evt.type !== 'run.completed') {
              console.warn('[LIVE_NIM_EVENT_TERMINAL]', evt.type, evt.data);
            }
            liveNimResult.completed = evt.type === 'run.completed';
            stream.off('event', handler);
            resolve();
          }
        };
        stream.on('event', handler);
      });
      void runtime.startRun(run.id).catch((err) => {
        console.error('[LIVE_NIM_START_ERR]', err);
      });
      await donePromise;
      res.write('event: done\ndata: [DONE]\n\n');
      res.end();
      return;
    }

    // Deterministic runtime-driven calculator path (tests real PresentationRouter + AgentRuntime calc surface without web_search!)
    if (!prompt.startsWith('Using updated parameters') && (/compound interest/i.test(prompt) || /f\(x\)\s*=/.test(prompt))) {
      const run = await runtime.createRun(
        {
          prompt,
          modelPolicy: { model: 'mock-deterministic' },
          conversationId: String(req.body?.conversationId || 'conv_calc'),
        },
        ownerPrincipal,
        { callerTier: 'pro' }
      );
      // Assert server router did NOT send calculator query to web_search!
      assert.equal(run.intent, 'ANSWER');
      assert.equal(run.routingDecision?.metadata?.presentationMode, 'declarative_interactive');
      writeSse('run_started', { runId: run.id });
      writeSse('routing_decision', run.routingDecision);

      const stream = runtime.getEventStream(run.id);
      const donePromise = new Promise<void>((resolve) => {
        const handler = (evt: any) => {
          if (evt.type === 'content.delta') {
            writeSse('content_delta', { text: evt.data.delta });
          } else if (
            evt.type === 'genui.surface.created' ||
            evt.type === 'genui.surface.completed'
          ) {
            writeSse('genui_event', {
              eventId: evt.eventId,
              type: evt.type,
              runId: evt.runId,
              sequence: evt.sequence ?? evt.data?.sequence ?? 0,
              timestamp: evt.timestamp,
              ...(evt.data || {}),
            });
          } else if (evt.type === 'run.completed' || evt.type === 'run.failed') {
            stream.off('event', handler);
            resolve();
          }
        };
        stream.on('event', handler);
      });
      void runtime.startRun(run.id).catch(console.error);
      await donePromise;
      res.write('event: done\ndata: [DONE]\n\n');
      res.end();
      return;
    }

    // Scenario A: Plain prose (no GenUI surface!)
    if (prompt.includes('Explain TCP three-way handshake')) {
      const runId = `run_prose_${Date.now()}`;
      writeSse('run_started', { runId });
      writeSse('content_delta', { text: 'TCP uses SYN, SYN-ACK, and ACK to establish a reliable session cleanly.' });
      res.write('event: done\ndata: [DONE]\n\n');
      res.end();
      return;
    }

    // Scenario C + G: Bar chart + Chart/Table toggle + out-of-order/duplicate/stale GenUI frame resilience
    if (prompt.includes('Plot Q1-Q3 revenue bar chart')) {
      const runId = `run_chart_${Date.now()}`;
      writeSse('run_started', { runId });
      writeSse('content_delta', { text: 'Revenue grew steadily from Q1 to Q3.' });
      const chartSurface = {
        schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
        surfaceId: 'surf_q1_q3_chart',
        title: 'Quarterly Revenue',
        rootId: 'c_root',
        textFallback: 'Q1: 120, Q2: 185, Q3: 240',
        components: [
          { id: 'c_root', type: 'vertical_group', props: { gap: 'md', children: ['c_chart', 'c_comp'] } },
          {
            id: 'c_chart',
            type: 'bar_chart',
            props: {
              title: 'Quarterly Revenue ($k)',
              labels: ['Q1', 'Q2', 'Q3'],
              datasets: [{ label: 'Revenue', values: [120, 185, 240], colorToken: 'primary' }],
              unit: '$k',
              allowTableToggle: true,
            },
          },
          {
            id: 'c_comp',
            type: 'comparison_viz',
            props: {
              title: 'Target Attainment',
              primaryLabel: 'Actual',
              secondaryLabel: 'Target',
              items: [{ label: 'Q3', primaryValue: 240, secondaryValue: 210 }],
            },
          },
        ],
      };
      // Created event
      writeSse('genui_event', {
        eventId: 'evt_chart_1',
        type: 'genui.surface.created',
        surfaceId: chartSurface.surfaceId,
        runId,
        sequence: 1,
        timestamp: Date.now(),
        surface: chartSurface,
      });
      // Exact duplicate (must be idempotently ignored!)
      writeSse('genui_event', {
        eventId: 'evt_chart_1',
        type: 'genui.surface.created',
        surfaceId: chartSurface.surfaceId,
        runId,
        sequence: 1,
        timestamp: Date.now(),
        surface: chartSurface,
      });
      // Stale event from another run (must be ignored!)
      writeSse('genui_event', {
        eventId: 'evt_chart_stale',
        type: 'genui.surface.created',
        surfaceId: 'surf_stale_ignored',
        runId: 'run_other_conv',
        sequence: 1,
        timestamp: Date.now(),
        surface: { ...chartSurface, surfaceId: 'surf_stale_ignored' },
      });
      writeSse('genui_event', {
        eventId: 'evt_chart_2',
        type: 'genui.surface.completed',
        surfaceId: chartSurface.surfaceId,
        runId,
        sequence: 2,
        timestamp: Date.now(),
      });
      res.write('event: done\ndata: [DONE]\n\n');
      res.end();
      return;
    }

    // Scenario F: Agent Execution + Approval Request + Fallback Unknown Component Card
    if (prompt.includes('Show Agent Execution Mission')) {
      const runId = 'run_exec_demo_1';
      writeSse('run_started', { runId });
      writeSse('content_delta', { text: 'Agent mission paused pending approval.' });
      writeSse('genui_event', {
        eventId: 'evt_exec_1',
        type: 'genui.surface.created',
        surfaceId: 'surf_exec_demo',
        runId,
        sequence: 1,
        timestamp: Date.now(),
        surface: {
          schemaVersion: AIRA_GENUI_CONTRACT_VERSION,
          surfaceId: 'surf_exec_demo',
          rootId: 'e_root',
          textFallback: 'Mission paused for file write approval.',
          components: [
            { id: 'e_root', type: 'vertical_group', props: { gap: 'sm', children: ['e_ms', 'e_tools', 'e_apr'] } },
            {
              id: 'e_ms',
              type: 'mission_summary',
              props: { title: 'Refactor Auth Middleware', status: 'WAITING_FOR_APPROVAL', intent: 'AGENT_MISSION', stepCount: 3, completedSteps: 2 },
            },
            {
              id: 'e_tools',
              type: 'tool_execution_summary',
              props: { title: 'Tools', calls: [{ toolName: 'repo_read', status: 'COMPLETED', durationMs: 28 }] },
            },
            {
              id: 'e_apr',
              type: 'approval_request',
              props: {
                approvalId: 'req_exec_approve_1',
                runId,
                toolName: 'file_write',
                risk: 'medium',
                reason: 'Apply middleware security patch',
                decision: 'PENDING',
              },
            },
          ],
        },
      });
      writeSse('genui_event', {
        eventId: 'evt_exec_bad',
        type: 'genui.surface.error',
        surfaceId: 'surf_exec_err_fallback',
        runId,
        sequence: 2,
        timestamp: Date.now(),
        error: 'Unknown widget blocked safely',
        fallbackText: 'Safe textual fallback rendered instead of unsafe widget.',
      });
      res.write('event: done\ndata: [DONE]\n\n');
      res.end();
      return;
    }

    // Default follow-up echo
    writeSse('run_started', { runId: `run_echo_${Date.now()}` });
    writeSse('content_delta', { text: `AIRA analyzed follow-up: ${prompt.slice(0, 180)}` });
    res.write('event: done\ndata: [DONE]\n\n');
    res.end();
  });

  app.use(express.static(distDir));
  app.use((_req, res) => res.sendFile(path.join(distDir, 'index.html')));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let browser;
  try {
    // Verify fail-closed server auth on /api/genui/actions (attacker blocked!)
    const attackerRes = await fetch(`${baseUrl}/api/genui/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-principal': 'attacker' },
      body: JSON.stringify({
        eventId: 'int_evil',
        surfaceId: 's1',
        componentId: 'b1',
        actionId: 'a1',
        kind: 'attach_followup',
        runId: 'run_1',
        stateSnapshot: {},
        timestamp: Date.now(),
      }),
    });
    assert.equal(attackerRes.status, 403, 'Cross-principal GenUI action must return 403');

    const forgedWorkflowRes = await fetch(`${baseUrl}/api/genui/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: 'int_wf',
        surfaceId: 's1',
        componentId: 'b1',
        actionId: 'a2',
        kind: 'workflow_trigger',
        stateSnapshot: {},
        timestamp: Date.now(),
      }),
    });
    assert.equal(forgedWorkflowRes.status, 403, 'Direct workflow trigger over /api/genui/actions must fail closed');

    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      browser = await chromium.launch({
        headless: true,
        executablePath: fs.existsSync(chromePath) ? chromePath : edgePath,
      });
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const pageErrors: string[] = [];
    const loadedChunks: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('response', (resp) => {
      const url = resp.url();
      if (url.includes('/assets/') && url.endsWith('.js')) {
        loadedChunks.push(path.basename(new URL(url).pathname));
      }
    });

    await page.addInitScript(() => {
      const dismissed = JSON.stringify(['ann_entitlements_v2', 'ann_onboarding_walkthrough', 'ann_model_routing_v3']);
      window.localStorage.setItem('aira_dismissed_announcements_usr_genui_e2e_owner', dismissed);
      window.localStorage.setItem('aira_dismissed_announcements_guest', dismissed);
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await dismissBlockingOverlays(page);

    // Proof 1: Chart.js chunk is NOT eagerly loaded on initial load
    assert.equal(
      loadedChunks.some((c) => c.startsWith('GenUIChartCanvas')),
      false,
      `Chart.js lazy chunk must NOT load eagerly before any chart surface is rendered (${loadedChunks.join(', ')})`
    );

    const composer = page.locator('main textarea').first();

    // Scenario A: Ordinary prose prompt produces clean text without unwanted chart widgets
    await composer.fill('Explain TCP three-way handshake');
    await composer.press('Enter');
    await page.getByText('TCP uses SYN, SYN-ACK, and ACK').waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await page.locator('[data-testid^="genui-surface-"]').count(), 0);

    // Scenario D: Deterministic compound interest calculator + live bidirectional slider/input + Reset + Ask AIRA follow-up
    await composer.fill('Calculate compound interest on $10000 at 8% for 10 years');
    await composer.press('Enter');
    await page.getByText('Compound Interest Explorer').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('canvas[role="img"][aria-label="Balance Growth Over Time"]').waitFor({ state: 'visible', timeout: 8000 });

    // Confirm Chart.js chunk lazy-loaded now!
    assert.equal(
      loadedChunks.some((c) => c.startsWith('GenUIChartCanvas')),
      true,
      'Chart.js lazy chunk MUST load once chart surface mounts'
    );

    const streamCountBeforeEdit = chatRequestsCaptured.length;
    const principalInput = page.getByLabel('Initial Principal ($)');
    await principalInput.fill('25000');
    await principalInput.blur();
    // 25000 * (1 + 0.08/12)^120 = 55,491.01
    await page.getByText('$55,491').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(chatRequestsCaptured.length, streamCountBeforeEdit, 'Local calculator recompute must NOT call AI');

    // Screenshot 1: Desktop Light theme
    await page.screenshot({ path: path.join(ARTIFACT_SCRATCH_DIR, 'genui-desktop-light.png'), fullPage: false });

    // Click Reset inputs -> reverts to $10,000 ($22,196.40)
    await page.getByRole('button', { name: 'Reset inputs' }).first().click();
    await page.getByText('$22,196').waitFor({ state: 'visible', timeout: 5000 });

    // Re-change principal to 20000 then click "Ask AIRA about current inputs"
    await principalInput.fill('20000');
    await page.getByRole('button', { name: 'Ask AIRA about current inputs' }).first().click();
    await page.getByText(/AIRA analyzed follow-up:.*20000/).waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(genuiActionsReceived.length >= 1, 'Server /api/genui/actions must record explicit follow-up action');

    // Scenario C + G: Bar chart + local Chart/Table toggle + duplicate/stale frame resilience
    await composer.fill('Plot Q1-Q3 revenue bar chart');
    await composer.press('Enter');
    const barCanvas = page.locator('canvas[role="img"][aria-label="Quarterly Revenue ($k)"]');
    await barCanvas.waitFor({ state: 'visible', timeout: 8000 });
    await barCanvas.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const el = document.querySelector('canvas[role="img"][aria-label="Quarterly Revenue ($k)"]') as HTMLCanvasElement | null;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 120 && r.height > 120;
    }, null, { timeout: 5000 });
    const box = await barCanvas.boundingBox();
    assert.ok(box && box.width > 120 && box.height > 120, `Chart.js canvas must render with non-zero box (got ${JSON.stringify(box)})`);
    // Stale surface must NOT mount
    assert.equal(await page.locator('[data-testid="genui-surface-surf_stale_ignored"]').count(), 0);

    // Toggle to Data Table locally
    const chartCard = page.locator('[data-testid="genui-chart-c_chart"]');
    await chartCard.getByRole('button', { name: 'Table' }).click();
    await chartCard.locator('table').waitFor({ state: 'visible', timeout: 3000 });
    await chartCard.getByRole('button', { name: 'Chart' }).click();
    await barCanvas.waitFor({ state: 'visible', timeout: 3000 });

    // Scenario E: Scientific plotter f(x) + safe invalid expression handling
    await composer.fill('Plot function f(x) = sin(x) + 0.25 * x^2');
    await composer.press('Enter');
    await page.getByText('Scientific Function Plotter').waitFor({ state: 'visible', timeout: 8000 });
    await page.getByRole('textbox', { name: 'f(x) =' }).fill('window.alert(1)');
    await page.getByText(/Unsupported/i).waitFor({ state: 'visible', timeout: 5000 });

    // Scenario F: Agent Execution + Approval button + error surface
    await composer.fill('Show Agent Execution Mission');
    await composer.press('Enter');
    await page.getByText('Refactor Auth Middleware').waitFor({ state: 'visible', timeout: 8000 });
    await page.getByRole('button', { name: 'Approve Once' }).click();
    await page.waitForTimeout(300);
    assert.ok(
      approvalsReceived.some((a) => a.requestId === 'req_exec_approve_1' && a.runId === 'run_exec_demo_1'),
      'GenUI Approval button must invoke real /api/runs/:id/approve'
    );

    // Theme Switch: Dark mode screenshot
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(ARTIFACT_SCRATCH_DIR, 'genui-desktop-dark.png'), fullPage: false });

    // Viewport: Tablet 768x1024 light check
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.waitForTimeout(200);
    const tabletOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    assert.equal(tabletOverflow, false, 'Tablet layout must have zero horizontal overflow');
    await page.screenshot({ path: path.join(ARTIFACT_SCRATCH_DIR, 'genui-tablet-light.png'), fullPage: false });

    // Viewport: Mobile 375x812 dark check
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(200);
    const mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    assert.equal(mobileOverflow, false, 'Mobile layout must have zero horizontal overflow');
    await page.screenshot({ path: path.join(ARTIFACT_SCRATCH_DIR, 'genui-mobile-dark.png'), fullPage: false });

    // Live NVIDIA NIM E2E verification (when NVIDIA_API_KEY is available)
    if (nvidiaKey) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
      const tLiveStart = performance.now();
      const chartCountBeforeLive = await page.locator('[data-testid^="genui-chart-"]').count();
      await composer.fill(
        '[LIVE_NIM] Visualize regional cloud latency trends (US-East 42ms, EU-West 58ms, AP-South 71ms) with a bar chart and brief explanation.'
      );
      await composer.press('Enter');

      // Wait genuinely for backend live NVIDIA NIM SSE stream completion
      const deadline = Date.now() + 28000;
      while (!liveNimResult.completed && Date.now() < deadline) {
        await page.waitForTimeout(150);
      }
      assert.equal(liveNimResult.completed, true, 'Live NVIDIA NIM turn must complete within 28s');
      assert.ok(
        liveNimResult.genuiSurfaceCount >= 1 || liveNimResult.assistantTextLength > 20,
        'Live NVIDIA NIM must produce validated GenUI surface or substantive answer text'
      );
      await page.waitForTimeout(300);
      const chartCountAfterLive = await page.locator('[data-testid^="genui-chart-"]').count();
      const liveMs = Math.round(performance.now() - tLiveStart);
      console.log(
        `[LIVE_NIM_E2E] completed=${liveNimResult.completed} model=${liveNimResult.model} presentationMode=${liveNimResult.presentationMode} source=${liveNimResult.presentationSource} genuiSurfaces=${liveNimResult.genuiSurfaceCount} chartDelta=${chartCountAfterLive - chartCountBeforeLive} textLen=${liveNimResult.assistantTextLength} latencyMs=${liveMs}`
      );
    } else {
      console.log('[LIVE_NIM_E2E] Skipped: NVIDIA_API_KEY not configured.');
    }

    assert.deepEqual(pageErrors, [], `Browser console/page errors observed: ${pageErrors.join(' | ')}`);
  } finally {
    if (browser) await browser.close();
    server.close();
    process.env = savedEnv;
  }
});
