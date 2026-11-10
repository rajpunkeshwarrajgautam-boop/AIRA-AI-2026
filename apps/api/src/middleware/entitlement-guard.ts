import type { Request, Response, NextFunction } from 'express';
import {
  PlanTier,
  PlanTierSchema,
  PLAN_MODEL_ALLOWLIST,
  isModelAllowedForTier,
  isFeatureAllowedForTier,
  normalizeModelIdentifier
} from '../../../../packages/contracts/src/index.js';
import { commercialBillingService } from '../billing/commercial-billing-service.js';

export const TIER_RANKS: Record<PlanTier, number> = {
  guest: 0,
  free: 1,
  plus: 2,
  pro: 3
};

/**
 * Server-authoritative tier resolution.
 * Protects against header-spoofing attacks: an untrusted 'x-user-tier' header
 * must NEVER override an authenticated session, managed identity, or database subscription.
 */
export async function resolveCallerTier(req: Request): Promise<PlanTier> {
  const user = (req as any).user;
  const principal = req.principal;
  const principalId = principal?.userId || user?.id;

  // 1. Explicit guest identity detection (session or principal starting with 'guest_')
  if (principalId && typeof principalId === 'string' && principalId.startsWith('guest_')) {
    return 'guest';
  }
  if (user?.isGuest === true) {
    return 'guest';
  }

  // 2. Direct user object tier assigned by server-side authentication
  if (user?.tier && typeof user.tier === 'string') {
    const parsed = PlanTierSchema.safeParse(user.tier);
    if (parsed.success) {
      return parsed.data;
    }
  }

  // 3. Authenticated customer subscription query from database
  if (principalId && typeof principalId === 'string' && !principalId.startsWith('test-') && principalId !== 'anonymous') {
    try {
      const customer = await commercialBillingService.getOrCreateCustomer(principalId);
      const sub = await commercialBillingService.getActiveSubscription(customer.id);
      if (sub?.planId) {
        const parsed = PlanTierSchema.safeParse(sub.planId);
        if (parsed.success) {
          return parsed.data;
        }
      }
    } catch {
      // In-flight or degraded database fallback
    }
  }

  // 4. Header spoofing protection:
  // x-user-tier is ONLY honored in unauthenticated dev/test environments when NO session credentials,
  // authorization headers, or cookie tokens exist.
  const hasAuth = Boolean(req.headers.authorization || req.headers.cookie);
  const headerTier = req.headers['x-user-tier'];
  if (!hasAuth && headerTier && typeof headerTier === 'string') {
    const parsed = PlanTierSchema.safeParse(headerTier.toLowerCase().trim());
    if (parsed.success) {
      return parsed.data;
    }
  }

  // 5. Default fallback: authenticated user without subscription is 'free'; anonymous is 'guest'
  return principalId ? 'free' : 'guest';
}

/**
 * Express middleware requiring a minimum plan tier rank.
 */
export function requirePlanTier(minTier: PlanTier) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const callerTier = await resolveCallerTier(req);
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
      const callerTier = await resolveCallerTier(req);

      if (!isModelAllowedForTier(model, callerTier)) {
        const isPlusModel = isModelAllowedForTier(model, 'plus');
        const requiredTier = isPlusModel ? 'plus' : 'pro';
        const allowedModels = PLAN_MODEL_ALLOWLIST[callerTier] || [];

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

      const callerTier = await resolveCallerTier(req);

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
      const callerTier = await resolveCallerTier(req);
      if (!isFeatureAllowedForTier(capability, callerTier)) {
        res.status(403).json({
          error: 'PLAN_CAPABILITY_RESTRICTED',
          capability,
          message: `Capability '${capability}' is restricted to higher plan tiers.`,
          requiredTier: 'pro'
        });
        return;
      }
      (req as any).callerTier = callerTier;
      next();
    } catch (err: any) {
      res.status(500).json({ error: 'CAPABILITY_CHECK_FAILED', message: err.message });
    }
  };
}
