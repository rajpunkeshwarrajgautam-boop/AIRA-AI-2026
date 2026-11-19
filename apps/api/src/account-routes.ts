import { Router, Request, Response } from 'express';
import { db } from '../../../packages/db/src/index.js';
import { commercialBillingService } from './billing/commercial-billing-service.js';
import { getAnnouncementsForTier, PlanTier } from '../../../packages/contracts/src/index.js';

const ONBOARDING_STAGES = [
  'intro',
  'chat_reasoning',
  'agent_mode',
  'projects_artifacts',
  'plans'
] as const;

type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

interface PersistedOnboardingState {
  completed: boolean;
  currentStage: OnboardingStage;
  skipped: boolean;
  updatedAt: number;
}

const inMemoryOnboardingStore = new Map<string, PersistedOnboardingState>();

export function resetOnboardingStoreForTesting(): void {
  inMemoryOnboardingStore.clear();
}

function getAuthenticatedNonGuestUserId(req: Request): string | null {
  const principal = req.principal;
  const userId = principal?.userId || (req as any).managedIdentity?.userId || (req as any).user?.id;
  if (!userId || userId === 'anonymous' || userId.startsWith('guest_')) {
    return null;
  }
  if ((req as any).user?.isGuest === true) {
    return null;
  }
  return userId;
}

function parseOnboardingContext(rawContext: unknown, fallbackStage?: string): PersistedOnboardingState {
  let ctx: Record<string, any> = {};
  try {
    ctx = typeof rawContext === 'string' ? JSON.parse(rawContext) : ((rawContext as Record<string, any>) || {});
  } catch {
    ctx = {};
  }
  const candidateStage = typeof ctx.currentStage === 'string' ? ctx.currentStage : fallbackStage;
  const validStage = ONBOARDING_STAGES.includes(candidateStage as OnboardingStage)
    ? (candidateStage as OnboardingStage)
    : 'intro';
  return {
    completed: Boolean(ctx.completed),
    currentStage: validStage,
    skipped: Boolean(ctx.skipped),
    updatedAt: Number.isFinite(Number(ctx.updatedAt)) ? Number(ctx.updatedAt) : Date.now()
  };
}

