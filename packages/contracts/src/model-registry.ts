import type { PlanTier } from './commercial.js';

export interface ModelCapabilityDescriptor {
  id: string;                      // Canonical ID
  displayName: string;             // UI name
  provider: 'anthropic' | 'nvidia' | 'openai' | 'groq' | 'gemini';
  upstreamModelId: string;         // Real model ID passed to provider API
  minTier: PlanTier;
  contextWindow: string;
  supportsThinking: boolean;
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
    provider: 'anthropic',
    upstreamModelId: 'claude-3-7-sonnet-20250219',
    minTier: 'free',
    contextWindow: '200K tokens',
    supportsThinking: true,
    description: 'Balanced default that dynamically scales reasoning depth to task complexity.',
    badge: 'Router'
  },
  'aira-fast': {
    id: 'aira-fast',
    displayName: 'AIRA Fast',
    provider: 'anthropic',
    upstreamModelId: 'claude-3-5-haiku-20241022',
    minTier: 'guest',
    contextWindow: '200K tokens',
    supportsThinking: false,
    description: 'Ultra-low latency intelligence for rapid edits, queries, and extraction.',
    badge: 'Fast'
  },
  'aira-pro': {
    id: 'aira-pro',
    displayName: 'AIRA Pro',
    provider: 'anthropic',
    upstreamModelId: 'claude-3-5-sonnet-20241022',
    minTier: 'plus',
    contextWindow: '200K tokens',
    supportsThinking: false,
    description: 'High-fidelity model for software engineering, architecture, and multi-step reasoning.',
    badge: 'Quality'
  },
  'aira-deep': {
    id: 'aira-deep',
    displayName: 'AIRA Deep',
    provider: 'anthropic',
    upstreamModelId: 'claude-3-opus-20240229',
    minTier: 'pro',
    contextWindow: '200K tokens',
    supportsThinking: false,
    description: 'Deliberate deep-research and architectural reasoning mode.',
    badge: 'Deep'
  },
  'claude-3-7-sonnet': {
    id: 'claude-3-7-sonnet',
    displayName: 'Aira Auto (Claude 3.7 Sonnet)',
    provider: 'anthropic',
    upstreamModelId: 'claude-3-7-sonnet-20250219',
    minTier: 'free',
    contextWindow: '200K tokens',
    supportsThinking: true,
    description: 'Balanced default that dynamically scales reasoning depth to task complexity.',
    badge: 'Router'
  },
  'claude-3-5-sonnet': {
    id: 'claude-3-5-sonnet',
    displayName: 'Aira Pro (Claude 3.5 Sonnet)',
    provider: 'anthropic',
    upstreamModelId: 'claude-3-5-sonnet-20241022',
    // Browser alias normalizes to aira-pro; the tier must match that canonical ID.
    minTier: 'plus',
    contextWindow: '200K tokens',
    supportsThinking: false,
    description: 'High-fidelity model for software engineering, architecture, and multi-step reasoning.',
    badge: 'Quality'
  },
  'claude-3-5-haiku': {
    id: 'claude-3-5-haiku',
    displayName: 'Aira Fast (Claude 3.5 Haiku)',
    provider: 'anthropic',
    upstreamModelId: 'claude-3-5-haiku-20241022',
    minTier: 'guest',
    contextWindow: '200K tokens',
    supportsThinking: false,
    description: 'Ultra-low latency intelligence for rapid edits, queries, and extraction.',
    badge: 'Fast'
  },
  'claude-3-opus': {
    id: 'claude-3-opus',
    displayName: 'Aira Deep (Claude 3 Opus)',
    provider: 'anthropic',
    upstreamModelId: 'claude-3-opus-20240229',
    minTier: 'pro',
    contextWindow: '200K tokens',
    supportsThinking: false,
    description: 'Deliberate deep-research and architectural reasoning mode.',
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
    description: 'Fine-tuned by NVIDIA with RLHF alignment for instruction following and coding.',
    badge: 'NVIDIA'
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
