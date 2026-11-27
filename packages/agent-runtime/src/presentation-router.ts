import { z } from 'zod';
import type { IntentTaxonomy, ModelPolicy } from '../../contracts/src/index.js';
import type { ModelAdapter } from '../../model-router/src/index.js';

export const PRESENTATION_MODES = [
  'plain_text',
  'structured_explanation',
  'table',
  'native_visualization',
  'declarative_interactive',
  'sandboxed_app',
  'editable_artifact',
  'agent_workspace_view',
] as const;

export const PresentationModeSchema = z.enum(PRESENTATION_MODES);
export type PresentationMode = z.infer<typeof PresentationModeSchema>;

export const PresentationApproachSchema = z.enum([
  'text_markdown',
  'controlled_genui',
  'declarative_a2ui',
  'open_genui_sandbox',
  'artifact_studio',
  'agent_workspace',
]);
export type PresentationApproach = z.infer<typeof PresentationApproachSchema>;

export const PresentationDecisionSchema = z.object({
  mode: PresentationModeSchema,
  approach: PresentationApproachSchema,
  source: z.enum(['deterministic', 'model', 'fallback']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(300),
  degradedToFallback: z.boolean(),
  invalidStructuredOutput: z.boolean(),
  latencyMs: z.number().nonnegative(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }),
  estimatedCostUsd: z.number().nonnegative(),
});
export type PresentationDecision = z.infer<typeof PresentationDecisionSchema>;

const ModelPresentationChoiceSchema = z.object({
  mode: PresentationModeSchema,
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().min(1).max(300).optional(),
});

export interface PresentationRoutingInput {
  prompt: string;
  intent?: IntentTaxonomy;
  conversationHistory?: Array<{ role: string; content: string }>;
  preferredMode?: PresentationMode;
}

export interface PresentationRouterModelProvider {
  listProviders(): string[];
  resolvePolicy(model: any, intent?: IntentTaxonomy): ModelPolicy;
  getAdapter(policy: ModelPolicy): ModelAdapter;
}

export interface PresentationRouterOptions {
  modelTimeoutMs?: number;
  inputCostPerMillionUsd?: number;
  outputCostPerMillionUsd?: number;
}

export interface PresentationBenchmarkCase {
  id: string;
  prompt: string;
  intent?: IntentTaxonomy;
  expectedMode: PresentationMode;
}

export interface PresentationBenchmarkSummary {
  totalCases: number;
  correctCases: number;
  accuracy: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  totalEstimatedCostUsd: number;
  averageCostUsd: number;
  fallbackRate: number;
  invalidStructuredOutputRate: number;
  tierBreakdown: {
    deterministic: number;
    model: number;
    fallback: number;
  };
  results: Array<{
    id: string;
    expectedMode: PresentationMode;
    actualMode: PresentationMode;
    correct: boolean;
    decision: PresentationDecision;
  }>;
}

export function approachForMode(mode: PresentationMode): PresentationApproach {
  switch (mode) {
    case 'plain_text':
    case 'structured_explanation':
      return 'text_markdown';
    case 'table':
    case 'native_visualization':
      return 'controlled_genui';
    case 'declarative_interactive':
      return 'declarative_a2ui';
    case 'sandboxed_app':
      return 'open_genui_sandbox';
    case 'editable_artifact':
      return 'artifact_studio';
    case 'agent_workspace_view':
      return 'agent_workspace';
  }
}

const PRESENTATION_SYSTEM_PROMPT =
  'You are AIRA PresentationRouter. Choose the best single UI presentation mode for a user prompt. ' +
  'Return strictly valid JSON: {"mode": one of ["plain_text","structured_explanation","table","native_visualization","declarative_interactive","sandboxed_app","editable_artifact","agent_workspace_view"], "confidence": 0.0-1.0, "reason": "<under 180 chars>"}.';

