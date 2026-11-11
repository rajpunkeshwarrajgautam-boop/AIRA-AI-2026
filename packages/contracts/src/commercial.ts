import { z } from 'zod';
import {
  VERIFIED_MODEL_REGISTRY,
  VERIFIED_PLAN_MODEL_ALLOWLIST,
  type ModelCapabilityDescriptor
} from './model-registry.js';

// ==========================================
// 1. PLANS & PRICING
// ==========================================

export const PlanTierSchema = z.enum(['guest', 'free', 'plus', 'pro']);
export type PlanTier = z.infer<typeof PlanTierSchema>;

export const CurrencyCodeSchema = z.enum(['INR', 'USD']);
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

export const PlanPriceSchema = z.object({
  id: z.string(),
  planId: PlanTierSchema,
  currency: CurrencyCodeSchema,
  interval: z.literal('monthly'),
  amountMinorUnits: z.number().int().nonnegative(), // Paise for INR, Cents for USD
  displayAmount: z.number().nonnegative(), // e.g. 399 for INR, 7.99 for USD
  isTaxInclusive: z.boolean().default(true),
  taxRatePercent: z.number().min(0).max(100).default(18),
  isActive: z.boolean().default(true),
  gatewayPriceId: z.string().optional()
});
export type PlanPrice = z.infer<typeof PlanPriceSchema>;

export const PlanDefinitionSchema = z.object({
  id: PlanTierSchema,
  planTier: PlanTierSchema.optional(),
  name: z.string(),
  description: z.string(),
  pricing: z.object({
    INR: z.number().nonnegative(),
    USD: z.number().nonnegative()
  }).optional(),
  billingInterval: z.string().default('monthly').optional(),
  dailyStandardChatLimit: z.number().int().positive(),
  monthlyStandardChatUnits: z.number().int().positive(),
  monthlyPremiumCredits: z.number().int().nonnegative(),
  complimentaryReasoningBoosts: z.number().int().nonnegative(),
  savedAgentsLimit: z.number().int().nonnegative().default(0),
  builderAccess: z.enum(['none', 'trial', 'metered']),
  concurrentInferenceLimit: z.number().int().positive(),
  maxProjects: z.number().int().default(0),
  maxMemoryRecords: z.number().int().default(0),
  allowAutonomous: z.boolean().default(false),
  allowBrowserTools: z.boolean().default(false),
  allowPythonSandbox: z.boolean().default(false),
  prices: z.array(PlanPriceSchema).default([])
});
export type PlanDefinition = z.infer<typeof PlanDefinitionSchema>;

