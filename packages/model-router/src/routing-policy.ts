import { ProviderHealthTracker } from './health-tracker.js';

export interface FastExecutionCandidate {
  provider: string;
  model: string;
  qualityScore: number; // 0 to 10
  typicalTtftMs: number;
  costTier: 'low' | 'medium' | 'high';
  allowed: boolean;
  rejectionReason?: string;
}

export interface FastExecutionPlan {
  primary: { provider: string; model: string };
  fallback: { provider: string; model: string } | null;
  hedgingRecommended: boolean;
  isDegraded: boolean;
  selectionReason: string;
}

export interface SelectPlanOptions {
  configuredProviders: string[];
  preferredProvider?: string;
  preferredModel?: string;
  hasDedicatedNvidiaFastModel?: boolean;
  nvidiaFastModel?: string;
  enableHedging?: boolean;
}

export class LatencyAwareRoutingPolicy {
  private healthTracker: ProviderHealthTracker;

  // Catalog of known fast candidates and their empirical performance / quality
  private static readonly CANDIDATES: FastExecutionCandidate[] = [
    {
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      qualityScore: 9.5,
      typicalTtftMs: 447,
      costTier: 'low',
      allowed: true
    },
    {
      provider: 'groq',
      model: 'allam-2-7b',
      qualityScore: 7.2,
      typicalTtftMs: 240,
      costTier: 'low',
      allowed: true
    },
    {
      provider: 'groq',
      model: 'qwen/qwen3.8-27b',
      qualityScore: 8.5,
      typicalTtftMs: 133,
      costTier: 'low',
      allowed: false,
      rejectionReason: 'REJECTED: Strict 1,000 OTPM on-demand quota causes frequent 429 rate-limit exhaustion'
    },
    {
      provider: 'groq',
      model: 'openai/gpt-oss-20b',
      qualityScore: 3.0,
      typicalTtftMs: 359,
      costTier: 'low',
      allowed: false,
      rejectionReason: 'REJECTED: 43.7% empty responses observed on live Groq endpoint'
    },
    {
      provider: 'cerebras',
      model: 'llama3.1-8b',
      qualityScore: 8.0,
      typicalTtftMs: 280,
      costTier: 'low',
      allowed: true
    },
    {
      provider: 'together',
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
      qualityScore: 8.0,
      typicalTtftMs: 350,
      costTier: 'low',
      allowed: true
    },
    {
      provider: 'fireworks',
      model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      qualityScore: 8.0,
      typicalTtftMs: 350,
      costTier: 'low',
      allowed: true
    },
    {
      provider: 'openai',
      model: 'gpt-4o-mini',
      qualityScore: 9.0,
      typicalTtftMs: 450,
      costTier: 'medium',
      allowed: true
    },
    {
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      qualityScore: 9.2,
      typicalTtftMs: 500,
      costTier: 'medium',
      allowed: true
    },
    {
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      qualityScore: 9.5,
      typicalTtftMs: 493,
      costTier: 'low',
      allowed: true
    },
    {
      provider: 'gemini',
      model: 'gemini-flash-lite-latest',
      qualityScore: 9.5,
      typicalTtftMs: 893,
      costTier: 'low',
      allowed: false,
      rejectionReason: 'REJECTED: Floating alias exhibits queue tail latency spikes under burst; pinned gemini-3.5-flash-lite preferred'
    },
    {
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      qualityScore: 9.0,
      typicalTtftMs: 1942,
      costTier: 'low',
      allowed: false,
      rejectionReason: 'REJECTED: Reasoning token latency (~1940ms) violates Fast low-latency requirements'
    },
    {
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      qualityScore: 9.0,
      typicalTtftMs: 1500,
      costTier: 'low',
      allowed: false,
      rejectionReason: 'REJECTED: 503 high demand capacity exhaustion on Google upstream'
    },
    {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      qualityScore: 0,
      typicalTtftMs: 0,
      costTier: 'low',
      allowed: false,
      rejectionReason: 'DEPRECATED: 404 retired by Google for new users'
    },
    {
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      qualityScore: 0,
      typicalTtftMs: 0,
      costTier: 'low',
      allowed: false,
      rejectionReason: 'DEPRECATED: 404 retired by Google for new users'
    }
  ];

  constructor(healthTracker?: ProviderHealthTracker) {
    this.healthTracker = healthTracker || new ProviderHealthTracker();
  }

  public isModelAllowed(model: string): boolean {
    const clean = model.trim().toLowerCase();
    const candidate = LatencyAwareRoutingPolicy.CANDIDATES.find(c => c.model.toLowerCase() === clean);
    if (!candidate) return true; // Uncatalogued models evaluated by caller
    return candidate.allowed;
  }

  public resolveFastRoute(): FastExecutionPlan {
    const configuredProviders: string[] = [];
    if (process.env.GROQ_API_KEY) configuredProviders.push('groq');
    if (process.env.GEMINI_API_KEY) configuredProviders.push('gemini');
    if (process.env.CEREBRAS_API_KEY) configuredProviders.push('cerebras');
    if (process.env.TOGETHER_API_KEY) configuredProviders.push('together');
    if (process.env.FIREWORKS_API_KEY) configuredProviders.push('fireworks');
    if (process.env.OPENAI_API_KEY) configuredProviders.push('openai');
    if (process.env.ANTHROPIC_API_KEY) configuredProviders.push('anthropic');
    if (process.env.NVIDIA_API_KEY) configuredProviders.push('nvidia');

    return this.selectFastExecutionPlan({
      configuredProviders,
      preferredProvider: process.env.AIRA_FAST_PROVIDER,
      preferredModel: process.env.AIRA_FAST_MODEL,
      hasDedicatedNvidiaFastModel: Boolean(process.env.NVIDIA_FAST_MODEL),
      nvidiaFastModel: process.env.NVIDIA_FAST_MODEL
    });
  }

