import type { Request, Response, NextFunction } from 'express';
import {
  PlanTier,
  PlanTierSchema,
  PLAN_MODEL_ALLOWLIST,
  VERIFIED_PLAN_MODEL_ALLOWLIST,
  isModelAllowedForTier,
  isFeatureAllowedForTier,
  getMinimumRequiredTierForFeature,
  getMinimumRequiredTierForModel,
  normalizeModelIdentifier,
  isGuestPrincipal
} from '../../../../packages/contracts/src/index.js';
import { commercialBillingService } from '../billing/commercial-billing-service.js';

export const TIER_RANKS: Record<PlanTier, number> = {
  guest: 0,
  free: 1,
  plus: 2,
  pro: 3
};

export class EntitlementServiceUnavailableError extends Error {
  readonly code = 'ENTITLEMENT_SERVICE_UNAVAILABLE';
  readonly statusCode = 503;

  constructor(message = 'Authoritative entitlement service is temporarily unavailable.', readonly cause?: unknown) {
    super(message);
    this.name = 'EntitlementServiceUnavailableError';
  }
}

/**
 * Server-authoritative tier resolution.
 * Completely immune to header-spoofing attacks: an untrusted 'x-user-tier' header,
 * client cookies, body attributes, or unverified claims must NEVER declare plan tier.
 * Only verified cryptographic sessions and PostgreSQL database subscriptions govern entitlements.
 */
export async function resolveCallerTier(req: Request, _options: { failClosed?: boolean } = {}): Promise<PlanTier> {
  const user = (req as any).user;
  const principal = req.principal;
  const principalId = principal?.userId || (req as any).session?.userId || user?.id;

  // 1. Explicit guest identity detection (session or principal starting with 'guest_' or legacy anonymous 'user_')
  if (principalId && typeof principalId === 'string' && isGuestPrincipal(principalId)) {
    return 'guest';
  }
  if (user?.isGuest === true) {
    return 'guest';
  }

  // 2. Unauthenticated caller without verified identity is strictly 'guest'
  if (!principalId || principalId === 'anonymous') {
    return 'guest';
  }

  // 3. Authenticated customer subscription query from PostgreSQL
  // NOTE: x-user-tier header is unconditionally stripped and ignored in all environments.
  // Paid tiers (plus, pro) CANNOT be self-declared via user/principal properties.
  try {
    const customer = await commercialBillingService.getOrCreateCustomer(principalId);
    const sub = await commercialBillingService.getActiveSubscription(customer.id);
    if (sub?.planId && (sub.status === 'active' || sub.status === 'authenticated')) {
      const parsed = PlanTierSchema.safeParse(sub.planId);
      if (parsed.success && (parsed.data === 'plus' || parsed.data === 'pro')) {
        return parsed.data;
      }
    }
    return 'free';
  } catch (err: unknown) {
    // A verified identity whose subscription cannot be read has no verified tier.
    // In particular, req.user.tier='free' is NOT proof of a working billing DB.
    throw new EntitlementServiceUnavailableError(
      'Authoritative entitlement database is temporarily unreachable.', err
    );
  }
}

/**
 * Express middleware requiring a minimum plan tier rank.
 */
export function requirePlanTier(minTier: PlanTier) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const callerTier = await resolveCallerTier(req, { failClosed: minTier === 'plus' || minTier === 'pro' });
      if (TIER_RANKS[callerTier] < TIER_RANKS[minTier]) {
        res.status(403).json({
          error: 'PLAN_TIER_RESTRICTED',
          message: `This endpoint requires ${minTier} tier or higher.`,
          callerTier,
          requiredTier: minTier
        });
        return;
      }
      (req as any).callerTier = callerTier;
      next();
    } catch (err: any) {
      if (err?.code === 'ENTITLEMENT_SERVICE_UNAVAILABLE' || err?.statusCode === 503) {
        res.status(503).json({
          error: 'ENTITLEMENT_SERVICE_UNAVAILABLE',
          message: err.message || 'Authoritative entitlement service is temporarily unavailable.'
        });
        return;
      }
      res.status(500).json({ error: 'ENTITLEMENT_RESOLUTION_FAILED', message: err.message });
    }
  };
}

/**
 * Express middleware enforcing model tier allowlist.
 */
