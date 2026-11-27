import { ModelInfo, AppSettings } from '../types';
import { isModelAllowedForTier, type PlanTier } from '../types/commercial-types';

/**
 * The selectable catalog only shows explicitly supported model routes.
 * Historical IDs remain accepted by the server for backward-compatible migration,
 * but retired hosted models must never be offered as working choices.
 */
export const AVAILABLE_MODELS: ModelInfo[] = [
  {
    id: 'aira-auto',
    name: 'Aira Auto',
    badge: 'Router',
    description: 'Intelligent router directing tasks to Fast (Groq) or Deep Reasoning (Groq effort-mapped / Gemini 1M).',
    supportsThinking: true,
    contextWindow: '128K tokens',
  },
  {
    id: 'aira-fast',
    name: 'Aira Fast',
    badge: 'Fast',
    description: 'Ultra-low latency intelligence via Groq LPU with Gemini failover.',
    supportsThinking: false,
    contextWindow: '128K tokens',
  },
  {
    id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    name: 'Nemotron 3.5 Lightning',
    badge: 'NVIDIA (Exp)',
    description: 'Experimental NVIDIA NIM 30B MoE model (subject to account-level provisioning; automatic failover to Groq/Gemini).',
    supportsThinking: false,
    contextWindow: '128K tokens',
  },
  {
    id: 'aira-deep',
    name: 'Aira Deep',
    badge: 'Deep',
    description: 'Deep architectural synthesis and multi-step reasoning powered by Groq reasoning_effort with Gemini failover.',
    supportsThinking: true,
    contextWindow: '128K tokens',
  },
  {
    id: 'aira-pro',
    name: 'Aira Pro',
    badge: 'Quality',
    description: 'High-throughput advanced synthesis and engineering powered by Groq with automatic Gemini 1M failover.',
    supportsThinking: false,
    contextWindow: '128K tokens',
  },
];

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  activeModel: 'aira-auto',
  extendedThinking: false,
  thinkingBudget: 8192,
  provider: 'simulated',
  anthropicApiKey: '',
  openRouterApiKey: '',
  customInstructions: '',
  userName: '',
  email: '',
  userBio: '',
  responseStyle: 'normal',
  autoOpenArtifacts: true,
  aestheticPreset: 'linear-precision',
  persistentMemoryEnabled: true,
  autoConsolidateMemory: true,
  privacyScrubbing: true,
  memoryTokenBudget: 800,
  reducedMotion: 'system',
  highContrast: false,
  fontSize: 'base',
  soundEffects: false,
  streamResponse: true,
  telemetryOptOut: false,
  notificationsEnabled: true,
  announcementsEnabled: true,
  productUpdatesEnabled: true,
  tipsEnabled: true,
};

export function normalizeCanonicalModelId(model: unknown): AppSettings['activeModel'] {
  let migrated = model;
  if (
    model === 'meta/llama-3.1-405b-instruct' ||
    model === 'meta-llama/llama-3.1-405b-instruct' ||
    model === 'nvidia/nemotron-3-super-120b-a12b' ||
    model === 'nvidia/llama-3.1-nemotron-70b-instruct'
  ) {
    migrated = 'nvidia/nemotron-3.5-lightning-30b-a3b';
  } else if (model === 'claude-3-7-sonnet') {
    migrated = 'aira-auto';
  } else if (model === 'claude-3-5-sonnet') {
    migrated = 'aira-pro';
  } else if (model === 'claude-3-5-haiku') {
    migrated = 'aira-fast';
  } else if (model === 'claude-3-opus') {
    migrated = 'aira-deep';
  }

  return AVAILABLE_MODELS.some(candidate => candidate.id === migrated)
    ? (migrated as AppSettings['activeModel'])
    : DEFAULT_SETTINGS.activeModel;
}

export function getDefaultModelForTier(tier: PlanTier = 'guest'): AppSettings['activeModel'] {
  const candidates: Array<AppSettings['activeModel']> =
    tier === 'guest'
      ? ['aira-fast']
      : ['aira-auto', 'aira-fast'];

  for (const candidate of candidates) {
    if (isModelAllowedForTier(candidate, tier)) {
      return candidate;
    }
  }

  const fallback = AVAILABLE_MODELS.find(m => isModelAllowedForTier(m.id, tier));
  return fallback ? fallback.id : 'aira-fast';
}

export function resolveEntitledModelForTier(
  candidate: unknown,
  tier: PlanTier = 'guest'
): AppSettings['activeModel'] {
  const normalized = normalizeCanonicalModelId(candidate);
  if (isModelAllowedForTier(normalized, tier)) {
    return normalized;
  }
  return getDefaultModelForTier(tier);
}

export const PROMPT_STARTERS = [
  {
    icon: 'compass',
    title: 'Research a hard question',
    prompt: 'Research the current landscape for multimodel AI workspaces and give me a sourced competitive brief with the important product gaps.',
  },
  {
    icon: 'code',
    title: 'Build something',
    prompt: 'Design and build a polished interactive dashboard artifact for an AI operations workspace.',
  },
  {
    icon: 'file-text',
    title: 'Analyze my material',
    prompt: 'Analyze the files I attach, identify the most important findings, and turn them into a concise decision memo.',
  },
  {
    icon: 'bot',
    title: 'Plan an agent mission',
    prompt: 'Break this objective into an autonomous agent mission with steps, tools, checkpoints, and a final deliverable.',
  },
];