/**
 * Isolated Phase 0 PoC PresentationRouter.
 * Implements 3-tier AIRA-native presentation selection:
 *   Tier 1: Deterministic fast-paths (<1ms, $0)
 *   Tier 2: Bounded existing ModelRouter structured JSON classification (Zod v4 validated)
 *   Tier 3: Safe fallback to text/Markdown so answers never fail if selection errors.
 */
export class PresentationRouter {
  private readonly modelTimeoutMs: number;
  private readonly inputCostPerMillionUsd: number;
  private readonly outputCostPerMillionUsd: number;

  constructor(
    private readonly modelRouter?: PresentationRouterModelProvider,
    options: PresentationRouterOptions = {}
  ) {
    this.modelTimeoutMs = options.modelTimeoutMs ?? 1200;
    // Reference Groq/Flash-Lite tier cost baseline ($0.15/1M in, $0.60/1M out)
    this.inputCostPerMillionUsd = options.inputCostPerMillionUsd ?? 0.15;
    this.outputCostPerMillionUsd = options.outputCostPerMillionUsd ?? 0.60;
  }

  public async route(input: PresentationRoutingInput): Promise<PresentationDecision> {
    const startNs = performance.now();
    const rawPrompt = (input.prompt || '').trim();
    const zeroUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    if (input.preferredMode && PRESENTATION_MODES.includes(input.preferredMode)) {
      return {
        mode: input.preferredMode,
        approach: approachForMode(input.preferredMode),
        source: 'deterministic',
        confidence: 1,
        reason: 'Caller explicitly requested presentation mode.',
        degradedToFallback: false,
        invalidStructuredOutput: false,
        latencyMs: Math.round((performance.now() - startNs) * 100) / 100,
        usage: zeroUsage,
        estimatedCostUsd: 0,
      };
    }

    const tier1 = this.classifyDeterministic(rawPrompt, input.intent);
    if (tier1) {
      return {
        mode: tier1.mode,
        approach: approachForMode(tier1.mode),
        source: 'deterministic',
        confidence: tier1.confidence,
        reason: tier1.reason,
        degradedToFallback: false,
        invalidStructuredOutput: false,
        latencyMs: Math.round((performance.now() - startNs) * 100) / 100,
        usage: zeroUsage,
        estimatedCostUsd: 0,
      };
    }

    if (this.modelRouter && this.modelRouter.listProviders().length > 0 && rawPrompt.length > 0) {
      const modelAttempt = await this.classifyWithModel(rawPrompt, startNs);
      if (modelAttempt.decision) {
        return modelAttempt.decision;
      }
      return this.buildFallbackDecision(
        rawPrompt,
        startNs,
        modelAttempt.usage,
        modelAttempt.estimatedCostUsd,
        modelAttempt.invalidStructuredOutput,
        modelAttempt.reason
      );
    }

    return this.buildFallbackDecision(
      rawPrompt,
      startNs,
      zeroUsage,
      0,
      false,
      'No model classifier available; preserved answer via text/Markdown fallback.'
    );
  }