export function requireEntitledModel(modelExtractor?: (req: Request) => string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawModel = modelExtractor ? modelExtractor(req) : (req.body?.model || req.query?.model);
      if (!rawModel || typeof rawModel !== 'string' || !rawModel.trim()) {
        res.status(400).json({ error: 'MODEL_REQUIRED', message: 'Missing model parameter' });
        return;
      }

      const model = normalizeModelIdentifier(rawModel);
      const isRestrictedModel = !isModelAllowedForTier(model, 'guest') && !isModelAllowedForTier(model, 'free');
      const callerTier = await resolveCallerTier(req, { failClosed: isRestrictedModel });

      if (!isModelAllowedForTier(model, callerTier)) {
        const isPlusModel = isModelAllowedForTier(model, 'plus');
        const requiredTier = isPlusModel ? 'plus' : 'pro';
        const allowedModels = VERIFIED_PLAN_MODEL_ALLOWLIST[callerTier] || PLAN_MODEL_ALLOWLIST[callerTier] || [];

        res.status(403).json({
          error: 'PLAN_MODEL_RESTRICTED',
          message: `Model '${model}' requires higher plan tier`,
          callerTier,
          requiredTier,
          allowedModels
        });
        return;
      }

      (req as any).callerTier = callerTier;
      (req as any).normalizedModel = model;
      next();
    } catch (err: any) {
      if (err?.code === 'ENTITLEMENT_SERVICE_UNAVAILABLE' || err?.statusCode === 503) {
        res.status(503).json({
          error: 'ENTITLEMENT_SERVICE_UNAVAILABLE',
          message: err.message || 'Authoritative entitlement service is temporarily unavailable.'
        });
        return;
      }
      res.status(500).json({ error: 'MODEL_ENTITLEMENT_CHECK_FAILED', message: err.message });
    }
  };
}

/**
 * Express middleware enforcing tool tier gating.
 */
export function requireToolEntitlement(toolExtractor?: (req: Request) => string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const toolName = toolExtractor ? toolExtractor(req) : (req.body?.toolName || req.body?.toolId);
      if (!toolName || typeof toolName !== 'string') {
        res.status(400).json({ error: 'toolName or toolId is required.' });
        return;
      }

      const isRestrictedTool = toolName.startsWith('browser_') || toolName === 'python_sandbox';
      const callerTier = await resolveCallerTier(req, { failClosed: isRestrictedTool });

      if (toolName.startsWith('browser_') && !isFeatureAllowedForTier('browsertools', callerTier)) {
        res.status(403).json({
          error: 'PLAN_TOOL_RESTRICTED',
          tool: toolName,
          message: 'Browser execution tools require AIRA Pro plan.',
          requiredTier: 'pro'
        });
        return;
      }

      if (toolName === 'python_sandbox' && !isFeatureAllowedForTier('pythonsandbox', callerTier)) {
        res.status(403).json({
          error: 'PLAN_TOOL_RESTRICTED',
          tool: toolName,
          message: 'Python Sandbox execution requires AIRA Pro plan.',
          requiredTier: 'pro'
        });
        return;
      }

      (req as any).callerTier = callerTier;
      next();
    } catch (err: any) {
      if (err?.code === 'ENTITLEMENT_SERVICE_UNAVAILABLE' || err?.statusCode === 503) {
        res.status(503).json({
          error: 'ENTITLEMENT_SERVICE_UNAVAILABLE',
          message: err.message || 'Authoritative entitlement service is temporarily unavailable.'
        });
        return;
      }
      res.status(500).json({ error: 'TOOL_ENTITLEMENT_CHECK_FAILED', message: err.message });
    }
  };
}

/**
 * Express middleware enforcing generic capability matrix gating.
 */
export function requireCapability(capability: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const requiredTier = getMinimumRequiredTierForFeature(capability);
      const isRestricted = requiredTier === 'plus' || requiredTier === 'pro';
      const callerTier = await resolveCallerTier(req, { failClosed: isRestricted });
      if (!isFeatureAllowedForTier(capability, callerTier)) {
        res.status(403).json({
          error: 'PLAN_CAPABILITY_RESTRICTED',
          capability,
          message: `Capability '${capability}' requires ${requiredTier.toUpperCase()} tier or higher.`,
          callerTier,
          requiredTier
        });
        return;
      }
      (req as any).callerTier = callerTier;
      next();
    } catch (err: any) {
      if (err?.code === 'ENTITLEMENT_SERVICE_UNAVAILABLE' || err?.statusCode === 503) {
        res.status(503).json({
          error: 'ENTITLEMENT_SERVICE_UNAVAILABLE',
          message: err.message || 'Authoritative entitlement service is temporarily unavailable.'
        });
        return;
      }
      res.status(500).json({ error: 'CAPABILITY_CHECK_FAILED', message: err.message });
    }
  };
}
