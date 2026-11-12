import { ModelInfo, AppSettings } from '../types';

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
    description: 'Intelligent router directing tasks to Fast (Groq) or Deep Reasoning (NVIDIA Nemotron).',
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
    id: 'nvidia/llama-3.1-nemotron-70b-instruct',
    name: 'Nemotron 70B (NVIDIA)',
    badge: 'NVIDIA',
    description: 'NVIDIA NIM flagship 70B model with RLHF alignment for coding and instruction following.',
    supportsThinking: false,
    contextWindow: '128K tokens',
  },
  {
    id: 'aira-deep',
    name: 'Aira Deep',
    badge: 'Deep',
    description: 'Deep-research and architectural synthesis targeting NVIDIA NIM with Gemini 3.8 Flash native thinking failover.',
    supportsThinking: true,
    contextWindow: '128K tokens',
  },
  {
    id: 'aira-pro',
    name: 'Aira Pro',
    badge: 'Quality',
    description: 'High-fidelity engineering and multi-step synthesis targeting NVIDIA NIM with Gemini 3.8 Flash automatic failover.',
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