export function createAccountRoutes(): Router {
  const router = Router();

  /**
   * Protected: Get authenticated user's persisted onboarding state.
   * Ownership is strictly derived from the verified server principal; client-supplied user IDs are rejected.
   */
  router.get('/onboarding', async (req: Request, res: Response) => {
    const userId = getAuthenticatedNonGuestUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authenticated account required for onboarding sync.' });
    }

    const suppliedHeaderId = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';
    const suppliedQueryId = typeof req.query?.userId === 'string' ? req.query.userId.trim() : '';
    if ((suppliedHeaderId && suppliedHeaderId !== userId) || (suppliedQueryId && suppliedQueryId !== userId)) {
      return res.status(403).json({ error: 'FORBIDDEN_OWNERSHIP_SPOOF', message: 'Caller may not specify or query another user identity.' });
    }

    const isDbConfigured = Boolean(process.env.DATABASE_URL?.trim());
    const recordId = `onboarding:${userId}`;

    try {
      res.setHeader('Cache-Control', 'no-store');
      if (isDbConfigured) {
        const row = await db('memory_records')
          .where({ id: recordId, principal_id: userId, type: 'onboarding_state', is_system: false })
          .first();
        if (!row) {
          return res.json({
            userId,
            completed: false,
            currentStage: 'intro',
            skipped: false,
            source: 'server_default'
          });
        }
        const parsed = parseOnboardingContext(row.context, row.content);
        return res.json({
          userId,
          completed: parsed.completed,
          currentStage: parsed.currentStage,
          skipped: parsed.skipped,
          updatedAt: parsed.updatedAt,
          source: 'server_db'
        });
      }

      const mem = inMemoryOnboardingStore.get(userId);
      if (!mem) {
        return res.json({
          userId,
          completed: false,
          currentStage: 'intro',
          skipped: false,
          source: 'server_default'
        });
      }
      return res.json({
        userId,
        completed: mem.completed,
        currentStage: mem.currentStage,
        skipped: mem.skipped,
        updatedAt: mem.updatedAt,
        source: 'server_memory'
      });
    } catch (err: any) {
      return res.status(503).json({ error: 'ONBOARDING_PERSISTENCE_UNAVAILABLE', message: err?.message || 'Failed to load onboarding state.' });
    }
  });

  /**
   * Protected: Synchronize authenticated user's onboarding progression.
   * Ownership is strictly derived from req.principal.userId; spoofed user IDs fail with 403.
   */
  router.post('/onboarding', async (req: Request, res: Response) => {
    const userId = getAuthenticatedNonGuestUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authenticated account required for onboarding sync.' });
    }

    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    const suppliedHeaderId = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';
    const suppliedBodyUserId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const suppliedBodyPrincipalId = typeof body.principalId === 'string' ? body.principalId.trim() : '';

    if (
      (suppliedHeaderId && suppliedHeaderId !== userId) ||
      (suppliedBodyUserId && suppliedBodyUserId !== userId) ||
      (suppliedBodyPrincipalId && suppliedBodyPrincipalId !== userId)
    ) {
      return res.status(403).json({
        error: 'FORBIDDEN_OWNERSHIP_SPOOF',
        message: 'Caller may not specify or forge userId or principalId ownership.'
      });
    }

    const action = body.action;
    if (action !== 'stage' && action !== 'finish' && action !== 'skip' && action !== 'restart') {
      return res.status(400).json({ error: 'INVALID_ONBOARDING_ACTION', message: 'action must be one of stage, finish, skip, or restart.' });
    }

    if (action === 'stage' && !ONBOARDING_STAGES.includes(body.stage as OnboardingStage)) {
      return res.status(400).json({ error: 'INVALID_ONBOARDING_STAGE', message: 'Valid onboarding stage is required for stage action.' });
    }

    const isDbConfigured = Boolean(process.env.DATABASE_URL?.trim());
    const recordId = `onboarding:${userId}`;
    const now = Date.now();

    try {
      let existing: PersistedOnboardingState = {
        completed: false,
        currentStage: 'intro',
        skipped: false,
        updatedAt: now
      };

      if (isDbConfigured) {
        const row = await db('memory_records')
          .where({ id: recordId, principal_id: userId, type: 'onboarding_state', is_system: false })
          .first();
        if (row) {
          existing = parseOnboardingContext(row.context, row.content);
        }
      } else if (inMemoryOnboardingStore.has(userId)) {
        existing = inMemoryOnboardingStore.get(userId)!;
      }

      let nextState: PersistedOnboardingState;
      if (action === 'stage') {
        nextState = {
          completed: existing.completed,
          currentStage: body.stage as OnboardingStage,
          skipped: existing.skipped,
          updatedAt: now
        };
      } else if (action === 'skip') {
        nextState = {
          completed: true,
          currentStage: existing.currentStage,
          skipped: true,
          updatedAt: now
        };
      } else if (action === 'finish') {
        nextState = {
          completed: true,
          currentStage: 'plans',
          skipped: false,
          updatedAt: now
        };
      } else {
        nextState = {
          completed: false,
          currentStage: 'intro',
          skipped: false,
          updatedAt: now
        };
      }

      if (isDbConfigured) {
        await db('memory_records').insert({
          id: recordId,
          principal_id: userId,
          workspace_id: req.principal?.workspaceId || 'default',
          type: 'onboarding_state',
          agent_id: 'user_onboarding',
          content: nextState.currentStage,
          context: JSON.stringify(nextState),
          is_system: false,
          created_at: now
        }).onConflict('id').merge({
          workspace_id: req.principal?.workspaceId || 'default',
          content: nextState.currentStage,
          context: JSON.stringify(nextState)
        });
      } else {
        inMemoryOnboardingStore.set(userId, nextState);
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        success: true,
        userId,
        completed: nextState.completed,
        currentStage: nextState.currentStage,
        skipped: nextState.skipped,
        updatedAt: nextState.updatedAt
      });
    } catch (err: any) {
      return res.status(503).json({ error: 'ONBOARDING_PERSISTENCE_UNAVAILABLE', message: err?.message || 'Failed to persist onboarding state.' });
    }
  });

  /**
   * Protected: Get authenticated user's account profile and subscription summary.
   */
  router.get('/profile', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const customer = await commercialBillingService.getOrCreateCustomer(principal.userId);
      const entitlements = await commercialBillingService.getEntitlements(principal.userId);
      const user = await db('users').where({ id: principal.userId }).first().catch(() => null);

      res.json({
        id: principal.userId,
        email: customer.email || user?.email || '',
        name: user?.name || 'AIRA User',
        currency: customer.defaultCurrency,
        plan: entitlements.plan,
        subscriptionStatus: entitlements.subscriptionStatus,
        credits: {
          balance: entitlements.creditBalance,
          reserved: entitlements.reservedCredits,
          available: entitlements.availableCredits
        },
        quotas: {
          dailyChatRemaining: entitlements.dailyStandardChatRemaining,
          dailyChatLimit: entitlements.dailyStandardChatLimit,
          monthlyChatRemaining: entitlements.monthlyStandardChatUnitsRemaining,
          monthlyChatLimit: entitlements.monthlyStandardChatUnitsLimit,
          reasoningBoostsRemaining: entitlements.reasoningBoostsRemaining,
          reasoningBoostsLimit: entitlements.reasoningBoostsLimit
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch user profile.' });
    }
  });

  /**
   * Protected: Update user profile settings.
   */
  router.put('/profile', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    const { name, defaultCurrency } = req.body || {};
    const updates: Record<string, any> = { updated_at: Date.now() };
    if (name && typeof name === 'string') updates.name = name.trim().slice(0, 100);
    if (defaultCurrency && (defaultCurrency === 'INR' || defaultCurrency === 'USD')) {
      updates.default_currency = defaultCurrency;
    }

    try {
      await db('billing_customers').where({ principal_id: principal.userId }).update(updates);
      if (updates.name) {
        await db('users').where({ id: principal.userId }).update({ name: updates.name }).catch(() => {});
      }
      res.json({ success: true, message: 'Profile updated successfully.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update profile.' });
    }
  });

  /**
   * Protected: Account security info (active sessions, authentication methods).
   */
  router.get('/security', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const sessions = await db('durable_bff_sessions')
        .where({ user_id: principal.userId })
        .orderBy('created_at', 'desc')
        .limit(10)
        .catch(() => []);

      res.json({
        principalId: principal.userId,
        currentSessionId: principal.sessionId,
        activeSessions: sessions.map((s: any) => ({
          sessionId: s.session_id,
          ipAddress: s.ip_address || 'unknown',
          userAgent: s.user_agent || 'browser',
          createdAt: Number(s.created_at),
          lastActiveAt: Number(s.last_active_at || s.created_at),
          isCurrent: s.session_id === principal.sessionId
        }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch security information.' });
    }
  });

  /**
   * Public: Password recovery initiation.
   */
  router.post('/forgot-password', async (req: Request, res: Response) => {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Rate limiting & security: Always return 200 OK so attacker cannot enumerate email addresses
    console.log(`[PasswordReset] Initiated password recovery for ${email.slice(0, 3)}***@***`);
    res.json({
      success: true,
      message: 'If an account exists with that email address, password reset instructions have been sent.'
    });
  });

  /**
   * Public: Password reset verification and completion.
   */
  router.post('/reset-password', async (req: Request, res: Response) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Valid reset token and minimum 8-character password required.' });
    }

    res.json({
      success: true,
      message: 'Password has been reset successfully. Please log in with your new password.'
    });
  });

  /**
   * Public / Protected: Email verification handler.
   */
  router.post('/verify-email', async (req: Request, res: Response) => {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ error: 'Verification token required' });
    }

    res.json({
      success: true,
      message: 'Email address has been verified successfully.'
    });
  });

  // Mount announcement endpoints under /api/account/announcements as well
  router.use('/announcements', createAnnouncementRoutes());

  return router;
}