// Baseline configurations per Master Execution Prompt & Authoritative Scope
export const COMMERCIAL_PLANS: Record<PlanTier, PlanDefinition> = {
  guest: {
    id: 'guest',
    planTier: 'guest',
    name: 'Guest',
    description: 'Basic AI trial session',
    pricing: { INR: 0, USD: 0 },
    billingInterval: 'monthly',
    dailyStandardChatLimit: 5,
    monthlyStandardChatUnits: 5,
    complimentaryReasoningBoosts: 0,
    monthlyPremiumCredits: 0,
    savedAgentsLimit: 0,
    builderAccess: 'none',
    concurrentInferenceLimit: 1,
    maxProjects: 0,
    maxMemoryRecords: 0,
    allowAutonomous: false,
    allowBrowserTools: false,
    allowPythonSandbox: false,
    prices: [
      {
        id: 'price_guest_inr',
        planId: 'guest',
        currency: 'INR',
        interval: 'monthly',
        amountMinorUnits: 0,
        displayAmount: 0,
        isTaxInclusive: true,
        taxRatePercent: 0,
        isActive: true
      },
      {
        id: 'price_guest_usd',
        planId: 'guest',
        currency: 'USD',
        interval: 'monthly',
        amountMinorUnits: 0,
        displayAmount: 0,
        isTaxInclusive: false,
        taxRatePercent: 0,
        isActive: true
      }
    ]
  },
  free: {
    id: 'free',
    planTier: 'free',
    name: 'AIRA Free',
    description: 'Essential intelligence for everyday exploration',
    pricing: { INR: 0, USD: 0 },
    billingInterval: 'monthly',
    dailyStandardChatLimit: 15,
    monthlyStandardChatUnits: 150,
    monthlyPremiumCredits: 100,
    complimentaryReasoningBoosts: 5,
    savedAgentsLimit: 0,
    builderAccess: 'none',
    concurrentInferenceLimit: 1,
    maxProjects: 3,
    maxMemoryRecords: 50,
    allowAutonomous: false,
    allowBrowserTools: false,
    allowPythonSandbox: false,
    prices: [
      {
        id: 'price_free_inr',
        planId: 'free',
        currency: 'INR',
        interval: 'monthly',
        amountMinorUnits: 0,
        displayAmount: 0,
        isTaxInclusive: true,
        taxRatePercent: 18,
        isActive: true
      },
      {
        id: 'price_free_usd',
        planId: 'free',
        currency: 'USD',
        interval: 'monthly',
        amountMinorUnits: 0,
        displayAmount: 0,
        isTaxInclusive: false,
        taxRatePercent: 0,
        isActive: true
      }
    ]
  },
  plus: {
    id: 'plus',
    planTier: 'plus',
    name: 'AIRA Plus',
    description: 'Power-user productivity with everyday value',
    // Paid pricing is pending owner approval and verified gateway integration.
    billingInterval: 'monthly',
    dailyStandardChatLimit: 50,
    monthlyStandardChatUnits: 700,
    monthlyPremiumCredits: 3000,
    complimentaryReasoningBoosts: 50,
    savedAgentsLimit: 3,
    builderAccess: 'trial',
    concurrentInferenceLimit: 1,
    maxProjects: 10,
    maxMemoryRecords: 250,
    allowAutonomous: true,
    allowBrowserTools: false,
    allowPythonSandbox: false,
    prices: []
  },
  pro: {
    id: 'pro',
    planTier: 'pro',
    name: 'AIRA Pro',
    description: 'Higher limits, deep research, vision, builder and agent workflows',
    // Paid pricing is pending owner approval and verified gateway integration.
    billingInterval: 'monthly',
    dailyStandardChatLimit: 150,
    monthlyStandardChatUnits: 2000,
    monthlyPremiumCredits: 7500,
    complimentaryReasoningBoosts: 200,
    savedAgentsLimit: 20,
    builderAccess: 'metered',
    concurrentInferenceLimit: 2,
    maxProjects: -1,
    maxMemoryRecords: -1,
    allowAutonomous: true,
    allowBrowserTools: true,
    allowPythonSandbox: true,
    prices: []
  }
};

// ==========================================
// 1B. MODEL ALLOWLIST & CAPABILITY MATRIX
// ==========================================

/** Compatibility export: no second, contradictory model admission catalog. */
export const PLAN_MODEL_ALLOWLIST: Record<PlanTier, readonly string[]> = VERIFIED_PLAN_MODEL_ALLOWLIST;

export interface PlanCapabilities {
  maxProjects: number;
  maxMemoryRecords: number;
  allowAutonomous: boolean;
  allowBrowserTools: boolean;
  allowPythonSandbox: boolean;
  concurrentInferenceLimit: number;
  dailyStandardChatLimit: number;
  monthlyStandardChatUnits: number;
  monthlyPremiumCredits: number;
  complimentaryReasoningBoosts: number;
  savedAgentsLimit: number;
  builderAccess: 'none' | 'trial' | 'metered';
}

export const PLAN_CAPABILITY_MATRIX: Record<PlanTier, PlanCapabilities> = {
  guest: {
    maxProjects: 0,
    maxMemoryRecords: 0,
    allowAutonomous: false,
    allowBrowserTools: false,
    allowPythonSandbox: false,
    concurrentInferenceLimit: 1,
    dailyStandardChatLimit: 5,
    monthlyStandardChatUnits: 5,
    monthlyPremiumCredits: 0,
    complimentaryReasoningBoosts: 0,
    savedAgentsLimit: 0,
    builderAccess: 'none'
  },
  free: {
    maxProjects: 3,
    maxMemoryRecords: 50,
    allowAutonomous: false,
    allowBrowserTools: false,
    allowPythonSandbox: false,
    concurrentInferenceLimit: 1,
    dailyStandardChatLimit: 15,
    monthlyStandardChatUnits: 150,
    monthlyPremiumCredits: 100,
    complimentaryReasoningBoosts: 5,
    savedAgentsLimit: 0,
    builderAccess: 'none'
  },
  plus: {
    maxProjects: 10,
    maxMemoryRecords: 250,
    allowAutonomous: true,
    allowBrowserTools: false,
    allowPythonSandbox: false,
    concurrentInferenceLimit: 1,
    dailyStandardChatLimit: 50,
    monthlyStandardChatUnits: 700,
    monthlyPremiumCredits: 3000,
    complimentaryReasoningBoosts: 50,
    savedAgentsLimit: 3,
    builderAccess: 'trial'
  },
  pro: {
    maxProjects: -1,
    maxMemoryRecords: -1,
    allowAutonomous: true,
    allowBrowserTools: true,
    allowPythonSandbox: true,
    concurrentInferenceLimit: 2,
    dailyStandardChatLimit: 150,
    monthlyStandardChatUnits: 2000,
    monthlyPremiumCredits: 7500,
    complimentaryReasoningBoosts: 200,
    savedAgentsLimit: 20,
    builderAccess: 'metered'
  }
};