  public selectFastExecutionPlan(options: SelectPlanOptions): FastExecutionPlan {
    const configured = options.configuredProviders.map(p => p.toLowerCase().trim());
    const eligibleCandidates: FastExecutionCandidate[] = [];

    // 1. Collect configured non-NVIDIA fast candidates
    for (const c of LatencyAwareRoutingPolicy.CANDIDATES) {
      if (!c.allowed) continue;
      if (configured.includes(c.provider)) {
        eligibleCandidates.push(c);
      }
    }

    // 2. Evaluate NVIDIA: Strict rule from Section 12:
    // "NVIDIA Nemotron 120B remains AIRA Deep. Do not fallback Fast normal-chat traffic to
    // Nemotron 120B merely to avoid an error if it recreates multi-second reasoning latency."
    if (configured.includes('nvidia') && options.hasDedicatedNvidiaFastModel && options.nvidiaFastModel) {
      eligibleCandidates.push({
        provider: 'nvidia',
        model: options.nvidiaFastModel,
        qualityScore: 8.8,
        typicalTtftMs: 650,
        costTier: 'low',
        allowed: true
      });
    }

    // If preferred model is explicitly requested in env and configured:
    if (options.preferredProvider && options.preferredModel) {
      const prefProv = options.preferredProvider.toLowerCase().trim();
      const prefMod = options.preferredModel.trim();
      if (configured.includes(prefProv) && this.isModelAllowed(prefMod)) {
        const existingIdx = eligibleCandidates.findIndex(
          c => c.provider === prefProv && c.model.toLowerCase() === prefMod.toLowerCase()
        );
        if (existingIdx !== -1) {
          const [pref] = eligibleCandidates.splice(existingIdx, 1);
          eligibleCandidates.unshift(pref);
        } else {
          eligibleCandidates.unshift({
            provider: prefProv,
            model: prefMod,
            qualityScore: 8.5,
            typicalTtftMs: 500,
            costTier: 'low',
            allowed: true
          });
        }
      }
    }

    // If no eligible fast candidates exist:
    if (eligibleCandidates.length === 0) {
      return {
        primary: { provider: 'none', model: 'none' },
        fallback: null,
        hedgingRecommended: false,
        isDegraded: true,
        selectionReason: 'DEGRADED: No low-latency Fast provider configured. NVIDIA Nemotron 120B is reserved exclusively for AIRA Deep and cannot be used for Fast chat.'
      };
    }

    // Filter by Circuit Breaker availability
    const availableCandidates = eligibleCandidates.filter(c =>
      this.healthTracker.isAvailable(c.provider, c.model)
    );

    if (availableCandidates.length === 0) {
      // All eligible candidates have open circuits. Fallback to primary candidate in degraded probe mode.
      const first = eligibleCandidates[0];
      return {
        primary: { provider: first.provider, model: first.model },
        fallback: eligibleCandidates.length > 1 ? { provider: eligibleCandidates[1].provider, model: eligibleCandidates[1].model } : null,
        hedgingRecommended: false,
        isDegraded: false,
        selectionReason: `DEGRADED_PROBE: All candidates currently OPEN/degraded. Probing ${first.provider}:${first.model}.`
      };
    }

    const primary = availableCandidates[0];
    // Prefer independent provider for fallback resilience (Prompt Section 8)
    const independentFallback = availableCandidates.find(c => c.provider !== primary.provider);
    const fallbackCandidate = independentFallback
      || availableCandidates.find(c => c.provider !== primary.provider || c.model !== primary.model)
      || (eligibleCandidates.find(c => c.model !== primary.model) ?? null);

    const fallback = fallbackCandidate
      ? { provider: fallbackCandidate.provider, model: fallbackCandidate.model }
      : null;

    const primaryTele = this.healthTracker.getTelemetry(primary.provider, primary.model);
    const circuitState = primaryTele.circuitState;
    const promotedFromFailover = eligibleCandidates[0].model !== primary.model;
    const skippedCandidate = promotedFromFailover ? eligibleCandidates[0] : null;

    let selectionReason: string;
    if (promotedFromFailover && skippedCandidate) {
      const skippedTele = this.healthTracker.getTelemetry(skippedCandidate.provider, skippedCandidate.model);
      selectionReason = `FAILOVER: Promoted ${primary.provider}:${primary.model} because preferred ${skippedCandidate.provider}:${skippedCandidate.model} circuit is ${skippedTele.circuitState}; fallback ${fallback ? `${fallback.provider}:${fallback.model}` : 'NONE'}`;
    } else if (circuitState === 'CLOSED') {
      selectionReason = `Primary ${primary.provider}:${primary.model} healthy (Quality: ${primary.qualityScore}/10, P50: ${primaryTele.recentTTFTP50 || primary.typicalTtftMs}ms); fallback ${fallback ? `${fallback.provider}:${fallback.model}` : 'NONE'}`;
    } else {
      selectionReason = `Primary ${primary.provider}:${primary.model} in ${circuitState} state; fallback ${fallback ? `${fallback.provider}:${fallback.model}` : 'NONE'}`;
    }

    return {
      primary: { provider: primary.provider, model: primary.model },
      fallback,
      hedgingRecommended: Boolean(options.enableHedging && fallback !== null),
      isDegraded: false,
      selectionReason
    };
  }
}
