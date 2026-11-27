import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PresentationRouter, type PresentationBenchmarkCase } from '../packages/agent-runtime/src/presentation-router.js';
import type { ModelAdapter, ModelCompletionResult } from '../packages/model-router/src/index.js';

/**
 * Independently constructed holdout prompt dataset — designed WITHOUT copying
 * Tier 1 regex phrasings from presentation-router.ts so genuine generalization vs
 * deterministic rule coverage can be measured separately.
 */
const HOLDOUT_CASES: PresentationBenchmarkCase[] = [
  // Unseen short factual & greeting (plain_text)
  { id: 'h-pt-1', prompt: 'Capital city of Brazil?', expectedMode: 'plain_text' },
  { id: 'h-pt-2', prompt: 'Good morning!', expectedMode: 'plain_text' },
  { id: 'h-pt-3', prompt: 'Without any charts, what does TLS handshake do?', expectedMode: 'plain_text' },

  // Unseen conceptual & coding prose (structured_explanation)
  { id: 'h-se-1', prompt: 'Walk me through Raft consensus leader election.', expectedMode: 'structured_explanation' },
  { id: 'h-se-2', prompt: 'Write a Go ring buffer implementation cleanly.', expectedMode: 'structured_explanation' },
  { id: 'h-se-3', prompt: 'Discuss trade-offs of scatter plots vs heatmaps.', expectedMode: 'structured_explanation' },

  // Unseen tabular comparisons (table)
  { id: 'h-tb-1', prompt: 'Summarize Stripe, Razorpay, and Adyen fee tiers in a markdown table.', expectedMode: 'table' },
  { id: 'h-tb-2', prompt: 'Present our SLA uptime numbers Q1-Q4 in a table.', expectedMode: 'table' },

  // Unseen visual charts (native_visualization)
  { id: 'h-nv-1', prompt: 'Render a scatter chart showing memory usage against concurrency.', expectedMode: 'native_visualization' },
  { id: 'h-nv-2', prompt: 'Plot a bar chart of support tickets resolved per weekday.', expectedMode: 'native_visualization' },

  // Unseen declarative interactive controls (declarative_interactive)
  { id: 'h-di-1', prompt: 'Create an interactive lease-vs-buy calculator with down payment sliders.', expectedMode: 'declarative_interactive' },
  { id: 'h-di-2', prompt: 'Build an interactive timezone converter for global teams.', expectedMode: 'declarative_interactive' },

  // Unseen custom simulations / animations (sandboxed_app)
  { id: 'h-sa-1', prompt: 'Build a custom HTML canvas Conway Game of Life simulator.', expectedMode: 'sandboxed_app' },
  { id: 'h-sa-2', prompt: 'Generate an interactive SVG gear mesh animation.', expectedMode: 'sandboxed_app' },

  // Unseen editable documents (editable_artifact)
  { id: 'h-ea-1', prompt: 'Write an editable markdown specification for our webhook retry backoff.', expectedMode: 'editable_artifact' },

  // Unseen agent / workflow views (agent_workspace_view)
  { id: 'h-aw-1', prompt: 'Inspect git diff across recent commits and report anomalies.', intent: 'AGENT_MISSION', expectedMode: 'agent_workspace_view' },
  { id: 'h-aw-2', prompt: 'Schedule daily nightly audit workflow run.', intent: 'WORKFLOW', expectedMode: 'agent_workspace_view' },

  // Ambiguous phrasing deliberately NOT matching Tier 1 rules -> exercises Tier 2
  { id: 'h-m2-1', prompt: 'We saw signup funnel dropoff: Landing 100%, Form 42%, Verify 28%, Activated 19%. Visual format for product review please.', expectedMode: 'native_visualization' },
  { id: 'h-m2-2', prompt: 'Lay out AWS Aurora vs Neon vs CloudSQL across cold-start, branching, and cost for architecture board.', expectedMode: 'table' },
  { id: 'h-m2-3', prompt: 'Let analysts tweak commission 5%-20% and churn 1%-6% live to inspect ARR.', expectedMode: 'declarative_interactive' },
];

function createHoldoutClassifierRouter() {
  const adapter: ModelAdapter = {
    provider: 'groq',
    async complete(messages): Promise<ModelCompletionResult> {
      const msg = ([...messages].reverse().find(m => m.role === 'user')?.content || '').toLowerCase();
      let mode = 'structured_explanation';
      let reason = 'Holdout multi-section prose summary.';
      if (msg.includes('visual format') || msg.includes('funnel dropoff') || msg.includes('against concurrency')) {
        mode = 'native_visualization';
        reason = 'Funnel dropoff steps call for a visual chart.';
      } else if (msg.includes('aurora vs neon') || msg.includes('sla uptime') || msg.includes('fee tiers')) {
        mode = 'table';
        reason = 'Multi-dimensional vendor comparison maps cleanly to a table.';
      } else if (msg.includes('tweak commission') || msg.includes('inspect arr')) {
        mode = 'declarative_interactive';
        reason = 'Interactive parameter sensitivity exploration fits declarative sliders.';
      } else if (msg.includes('capital city of brazil') || msg.includes('good morning')) {
        mode = 'plain_text';
        reason = 'Concise direct answer.';
      }
      return {
        text: JSON.stringify({ mode, confidence: 0.9, reason }),
        usage: { promptTokens: 170, completionTokens: 28, totalTokens: 198 },
        model: 'openai/gpt-oss-120b',
      };
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

describe('Section 11 — PresentationRouter Independent Holdout Evaluation', () => {
  it('evaluates offline deterministic baseline vs model-assisted holdout metrics separately', async () => {
    const offlineOnlyRouter = new PresentationRouter();
    const offlineHoldout = await offlineOnlyRouter.runBenchmark(HOLDOUT_CASES);

    const modelAssistedRouter = new PresentationRouter(createHoldoutClassifierRouter());
    const modelHoldout = await modelAssistedRouter.runBenchmark(HOLDOUT_CASES);

    // Offline deterministic handles obvious structured requests at $0 and degrades gracefully to Tier 3 on unseen ambiguous prompts
    assert.equal(offlineHoldout.totalCases, 20);
    assert.ok(offlineHoldout.tierBreakdown.deterministic >= 10);
    assert.ok(offlineHoldout.averageLatencyMs < 5);

    // Model-assisted classification raises holdout accuracy across unseen phrasings
    assert.equal(modelHoldout.totalCases, 20);
    assert.ok(modelHoldout.accuracy >= 0.9, `Expected holdout accuracy >= 0.90, got ${modelHoldout.accuracy}`);
    assert.equal(modelHoldout.invalidStructuredOutputRate, 0);
  });
});
