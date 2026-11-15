/**
 * TEMPORARY: AI Staring trial probe. Isolated to one Vercel Preview branch.
 * Delete this file, its route registration, the static playground, and branch-scoped
 * AIRA_STAR_TRIAL_* variables after the trial. No database schema or user data changes.
 *
 * Never route production/normal AIRA chat or background agents through this probe.
 */
import { Router, type Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

export const AI_STAR_TRIAL_BRANCH = 'trial/ai-staring-preview-20261115';

export const AI_STAR_TRIAL_MODELS = [
  'deepseek-v4-flash',
  'gpt-6-luna',
  'claude-sonnet-5',
  'gemini-3.1-pro',
  'kimi-k3'
] as const;

const MAX_PROMPT_LENGTH = 600;
const MAX_OUTPUT_TOKENS = 160;
const MIN_INTERVAL_MS = 10_000;
const MAX_EXPIRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UPSTREAM_URL = 'https://ai.starimg.ru/v1/chat/completions';

type TrialEnvironment = NodeJS.ProcessEnv;

let exhaustedInThisInstance = false;
const lastRequestAt = new Map<string, number>();

export function getTrialConfiguration(env: TrialEnvironment = process.env, now = Date.now()) {
  // Both deployment environment AND exact Git ref must match. NODE_ENV alone is unsafe:
  // Vercel Preview and Production both run with NODE_ENV=production.
  if (env.VERCEL_ENV !== 'preview' || env.VERCEL_GIT_COMMIT_REF !== AI_STAR_TRIAL_BRANCH) {
    return { enabled: false, reason: 'NOT_TRIAL_PREVIEW' } as const;
  }
  if (env.AIRA_STAR_TRIAL_ENABLED !== 'true') {
    return { enabled: false, reason: 'DISABLED' } as const;
  }
  const expiry = Date.parse(env.AIRA_STAR_TRIAL_EXPIRES_AT || '');
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + MAX_EXPIRY_WINDOW_MS) {
    return { enabled: false, reason: 'EXPIRED_OR_INVALID_EXPIRY' } as const;
  }
  if (!env.AIRA_STAR_TRIAL_API_KEY?.trim()) {
    return { enabled: false, reason: 'KEY_NOT_CONFIGURED' } as const;
  }
  const accessCode = env.AIRA_STAR_TRIAL_ACCESS_CODE?.trim() || '';
  if (accessCode.length < 40 || accessCode.length > 200) {
    return { enabled: false, reason: 'ACCESS_CODE_NOT_CONFIGURED' } as const;
  }
  if (!env.AIRA_STAR_TRIAL_ALLOWED_USER_IDS?.trim()) {
    return { enabled: false, reason: 'ALLOWLIST_NOT_CONFIGURED' } as const;
  }
  if (exhaustedInThisInstance) {
    return { enabled: false, reason: 'UPSTREAM_QUOTA_EXHAUSTED' } as const;
  }
  return { enabled: true, reason: 'READY' } as const;
}

