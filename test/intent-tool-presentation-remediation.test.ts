import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ServerIntentRouter,
  CapabilityRegistry,
  AgentRuntime,
  InMemoryRunRepository,
  PresentationRouter,
} from '../packages/agent-runtime/src/index.js';
import { ToolRegistry, ToolGateway, InMemoryToolCallRepository } from '../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../packages/approvals/src/index.js';
import { BrainV2KnowledgeEngine, InMemoryKnowledgeRepository } from '../packages/knowledge/src/index.js';
import { ModelRouter } from '../packages/model-router/src/index.js';
import type { ExecutionPrincipal } from '../packages/contracts/src/index.js';

function createTestApprovalKernel(): ApprovalKernel {
  const mockApprovalRepo: any = {
    createRequest: async () => {},
    getPendingRequest: async () => null,
    resolveRequest: async () => {},
  };
  const mockGrantRepo: any = {
    hasAlwaysGrant: async () => false,
    hasSessionGrant: async () => false,
    createSessionGrant: async () => {},
    clearSession: async () => {},
  };
  return new ApprovalKernel(mockApprovalRepo, mockGrantRepo);
}

function makeGuestPrincipal(): ExecutionPrincipal {
  return {
    userId: 'guest_test_p4_isolation',
    sessionId: 'sess_guest_p4',
    roles: ['guest_user'],
    scopes: ['chat:write'], // Never has browser.read!
  };
}

function makeRuntime() {
  const modelRouter = new ModelRouter();
  const toolRegistry = new ToolRegistry();
  const approvalKernel = createTestApprovalKernel();
  const toolGateway = new ToolGateway(new InMemoryToolCallRepository(), approvalKernel);
  const knowledge = new BrainV2KnowledgeEngine(new InMemoryKnowledgeRepository());
  const runRepo = new InMemoryRunRepository();
  const runtime = new AgentRuntime(
    modelRouter,
    toolRegistry,
    approvalKernel,
    knowledge,
    runRepo,
    process.cwd(),
    undefined,
    undefined,
    toolGateway
  );
  return { runtime, toolGateway };
}

async function runAndWait(
  runtime: AgentRuntime,
  req: Parameters<AgentRuntime['createRun']>[0],
  principal: ExecutionPrincipal
) {
  const events: any[] = [];
  let targetRunId = '';
  return new Promise<{ run: Awaited<ReturnType<AgentRuntime['getRun']>>; events: any[] }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AgentRuntime run timeout')), 5000);
    const listener = async ({ runId, event }: { runId: string; event: any }) => {
      if (targetRunId && runId !== targetRunId) return;
      events.push(event);
      if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
        clearTimeout(timer);
        runtime.off('run_event', listener);
        const finalRun = await runtime.getRun(targetRunId || runId);
        resolve({ run: finalRun, events });
      }
    };
    runtime.on('run_event', listener);
    runtime.createRun(req, principal).then(async run => {
      targetRunId = run.id;
      await runtime.startRun(run.id);
      const latest = await runtime.getRun(run.id);
      if (latest && (latest.state === 'COMPLETED' || latest.state === 'FAILED' || latest.state === 'CANCELLED')) {
        clearTimeout(timer);
        runtime.off('run_event', listener);
        resolve({ run: latest, events });
      }
    }).catch(err => {
      clearTimeout(timer);
      runtime.off('run_event', listener);
      reject(err);
    });
  });
}