// Deep freeze to guarantee runtime immutability and immunity against prototype pollution
Object.freeze(PLAN_MODEL_ALLOWLIST.guest);
Object.freeze(PLAN_MODEL_ALLOWLIST.free);
Object.freeze(PLAN_MODEL_ALLOWLIST.plus);
Object.freeze(PLAN_MODEL_ALLOWLIST.pro);
Object.freeze(PLAN_MODEL_ALLOWLIST);

Object.freeze(PLAN_CAPABILITY_MATRIX.guest);
Object.freeze(PLAN_CAPABILITY_MATRIX.free);
Object.freeze(PLAN_CAPABILITY_MATRIX.plus);
Object.freeze(PLAN_CAPABILITY_MATRIX.pro);
Object.freeze(PLAN_CAPABILITY_MATRIX);

const CANONICAL_MODEL_ALIASES: Record<string, string> = {
  'claude-3-7-sonnet': 'aira-auto',
  'claude-3-5-sonnet': 'aira-pro',
  'claude-3-5-haiku': 'aira-fast',
  'claude-3-opus': 'aira-deep',
  'meta/llama-3.1-405b-instruct': 'nvidia/llama-3.1-nemotron-70b-instruct',
  'nvidia/nemotron-3-super-120b-a12b': 'nvidia/llama-3.1-nemotron-70b-instruct'
};

export function isModelAllowedForTier(model: string, tier: PlanTier): boolean {
  if (!model || !tier || typeof model !== 'string' || typeof tier !== 'string') {
    return false;
  }
  if (!Object.hasOwn(PLAN_MODEL_ALLOWLIST, tier)) {
    return false;
  }
  const allowed = PLAN_MODEL_ALLOWLIST[tier as PlanTier];
  const trimmed = model.trim();
  const canonical = Object.hasOwn(CANONICAL_MODEL_ALIASES, trimmed)
    ? CANONICAL_MODEL_ALIASES[trimmed]
    : trimmed;
  return Array.isArray(allowed) && allowed.includes(canonical);
}

export { VERIFIED_MODEL_REGISTRY, VERIFIED_PLAN_MODEL_ALLOWLIST, type ModelCapabilityDescriptor };

export function isFeatureAllowedForTier(feature: string, tier: PlanTier): boolean {
  if (!feature || !tier || typeof feature !== 'string' || typeof tier !== 'string') {
    return false;
  }
  if (!Object.hasOwn(COMMERCIAL_PLANS, tier)) {
    return false;
  }
  const plan = COMMERCIAL_PLANS[tier as PlanTier];
  if (!plan) return false;

  const normalized = feature.toLowerCase().trim().replace(/[-_\s]/g, '');

  switch (normalized) {
    case 'autonomous':
    case 'allowautonomous':
    case 'agentmodeautonomous':
    case 'agentmode':
      return Boolean(plan.allowAutonomous);

    case 'browsertools':
    case 'allowbrowsertools':
    case 'probrowsertools':
      return Boolean(plan.allowBrowserTools);

    case 'pythonsandbox':
    case 'allowpythonsandbox':
    case 'prosandboxpython':
    case 'python':
      return Boolean(plan.allowPythonSandbox);

    case 'projects':
    case 'maxprojects':
      return typeof plan.maxProjects === 'number' && plan.maxProjects !== 0;

    case 'memory':
    case 'memoryrecords':
    case 'maxmemoryrecords':
      return typeof plan.maxMemoryRecords === 'number' && plan.maxMemoryRecords !== 0;

    case 'builder':
    case 'builderaccess':
      return typeof plan.builderAccess === 'string' && plan.builderAccess !== 'none';

    case 'reasoning':
    case 'reasoningboosts':
    case 'complimentaryreasoningboosts':
      return typeof plan.complimentaryReasoningBoosts === 'number' && plan.complimentaryReasoningBoosts > 0;

    case 'credits':
    case 'premiumcredits':
    case 'monthlypremiumcredits':
      return typeof plan.monthlyPremiumCredits === 'number' && plan.monthlyPremiumCredits > 0;

    default:
      if (Object.hasOwn(plan, feature) && typeof (plan as any)[feature] === 'boolean') {
        return Boolean((plan as any)[feature]);
      }
      return false;
  }
}

