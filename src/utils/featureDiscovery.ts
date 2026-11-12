import type { PlanTier } from '../../packages/contracts/src/index';

/**
 * Feature Discovery & Contextual Guidance Catalog
 * Provides newly unlocked feature recommendations, sample prompts,
 * and dismissal state persistence when users upgrade tiers.
 */

export interface FeatureGuidanceItem {
  feature: string;
  title: string;
  subtitle: string;
  description: string;
  samplePrompt: string;
  ctaRoute?: string;
  targetMode?: 'chat' | 'agent';
  unlockedAtTier: 'plus' | 'pro';
}

export const FEATURE_GUIDANCE_CATALOG: readonly FeatureGuidanceItem[] = [
  {
    feature: 'agent_mode',
    title: 'Autonomous Agent Missions',
    subtitle: 'Multi-step planning and tool execution',
    description: 'Switch to Agent mode to dispatch end-to-end missions with automated step breakdown and verification.',
    samplePrompt: 'Create a full project breakdown for a modern analytics dashboard',
    ctaRoute: '#mode=agent',
    targetMode: 'agent',
    unlockedAtTier: 'plus'
  },
  {
    feature: 'reasoning_boosts',
    title: 'Extended Reasoning Models',
    subtitle: 'Deep thinking tokens for complex problems',
    description: 'Access NVIDIA Nemotron 70B and extended reasoning modes with thinking budgets for difficult algorithms, architecture, and proofs.',
    samplePrompt: 'Analyze concurrency and race conditions in a distributed payment processor',
    ctaRoute: '#model-select',
    targetMode: 'chat',
    unlockedAtTier: 'plus'
  },
  {
    feature: 'python_sandbox',
    title: 'Run Real Python in Isolated Sandbox',
    subtitle: 'Data science, numerical calculations & scripts',
    description: 'Execute real Python code securely in isolated cloud sandboxes with standard computational libraries.',
    samplePrompt: 'Calculate the eigenvalues of a 3x3 matrix',
    ctaRoute: '#mode=agent',
    targetMode: 'agent',
    unlockedAtTier: 'pro'
  },
  {
    feature: 'browser_tools',
    title: 'Real-Time Web & Browser Automation',
    subtitle: 'DOM inspection, web search & data retrieval',
    description: 'Empower your agent to navigate websites, extract live documentation, and inspect web applications.',
    samplePrompt: 'Inspect the latest specifications on https://docs.aira.ai and summarize',
    ctaRoute: '#mode=agent',
    targetMode: 'agent',
    unlockedAtTier: 'pro'
  },
  {
    feature: 'autonomous_workers',
    title: 'Autonomous Multi-Step Agents',
    subtitle: 'Higher concurrency & background permits',
    description: 'Run multiple agent missions with 2 concurrent inference permits and extended execution budgets.',
    samplePrompt: 'Perform an automated security audit across this workspace',
    ctaRoute: '#mode=agent',
    targetMode: 'agent',
    unlockedAtTier: 'pro'
  }
] as const;

export function getFeatureGuidanceStorageKey(userId?: string | null): string {
  const scope = (userId && typeof userId === 'string' && userId.trim()) ? userId.trim() : 'guest';
  return `aira_feature_guidance_dismissed_${scope}`;
}

/**
 * Retrieve dismissed guidance feature keys for target user.
 */
export function getDismissedFeatureGuidance(userId?: string | null): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  const key = getFeatureGuidanceStorageKey(userId);
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(item => typeof item === 'string');
      }
    }
  } catch (err) {
    console.warn(`[FeatureDiscovery] Error reading dismissed guidance from ${key}:`, err);
  }
  return [];
}

/**
 * Persist dismissal of a guidance card for target user.
 */
export function dismissFeatureGuidance(feature: string, userId?: string | null): void {
  if (!feature || typeof feature !== 'string') return;
  if (typeof window === 'undefined' || !window.localStorage) return;

  const key = getFeatureGuidanceStorageKey(userId);
  const current = new Set(getDismissedFeatureGuidance(userId));
  current.add(feature);

  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(current)));
  } catch (err) {
    console.warn(`[FeatureDiscovery] Error saving dismissed guidance to ${key}:`, err);
  }
}

/**
 * Get all active undisplayed guidance items for a user's current tier.
 */
export function getUnlockedGuidanceForTier(tier: PlanTier, userId?: string | null): FeatureGuidanceItem[] {
  if (tier !== 'plus' && tier !== 'pro') return [];

  const dismissed = new Set(getDismissedFeatureGuidance(userId));
  return FEATURE_GUIDANCE_CATALOG.filter(item => {
    if (dismissed.has(item.feature)) return false;
    if (tier === 'plus') return item.unlockedAtTier === 'plus';
    if (tier === 'pro') return item.unlockedAtTier === 'plus' || item.unlockedAtTier === 'pro';
    return false;
  });
}

/**
 * Evaluate tier transition (e.g. Free -> Plus or Plus -> Pro) and return newly unlocked items.
 */
export function getTierTransitionGuidance(
  previousTier: PlanTier,
  currentTier: PlanTier,
  userId?: string | null
): FeatureGuidanceItem[] {
  if (previousTier === currentTier) return [];

  const dismissed = new Set(getDismissedFeatureGuidance(userId));

  if (currentTier === 'plus' && (previousTier === 'guest' || previousTier === 'free')) {
    return FEATURE_GUIDANCE_CATALOG.filter(
      item => item.unlockedAtTier === 'plus' && !dismissed.has(item.feature)
    );
  }

  if (currentTier === 'pro' && previousTier !== 'pro') {
    return FEATURE_GUIDANCE_CATALOG.filter(
      item => item.unlockedAtTier === 'pro' && !dismissed.has(item.feature)
    );
  }

  return [];
}