describe('Section 7 & 11 — Intent, Tool Selection & PresentationRouter Remediation (TDD)', () => {
  it('1. routes supplied-data charts, interactive calculators, and HTML/SVG simulations to ANSWER with PresentationMode (never TOOL_ACTION)', async () => {
    const router = new ServerIntentRouter(new CapabilityRegistry());
    const guest = makeGuestPrincipal();

    const chart = await router.route({
      prompt: 'Create a bar chart comparing quarterly revenue Q1 $1.2M, Q2 $1.8M, Q3 $2.4M, Q4 $3.1M.',
      principal: guest,
    });
    assert.equal(chart.intent, 'ANSWER');
    assert.equal(chart.sideEffectLevel, 'NONE');
    assert.equal(chart.metadata.presentationMode, 'native_visualization');

    const calc = await router.route({
      prompt: 'Create an interactive compound interest calculator with principal, rate, and years sliders.',
      principal: guest,
    });
    assert.equal(calc.intent, 'ANSWER');
    assert.equal(calc.sideEffectLevel, 'NONE');
    assert.equal(calc.metadata.presentationMode, 'declarative_interactive');

    const sim = await router.route({
      prompt: 'Create an HTML/SVG interactive pendulum simulation with damping and gravity controls.',
      principal: guest,
    });
    assert.equal(sim.intent, 'ANSWER');
    assert.equal(sim.sideEffectLevel, 'NONE');
    assert.equal(sim.metadata.presentationMode, 'sandboxed_app');
  });

  it('2. distinguishes supplied datasets (ANSWER) from live external market/weather requests requiring retrieval (RESEARCH)', async () => {
    const router = new ServerIntentRouter(new CapabilityRegistry());
    const guest = makeGuestPrincipal();

    const liveStockChart = await router.route({
      prompt: "Plot NVIDIA's current stock price trend using today's live quote.",
      principal: guest,
    });
    assert.equal(liveStockChart.intent, 'RESEARCH');
    assert.equal(liveStockChart.metadata.isFreshnessRequired, true);
  });

  it('3. eliminates arbitrary web_search default in AgentRuntime Checkpoint 2 even if advisory/model intent is TOOL_ACTION', async () => {
    const { runtime } = makeRuntime();
    const guest = makeGuestPrincipal();

    // Even when a caller forces advisoryIntent='TOOL_ACTION' on an unmatched visualization prompt,
    // AgentRuntime MUST NOT default to web_search and fail with TOOL_PERMISSION_DENIED on browser.read.
    const { run: finished, events } = await runAndWait(
      runtime,
      {
        prompt: 'Create a bar chart comparing quarterly revenue Q1 $1.2M, Q2 $1.8M, Q3 $2.4M, Q4 $3.1M.',
        advisoryIntent: 'TOOL_ACTION',
        modelPolicy: { model: 'mock-deterministic' },
      },
      guest
    );

    assert.equal(finished?.state, 'COMPLETED', `Expected COMPLETED, got ${finished?.state}: ${finished?.error}`);
    assert.equal(finished?.toolsUsed.includes('web_search'), false);
    assert.equal(events.some(e => e.type === 'tool.started' && e.data?.name === 'web_search'), false);
  });

  it('4. preserves guest permission boundaries: explicit web search still fails closed at ToolGateway without granting browser.read', async () => {
    const { runtime } = makeRuntime();
    const guest = makeGuestPrincipal();

    const { run: finished } = await runAndWait(
      runtime,
      {
        prompt: 'Search the web for latest Kubernetes CVEs',
        modelPolicy: { model: 'mock-deterministic' },
      },
      guest
    );

    assert.equal(finished?.state, 'FAILED');
    assert.match(String(finished?.error || ''), /TOOL_PERMISSION_DENIED|browser\.read/);
  });

  it('5. integrates PresentationRouter cleanly without failing normal chat answers if presentation classification errors', async () => {
    const failingClassifier = {
      listProviders: () => ['groq'],
      resolvePolicy: () => ({ model: 'openai/gpt-oss-120b' as const, maxTokens: 120, temperature: 0, extendedThinking: false, timeoutMs: 50 }),
      getAdapter: () => ({
        provider: 'groq' as const,
        async complete() { throw new Error('CLASSIFIER_UPSTREAM_503'); },
        async stream() { throw new Error('CLASSIFIER_UPSTREAM_503'); },
      }),
    };
    const safePresentationRouter = new PresentationRouter(failingClassifier as any);
    const router = new ServerIntentRouter(new CapabilityRegistry(), undefined, safePresentationRouter);
    const decision = await router.route({
      prompt: 'Share a clean summary of Q3 priorities for engineering leadership.',
      principal: makeGuestPrincipal(),
    });
    assert.equal(decision.intent, 'ANSWER');
    assert.equal(decision.metadata.presentationDegraded, true);
    assert.ok(decision.metadata.presentationMode === 'plain_text' || decision.metadata.presentationMode === 'structured_explanation');
  });
});
