import { z } from 'zod';
import { PlanTierSchema, type PlanTier } from './commercial.js';

// ==========================================
// FEATURE FLAGS CONTRACT
// ==========================================

export const FeatureFlagKeySchema = z.enum([
  'onboarding_walkthrough',
  'whats_new_announcements',
  'pro_sandbox_python',
  'pro_browser_tools',
  'agent_mode_autonomous',
  'dynamic_quota_gauges',
  'intelligent_capability_discovery'
]);
export type FeatureFlagKey = z.infer<typeof FeatureFlagKeySchema>;

export const ALL_FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] = [
  'onboarding_walkthrough',
  'whats_new_announcements',
  'pro_sandbox_python',
  'pro_browser_tools',
  'agent_mode_autonomous',
  'dynamic_quota_gauges',
  'intelligent_capability_discovery'
] as const;

export const FeatureFlagsSchema = z.record(FeatureFlagKeySchema, z.boolean());
export type FeatureFlags = Record<FeatureFlagKey, boolean>;

export const DEFAULT_TIER_FEATURE_FLAGS: Record<PlanTier, FeatureFlags> = {
  guest: {
    onboarding_walkthrough: true,
    whats_new_announcements: true,
    pro_sandbox_python: false,
    pro_browser_tools: false,
    agent_mode_autonomous: false,
    dynamic_quota_gauges: true,
    intelligent_capability_discovery: true
  },
  free: {
    onboarding_walkthrough: true,
    whats_new_announcements: true,
    pro_sandbox_python: false,
    pro_browser_tools: false,
    agent_mode_autonomous: false,
    dynamic_quota_gauges: true,
    intelligent_capability_discovery: true
  },
  plus: {
    onboarding_walkthrough: true,
    whats_new_announcements: true,
    pro_sandbox_python: false,
    pro_browser_tools: false,
    agent_mode_autonomous: true,
    dynamic_quota_gauges: true,
    intelligent_capability_discovery: true
  },
  pro: {
    onboarding_walkthrough: true,
    whats_new_announcements: true,
    pro_sandbox_python: true,
    pro_browser_tools: true,
    agent_mode_autonomous: true,
    dynamic_quota_gauges: true,
    intelligent_capability_discovery: true
  }
};

/**
 * Evaluates feature flags for a given plan tier with optional runtime overrides.
 */
export function evaluateFeatureFlags(
  tier: PlanTier,
  overrides?: Record<string, boolean>
): Record<FeatureFlagKey, boolean> {
  const defaults = (tier && typeof tier === 'string' && Object.hasOwn(DEFAULT_TIER_FEATURE_FLAGS, tier))
    ? DEFAULT_TIER_FEATURE_FLAGS[tier as PlanTier]
    : DEFAULT_TIER_FEATURE_FLAGS.free;
  const result: Record<FeatureFlagKey, boolean> = { ...defaults };

  if (overrides && typeof overrides === 'object') {
    for (const key of ALL_FEATURE_FLAG_KEYS) {
      if (Object.hasOwn(overrides, key) && typeof overrides[key] === 'boolean') {
        result[key] = overrides[key];
      }
    }
  }

  return result;
}

/**
 * Quick check if a single feature flag is enabled for a tier.
 */
export function isFeatureFlagEnabled(
  flag: FeatureFlagKey,
  tier: PlanTier,
  overrides?: Record<string, boolean>
): boolean {
  if (!flag || typeof flag !== 'string') return false;
  const evaluated = evaluateFeatureFlags(tier, overrides);
  if (!Object.hasOwn(evaluated, flag)) return false;
  return Boolean(evaluated[flag as FeatureFlagKey]);
}