  private classifyDeterministic(
    prompt: string,
    intent?: IntentTaxonomy
  ): { mode: PresentationMode; confidence: number; reason: string } | null {
    const lower = prompt.toLowerCase();

    // 1. Explicit plain text override takes precedence over visual/workspace layouts
    if (/\b(plain\s+text(\s+only)?|no\s+charts?|without\s+charts?|text\s+only)\b/i.test(lower)) {
      return {
        mode: 'plain_text',
        confidence: 0.97,
        reason: 'User requested plain text presentation.',
      };
    }

    // 2. Agent Workspace execution views take priority for multi-step missions/workflows/repo inspection
    if (
      intent === 'AGENT_MISSION' ||
      intent === 'WORKFLOW' ||
      intent === 'AUTOMATION_CREATE' ||
      /\b(inspect\s+(?:the\s+)?(?:repo|repository|workspace|codebase)|git\s+(?:status|diff|log)|fix\s+failing\s+tests|investigate\s+why\s+the\s+ci)\b/i.test(lower)
    ) {
      return {
        mode: 'agent_workspace_view',
        confidence: 0.96,
        reason: 'Multi-step agent/repo execution maps to Agent Workspace view.',
      };
    }

    // 3. Explicit tabular output
    if (/\b(markdown\s+(?:comparison\s+)?table|comparison\s+table|(?:in|as)\s+a\s+(?:markdown\s+)?table)\b/i.test(lower)) {
      return {
        mode: 'table',
        confidence: 0.96,
        reason: 'Explicit table formatting request routed to structured table mode.',
      };
    }

    // 4. Conceptual explanation guard (avoid hijacking "explain X chart" or coding tutorials)
    const isConceptualExplanation =
      /^(explain|when\s+to\s+use|how\s+does|how\s+do|why\s+does|what\s+are\s+the\s+differences|describe)\b/i.test(lower) &&
      !/\b(create|build|generate|plot|render|draw|make)\b/i.test(lower);
    if (isConceptualExplanation) {
      return {
        mode: 'structured_explanation',
        confidence: 0.94,
        reason: 'Conceptual inquiry routed to structured Markdown explanation.',
      };
    }

    // 5. Sandboxed custom mini-apps (HTML/SVG/Canvas/Three.js animations & simulations)
    if (
      /\b(html|svg|canvas|three\.?js|webgl)\b/i.test(lower) &&
      /\b(interactive|simulation|animation|app|widget|pendulum|orbit|physics|game|visualizer)\b/i.test(lower)
    ) {
      return {
        mode: 'sandboxed_app',
        confidence: 0.94,
        reason: 'Custom HTML/SVG/Canvas interactive simulation routes to isolated sandboxed app.',
      };
    }

    // 6. Editable / downloadable artifacts
    if (
      /\b(editable\s+(?:markdown\s+)?(?:artifact|spec|specification|document|report)|downloadable\s+(?:spec|specification|document|report)|refine\s+iteratively)\b/i.test(lower)
    ) {
      return {
        mode: 'editable_artifact',
        confidence: 0.93,
        reason: 'Iterative/downloadable deliverable routed to editable artifact studio.',
      };
    }

    // 7. Declarative interactive controls (calculators, sliders, forms, configurators)
    if (
      /\b(interactive\s+[a-z\s]{0,30}(?:calculator|converter|picker|filter|form|dashboard)|calculator\s+with\s+sliders?|sliders?\s+for)\b/i.test(lower)
    ) {
      return {
        mode: 'declarative_interactive',
        confidence: 0.93,
        reason: 'Structured interactive controls/calculator routed to declarative interactive surface.',
      };
    }

    // 8. Native charts & visualizations
    if (
      /\b(bar|line|pie|donut|scatter|area|radar|heatmap|histogram)\s+chart\b/i.test(lower) ||
      (/\b(create|plot|generate|draw|visualize|render)\b/i.test(lower) &&
        /\b(chart|plot|graph|visualization|sparkline)\b/i.test(lower))
    ) {
      return {
        mode: 'native_visualization',
        confidence: 0.95,
        reason: 'Chart/plot generation routed to native visualization mode.',
      };
    }

    // 9. Standard code/algorithm/math explanations remain in structured Markdown (fixes P3 hijacking)
    if (
      /\b(typescript|javascript|python|rust|sql|quicksort|closures?|algorithm|time\s+complexity|formula|proof|derive)\b/i.test(lower) &&
      !/\b(interactive|chart|table|artifact|html|svg)\b/i.test(lower)
    ) {
      return {
        mode: 'structured_explanation',
        confidence: 0.93,
        reason: 'Technical/code/math explanation kept in structured Markdown instead of HTML preview.',
      };
    }

    // 10. Short direct factual queries
    if (
      prompt.length <= 55 &&
      /^(what\s+is|who\s+is|when\s+was|where\s+is|hi|hello|hey)\b/i.test(lower) &&
      !/\b(compare|chart|table|interactive|code|explain\s+how|organize|present)\b/i.test(lower)
    ) {
      return {
        mode: 'plain_text',
        confidence: 0.92,
        reason: 'Short direct factual/greeting query routed to plain text.',
      };
    }

    return null;
  }