// ==========================================
// 2. SUBSCRIPTION LIFECYCLE
// ==========================================

export const SubscriptionStatusSchema = z.enum([
  'created',
  'authenticated',
  'active',
  'pending',
  'past_due',
  'paused',
  'cancelled',
  'expired'
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const SubscriptionSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  planId: PlanTierSchema,
  priceId: z.string(),
  status: SubscriptionStatusSchema,
  gateway: z.enum(['razorpay', 'cashfree', 'manual_grant']),
  gatewaySubscriptionId: z.string().optional(),
  currency: CurrencyCodeSchema,
  amountMinorUnits: z.number().int().nonnegative(),
  currentPeriodStart: z.number(),
  currentPeriodEnd: z.number(),
  cancelAtPeriodEnd: z.boolean().default(false),
  cancelledAt: z.number().optional(),
  metadata: z.record(z.string(), z.any()).default({}),
  createdAt: z.number(),
  updatedAt: z.number()
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

// ==========================================
// 3. CREDIT ACCOUNT & LEDGER
// ==========================================

export const CreditAccountSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  balanceCredits: z.number().int().min(0, "Credit balance cannot be negative"),
  reservedCredits: z.number().int().min(0, "Reserved credits cannot be negative"),
  lifetimeGrantedCredits: z.number().int().min(0),
  lifetimeSpentCredits: z.number().int().min(0),
  createdAt: z.number(),
  updatedAt: z.number()
});
export type CreditAccount = z.infer<typeof CreditAccountSchema>;

export const CreditGrantTypeSchema = z.enum([
  'subscription_monthly',
  'promotional',
  'purchased_topup',
  'refund_adjustment'
]);
export type CreditGrantType = z.infer<typeof CreditGrantTypeSchema>;

export const CreditGrantSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  amountCredits: z.number().int().positive(),
  remainingCredits: z.number().int().nonnegative(),
  grantType: CreditGrantTypeSchema,
  expiresAt: z.number().optional(),
  rolloverCapped: z.boolean().default(false),
  metadata: z.record(z.string(), z.any()).default({}),
  createdAt: z.number()
});
export type CreditGrant = z.infer<typeof CreditGrantSchema>;

export const ReservationStatusSchema = z.enum([
  'HELD',
  'SETTLED',
  'RELEASED',
  'EXPIRED'
]);
export type ReservationStatus = z.infer<typeof ReservationStatusSchema>;

export const CreditReservationSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  amountCredits: z.number().int().positive(),
  status: ReservationStatusSchema,
  taskType: z.enum([
    'vision_understand',
    'vision_generate',
    'vision_edit',
    'deep_research',
    'agent_step',
    'builder_execution',
    'premium_inference'
  ]),
  referenceId: z.string().optional(),
  expiresAt: z.number(),
  settledAmountCredits: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.any()).default({}),
  createdAt: z.number(),
  updatedAt: z.number()
});
export type CreditReservation = z.infer<typeof CreditReservationSchema>;

export const CreditTransactionTypeSchema = z.enum([
  'GRANT',
  'RESERVATION_HOLD',
  'RESERVATION_SETTLE',
  'RESERVATION_RELEASE',
  'DIRECT_DEBIT',
  'REFUND',
  'EXPIRATION'
]);
export type CreditTransactionType = z.infer<typeof CreditTransactionTypeSchema>;

export const CreditTransactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  reservationId: z.string().optional(),
  transactionType: CreditTransactionTypeSchema,
  amountCredits: z.number().int(), // Positive for inflow, negative for debit
  balanceBefore: z.number().int().nonnegative(),
  balanceAfter: z.number().int().nonnegative(),
  idempotencyKey: z.string(),
  description: z.string(),
  metadata: z.record(z.string(), z.any()).default({}),
  createdAt: z.number()
});
export type CreditTransaction = z.infer<typeof CreditTransactionSchema>;

// ==========================================
// 4. USAGE EVENTS & METERING
// ==========================================

export const UsageEventSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  runId: z.string().optional(),
  taskType: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  cachedTokens: z.number().int().nonnegative().default(0),
  imagesCount: z.number().int().nonnegative().default(0),
  searchQueriesCount: z.number().int().nonnegative().default(0),
  sandboxDurationSeconds: z.number().nonnegative().default(0),
  chargedCredits: z.number().int().nonnegative().default(0),
  estimatedDirectCostUsd: z.number().nonnegative().default(0),
  metadata: z.record(z.string(), z.any()).default({}),
  createdAt: z.number()
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

// ==========================================
// 5. ENTITLEMENT STATE & USER STATUS
// ==========================================

