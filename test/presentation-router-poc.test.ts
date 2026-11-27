import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PresentationRouter,
  PRESENTATION_MODES,
  PresentationDecisionSchema,
  type PresentationMode,
  type PresentationBenchmarkCase,
} from '../packages/agent-runtime/src/presentation-router.js';
import type { ModelAdapter, ModelCompletionResult } from '../packages/model-router/src/index.js';

function makeStubModelRouter(responder: (promptText: string) => Promise<ModelCompletionResult>) {
  const adapter: ModelAdapter = {
    provider: 'groq',
    async complete(messages) {
      const userMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
      return responder(userMsg);
    },
    async stream(messages, policy, onChunk) {
      const res = await this.complete(messages, policy);
      if (res.text) onChunk({ type: 'text', text: res.text });
      return res;
    },
  };
  return {
    listProviders: () => ['groq'],
    resolvePolicy: () => ({
      model: 'openai/gpt-oss-120b' as const,
      maxTokens: 220,
      temperature: 0,
      extendedThinking: false,
      timeoutMs: 1200,
    }),
    getAdapter: () => adapter,
  };
}

describe('PresentationRouter PoC & Benchmark Evaluation (Phase 0 TDD)', () => {
  it('1. deterministically classifies all 8 distinct presentation modes via Tier 1 fast paths', async () => {
    const router = new PresentationRouter();

    const cases: Array<{ prompt: string; expected: PresentationMode; intent?: any }> = [
      { prompt: 'What is the capital of Japan?', expected: 'plain_text' },
      { prompt: 'Explain how quicksort works in TypeScript with time complexity notes.', expected: 'structured_explanation' },
      { prompt: 'Compare PostgreSQL, MySQL, and DuckDB in a markdown comparison table.', expected: 'table' },
      { prompt: 'Create a bar chart comparing quarterly revenue Q1 $1.2M, Q2 $1.8M, Q3 $2.4M, Q4 $3.1M.', expected: 'native_visualization' },
      { prompt: 'Create an interactive compound interest calculator with principal, rate, and years sliders.', expected: 'declarative_interactive' },
      { prompt: 'Create an HTML/SVG interactive pendulum physics simulation with play and damping controls.', expected: 'sandboxed_app' },
      { prompt: 'Write an editable markdown specification document for an API rate limiter we can refine iteratively.', expected: 'editable_artifact' },
      { prompt: 'Inspect the repository files, run git status, and investigate why the CI build is failing.', expected: 'agent_workspace_view', intent: 'AGENT_MISSION' },
    ];

    for (const tc of cases) {
      const decision = await router.route({ prompt: tc.prompt, intent: tc.intent });
      PresentationDecisionSchema.parse(decision);
      assert.equal(decision.mode, tc.expected, `Prompt failed mode assertion: ${tc.prompt}`);
      assert.equal(decision.source, 'deterministic');
      assert.equal(decision.estimatedCostUsd, 0);
      assert.equal(decision.degradedToFallback, false);
    }
    assert.equal(PRESENTATION_MODES.length, 8);
  });

  it('2. does not misroute chart/calculator/HTML requests to web_search and treats conceptual "explain a chart" as structured_explanation', async () => {
    const router = new PresentationRouter();

    const conceptualChart = await router.route({
      prompt: 'Explain when to use a stacked bar chart versus a grouped bar chart.',
    });
    assert.equal(conceptualChart.mode, 'structured_explanation');

    const chart = await router.route({ prompt: 'Plot a line chart of monthly active users Jan-Jun.' });
    assert.equal(chart.mode, 'native_visualization');
    assert.equal(chart.approach, 'controlled_genui');

    const htmlSim = await router.route({ prompt: 'Build a custom interactive solar orbit HTML canvas animation.' });
    assert.equal(htmlSim.mode, 'sandboxed_app');
    assert.equal(htmlSim.approach, 'open_genui_sandbox');
  });

  it('3. routes ambiguous prompts via Tier 2 ModelRouter structured JSON and tracks tokens, latency, and cost', async () => {
    let modelCalls = 0;
    const stubRouter = makeStubModelRouter(async () => {
      modelCalls += 1;
      return {
        text: JSON.stringify({
          mode: 'native_visualization',
          confidence: 0.91,
          reason: 'Quarterly revenue figures benefit most from a visual comparison chart.',
        }),
        usage: { promptTokens: 180, completionTokens: 32, totalTokens: 212 },
        model: 'openai/gpt-oss-120b',
      };
    });

    const router = new PresentationRouter(stubRouter as any);
    const decision = await router.route({
      prompt: 'Look at these four numbers for regional retention: North 72%, South 64%, East 81%, West 59%. Help executives digest this quickly.',
    });

    assert.equal(modelCalls, 1);
    assert.equal(decision.source, 'model');
    assert.equal(decision.mode, 'native_visualization');
    assert.equal(decision.usage.totalTokens, 212);
    assert.ok(decision.estimatedCostUsd > 0);
    assert.equal(decision.invalidStructuredOutput, false);
  });

  it('4. preserves answer delivery via Tier 3 fallback when model outputs invalid JSON, invalid mode, or times out', async () => {
    const malformedRouter = makeStubModelRouter(async () => ({
      text: 'I think maybe chart {not valid json',
      usage: { promptTokens: 150, completionTokens: 20, totalTokens: 170 },
    }));
    const r1 = new PresentationRouter(malformedRouter as any);
    const d1 = await r1.route({ prompt: 'Help me present these ambiguous regional numbers cleanly for stakeholders.' });
    assert.equal(d1.source, 'fallback');
    assert.equal(d1.degradedToFallback, true);
    assert.equal(d1.invalidStructuredOutput, true);
    assert.ok(d1.mode === 'structured_explanation' || d1.mode === 'plain_text');

    const schemaMismatchRouter = makeStubModelRouter(async () => ({
      text: JSON.stringify({ mode: 'nonexistent_mode', confidence: 0.99, reason: 'bad' }),
      usage: { promptTokens: 120, completionTokens: 15, totalTokens: 135 },
    }));
    const r2 = new PresentationRouter(schemaMismatchRouter as any);
    const d2 = await r2.route({ prompt: 'Suggest an appropriate presentation format for my messy findings.' });
    assert.equal(d2.source, 'fallback');
    assert.equal(d2.invalidStructuredOutput, true);

    const timeoutRouter = makeStubModelRouter(() => new Promise(resolve => setTimeout(() => resolve({
      text: '{"mode":"table","confidence":0.9,"reason":"late"}',
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    }), 150)));
    const r3 = new PresentationRouter(timeoutRouter as any, { modelTimeoutMs: 25 });
    const d3 = await r3.route({ prompt: 'What is the cleanest way to organize my project notes for an upcoming meeting?' });
    assert.equal(d3.source, 'fallback');
    assert.equal(d3.degradedToFallback, true);
  });

  it('5. executes benchmark evaluation dataset and computes real accuracy, latency, cost, fallback, and invalid output rates', async () => {
    const stubRouter = makeStubModelRouter(async (userMsg) => {
      if (userMsg.includes('stakeholders')) {
        return {
          text: JSON.stringify({ mode: 'table', confidence: 0.88, reason: 'Executive regional comparison fits a table.' }),
          usage: { promptTokens: 160, completionTokens: 28, totalTokens: 188 },
        };
      }
      return {
        text: JSON.stringify({ mode: 'structured_explanation', confidence: 0.84, reason: 'Structured conceptual summary.' }),
        usage: { promptTokens: 160, completionTokens: 24, totalTokens: 184 },
      };
    });

    const router = new PresentationRouter(stubRouter as any);
    const dataset: PresentationBenchmarkCase[] = [
      { id: 'b1', prompt: 'What is 144 divided by 12?', expectedMode: 'plain_text' },
      { id: 'b2', prompt: 'Explain closures in JavaScript with examples.', expectedMode: 'structured_explanation' },
      { id: 'b3', prompt: 'Format Q1-Q4 metrics as a markdown table.', expectedMode: 'table' },
      { id: 'b4', prompt: 'Create a bar chart comparing Q1 $1.2M and Q2 $1.8M.', expectedMode: 'native_visualization' },
      { id: 'b5', prompt: 'Create an interactive mortgage calculator with sliders.', expectedMode: 'declarative_interactive' },
      { id: 'b6', prompt: 'Build a custom HTML/SVG double pendulum simulation.', expectedMode: 'sandboxed_app' },
      { id: 'b7', prompt: 'Draft an editable spec document I can download.', expectedMode: 'editable_artifact' },
      { id: 'b8', prompt: 'Inspect the repo and fix failing tests.', intent: 'AGENT_MISSION', expectedMode: 'agent_workspace_view' },
      { id: 'b9', prompt: 'Organize regional metrics North 70 South 80 East 65 for stakeholders.', expectedMode: 'table' },
    ];

    const summary = await router.runBenchmark(dataset);
    assert.equal(summary.totalCases, 9);
    assert.equal(summary.correctCases, 9);
    assert.equal(summary.accuracy, 1);
    assert.equal(summary.invalidStructuredOutputRate, 0);
    assert.equal(summary.fallbackRate, 0);
    assert.ok(summary.averageLatencyMs >= 0);
    assert.ok(summary.totalEstimatedCostUsd >= 0);
  });

  it('6. honors explicit plain-text overrides over repo commands and safely escapes trailing backslashes / noisy prose around JSON', async () => {
    const overrideDecision = await new PresentationRouter().route({
      prompt: 'Inspect git status and show it in plain text only.',
    });
    assert.equal(overrideDecision.mode, 'plain_text');

    const noisyProseRouter = makeStubModelRouter(async () => ({
      text: 'Note: {ignore me} -> {"mode":"table","confidence":0.9,"reason":"Balanced JSON"} trailing {noise}',
      usage: { promptTokens: 110, completionTokens: 25, totalTokens: 135 },
    }));
    const d = await new PresentationRouter(noisyProseRouter as any).route({
      prompt: 'How should I organize these metrics ending with backslash \\',
    });
    assert.equal(d.mode, 'table');
    assert.equal(d.source, 'model');
  });
});
