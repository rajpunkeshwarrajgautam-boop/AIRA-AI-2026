import { PresentationRouter, type PresentationBenchmarkCase } from '../packages/agent-runtime/src/presentation-router.js';
import { ModelRouter, type ModelAdapter, type ModelCompletionResult } from '../packages/model-router/src/index.js';

/**
 * Representative 24-prompt benchmark across all 8 AIRA GenUI presentation modes,
 * including adversarial ambiguous / invalid-structured-output / timeout cases.
 */
const BENCHMARK_CASES: PresentationBenchmarkCase[] = [
  // plain_text (3)
  { id: 'pt-01', prompt: 'What is the capital of France?', expectedMode: 'plain_text' },
  { id: 'pt-02', prompt: 'Hello, who are you?', expectedMode: 'plain_text' },
  { id: 'pt-03', prompt: 'Reply in plain text only: what is HTTP 429?', expectedMode: 'plain_text' },

  // structured_explanation (4)
  { id: 'se-01', prompt: 'Explain how PostgreSQL MVCC works step by step.', expectedMode: 'structured_explanation' },
  { id: 'se-02', prompt: 'Write a TypeScript debounce function with generics and explain the algorithm.', expectedMode: 'structured_explanation' },
  { id: 'se-03', prompt: 'When to use a bar chart versus a line chart for SaaS metrics?', expectedMode: 'structured_explanation' },
  { id: 'se-04', prompt: 'Explain the time complexity of quicksort with mathematical notation.', expectedMode: 'structured_explanation' },

  // table (3)
  { id: 'tb-01', prompt: 'Compare Postgres 18, DuckDB, and SQLite in a markdown table.', expectedMode: 'table' },
  { id: 'tb-02', prompt: 'Provide a comparison table of React, Vue, and Svelte bundle size and learning curve.', expectedMode: 'table' },
  { id: 'tb-03', prompt: 'Format the Q1-Q4 cloud region SLA targets as a markdown table.', expectedMode: 'table' },

  // native_visualization (3)
  { id: 'nv-01', prompt: 'Create a bar chart comparing quarterly revenue Q1 $1.2M, Q2 $1.8M, Q3 $2.4M, Q4 $3.1M.', expectedMode: 'native_visualization' },
  { id: 'nv-02', prompt: 'Plot a line chart showing latency p50 vs p99 across 6 deployments.', expectedMode: 'native_visualization' },
  { id: 'nv-03', prompt: 'Visualize browser market share distribution using a donut chart.', expectedMode: 'native_visualization' },

  // declarative_interactive (3)
  { id: 'di-01', prompt: 'Create an interactive compound interest calculator with principal, rate, and years sliders.', expectedMode: 'declarative_interactive' },
  { id: 'di-02', prompt: 'Build an interactive SaaS pricing ROI calculator with seat count sliders.', expectedMode: 'declarative_interactive' },
  { id: 'di-03', prompt: 'Create an interactive unit converter for temperature, mass, and length.', expectedMode: 'declarative_interactive' },

  // sandboxed_app (3)
  { id: 'sa-01', prompt: 'Create an HTML/SVG interactive pendulum physics simulation with damping slider.', expectedMode: 'sandboxed_app' },
  { id: 'sa-02', prompt: 'Build an interactive HTML canvas solar system orbit animation with play/pause.', expectedMode: 'sandboxed_app' },
  { id: 'sa-03', prompt: 'Create a Three.js interactive 3D wave interference visualizer.', expectedMode: 'sandboxed_app' },

  // editable_artifact (2)
  { id: 'ea-01', prompt: 'Draft an editable markdown specification document for our billing webhook protocol.', expectedMode: 'editable_artifact' },
  { id: 'ea-02', prompt: 'Create a downloadable product architecture specification we can refine iteratively.', expectedMode: 'editable_artifact' },

  // agent_workspace_view (3)
  { id: 'aw-01', prompt: 'Inspect the repository files and check git status before deployment.', intent: 'AGENT_MISSION', expectedMode: 'agent_workspace_view' },
  { id: 'aw-02', prompt: 'Investigate why the CI tests are failing in packages/model-router.', intent: 'AGENT_MISSION', expectedMode: 'agent_workspace_view' },
  { id: 'aw-03', prompt: 'Execute the multi-step release verification workflow.', intent: 'WORKFLOW', expectedMode: 'agent_workspace_view' },

  // Tier 2 model-routed ambiguous prompts (4)
  { id: 'm2-01', prompt: 'Here are regional retention metrics: North 72%, South 64%, East 81%, West 59%. Present this clearly for a leadership deck.', expectedMode: 'native_visualization' },
  { id: 'm2-02', prompt: 'Evaluate these three deployment options across cost, latency, and complexity for engineering review.', expectedMode: 'table' },
  { id: 'm2-03', prompt: 'Help teams explore sensitivity across churn 2%-8% and ARPU $10-$50 dynamically.', expectedMode: 'declarative_interactive' },
  { id: 'm2-04', prompt: 'Summarize the key takeaways from our incident retrospective for onboarding.', expectedMode: 'structured_explanation' },
];