export const EntitlementStateSchema = z.object({
  customerId: z.string(),
  plan: PlanTierSchema,
  subscriptionStatus: SubscriptionStatusSchema,
  creditBalance: z.number().int().nonnegative(),
  reservedCredits: z.number().int().nonnegative(),
  availableCredits: z.number().int().nonnegative(),
  dailyStandardChatRemaining: z.number().int().nonnegative(),
  dailyStandardChatLimit: z.number().int().positive(),
  monthlyStandardChatUnitsRemaining: z.number().int().nonnegative(),
  monthlyStandardChatUnitsLimit: z.number().int().positive(),
  reasoningBoostsRemaining: z.number().int().nonnegative(),
  reasoningBoostsLimit: z.number().int().nonnegative(),
  savedAgentsCount: z.number().int().nonnegative(),
  savedAgentsLimit: z.number().int().nonnegative(),
  builderAccess: z.enum(['none', 'trial', 'metered']),
  canInitiateChat: z.boolean(),
  canUsePremiumModels: z.boolean(),
  canUseVision: z.boolean(),
  canUseBuilder: z.boolean(),
  maxProjects: z.number().int().optional(),
  maxMemoryRecords: z.number().int().optional(),
  allowAutonomous: z.boolean().optional(),
  allowBrowserTools: z.boolean().optional(),
  allowPythonSandbox: z.boolean().optional(),
  concurrentInferenceLimit: z.number().int().positive().optional()
});
export type EntitlementState = z.infer<typeof EntitlementStateSchema>;

// ==========================================
// 6. AIRA VISION CAPABILITY CONTRACTS
// ==========================================

export const VisionAspectRatioSchema = z.enum(['1:1', '3:4', '16:9']);
export type VisionAspectRatio = z.infer<typeof VisionAspectRatioSchema>;

export const VisionQualityTierSchema = z.enum(['economy', 'premium']);
export type VisionQualityTier = z.infer<typeof VisionQualityTierSchema>;
export type VisionQuality = VisionQualityTier;

export const VisionResolutionSchema = z.enum(['standard', 'high']);
export type VisionResolution = z.infer<typeof VisionResolutionSchema>;

export const VisionGenerationParamsSchema = z.object({
  prompt: z.string().min(1).max(2000),
  aspectRatio: VisionAspectRatioSchema.default('1:1'),
  quality: VisionQualityTierSchema.default('economy'),
  resolution: VisionResolutionSchema.default('standard'),
  numImages: z.union([z.literal(1), z.literal(2)]).default(1),
  negativePrompt: z.string().optional()
});
export type VisionGenerationParams = z.infer<typeof VisionGenerationParamsSchema>;

export const VisionUnderstandParamsSchema = z.object({
  imageUrl: z.string().url().optional(),
  imageBase64: z.string().optional(),
  prompt: z.string().min(1).default('Describe this image in detail and extract all visible text.')
});
export type VisionUnderstandParams = z.infer<typeof VisionUnderstandParamsSchema>;

export const VisionEditParamsSchema = z.object({
  imageUrl: z.string().url().optional(),
  imageBase64: z.string().optional(),
  maskBase64: z.string().optional(),
  prompt: z.string().min(1),
  quality: VisionQualityTierSchema.default('economy'),
  resolution: VisionResolutionSchema.default('standard'),
  advancedMode: z.boolean().default(false)
});
export type VisionEditParams = z.infer<typeof VisionEditParamsSchema>;

// Tariff calculator helper based on Master Execution Prompt section 8A
export function calculateVisionTariff(
  operation: 'understand' | 'generate' | 'edit',
  params: {
    quality?: VisionQualityTier;
    resolution?: VisionResolution;
    numImages?: number;
    advancedMode?: boolean;
  }
): number {
  if (operation === 'understand') {
    // Standard visual Q&A / OCR fee: 10 credits
    return 10;
  }

  const quality = params.quality || 'economy';
  const resolution = params.resolution || 'standard';
  const numImages = params.numImages || 1;

  if (operation === 'generate') {
    let perImage = 12;
    if (quality === 'economy' && resolution === 'standard') perImage = 12;
    else if (quality === 'economy' && resolution === 'high') perImage = 24;
    else if (quality === 'premium' && resolution === 'standard') perImage = 100;
    else if (quality === 'premium' && resolution === 'high') perImage = 125;
    return perImage * numImages;
  }

  if (operation === 'edit') {
    if (params.advancedMode) return 250;
    if (quality === 'premium') return 130;
    if (quality === 'economy' && resolution === 'high') return 80;
    return 40; // Economy Standard Edit
  }

  return 15;
}
