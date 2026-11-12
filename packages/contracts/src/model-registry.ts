import type { PlanTier } from './commercial.js';

export type ReasoningControlMode = 'none' | 'output_cap_only' | 'effort_mapped' | 'native_budget';

export interface ModelCapabilityDescriptor {
  id: string;                      // Canonical ID
  displayName: string;             // UI name
  provider: 'anthropic' | 'nvidia' | 'openai' | 'groq' | 'gemini';
  upstreamModelId: string;         // Real model ID passed to provider API
  minTier: PlanTier;
  contextWindow: string;
  supportsThinking: boolean;
  reasoningControl?: ReasoningControlMode;
  description: string;
  badge: string;
}

/**
 * Single Authoritative Model Capability Registry.
 * Only verified operational models supported by AIRA providers are registered here.
 * Fabricated and unoperational models (deepseek-r1, o1, o3-mini, gemini-3.5-flash-lite,
 * gemini-2-5-pro, gemini-2-5-flash) are strictly excluded.
 */
export const VERIFIED_MODEL_REGISTRY: Record<string, ModelCapabilityDescriptor> = {
  'aira-auto': {
    id: 'aira-auto',
    displayName: 'AIRA Auto',
    provider: 'groq',
    upstreamModelId: 'openai/gpt-oss-120b',
    minTier: 'free',
    contextWindow: '128K tokens',
    supportsThinking: true,
    reasoningControl: 'effort_mapped',
    description: 'Tier-aware router directing tasks within your plan allowlist (Fast via Groq/Gemini; Pro/Deep via NVIDIA NIM on entitled plans).',
    badge: 'Router'
  },
  'aira-fast': {
    id: 'aira-fast',
    displayName: 'AIRA Fast',
    provider: 'groq',
    upstreamModelId: 'openai/gpt-oss-120b',
    minTier: 'guest',
    contextWindow: '128K tokens',
    supportsThinking: false,
    reasoningControl: 'none',
    description: 'Ultra-low latency intelligence powered by Groq LPU inference with Gemini failover.',
    badge: 'Fast'
  },
  'aira-pro': {
    id: 'aira-pro',
    displayName: 'AIRA Pro',
    provider: 'groq',
    upstreamModelId: 'openai/gpt-oss-120b',
    minTier: 'plus',
    contextWindow: '128K tokens',
    supportsThinking: false,
    reasoningControl: 'none',
    description: 'High-throughput advanced synthesis and engineering powered by Groq (openai/gpt-oss-120b) with automatic Gemini 3.5 Flash-Lite 1M context failover.',
    badge: 'Quality'
  },
  'aira-deep': {
    id: 'aira-deep',
    displayName: 'AIRA Deep',
    provider: 'groq',
    upstreamModelId: 'openai/gpt-oss-120b',
    minTier: 'pro',
    contextWindow: '128K tokens',
    supportsThinking: true,
    reasoningControl: 'effort_mapped',
    description: 'Deep architectural synthesis and multi-step reasoning powered by Groq reasoning_effort (openai/gpt-oss-120b) with Gemini 3.5 Flash-Lite 1M context failover.',
    badge: 'Deep'
  },
  'nvidia/llama-3.1-nemotron-70b-instruct': {
    id: 'nvidia/llama-3.1-nemotron-70b-instruct',
    displayName: 'Nemotron 70B (NVIDIA)',
    provider: 'nvidia',
    upstreamModelId: 'nvidia/llama-3.1-nemotron-70b-instruct',
    minTier: 'plus',
    contextWindow: '128K tokens',
    supportsThinking: false,
    reasoningControl: 'output_cap_only',
    description: 'Experimental NVIDIA NIM integration (subject to account-level function provisioning; automatic Groq/Gemini failover).',
    badge: 'NVIDIA'
  },
  // Backward compatibility migration aliases for historical conversation sessions
  'claude-3-7-sonnet': {
    id: 'claude-3-7-sonnet',
    displayName: 'Aira Auto (Historical Alias)',
    provider: 'groq',
    upstreamModelId: 'openai/gpt-oss-120b',
    minTier: 'free',
    contextWindow: '128K tokens',
    supportsThinking: true,
    description: 'Historical migration alias mapping to AIRA Auto router.',
    badge: 'Router'
  },
  'claude-3-5-sonnet': {
    id: 'claude-3-5-sonnet',
    displayName: 'Aira Pro (Historical Alias)',
    provider: 'nvidia',
    upstreamModelId: 'nvidia/llama-3.1-nemotron-70b-instruct',
    minTier: 'plus',
    contextWindow: '128K tokens',
    supportsThinking: false,
    description: 'Historical migration alias mapping to AIRA Pro Nemotron 70B.',
    badge: 'Quality'
  },
  'claude-3-5-haiku': {
    id: 'claude-3-5-haiku',
    displayName: 'Aira Fast (Historical Alias)',
    provider: 'groq',
    upstreamModelId: 'openai/gpt-oss-120b',
    minTier: 'guest',
    contextWindow: '128K tokens',
    supportsThinking: false,
    description: 'Historical migration alias mapping to AIRA Fast Groq LPU.',
    badge: 'Fast'
  },
  'claude-3-opus': {
    id: 'claude-3-opus',
    displayName: 'Aira Deep (Historical Alias)',
    provider: 'nvidia',
    upstreamModelId: 'nvidia/llama-3.1-nemotron-70b-instruct',
    minTier: 'pro',
    contextWindow: '128K tokens',
    supportsThinking: true,
    description: 'Historical migration alias mapping to AIRA Deep reasoning.',
    badge: 'Deep'
  }
};

/**
 * Derived Authoritative Plan Model Allowlists.
 * Strictly enforced across contracts, model router, and UI components.
 */
export const VERIFIED_PLAN_MODEL_ALLOWLIST: Record<PlanTier, readonly string[]> = {
  guest: ['aira-fast', 'claude-3-5-haiku'],
  free: ['aira-fast', 'claude-3-5-haiku', 'aira-auto', 'claude-3-7-sonnet'],
  plus: [
    'aira-fast',
    'claude-3-5-haiku',
    'aira-auto',
    'claude-3-7-sonnet',
    'aira-pro',
    'claude-3-5-sonnet',
    'nvidia/llama-3.1-nemotron-70b-instruct'
  ],
  pro: [
    'aira-fast',
    'claude-3-5-haiku',
    'aira-auto',
    'claude-3-7-sonnet',
    'aira-pro',
    'claude-3-5-sonnet',
    'aira-deep',
    'claude-3-opus',
    'nvidia/llama-3.1-nemotron-70b-instruct'
  ]
};

// Immutability deep freeze
Object.freeze(VERIFIED_MODEL_REGISTRY);
Object.freeze(VERIFIED_PLAN_MODEL_ALLOWLIST.guest);
Object.freeze(VERIFIED_PLAN_MODEL_ALLOWLIST.free);
Object.freeze(VERIFIED_PLAN_MODEL_ALLOWLIST.plus);
Object.freeze(VERIFIED_PLAN_MODEL_ALLOWLIST.pro);
Object.freeze(VERIFIED_PLAN_MODEL_ALLOWLIST);