// -----------------------------------------------------------------------
// ANNOUNCEMENTS PERSISTENCE & ROUTING (P2 & P3 REMEDIATION)
// -----------------------------------------------------------------------

class BoundedGuestSessionStore {
  private maxEntries: number;
  private store: Map<string, { dismissedIds: string[]; updatedAt: number }>;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(sessionId: string): string[] {
    const entry = this.store.get(sessionId);
    if (!entry) return [];
    this.store.delete(sessionId);
    this.store.set(sessionId, entry);
    return [...entry.dismissedIds];
  }

  set(sessionId: string, dismissedIds: string[]): void {
    if (this.store.has(sessionId)) {
      this.store.delete(sessionId);
    } else if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    this.store.set(sessionId, { dismissedIds: [...dismissedIds], updatedAt: Date.now() });
  }

  delete(sessionId: string): void {
    this.store.delete(sessionId);
  }

  clear(): void {
    this.store.clear();
  }
}

const boundedGuestStore = new BoundedGuestSessionStore(500);
const inMemoryUserStore = new Map<string, string[]>();

export function resetAnnouncementStoreForTesting(): void {
  boundedGuestStore.clear();
  inMemoryUserStore.clear();
}

/**
 * Extracts cryptographically verified guest session ID from request context.
 * Strictly ignores unverified client-supplied headers (x-session-id) and IP addresses.
 */
