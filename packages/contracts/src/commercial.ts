import { z } from 'zod';

// ==========================================
// 1. PLANS & PRICING
// ==========================================

export const PlanTierSchema = z.enum(['free', 'plus', 'pro']);
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
  name: z.string(),
  description: z.string(),
  dailyStandardChatLimit: z.number().int().positive(),
  monthlyStandardChatUnits: z.number().int().positive(),
  monthlyPremiumCredits: z.number().int().nonnegative(),
  complimentaryReasoningBoosts: z.number().int().nonnegative(),
  savedAgentsLimit: z.number().int().nonnegative(),
  builderAccess: z.enum(['none', 'trial', 'metered']),
  concurrentInferenceLimit: z.number().int().positive(),
  prices: z.array(PlanPriceSchema)
});
export type PlanDefinition = z.infer<typeof PlanDefinitionSchema>;

// Baseline configurations per Master Execution Prompt
export const COMMERCIAL_PLANS: Record<PlanTier, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'AIRA Free',
    description: 'Essential intelligence for everyday exploration',
    dailyStandardChatLimit: 15,
    monthlyStandardChatUnits: 150,
    monthlyPremiumCredits: 100,
    complimentaryReasoningBoosts: 5,
    savedAgentsLimit: 0,
    builderAccess: 'none',
    concurrentInferenceLimit: 1,
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
    name: 'AIRA Plus',
    description: 'Power-user productivity with everyday value',
    dailyStandardChatLimit: 50,
    monthlyStandardChatUnits: 700,
    monthlyPremiumCredits: 3000,
    complimentaryReasoningBoosts: 50,
    savedAgentsLimit: 3,
    builderAccess: 'trial',
    concurrentInferenceLimit: 1,
    prices: [
      {
        id: 'price_plus_inr',
        planId: 'plus',
        currency: 'INR',
        interval: 'monthly',
        amountMinorUnits: 39900,
        displayAmount: 399,
        isTaxInclusive: true,
        taxRatePercent: 18,
        isActive: true
      },
      {
        id: 'price_plus_usd',
        planId: 'plus',
        currency: 'USD',
        interval: 'monthly',
        amountMinorUnits: 799,
        displayAmount: 7.99,
        isTaxInclusive: false,
        taxRatePercent: 0,
        isActive: true
      }
    ]
  },
  pro: {
    id: 'pro',
    name: 'AIRA Pro',
    description: 'Higher limits, deep research, vision, builder and agent workflows',
    dailyStandardChatLimit: 150,
    monthlyStandardChatUnits: 2000,
    monthlyPremiumCredits: 7500,
    complimentaryReasoningBoosts: 200,
    savedAgentsLimit: 20,
    builderAccess: 'metered',
    concurrentInferenceLimit: 2,
    prices: [
      {
        id: 'price_pro_inr',
        planId: 'pro',
        currency: 'INR',
        interval: 'monthly',
        amountMinorUnits: 99900,
        displayAmount: 999,
        isTaxInclusive: true,
        taxRatePercent: 18,
        isActive: true
      },
      {
        id: 'price_pro_usd',
        planId: 'pro',
        currency: 'USD',
        interval: 'monthly',
        amountMinorUnits: 1999,
        displayAmount: 19.99,
        isTaxInclusive: false,
        taxRatePercent: 0,
        isActive: true
      }
    ]
  }
};

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
  canUseBuilder: z.boolean()
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
