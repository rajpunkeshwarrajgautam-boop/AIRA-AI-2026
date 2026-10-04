import { ModelInfo, AppSettings } from '../types';

/**
 * Phase 1 keeps the existing provider/model IDs underneath so the prototype's
 * current streaming path continues to work. The UI exposes Aira intelligence
 * modes; provider routing can move behind the server-authoritative router next.
 */
export const AVAILABLE_MODELS: ModelInfo[] = [
  {
    id: 'claude-3-7-sonnet',
    name: 'Aira Auto',
    badge: 'Router',
    description: 'Balanced default that selects deeper reasoning when the task needs it.',
    supportsThinking: true,
    contextWindow: '200K tokens',
  },
  {
    id: 'claude-3-5-sonnet',
    name: 'Aira Pro',
    badge: 'Quality',
    description: 'Higher-quality mode for engineering, analysis, writing, and multi-step work.',
    supportsThinking: false,
    contextWindow: '200K tokens',
  },
  {
    id: 'claude-3-5-haiku',
    name: 'Aira Fast',
    badge: 'Fast',
    description: 'Low-latency mode for quick questions, edits, extraction, and iterations.',
    supportsThinking: false,
    contextWindow: '200K tokens',
  },
  {
    id: 'claude-3-opus',
    name: 'Aira Deep',
    badge: 'Deep',
    description: 'Deliberate mode for complex research, architecture, and open-ended analysis.',
    supportsThinking: false,
    contextWindow: '200K tokens',
  },
  {
    id: 'meta/llama-3.1-405b-instruct',
    name: 'Llama 3.1 405B',
    badge: 'NVIDIA',
    description: 'Open-weights frontier model running at ultra-low latency on NVIDIA NIM.',
    supportsThinking: false,
    contextWindow: '128K tokens',
  },
  {
    id: 'nvidia/llama-3.1-nemotron-70b-instruct',
    name: 'Nemotron 70B',
    badge: 'NVIDIA',
    description: 'Custom fine-tune by NVIDIA optimized for instruction following and reasoning.',
    supportsThinking: false,
    contextWindow: '128K tokens',
  },
];

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  activeModel: 'claude-3-7-sonnet',
  extendedThinking: true,
  thinkingBudget: 8192,
  provider: 'simulated',
  anthropicApiKey: '',
  openRouterApiKey: '',
  customInstructions: '',
  userName: '',
  email: 'user@aira.internal',
  userBio: 'Full-stack software engineer & researcher working with modern web and AI agent systems.',
  responseStyle: 'normal',
  autoOpenArtifacts: true,
  aestheticPreset: 'linear-precision',
  persistentMemoryEnabled: true,
  autoConsolidateMemory: true,
  privacyScrubbing: true,
  memoryTokenBudget: 800,
};

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
    icon: 'sparkles',
    title: 'Plan an agent mission',
    prompt: 'Break this objective into an autonomous agent mission with steps, tools, checkpoints, and a final deliverable.',
  },
];
