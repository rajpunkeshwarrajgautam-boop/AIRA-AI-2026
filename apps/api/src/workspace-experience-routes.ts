import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../../../packages/db/src/index.js';

const VALID_PLACEMENTS = new Set(['rail', 'welcome']);
const VALID_EVENTS = new Set(['impression', 'click']);

function accountPrincipal(req: Request): string | null {
  const id = req.principal?.userId;
  if (!id || id === 'anonymous' || id === 'guest' || id.startsWith('guest_')) return null;
  if ((req as Request & { user?: { isGuest?: boolean } }).user?.isGuest) return null;
  return id;
}

export function createWorkspaceExperienceRoutes(): Router {
  const router = Router();

  router.get('/me/onboarding', async (req: Request, res: Response) => {
    const userId = accountPrincipal(req);
    if (!userId) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    try {
      const row = await db('users').select('onboarded_at').where({ id: userId }).first();
      if (!row) return res.status(404).json({ error: 'USER_NOT_FOUND' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ onboardedAt: row.onboarded_at === null ? null : Number(row.onboarded_at) });
    } catch {
      return res.status(503).json({ error: 'ONBOARDING_READ_UNAVAILABLE' });
    }
  });

  router.post('/me/onboarding', async (req: Request, res: Response) => {
    const userId = accountPrincipal(req);
    if (!userId) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    if (req.body?.step !== 'intro') return res.status(400).json({ error: 'INVALID_STEP' });
    // Idempotent first-seen timestamp. Never trust user IDs supplied in the request body.
    try {
      const [row] = await db('users').where({ id: userId }).update({
        onboarded_at: db.raw('COALESCE(onboarded_at, ?)', [Date.now()]),
      }).returning('onboarded_at');
      if (!row) return res.status(404).json({ error: 'USER_NOT_FOUND' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ onboardedAt: Number(row.onboarded_at) });
    } catch {
      return res.status(503).json({ error: 'ONBOARDING_WRITE_UNAVAILABLE' });
    }
  });

  router.post('/events', async (req: Request, res: Response) => {
    const userId = accountPrincipal(req);
    if (!userId) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    const { placement, kind, sessionId } = req.body || {};
    if (!VALID_PLACEMENTS.has(placement) || !VALID_EVENTS.has(kind) ||
        typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      return res.status(400).json({ error: 'INVALID_PROMO_EVENT' });
    }
    try {
      const recent = await db('workspace_promo_events')
        .where({ principal_id: userId })
        .andWhere('created_at', '>=', Date.now() - 60 * 60 * 1000)
        .count<{ count: string }[]>('* as count')
        .first();
      if (Number(recent?.count || 0) >= 30) return res.status(429).json({ error: 'PROMO_EVENT_RATE_LIMIT' });
      await db('workspace_promo_events').insert({
        id: randomUUID(),
        principal_id: userId,
        placement,
        kind,
        session_id: sessionId,
        created_at: Date.now(),
      }).onConflict(['principal_id', 'placement', 'kind', 'session_id']).ignore();
      return res.status(204).end();
    } catch {
      return res.status(503).json({ error: 'EVENT_WRITE_UNAVAILABLE' });
    }
  });

  return router;
}

