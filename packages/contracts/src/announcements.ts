import { z } from 'zod';
import { PlanTierSchema, type PlanTier } from './commercial.js';

// ==========================================
// ANNOUNCEMENTS DATA CONTRACT
// ==========================================

export const AnnouncementCategorySchema = z.enum([
  'feature',
  'improvement',
  'security',
  'model',
  'announcement'
]);
export type AnnouncementCategory = z.infer<typeof AnnouncementCategorySchema>;

export const AnnouncementSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  features: z.array(z.string()).min(1),
  category: AnnouncementCategorySchema.default('feature'),
  publishedAt: z.string().datetime({ offset: true }), // ISO-8601 UTC timestamp
  minTier: PlanTierSchema.optional(),
  badge: z.string().optional(),
  ctaText: z.string().optional(),
  ctaUrl: z.string().optional()
});
export type Announcement = z.infer<typeof AnnouncementSchema>;

export const ANNOUNCEMENT_REGISTRY: readonly Announcement[] = [
  {
    id: 'ann_entitlements_v2',
    version: '2026.11.1',
    title: 'Introducing 4-Tier Entitlements & Pro Subscriptions',
    summary: 'AIRA now features four distinct tiers: Guest trial, Free everyday exploration, Plus productivity, and Pro with full agent autonomy and Python execution.',
    features: [
      '4-tier plan architecture with transparent daily and monthly limits',
      'Pro Python Sandbox and real-time Browser tools',
      'Expanded model routing with Claude 3.5 Sonnet, GPT-4o, and Gemini 2.5 Pro',
      'Zero-data-loss safe downgrades and read-only preservation'
    ],
    category: 'feature',
    publishedAt: '2026-11-10T08:00:00Z',
    badge: 'Major Update',
    ctaText: 'View Plans',
    ctaUrl: '#settings-billing'
  },
  {
    id: 'ann_onboarding_walkthrough',
    version: '2026.11.2',
    title: 'Interactive 5-Stage Onboarding Tour',
    summary: 'New to AIRA? Explore our interactive walkthrough covering Chat, Reasoning Boosts, Agent Mode, Artifact Studio, and Personalization.',
    features: [
      'Guided step-by-step introduction to core AIRA workflows',
      'Full navigation controls: Back, Next, Skip, and Resume',
      'Restart tutorial anytime from Account Settings',
      'Account-persisted progress across sessions'
    ],
    category: 'improvement',
    publishedAt: '2026-11-10T08:30:00Z',
    badge: 'New',
    ctaText: 'Take Tour',
    ctaUrl: '#onboarding'
  },
  {
    id: 'ann_model_routing_v3',
    version: '2026.11.3',
    title: 'Intelligent Capability Discovery & Quota Gauges',
    summary: 'Dynamic usage meters in Account Settings keep you informed of your chat limits, reasoning boosts, and credits in real time.',
    features: [
      'Real-time visual usage meters with reset countdowns',
      'Contextual upgrade alerts when selecting advanced models or tools',
      'Direct navigation from sidebar and account dropdown to My Plan & Usage'
    ],
    category: 'feature',
    publishedAt: '2026-11-10T09:00:00Z',
    badge: 'Feature',
    ctaText: 'Check Usage',
    ctaUrl: '#settings-billing'
  }
] as const;

const TIER_RANK: Record<PlanTier, number> = {
  guest: 0,
  free: 1,
  plus: 2,
  pro: 3
};

/**
 * Look up a specific announcement by its unique identifier.
 */
export function getAnnouncementById(id: string): Announcement | undefined {
  if (!id || typeof id !== 'string') return undefined;
  return ANNOUNCEMENT_REGISTRY.find(item => item.id === id);
}

/**
 * Retrieve the latest announcement in the registry.
 */
export function getLatestAnnouncement(): Announcement | undefined {
  if (!Array.isArray(ANNOUNCEMENT_REGISTRY) || ANNOUNCEMENT_REGISTRY.length === 0) return undefined;
  return ANNOUNCEMENT_REGISTRY[ANNOUNCEMENT_REGISTRY.length - 1];
}

/**
 * Filter announcements relevant to a specific plan tier.
 */
export function getAnnouncementsForTier(tier: PlanTier): Announcement[] {
  const userRank = (tier && typeof tier === 'string' && Object.hasOwn(TIER_RANK, tier))
    ? TIER_RANK[tier as PlanTier]
    : 0;

  return ANNOUNCEMENT_REGISTRY.filter(item => {
    if (!item.minTier) return true;
    const requiredRank = (item.minTier && typeof item.minTier === 'string' && Object.hasOwn(TIER_RANK, item.minTier))
      ? TIER_RANK[item.minTier]
      : 0;
    return userRank >= requiredRank;
  });
}
