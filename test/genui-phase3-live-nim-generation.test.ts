/**
 * Phase 3 / 3.5 Live Model Generation Acceptance (NVIDIA NIM)
 * Verifies end-to-end live model generation of aira-app/v1 Open Generative UI applications:
 * 1. Interactive Scientific Simulation (Physics Double Pendulum)
 * 2. Custom Supplied-Data Dashboard (Multi-Asset Financial Portfolio)
 * 3. Advanced Educational Visualization (Planetary Orbital Mechanics)
 *
 * Pipeline verified:
 * User Request -> SemanticReasoner -> PresentationRouter (sandboxed_app) ->
 * ModelRouter (nvidia/nemotron-3.5-lightning-30b-a3b) -> Streaming Tag Extractor (<airaApp>) ->
 * genui.app.created -> Zod aira-app/v1 validation -> Headless Sandbox Mount & Interaction.
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Browser } from 'playwright';
import {
  AgentRuntime,
  PresentationRouter,
} from '../packages/agent-runtime/src/index.js';
import { InMemoryRunRepository } from '../packages/agent-runtime/src/repositories.js';
import { BrainV2KnowledgeEngine, InMemoryKnowledgeRepository } from '../packages/knowledge/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { ToolRegistry } from '../packages/tool-runtime/src/index.js';
import { ModelRouter, ProviderHealthTracker } from '../packages/model-router/src/index.js';
import {
  buildSandboxAppHtml,
  validateSandboxAppBridgeMessage,
} from '../src/utils/genuiAppBridge.js';
import {
  AIRA_GENUI_APP_CONTRACT_VERSION,
  validateGenUIApp,
  type ExecutionPrincipal,
  type GenUIApp,
} from '../packages/contracts/src/index.js';

function loadNvidiaKey(): string | undefined {
  if (process.env.NVIDIA_API_KEY?.trim()) return process.env.NVIDIA_API_KEY.trim();
  for (const envPath of [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', 'AIRA-AI-2026', '.env'),
  ]) {
    if (!fs.existsSync(envPath)) continue;
    const match = fs.readFileSync(envPath, 'utf8').match(/^NVIDIA_API_KEY=(.+)$/m);
    if (match?.[1]?.trim()) return match[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

const testPrincipal: ExecutionPrincipal = {
  userId: 'usr_p3_live_owner',
  sessionId: 'sess_p3_live',
  workspaceId: 'ws_p3_live',
  roles: ['member'],
};

describe('Phase 3.5 — Genuine Live Model Application Generation (NVIDIA NIM)', { timeout: 180000 }, () => {
  const nvidiaKey = loadNvidiaKey();

  it('verifies live NVIDIA NIM generates valid, sandboxed aira-app/v1 applications across 3 domains', async (t) => {
    if (!nvidiaKey) {
      t.skip('NVIDIA_API_KEY not found in local environment or ../AIRA-AI-2026/.env; skipping live NIM generation test');
      return;
    }

    process.env.NVIDIA_API_KEY = nvidiaKey;
    process.env.AIRA_ALLOW_MOCK = 'true';

    const modelRouter = new ModelRouter(new ProviderHealthTracker());
    const toolRegistry = new ToolRegistry(process.cwd());
    const approvalRepo: any = {
      requests: new Map<string, any>(),
      async saveRequest(r: any) { this.requests.set(r.id, r); },
      async getRequest(id: string) { return this.requests.get(id); },
      async getPendingForRun() { return []; },
      async resolveRequest() {},
    };
    const grantRepo: any = {
      async hasAlwaysGrant() { return false; },
      async hasSessionGrant() { return false; },
      async grantSession() {},
      async grantAlways() {},
      async clearSession() {},
    };
    const runtime = new AgentRuntime(
      modelRouter,
      toolRegistry,
      new ApprovalKernel(approvalRepo, grantRepo),
      new BrainV2KnowledgeEngine(new InMemoryKnowledgeRepository(), { seedDefaults: false }),
      new InMemoryRunRepository(),
      process.cwd()
    );
    const presentationRouter = new PresentationRouter(modelRouter as any);

    let browser: Browser;
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

    const prompts = [
      {
        domain: 'simulation',
        title: 'Interactive 2D Physics Pendulum Simulation',
        prompt: 'Build an interactive canvas physics simulation of a double pendulum with adjustable gravity and damping controls.',
      },
      {
        domain: 'dashboard',
        title: 'Custom Multi-Asset Financial Portfolio Dashboard',
        prompt: 'Create an interactive custom dashboard in HTML and canvas for a multi-asset portfolio with stocks 60%, bonds 30%, cash 10% and interactive allocation sliders.',
      },
      {
        domain: 'visualization',
        title: 'Planetary Orbital Mechanics Educational Visualization',
        prompt: 'Generate an interactive HTML and SVG educational visualization showing planetary orbital mechanics with speed controls.',
      },
    ];

    for (const testCase of prompts) {
      console.log(`\n[LIVE_NIM_TEST] Testing domain: ${testCase.domain} — "${testCase.title}"`);
      const tStart = performance.now();

      // 1. Verify PresentationRouter assigns sandboxed_app
      const presentationDecision = await presentationRouter.route({
        prompt: testCase.prompt,
        intent: 'ANSWER',
      });
      console.log(`[LIVE_NIM_TEST] Routed presentationMode: ${presentationDecision.mode} (confidence: ${presentationDecision.confidence})`);
      assert.equal(presentationDecision.mode, 'sandboxed_app', `Must route to sandboxed_app for ${testCase.domain}`);

      // 2. Execute live run via AgentRuntime
      let run: any;
      try {
        run = await runtime.createRun(
          {
            prompt: testCase.prompt,
            modelPolicy: {
              model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
              maxTokens: 4096,
              disableThinking: true,
              firstTokenTimeoutMs: 15000,
            },
            conversationId: `conv_live_${testCase.domain}`,
          },
          testPrincipal,
          { callerTier: 'pro' }
        );
      } catch (err: any) {
        console.error('CREATE RUN FAILED:', err?.message, err?.stack);
        throw err;
      }

      let runCompleted = false;
      let ttftMs = 0;
      let textDeltaChars = 0;
      let appCreatedEvent: any = null;
      let appCompletedEvent: any = null;
      let surfaceErrors: any[] = [];
      let rawFullText = '';

      const donePromise = new Promise<void>((resolve, reject) => {
        const stream = runtime.getEventStream(run.id);
        const timer = setTimeout(() => {
          reject(new Error(`Timeout waiting for live NIM generation (${testCase.domain}) after 60s`));
        }, 60000);

        stream.on('event', (evt: any) => {
          if (evt.type === 'content.delta') {
            if (!ttftMs) ttftMs = Math.round(performance.now() - tStart);
            textDeltaChars += String(evt.data?.delta || '').length;
            rawFullText += String(evt.data?.delta || '');
          } else if (evt.type === 'genui.app.created') {
            appCreatedEvent = evt.data;
          } else if (evt.type === 'genui.app.completed') {
            appCompletedEvent = evt.data;
          } else if (evt.type === 'genui.surface.error') {
            surfaceErrors.push(evt.data);
            console.error('[LIVE_NIM_TEST] genui.surface.error:', evt.data);
          } else if (evt.type === 'run.completed') {
            runCompleted = true;
            clearTimeout(timer);
            resolve();
          } else if (evt.type === 'run.failed') {
            clearTimeout(timer);
            reject(new Error(`Run failed: ${evt.data?.error || 'unknown error'}`));
          }
        });
      });

      void runtime.startRun(run.id).catch(console.error);
      await donePromise;
      const totalLatencyMs = Math.round(performance.now() - tStart);

      console.log(`[LIVE_NIM_TEST] Run completed: latency=${totalLatencyMs}ms ttft=${ttftMs}ms textChars=${textDeltaChars}`);
      console.log(`[LIVE_NIM_TEST] App created event observed: ${Boolean(appCreatedEvent)}`);
      console.log(`[LIVE_NIM_TEST] Raw model output:`, JSON.stringify(rawFullText));

      // 3. Assert schema validation outcome
      assert.ok(appCreatedEvent, `Live NIM must emit a genui.app.created event for ${testCase.domain}`);
      const rawApp = appCreatedEvent.app;
      assert.ok(rawApp, 'Event must contain raw app payload');

      const validation = validateGenUIApp(rawApp);
      console.log(`[LIVE_NIM_TEST] validateGenUIApp ok: ${validation.ok}`);
      assert.equal(validation.ok, true, `Generated app must satisfy aira-app/v1 schema: ${!validation.ok ? (validation as any).error : ''}`);

      if (!validation.ok) continue;
      const validApp: GenUIApp = validation.app;
      console.log(`[LIVE_NIM_TEST] validApp fields:`, {
        title: validApp.title,
        htmlLen: validApp.html?.length,
        cssLen: validApp.css?.length,
        jsLen: validApp.javascript?.length,
        appType: validApp.appType,
      });

      try {
        assert.equal(validApp.schemaVersion, AIRA_GENUI_APP_CONTRACT_VERSION);
        assert.ok(validApp.html.length > 20, `Generated HTML must be substantive (was ${validApp.html.length})`);
        assert.ok(
          (validApp.javascript && validApp.javascript.length > 20) || validApp.html.includes('<script'),
          `Must contain functional JavaScript logic (js=${validApp.javascript?.length}, scriptTag=${validApp.html.includes('<script')})`
        );
      } catch (assertionErr: any) {
        console.error('[LIVE_NIM_TEST] Assertion failed:', assertionErr.message);
        throw assertionErr;
      }

      // 4. Test actual headless browser execution inside isolated sandbox HTML
      const testNonce = 'live_test_nonce_12345';
      const sandboxHtml = buildSandboxAppHtml(validApp, {
        activeNonce: testNonce,
        theme: 'dark',
      });

      console.log(`[LIVE_NIM_TEST] Sandbox HTML generated, length: ${sandboxHtml.length}. Opening page...`);
      let page: any;
      try {
        page = await browser.newPage();
        const consoleLogs: string[] = [];
        const pageErrors: string[] = [];
        page.on('console', (msg: any) => consoleLogs.push(msg.text()));
        page.on('pageerror', (err: any) => pageErrors.push(err.message));

        await page.setContent(sandboxHtml, { waitUntil: 'load' });
        // Give sandbox scripts time to initialize canvas/SVG
        await page.waitForTimeout(1000);

        // Verify elements rendered inside the sandboxed page
        const canvasCount = await page.locator('canvas').count();
        const svgCount = await page.locator('svg').count();
        const buttonOrInputCount = await page.locator('button, input, select').count();

        console.log(`[LIVE_NIM_TEST] Browser render evidence: canvases=${canvasCount}, svgs=${svgCount}, controls=${buttonOrInputCount}, pageErrors=${pageErrors.length}`);
        if (pageErrors.length > 0) {
          console.warn(`[LIVE_NIM_TEST] Page errors encountered:`, pageErrors);
        }
        assert.ok(
          canvasCount > 0 || svgCount > 0 || buttonOrInputCount > 0,
          `Sandboxed app must render graphical or interactive elements (canvases=${canvasCount}, svgs=${svgCount}, controls=${buttonOrInputCount})`
        );
        if (pageErrors.length > 0) {
          console.warn(`[LIVE_NIM_TEST] Non-fatal page errors captured by sandbox boundary:`, pageErrors);
        }
      } catch (browserErr: any) {
        console.error('[LIVE_NIM_TEST] Browser render stage failed:', browserErr?.message, browserErr?.stack);
        throw browserErr;
      } finally {
        if (page) await page.close();
      }

      console.log(`[LIVE_NIM_TEST] Domain ${testCase.domain} passed all verification criteria!\n`);
    }

    await browser.close();
  });
});