function allowedUserId(req: Request): string | null {
  // BFF verified identity ONLY. Guest cookies, x-test-user-id, and client headers are insufficient.
  const managed = (req as any).managedIdentity as { userId?: string } | undefined;
  const id = managed?.userId;
  // BFF middleware already verified this identity; the trial router mounts before
  // the unrelated global principal middleware to support isolated access-code mode.
  if (!id) return null;
  const allowlist = (process.env.AIRA_STAR_TRIAL_ALLOWED_USER_IDS || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  return allowlist.includes(id) ? id : null;
}

function validTrialAccessCode(req: Request): boolean {
  const supplied = req.headers['x-aira-trial-access-code'];
  const expected = process.env.AIRA_STAR_TRIAL_ACCESS_CODE?.trim() || '';
  if (typeof supplied !== 'string' || supplied.length < 40 || supplied.length > 200 || expected.length < 40) return false;
  // Fixed-width digests and constant-time comparison; never print either value.
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function isTrialBranch(): boolean {
  return process.env.VERCEL_ENV === 'preview' &&
    process.env.VERCEL_GIT_COMMIT_REF === AI_STAR_TRIAL_BRANCH;
}

function mightBeExhausted(status: number, body: string): boolean {
  if (status === 402) return true;
  if (status !== 403 && status !== 429) return false;
  return /(?:insufficient[_ -]?quota|quota[_ -]?exceeded|trial[_ -]?expired|balance[_ -]?(?:exhausted|insufficient)|credits?[_ -]?exhausted)/i.test(body);
}

export function createAiStaringTrialRouter(): Router {
  const router = Router();

  // The route does not exist outside the experiment branch.
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, private');
    if (!isTrialBranch()) return res.status(404).json({ code: 'NOT_FOUND' });
    const user = allowedUserId(req);
    const codeAuthorized = validTrialAccessCode(req);
    if (!user && !codeAuthorized) return res.status(401).json({ code: 'TRIAL_ACCESS_REQUIRED' });
    // An isolated test credential is intentionally accepted only on this exact
    // expiring Preview branch. Normal AIRA auth, users and billing are untouched.
    res.locals.trialOwnerId = user || 'ephemeral-trial-access';
    next();
  });

  router.get('/status', (_req, res) => {
    const config = getTrialConfiguration();
    res.status(200).json({
      enabled: config.enabled,
      reason: config.reason,
      expiry: process.env.AIRA_STAR_TRIAL_EXPIRES_AT || null,
      models: AI_STAR_TRIAL_MODELS,
      maxPromptLength: MAX_PROMPT_LENGTH,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      note: 'Preview-only diagnostic. Model identity and provider billing are not independently verified.'
    });
  });

  router.post('/complete', async (req, res) => {
    const config = getTrialConfiguration();
    if (!config.enabled) return res.status(503).json({ code: 'TRIAL_DISABLED', reason: config.reason });

    const model = req.body?.model;
    const prompt = req.body?.prompt;
    if (typeof model !== 'string' || !(AI_STAR_TRIAL_MODELS as readonly string[]).includes(model)) {
      return res.status(400).json({ code: 'TRIAL_MODEL_NOT_ALLOWED' });
    }
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ code: 'TRIAL_INVALID_PROMPT' });
    }

    const user = res.locals.trialOwnerId as string;
    const now = Date.now();
    const prior = lastRequestAt.get(user) || 0;
    if (now - prior < MIN_INTERVAL_MS) {
      res.setHeader('Retry-After', String(Math.ceil((MIN_INTERVAL_MS - (now - prior)) / 1000)));
      return res.status(429).json({ code: 'TRIAL_COOLDOWN' });
    }
    lastRequestAt.set(user, now);

    const started = performance.now();
    try {
      // Do not proxy arbitrary URLs, tools, system prompts, attachments, or model IDs.
      const upstream = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.AIRA_STAR_TRIAL_API_KEY!.trim(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt.trim() }],
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: false
        }),
        signal: AbortSignal.timeout(30_000)
      });

      if (!upstream.ok) {
        // Read only enough to detect exhaustion. Never relay raw provider errors, keys or URLs.
        const body = (await upstream.text()).slice(0, 2048);
        if (mightBeExhausted(upstream.status, body)) {
          exhaustedInThisInstance = true;
          return res.status(503).json({ code: 'TRIAL_QUOTA_EXHAUSTED' });
        }
        return res.status(502).json({ code: 'TRIAL_UPSTREAM_FAILED', upstreamStatus: upstream.status });
      }

      const data: any = await upstream.json();
      const answer = data?.choices?.[0]?.message?.content;
      if (typeof answer !== 'string' || !answer.trim()) {
        return res.status(502).json({ code: 'TRIAL_EMPTY_RESPONSE' });
      }
      const usage = data?.usage || {};
      const asNonnegative = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      return res.status(200).json({
        modelRequested: model,
        modelReported: typeof data.model === 'string' ? data.model : null,
        answer: answer.slice(0, 16_000),
        latencyMs: Math.round(performance.now() - started),
        usage: {
          promptTokens: asNonnegative(usage.prompt_tokens),
          completionTokens: asNonnegative(usage.completion_tokens),
          totalTokens: asNonnegative(usage.total_tokens)
        }
      });
    } catch (error) {
      // Do not log the request, credential, prompt, upstream response, or exception body.
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      return res.status(timeout ? 504 : 502).json({ code: timeout ? 'TRIAL_TIMEOUT' : 'TRIAL_NETWORK_FAILURE' });
    }
  });

  return router;
}