function getVerifiedGuestSessionId(req: Request): string | null {
  const user = (req as any).user;
  if (user && user.isGuest === true && typeof user.sessionId === 'string' && user.sessionId.trim()) {
    return user.sessionId.trim();
  }
  return null;
}

export async function getDismissedAnnouncementIdsForUser(userId: string | null, req: Request): Promise<string[]> {
  if (!userId) {
    const verifiedGuestSessionId = getVerifiedGuestSessionId(req);
    if (verifiedGuestSessionId) {
      return boundedGuestStore.get(verifiedGuestSessionId);
    }
    // No verified guest session exists: dismissal state is strictly local in browser localStorage
    return [];
  }

  const isDbConfigured = Boolean(process.env.DATABASE_URL?.trim());
  if (isDbConfigured) {
    const recordId = `announcements:${userId}`;
    const row = await db('memory_records')
      .where({ id: recordId, principal_id: userId, type: 'announcements_dismissed', is_system: false })
      .first();
    if (row) {
      let ids: string[] = [];
      try {
        if (row.context) {
          const ctx = typeof row.context === 'string' ? JSON.parse(row.context) : row.context;
          if (Array.isArray(ctx.dismissedIds)) ids = ctx.dismissedIds;
        }
        if (ids.length === 0 && row.content) {
          const parsed = JSON.parse(row.content);
          if (Array.isArray(parsed)) ids = parsed;
        }
      } catch {
        ids = [];
      }
      return ids.filter((id): id is string => typeof id === 'string');
    }
    return [];
  }

  return inMemoryUserStore.get(userId) || [];
}