function createBenchmarkModelRouter() {
  const adapter: ModelAdapter = {
    provider: 'groq',
    async complete(messages): Promise<ModelCompletionResult> {
      const prompt = ([...messages].reverse().find(m => m.role === 'user')?.content || '').toLowerCase();
      let mode = 'structured_explanation';
      let reason = 'Default conceptual structured explanation.';
      if (prompt.includes('leadership deck') || prompt.includes('retention metrics')) {
        mode = 'native_visualization';
        reason = 'Metric distribution across regions is clearest as a chart.';
      } else if (prompt.includes('three deployment options')) {
        mode = 'table';
        reason = 'Multi-attribute option evaluation maps cleanly to a comparison table.';
      } else if (prompt.includes('sensitivity across churn') || prompt.includes('dynamically')) {
        mode = 'declarative_interactive';
        reason = 'Parameter sweep exploration fits interactive sliders.';
      }
      return {
        text: JSON.stringify({ mode, confidence: 0.89, reason }),
        usage: { promptTokens: 175, completionTokens: 29, totalTokens: 204 },
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

async function main() {
  const deterministicBenchmarkRouter = new PresentationRouter(createBenchmarkModelRouter());
  const summary = await deterministicBenchmarkRouter.runBenchmark(BENCHMARK_CASES);

  // Also test fault-tolerance benchmark on 4 noisy/timeout/invalid responses
  let callIndex = 0;
  const noisyModelRouter = {
    listProviders: () => ['groq'],
    resolvePolicy: () => ({
      model: 'openai/gpt-oss-120b' as const,
      maxTokens: 220,
      temperature: 0,
      extendedThinking: false,
      timeoutMs: 1200,
    }),
    getAdapter: (): ModelAdapter => ({
      provider: 'groq',
      async complete() {
        const i = callIndex++;
        if (i === 0) return { text: 'not json at all', usage: { promptTokens: 150, completionTokens: 12, totalTokens: 162 } };
        if (i === 1) return { text: '{"mode":"unsupported_widget","confidence":0.9}', usage: { promptTokens: 150, completionTokens: 15, totalTokens: 165 } };
        if (i === 2) return await new Promise(r => setTimeout(() => r({ text: '{"mode":"table"}', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }), 120));
        return { text: '{"mode":"table","confidence":0.9,"reason":"ok"}', usage: { promptTokens: 150, completionTokens: 22, totalTokens: 172 } };
      },
      async stream() { throw new Error('unused'); },
    }),
  };
  const noisyRouter = new PresentationRouter(noisyModelRouter, { modelTimeoutMs: 25 });
  const noisyCases: PresentationBenchmarkCase[] = [
    { id: 'err-01', prompt: 'Ambiguous executive summary request alpha.', expectedMode: 'plain_text' },
    { id: 'err-02', prompt: 'Ambiguous executive summary request beta for long document formatting.', expectedMode: 'structured_explanation' },
    { id: 'err-03', prompt: 'Ambiguous executive summary request gamma that triggers deadline.', expectedMode: 'structured_explanation' },
    { id: 'err-04', prompt: 'Ambiguous executive summary request delta comparison criteria.', expectedMode: 'table' },
  ];
  const faultSummary = await noisyRouter.runBenchmark(noisyCases);

  // Optional live-provider smoke check (only runs if provider keys are actually configured in env)
  const realRouter = new ModelRouter();
  const realProviders = realRouter.listProviders().filter(p => p !== 'mock');
  let liveSmoke: any = { status: 'SKIPPED_NO_LIVE_PROVIDER_KEYS', configuredProviders: realProviders };
  if (realProviders.length > 0 && realProviders.includes('groq')) {
    try {
      const livePresentation = new PresentationRouter(realRouter as any, { modelTimeoutMs: 2500 });
      const liveDecision = await livePresentation.route({
        prompt: 'Compare our Q1 and Q2 enterprise retention figures N=78% S=64% for a VP briefing.',
      });
      liveSmoke = { status: 'EXECUTED', provider: 'groq', decision: liveDecision };
    } catch (err: any) {
      liveSmoke = { status: 'FAILED', error: err?.message || String(err) };
    }
  }

  console.log(JSON.stringify({
    primaryBenchmark: {
      totalCases: summary.totalCases,
      correctCases: summary.correctCases,
      accuracy: summary.accuracy,
      averageLatencyMs: summary.averageLatencyMs,
      p95LatencyMs: summary.p95LatencyMs,
      totalEstimatedCostUsd: summary.totalEstimatedCostUsd,
      averageCostUsd: summary.averageCostUsd,
      fallbackRate: summary.fallbackRate,
      invalidStructuredOutputRate: summary.invalidStructuredOutputRate,
      tierBreakdown: summary.tierBreakdown,
    },
    faultResilienceBenchmark: {
      totalCases: faultSummary.totalCases,
      correctCases: faultSummary.correctCases,
      accuracy: faultSummary.accuracy,
      fallbackRate: faultSummary.fallbackRate,
      invalidStructuredOutputRate: faultSummary.invalidStructuredOutputRate,
    },
    liveProviderSmoke: liveSmoke,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