  private async classifyWithModel(
    prompt: string,
    startNs: number
  ): Promise<{
    decision?: PresentationDecision;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    estimatedCostUsd: number;
    invalidStructuredOutput: boolean;
    reason: string;
  }> {
    const zeroUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    try {
      const basePolicy = this.modelRouter!.resolvePolicy('aira-fast', 'ANSWER');
      const policy: ModelPolicy = {
        ...basePolicy,
        temperature: 0,
        maxTokens: Math.min(basePolicy.maxTokens || 220, 220),
        extendedThinking: false,
        timeoutMs: this.modelTimeoutMs,
      };
      const adapter = this.modelRouter!.getAdapter(policy);
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(new Error(`PRESENTATION_ROUTER_TIMEOUT_${this.modelTimeoutMs}ms`)),
        this.modelTimeoutMs
      );

      let result: Awaited<ReturnType<ModelAdapter['complete']>>;
      try {
        // Callers in production must run within withInferencePrincipal / withInferenceReservation;
        // if omitted or capacity fails, catch below safely degrades to Tier 3 fallback.
        result = await Promise.race([
          adapter.complete(
            [
              { role: 'system', content: PRESENTATION_SYSTEM_PROMPT },
              { role: 'user', content: `Prompt: ${JSON.stringify(prompt.slice(0, 600))}` },
            ],
            policy,
            controller.signal
          ),
          new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
          }),
        ]);
      } finally {
        clearTimeout(timeoutHandle);
      }

      const usage = result.usage || zeroUsage;
      const estimatedCostUsd = this.estimateCostUsd(usage.promptTokens, usage.completionTokens);
      const parsedJson = parseFirstValidJsonObject(result.text || '');
      if (parsedJson.status !== 'ok') {
        const isMalformed = parsedJson.status === 'malformed';
        return {
          usage,
          estimatedCostUsd,
          invalidStructuredOutput: true,
          reason: isMalformed
            ? 'Model emitted malformed JSON; fell back to Markdown.'
            : 'Model response lacked structured JSON; fell back to Markdown.',
        };
      }

      const parsed = ModelPresentationChoiceSchema.safeParse(parsedJson.value);
      if (!parsed.success) {
        return {
          usage,
          estimatedCostUsd,
          invalidStructuredOutput: true,
          reason: 'Model output failed Zod presentation schema validation; fell back to Markdown.',
        };
      }

      const mode = parsed.data.mode;
      return {
        usage,
        estimatedCostUsd,
        invalidStructuredOutput: false,
        reason: parsed.data.reason || 'Selected via Tier 2 ModelRouter classification.',
        decision: {
          mode,
          approach: approachForMode(mode),
          source: 'model',
          confidence: parsed.data.confidence ?? 0.85,
          reason: (parsed.data.reason || 'Selected via Tier 2 ModelRouter classification.').slice(0, 300),
          degradedToFallback: false,
          invalidStructuredOutput: false,
          latencyMs: Math.round((performance.now() - startNs) * 100) / 100,
          usage,
          estimatedCostUsd,
        },
      };
    } catch (err: any) {
      return {
        usage: zeroUsage,
        estimatedCostUsd: 0,
        invalidStructuredOutput: false,
        reason: `Tier 2 classifier error (${String(err?.message || 'timeout').slice(0, 120)}); preserved answer via fallback.`,
      };
    }
  }

  private buildFallbackDecision(
    prompt: string,
    startNs: number,
    usage: { promptTokens: number; completionTokens: number; totalTokens: number },
    estimatedCostUsd: number,
    invalidStructuredOutput: boolean,
    reason: string
  ): PresentationDecision {
    const mode: PresentationMode = prompt.length < 60 ? 'plain_text' : 'structured_explanation';
    return {
      mode,
      approach: approachForMode(mode),
      source: 'fallback',
      confidence: 0.65,
      reason: reason.slice(0, 300),
      degradedToFallback: true,
      invalidStructuredOutput,
      latencyMs: Math.round((performance.now() - startNs) * 100) / 100,
      usage,
      estimatedCostUsd,
    };
  }

  private estimateCostUsd(promptTokens: number, completionTokens: number): number {
    const cost =
      (promptTokens / 1_000_000) * this.inputCostPerMillionUsd +
      (completionTokens / 1_000_000) * this.outputCostPerMillionUsd;
    return Number(cost.toFixed(8));
  }

  public async runBenchmark(cases: PresentationBenchmarkCase[]): Promise<PresentationBenchmarkSummary> {
    const results: PresentationBenchmarkSummary['results'] = [];
    const latencies: number[] = [];
    const tierBreakdown = { deterministic: 0, model: 0, fallback: 0 };
    let correctCases = 0;
    let totalEstimatedCostUsd = 0;
    let invalidStructuredCount = 0;

    for (const tc of cases) {
      const decision = await this.route({ prompt: tc.prompt, intent: tc.intent });
      const correct = decision.mode === tc.expectedMode;
      if (correct) correctCases += 1;
      latencies.push(decision.latencyMs);
      tierBreakdown[decision.source] += 1;
      totalEstimatedCostUsd += decision.estimatedCostUsd;
      if (decision.invalidStructuredOutput) invalidStructuredCount += 1;

      results.push({
        id: tc.id,
        expectedMode: tc.expectedMode,
        actualMode: decision.mode,
        correct,
        decision,
      });
    }

    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const p95Index = sortedLatencies.length > 0 ? Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95)) : 0;
    const total = cases.length || 1;
    const avgLatency = latencies.reduce((s, n) => s + n, 0) / total;

    return {
      totalCases: cases.length,
      correctCases: cases.length > 0 ? correctCases : 0,
      accuracy: cases.length > 0 ? Number((correctCases / cases.length).toFixed(4)) : 0,
      averageLatencyMs: Number(avgLatency.toFixed(3)),
      p95LatencyMs: Number((sortedLatencies[p95Index] || 0).toFixed(3)),
      totalEstimatedCostUsd: Number(totalEstimatedCostUsd.toFixed(8)),
      averageCostUsd: Number((totalEstimatedCostUsd / total).toFixed(8)),
      fallbackRate: cases.length > 0 ? Number((tierBreakdown.fallback / cases.length).toFixed(4)) : 0,
      invalidStructuredOutputRate: cases.length > 0 ? Number((invalidStructuredCount / cases.length).toFixed(4)) : 0,
      tierBreakdown,
      results,
    };
  }
}

function parseFirstValidJsonObject(raw: string): { status: 'ok'; value: unknown } | { status: 'no_json' | 'malformed' } {
  const trimmed = raw.trim();
  if (!trimmed) return { status: 'no_json' };
  let sawCandidate = false;
  let i = 0;
  while (i < trimmed.length) {
    if (trimmed[i] !== '{') {
      i += 1;
      continue;
    }
    sawCandidate = true;
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < trimmed.length; j += 1) {
      const ch = trimmed[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end !== -1) {
      const slice = trimmed.slice(start, end);
      try {
        return { status: 'ok', value: JSON.parse(slice) };
      } catch {
        // Continue scanning if an earlier non-JSON brace pair appeared in prose
      }
      i = end;
    } else {
      i += 1;
    }
  }
  return { status: sawCandidate ? 'malformed' : 'no_json' };
}