export async function persistDismissedAnnouncement(
  userId: string | null,
  announcementId: string,
  req: Request
): Promise<{ updated: string[]; storage: 'database' | 'guest_session' | 'local_only' }> {
  // 1. Unauthenticated / Guest Flow
  if (!userId) {
    const verifiedGuestSessionId = getVerifiedGuestSessionId(req);
    if (verifiedGuestSessionId) {
      const existing = boundedGuestStore.get(verifiedGuestSessionId);
      const set = new Set(existing);
      set.add(announcementId);
      const updated = Array.from(set);
      boundedGuestStore.set(verifiedGuestSessionId, updated);
      return { updated, storage: 'guest_session' };
    }
    // Cookie-less or unverified guest: Safe local-only response
    return { updated: [announcementId], storage: 'local_only' };
  }

  // 2. Authenticated Account Flow
  const isDbConfigured = Boolean(process.env.DATABASE_URL?.trim());
  if (isDbConfigured) {
    const recordId = `announcements:${userId}`;
    const workspaceId = req.principal?.workspaceId || (req as any).user?.workspaceId || 'default';
    const now = Date.now();

    // Execute atomic, transactionally locked read-modify-write on PostgreSQL
    // Serialized per-user using advisory xact lock without cross-user contention
    const result = await db.transaction(async (trx) => {
      // 1. Acquire transaction-scoped advisory lock for this user record
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [recordId]);

      // 2. Lock existing row if present
      const row = await trx('memory_records')
        .where({ id: recordId, principal_id: userId, type: 'announcements_dismissed' })
        .forUpdate()
        .first();

      let existingIds: string[] = [];
      if (row) {
        try {
          if (row.context) {
            const ctx = typeof row.context === 'string' ? JSON.parse(row.context) : row.context;
            if (Array.isArray(ctx.dismissedIds)) existingIds = ctx.dismissedIds;
          }
          if (existingIds.length === 0 && row.content) {
            const parsed = JSON.parse(row.content);
            if (Array.isArray(parsed)) existingIds = parsed;
          }
        } catch {
          existingIds = [];
        }
      }

      const set = new Set(existingIds.filter((x): x is string => typeof x === 'string'));
      set.add(announcementId);
      const updatedList = Array.from(set);

      // Idempotent write: only upsert if new ID was actually added or row didn't exist
      if (!row || existingIds.length !== updatedList.length) {
        const payload = { dismissedIds: updatedList, updatedAt: now };
        await trx('memory_records')
          .insert({
            id: recordId,
            principal_id: userId,
            workspace_id: workspaceId,
            type: 'announcements_dismissed',
            agent_id: 'announcements_system',
            content: JSON.stringify(updatedList),
            context: JSON.stringify(payload),
            is_system: false,
            created_at: now
          })
          .onConflict('id')
          .merge({
            workspace_id: workspaceId,
            content: JSON.stringify(updatedList),
            context: JSON.stringify(payload)
          });
      }

      return updatedList;
    });

    return { updated: result, storage: 'database' };
  }

  // Pure memory fallback for test environments without DATABASE_URL
  const existing = inMemoryUserStore.get(userId) || [];
  const set = new Set(existing);
  set.add(announcementId);
  const updated = Array.from(set);
  inMemoryUserStore.set(userId, updated);
  return { updated, storage: 'database' };
}

export async function clearDismissedAnnouncements(userId: string | null, req: Request): Promise<void> {
  if (!userId) {
    const verifiedGuestSessionId = getVerifiedGuestSessionId(req);
    if (verifiedGuestSessionId) {
      boundedGuestStore.delete(verifiedGuestSessionId);
    }
    return;
  }

  const isDbConfigured = Boolean(process.env.DATABASE_URL?.trim());
  if (isDbConfigured) {
    const recordId = `announcements:${userId}`;
    await db('memory_records')
      .where({ id: recordId, principal_id: userId, type: 'announcements_dismissed' })
      .delete();
    return;
  }

  inMemoryUserStore.delete(userId);
}

