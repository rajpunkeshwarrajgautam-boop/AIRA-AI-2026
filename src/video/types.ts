export interface ShowcaseScene {
  id: string;
  title: string;
  subtitle: string;
  durationInFrames: number;
  timecode: string;
  category: 'identity' | 'routing' | 'reasoning' | 'onboarding' | 'settings' | 'workspace';
  headline: string;
  statement: string;
  metrics?: Array<{ label: string; value: string }>;
  screenshotUrl: string;
  caption: string;
  badge: string;
}

export interface VideoStudioProps {
  fps?: number;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  scenes?: ShowcaseScene[];
}

export const SHOWCASE_SCENES: ShowcaseScene[] = [
  {
    id: 'scene-1-identity',
    title: 'Cognitive Architecture',
    subtitle: 'Verified Runtime Intelligence',
    durationInFrames: 150, // 5 seconds at 30fps
    timecode: '00:00:00',
    category: 'identity',
    headline: 'AIRA AI 2026',
    statement: 'Intelligent multi-model architecture built on verified runtime execution.',
    metrics: [
      { label: 'context window', value: '128K tokens' },
      { label: 'inference engines', value: 'Groq LPU · Gemini Failover' },
    ],
    screenshotUrl: '/previews/01_model_selector_truthful.png',
    caption: 'Verified model selector featuring AIRA Auto dynamic routing.',
    badge: 'Foundation',
  },
  {
    id: 'scene-2-routing',
    title: 'Ultra-Fast Routing',
    subtitle: 'Groq LPU with Gemini Failover',
    durationInFrames: 150,
    timecode: '00:00:05',
    category: 'routing',
    headline: 'Low-latency execution',
    statement: 'Adaptive query classifier directs simple prompts to ultra-fast inference.',
    metrics: [
      { label: 'primary engine', value: 'Groq gpt-oss-120b' },
      { label: 'failover', value: 'Gemini Flash-Lite' },
      { label: 'routing mode', value: 'latency-aware' },
    ],
    screenshotUrl: '/previews/01_model_selector_truthful.png',
    caption: 'AIRA Fast powered by Groq LPU inference with automatic Gemini backup.',
    badge: 'Fast LPU',
  },
  {
    id: 'scene-3-reasoning',
    title: 'Deep Reasoning',
    subtitle: 'Groq Reasoning Effort & Adaptive Bounds',
    durationInFrames: 150,
    timecode: '00:00:10',
    category: 'reasoning',
    headline: 'Token budget & reasoning effort',
    statement: 'Calibrated reasoning effort, multi-step synthesis, and resilient fallback execution.',
    metrics: [
      { label: 'reasoning effort', value: 'effort-mapped' },
      { label: 'output ceiling', value: '1,024 – 8,192 tokens' },
      { label: 'failover', value: 'Gemini 1M context' },
    ],
    screenshotUrl: '/previews/03_settings_reasoning_calibrated.png',
    caption: 'Configurable token bounds and effort levels aligned to runtime policy.',
    badge: 'Reasoning',
  },
  {
    id: 'scene-4-onboarding',
    title: 'Account-Scoped Tour',
    subtitle: 'Interactive Guidance',
    durationInFrames: 150,
    timecode: '00:00:15',
    category: 'onboarding',
    headline: 'Step-by-step onboarding',
    statement: 'State is saved to your authenticated account without reload replays.',
    metrics: [
      { label: 'stages', value: '5 progressive steps' },
      { label: 'persistence', value: 'account-scoped' },
    ],
    screenshotUrl: '/previews/06_onboarding_walkthrough_truthful.png',
    caption: 'Interactive onboarding walkthrough with on-demand tutorial restart.',
    badge: 'Tutorial',
  },
  {
    id: 'scene-5-settings',
    title: 'Cognitive Settings',
    subtitle: 'Styles & Enforced Safeguards',
    durationInFrames: 150,
    timecode: '00:00:20',
    category: 'settings',
    headline: 'Tailored intelligence',
    statement: 'Response styles, bio context, and mandatory secret scrubbing safeguards.',
    metrics: [
      { label: 'response styles', value: '5 distinct modes' },
      { label: 'privacy safeguard', value: 'enforced & active' },
    ],
    screenshotUrl: '/previews/04_settings_account_privacy_safeguard.png',
    caption: 'Dynamic workspace tiers, live memory counts, and enforced secret scrubbing.',
    badge: 'Security',
  },
  {
    id: 'scene-6-workspace',
    title: 'Live Workspace',
    subtitle: 'Production Certified',
    durationInFrames: 150,
    timecode: '00:00:25',
    category: 'workspace',
    headline: 'Start building now',
    statement: 'Experience AIRA live at aira-ai-2026.vercel.app with transparent quotas.',
    metrics: [
      { label: 'free daily chats', value: '15/day · 150/mo' },
      { label: 'pro limit', value: '150/day · 2,000/mo' },
      { label: 'canonical url', value: 'aira-ai-2026.vercel.app' },
    ],
    screenshotUrl: '/previews/05_settings_plan_truthful.png',
    caption: 'Transparent commercial tier matrix with zero unexpected charges.',
    badge: 'Production',
  },
];