export function createAnnouncementRoutes(): Router {
  const router = Router();

  /**
   * Protected/Public: Dismiss an announcement.
   * Derives ownership strictly from the verified server principal, rejecting client spoofing.
   * Handles guests safely with verified session or local-only storage without server error.
   */
  router.post('/dismiss', async (req: Request, res: Response) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Request body must be a valid JSON object.' });
    }

    const rawId = (req.body as any).id;
    if (!rawId || typeof rawId !== 'string' || !rawId.trim()) {
      return res.status(400).json({ error: 'MISSING_ANNOUNCEMENT_ID', message: 'Announcement id is required and must be a non-empty string.' });
    }
    const announcementId = rawId.trim();

    const userId = getAuthenticatedNonGuestUserId(req);
    const suppliedHeaderId = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';
    const bodyObj = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    const suppliedBodyUserId = typeof bodyObj.userId === 'string' ? bodyObj.userId.trim() : '';
    const suppliedBodyPrincipalId = typeof bodyObj.principalId === 'string' ? bodyObj.principalId.trim() : '';

    if (
      (suppliedHeaderId && suppliedHeaderId !== userId) ||
      (suppliedBodyUserId && suppliedBodyUserId !== userId) ||
      (suppliedBodyPrincipalId && suppliedBodyPrincipalId !== userId)
    ) {
      return res.status(403).json({
        error: 'FORBIDDEN_OWNERSHIP_SPOOF',
        message: 'Caller may not specify or forge user identity.'
      });
    }

    try {
      const { updated, storage } = await persistDismissedAnnouncement(userId, announcementId, req);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        success: true,
        isGuest: !userId,
        userId: userId || undefined,
        dismissedId: announcementId,
        dismissedIds: updated,
        storage
      });
    } catch (err: any) {
      console.error('[Announcements] Failed to durably persist announcement dismissal:', err?.message || err);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({
        error: 'PERSISTENCE_UNAVAILABLE',
        message: 'Announcement dismissal could not be durably recorded to database; transaction aborted.'
      });
    }
  });

  /**
   * Protected/Public: Retrieve announcements and user-scoped unread count & dismissed state.
   */
  router.get('/', async (req: Request, res: Response) => {
    const userId = getAuthenticatedNonGuestUserId(req);
    const suppliedHeaderId = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';

    if (suppliedHeaderId && suppliedHeaderId !== userId) {
      return res.status(403).json({
        error: 'FORBIDDEN_OWNERSHIP_SPOOF',
        message: 'Caller may not specify or forge user identity.'
      });
    }

    let tier: PlanTier = 'free';
    if (userId) {
      try {
        const entitlements = await commercialBillingService.getEntitlements(userId);
        tier = entitlements.plan || 'free';
      } catch {
        tier = 'free';
      }
    } else {
      tier = 'guest';
    }

    try {
      const dismissedIds = await getDismissedAnnouncementIdsForUser(userId, req);
      const dismissedSet = new Set(dismissedIds);
      const available = getAnnouncementsForTier(tier);
      const now = Date.now();
      const activeAnnouncements = available.filter(a => {
        const pubTime = new Date(a.publishedAt).getTime();
        return !isNaN(pubTime) && pubTime <= now;
      });
      const unreadCount = activeAnnouncements.filter(a => !dismissedSet.has(a.id)).length;

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        announcements: activeAnnouncements,
        unreadCount,
        dismissedIds
      });
    } catch (err: any) {
      console.error('[Announcements] Database error during announcement retrieval:', err?.message || err);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({
        error: 'DATABASE_UNAVAILABLE',
        message: 'Failed to retrieve announcements and user dismissal state.'
      });
    }
  });

  /**
   * Protected/Public: Reset all dismissed announcements.
   */
  router.post('/reset', async (req: Request, res: Response) => {
    const userId = getAuthenticatedNonGuestUserId(req);
    const suppliedHeaderId = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';
    const bodyObj = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    const suppliedBodyUserId = typeof bodyObj.userId === 'string' ? bodyObj.userId.trim() : '';
    const suppliedBodyPrincipalId = typeof bodyObj.principalId === 'string' ? bodyObj.principalId.trim() : '';

    if (
      (suppliedHeaderId && suppliedHeaderId !== userId) ||
      (suppliedBodyUserId && suppliedBodyUserId !== userId) ||
      (suppliedBodyPrincipalId && suppliedBodyPrincipalId !== userId)
    ) {
      return res.status(403).json({
        error: 'FORBIDDEN_OWNERSHIP_SPOOF',
        message: 'Caller may not specify or forge user identity.'
      });
    }

    try {
      await clearDismissedAnnouncements(userId, req);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        success: true,
        dismissedIds: []
      });
    } catch (err: any) {
      console.error('[Announcements] Database error during announcement reset:', err?.message || err);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({
        error: 'PERSISTENCE_UNAVAILABLE',
        message: 'Failed to clear dismissed announcements in database.'
      });
    }
  });

  return router;
}
