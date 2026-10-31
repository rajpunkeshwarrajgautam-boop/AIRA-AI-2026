import { createBuilderRoutes } from './builder-routes.js';
import { createBillingRoutes } from './billing-routes.js';
import { createVisionRoutes } from './vision-routes.js';
import { createAccountRoutes } from './account-routes.js';
import { commercialBillingService } from './billing/commercial-billing-service.js';
import { paymentGatewayService, TOPUP_PACKS } from './billing/payment-gateway-service.js';
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { normalizeModelIdentifier, UnsupportedModelIdentifierError, COMMERCIAL_PLANS } from '../../../packages/contracts/src/index.js';
import {
  ModelRouter,
  withInferencePrincipal,
  withInferenceReservation,
  ProviderHealthTracker,
  PrivateBetaCapacityGuard,
  InMemoryCapacityStore,
  DistributedPostgresCapacityStore
} from '../../../packages/model-router/src/index.js';
import { db } from '../../../packages/db/src/index.js';
import { ToolRegistry, ToolGateway, PostgresToolCallRepository, InMemoryToolCallRepository } from '../../../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../../../packages/approvals/src/index.js';
import { PostgresApprovalRepository, PostgresSessionGrantRepository } from '../../../packages/approvals/src/repositories.js';
import { BrainV2KnowledgeEngine, PrincipalScope } from '../../../packages/knowledge/src/index.js';
import { McpHost } from '../../../packages/mcp/src/index.js';
import { AgentRuntime } from '../../../packages/agent-runtime/src/index.js';
import { validateDurableToolScopes } from '../../../packages/agent-runtime/src/durable/tool-authorization.js';
import { validateApiStartupConfiguration } from './startup-config.js';
import { AutomationEngine } from '../../../packages/automation/src/index.js';
import { PostgresAgentRepository, PostgresRunRepository, InMemoryRunRepository } from '../../../packages/agent-runtime/src/repositories.js';
import { PostgresAutomationRepository, PostgresAutomationRunRepository } from '../../../packages/automation/src/repositories.js';
import {
  ConversationSearchRepository,
  ConversationEmbeddingIndexer,
  HybridConversationSearchService,
  createEmbeddingProvider
} from '../../../packages/retrieval/src/index.js';
import {
  Run,
  ModelPolicySchema,
  CreateRunRequestSchema,
  ApprovalDecisionSchema,
  AutomationDefinitionSchema,
  AgentDefinition,
  WorkflowDefinitionSchema,
  validateWorkflowDag,
  TaskDAG,
  TaskDAGSchema,
  validateTaskDAG
} from '../../../packages/contracts/src/index.js';

// -----------------------------------------------------------------------
// Deployment-aware startup assertions. Vercel Preview also has NODE_ENV=production.
// -----------------------------------------------------------------------
const startupConfiguration = validateApiStartupConfiguration(process.env);
for (const warning of startupConfiguration.warnings) {
  process.stderr.write(`[STARTUP_ASSERTION] WARN: ${warning}\n`);
}
if (startupConfiguration.errors.length > 0) {
  for (const error of startupConfiguration.errors) {
    process.stderr.write(`[STARTUP_ASSERTION] FAIL: ${error}\n`);
  }
  process.exit(1);
}

import { createPrincipalMiddleware } from './middleware/principal.js';
function getParam(param: string | string[] | undefined): string {
  if (Array.isArray(param)) return param[0] || '';
  return param || '';
}

import { createStagingMaintenanceMiddleware } from './middleware/staging-maintenance.js';
import { createSessionAuthMiddleware, ensureAuthenticatedSession } from './auth/session-auth.js';
import { createNeonAuthPrincipalMiddleware } from './auth/neon-auth-principal.js';
import {
  createBffSessionMiddleware,
  createCsrfProtectionMiddleware,
  handleBffSignUp,
  handleBffSignIn,
  handleBffOAuthExchange,
  handleBffOAuthGoogleStart,
  handleBffOAuthGoogleCallback,
  handleBffOAuthGithubStart,
  handleBffOAuthGithubCallback,
  handleBffOAuthLinkStart,
  handleBffGetProviders,
  handleBffUnlinkProvider,
  handleBffRecoveryRequest,
  handleBffRecoveryGuidance,
  handleBffSession,
  handleBffSignOut,
  isAllowedOrigin
} from './auth/bff-session.js';
import { isTemporaryDatabaseError } from './utils/storage-errors.js';
import {
  durableIdempotencyManager,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyUncertainOutcomeError,
  IdempotencyDatabaseError
} from './utils/idempotency.js';

export class UntrustedOriginError extends Error {
  readonly status = 403;
  readonly code = 'CORS_ORIGIN_DENIED';
  readonly origin: string;

  constructor(origin: string) {
    super('Origin not allowed');
    this.name = 'UntrustedOriginError';
    this.origin = origin;
  }
}

import { sanitizeUrlForLogging } from './utils/sanitize-url.js';
export { sanitizeUrlForLogging };

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

// Audit 28: Body size limits and strict CORS with credentials
app.use((req: Request, res: Response, next: NextFunction) => {
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = typeof forwardedHost === 'string'
    ? forwardedHost.split(',')[0].trim()
    : req.headers.host;

  cors({
    origin: (origin, callback) => {
      // Allow non-browser callers (curl, internal server requests) where origin is not set
      if (!origin) return callback(null, true);
      if (isAllowedOrigin(origin, host)) {
        return callback(null, true);
      }
      return callback(new UntrustedOriginError(origin), false);
    },
    credentials: true
  })(req, res, next);
});

// Dedicated CORS origin rejection error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof UntrustedOriginError || err?.code === 'CORS_ORIGIN_DENIED' || err?.name === 'UntrustedOriginError') {
    const rawOrigin = typeof err.origin === 'string' ? err.origin : (req.headers.origin as string) || 'unknown';
    const sanitizedOrigin = rawOrigin.slice(0, 200).replace(/[\r\n\t]/g, '');
    const sanitizedRoute = sanitizeUrlForLogging(req.originalUrl || req.url || 'unknown').slice(0, 200).replace(/[\r\n\t]/g, '');
    
    process.stdout.write(
      `[SECURITY_EVENT] event=cors_origin_rejected origin=${sanitizedOrigin} route=${sanitizedRoute} status=403\n`
    );
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('access-control-allow-origin');
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }
  next(err);
});
app.use(express.json({
  limit: '2mb',
  verify: (req: any, _res: any, buf: Buffer) => {
    req.rawBody = buf.toString('utf8');
  }
}));
app.use(express.urlencoded({ limit: '2mb', extended: false }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  process.stdout.write(`[API_REQ] ${req.method} ${sanitizeUrlForLogging(req.url)}\n`);
  next();
});

// Staging maintenance barrier: blocks mutating requests during PR #96 cutover
app.use(createStagingMaintenanceMiddleware());

// Resolve a trusted first-party session cookie before principal enforcement.
// This middleware never trusts client-supplied user/session headers in production.
app.use(createSessionAuthMiddleware());
// Staging opt-in: verified Neon Auth bearer identity overrides browser-local
// guest sessions only after cryptographic signature verification.
app.use(createNeonAuthPrincipalMiddleware());
// First-party BFF gateway: resolves secure HttpOnly cookie sessions into verified ExecutionPrincipals
app.use(createBffSessionMiddleware());
// Cryptographic CSRF and origin protection on mutating endpoints
app.use(createCsrfProtectionMiddleware());

// First-party BFF authentication routes
app.post('/api/auth/sign-in', (req: Request, res: Response) => {
  handleBffSignIn(req, res).catch((err) => {
    res.status(500).json({ error: err.message || 'BFF sign in failed' });
  });
});
app.post('/api/auth/sign-up', (req: Request, res: Response) => {
  handleBffSignUp(req, res).catch((err) => {
    res.status(500).json({ error: err.message || 'BFF sign up failed' });
  });
});
app.post('/api/auth/oauth-exchange', (req: Request, res: Response) => {
  handleBffOAuthExchange(req, res).catch((err) => {
    res.status(500).json({ error: err.message || 'BFF OAuth exchange failed' });
  });
});
app.post('/api/auth/oauth/google/start', (req: Request, res: Response) => {
  handleBffOAuthGoogleStart(req, res).catch((err) => {
    res.status(500).json({ error: err.message || 'OAuth start failed' });
  });
});
app.get('/api/auth/oauth/google/start', (req: Request, res: Response) => {
  handleBffOAuthGoogleStart(req, res).catch((err) => {
    res.status(500).json({ error: err.message || 'OAuth start failed' });
  });
});
app.get('/api/auth/oauth/google/callback', (req: Request, res: Response) => {
  handleBffOAuthGoogleCallback(req, res).catch((err) => {
    res.status(500).json({ error: err.message || 'OAuth callback failed' });
  });
});
// GitHub uses the same verified BFF exchange with provider-bound flow state.
app.post('/api/auth/oauth/github/start', (req: Request, res: Response) => {
  handleBffOAuthGithubStart(req, res).catch(() => {
    res.status(502).json({ error: 'GitHub OAuth start failed' });
  });
});
app.get('/api/auth/oauth/github/start', (req: Request, res: Response) => {
  handleBffOAuthGithubStart(req, res).catch(() => {
    res.status(502).json({ error: 'GitHub OAuth start failed' });
  });
});
app.get('/api/auth/oauth/github/callback', (req: Request, res: Response) => {
  handleBffOAuthGithubCallback(req, res).catch(() => {
    res.status(502).json({ error: 'GitHub OAuth callback failed' });
  });
});
// Account Linking endpoints (authenticated user initiates linking of secondary provider)
app.get('/api/auth/oauth/google/link', (req: Request, res: Response) => {
  handleBffOAuthLinkStart(req, res, 'google').catch((err) => {
    res.status(500).json({ error: err.message || 'OAuth linking start failed' });
  });
});
app.get('/api/auth/oauth/github/link', (req: Request, res: Response) => {
  handleBffOAuthLinkStart(req, res, 'github').catch((err) => {
    res.status(500).json({ error: err.message || 'OAuth linking start failed' });
  });
});
// Linked providers listing & unlinking
app.get('/api/auth/providers', (req: Request, res: Response) => {
  handleBffGetProviders(req, res).catch((err) => {
    res.status(500).json({ error: err.message || 'Failed to get providers' });
  });
});
app.post('/api/auth/providers/:provider/unlink', (req: Request, res: Response) => {
  handleBffUnlinkProvider(req, res).catch((err) => {
    res.status(500).json({ error: err.message || 'Failed to unlink provider' });
  });
});
// Account recovery guidance & audited support requests
app.get('/api/auth/recovery/guidance', (req: Request, res: Response) => {
  handleBffRecoveryGuidance(req, res).catch((err) => {
    res.status(500).json({ error: err.message || 'Failed to get recovery guidance' });
  });
});
app.post('/api/auth/recovery/request', (req: Request, res: Response) => {
  handleBffRecoveryRequest(req, res).catch((err) => {
    res.status(500).json({ error: err.message || 'Failed to submit recovery request' });
  });
});
app.get('/api/auth/session', handleBffSession);
app.post('/api/auth/sign-out', (req: Request, res: Response) => {
  handleBffSignOut(req, res).catch((err) => {
    res.status(500).json({ error: err.message || 'BFF sign out failed' });
  });
});

// Authoritative deployment identity endpoint for Preview and Release certification
const versionHandler = (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || process.env.COMMIT_SHA || 'unknown',
    deploymentUrl: process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'unknown',
    environment: process.env.NODE_ENV || 'production'
  });
};
app.get('/api/version', versionHandler);
app.get('/version', versionHandler);

// Public bootstrap endpoint used by the browser before protected API calls.
// It issues or refreshes an opaque, signed, HttpOnly session cookie.
app.post('/api/auth/session', (req: Request, res: Response) => {
  try {
    const session = ensureAuthenticatedSession(req, res);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ status: 'AUTHENTICATED', ...session });
  } catch (error: any) {
    res.status(500).json({
      error: 'Session initialization failed',
      message: error?.message || 'Unable to initialize an authenticated session',
    });
  }
});

// Staging-only identity probe. Requires a valid Neon Auth JWT; signed guest
// browser cookies do not count as a durable account identity.
app.get('/api/auth/identity', (req: Request, res: Response) => {
  const verified = (req as any).managedIdentity as { userId: string; sessionId: string; provider: string; email?: string; name?: string } | undefined;
  res.setHeader('Cache-Control', 'no-store');
  if (!verified) return res.status(401).json({ error: 'Verified managed account required' });
  return res.status(200).json({
    status: 'AUTHENTICATED',
    userId: verified.userId,
    provider: verified.provider,
    email: verified.email,
    name: verified.name
  });
});

app.post('/api/auth/link-guest', async (req: Request, res: Response) => {
  try {
    const verified = (req as any).managedIdentity as { userId: string } | undefined;
    if (!verified || !verified.userId) {
      return res.status(401).json({ error: 'Verified managed account required to link data' });
    }

    // Security requirement: Must verify the existing server-signed guest session cookie.
    // Client-provided IDs in the request body are strictly rejected to prevent cross-account theft.
    if (req.body?.guestUserId && req.body.guestUserId !== (req as any).guestSession?.id) {
      return res.status(400).json({ error: 'Forbidden: unverified client-provided guestUserId is rejected' });
    }

    const candidateGuest = (req as any).guestSession?.id as string | undefined;

    if (!candidateGuest || candidateGuest === verified.userId) {
      return res.status(400).json({ error: 'No verifiable active guest session found to link' });
    }

    if (!candidateGuest.startsWith('usr_') && !candidateGuest.startsWith('user_')) {
      return res.status(400).json({ error: 'Only guest sessions may be linked to accounts' });
    }

    const result = await conversationSearchRepo.transferGuestData(candidateGuest, verified.userId);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Guest linking failed' });
  }
});

// -----------------------------------------------------------------------
// PUBLIC INFRASTRUCTURE PROBES — Registered BEFORE principal middleware.
// Health and readiness endpoints must never require authenticated identity.
// They are liveness/readiness signals consumed by orchestrators and proxies.
// -----------------------------------------------------------------------
let appState: 'STARTING' | 'RECOVERING' | 'HEALTHY' | 'FAILED' = 'STARTING';

app.get('/api/health', (_req: Request, res: Response) => {
  const providers = modelRouter.listProviders();
  res.json({
    status: 'HEALTHY',
    appState,
    subsystems: {
      modelRouter: `ONLINE (${providers.length} provider(s): ${providers.join(', ') || 'none — mock-dev only'})`,
      toolRuntime: 'ONLINE',
      toolGateway: 'ONLINE',
      approvalKernel: 'ONLINE',
      mcpHost: 'ONLINE',
      knowledgeEngine: 'ONLINE',
      agentRuntime: 'ONLINE',
      automationEngine: 'ONLINE',
      capabilityRegistry: 'ONLINE',
      intentRouter: 'ONLINE',
      workflowEngine: 'ONLINE',
      conversationSearch: 'ONLINE'
    },
    productionMockFallback: providers.length === 0 ? 'ACTIVE (dev/test only)' : 'DISABLED',
    version: '2026.2.0',
    timestamp: Date.now()
  });
});

// Instantiate ModelRouter early for health, circuit breakers, and private beta capacity
const isDbConfiguredEarly = Boolean(process.env.DATABASE_URL?.trim());
const capacityStore = isDbConfiguredEarly
  ? new DistributedPostgresCapacityStore(db)
  : (process.env.VERCEL || process.env.NODE_ENV === 'production')
    ? new DistributedPostgresCapacityStore(db)
    : new InMemoryCapacityStore();
const healthTracker = new ProviderHealthTracker();
const capacityGuard = new PrivateBetaCapacityGuard(undefined, capacityStore, healthTracker);
const modelRouter = new ModelRouter(healthTracker, capacityGuard);

app.get('/api/ready', (_req: Request, res: Response) => {
  if (appState === 'HEALTHY') {
    res.status(200).json({ status: 'READY', timestamp: Date.now() });
  } else {
    res.status(503).json({ status: appState, timestamp: Date.now() });
  }
});

app.get('/api/ready/providers', async (_req: Request, res: Response) => {
  const fastRoute = modelRouter.routingPolicy.resolveFastRoute();
  const result: Record<string, any> = {
    supportedProviders: {
      groq: { configured: Boolean(process.env.GROQ_API_KEY) },
      gemini: { configured: Boolean(process.env.GEMINI_API_KEY) },
      nvidia: { configured: Boolean(process.env.NVIDIA_API_KEY), deepModel: 'nvidia/nemotron-3-super-120b-a12b' },
      cerebras: { configured: Boolean(process.env.CEREBRAS_API_KEY) },
      together: { configured: Boolean(process.env.TOGETHER_API_KEY) },
      fireworks: { configured: Boolean(process.env.FIREWORKS_API_KEY) },
      openai: { configured: Boolean(process.env.OPENAI_API_KEY) },
      anthropic: { configured: Boolean(process.env.ANTHROPIC_API_KEY) }
    },
    fastRouting: fastRoute,
    circuitBreakers: modelRouter.healthTracker.getAllTelemetry(),
    capacity: {
      guardEnabled: modelRouter.capacityGuard.isEnabled(),
      isDegraded: fastRoute.isDegraded
    }
  };
  if (process.env.GROQ_API_KEY) {
    try {
      const groqKey = process.env.GROQ_API_KEY.trim().replace(/^["']|["']$/g, '');
      const resp = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${groqKey}` }
      });
      const data: any = await resp.json().catch(() => ({}));
      result.groq = {
        status: resp.status,
        models: Array.isArray(data.data) ? data.data.map((m: any) => m.id) : [],
        error: !resp.ok ? data : undefined
      };
    } catch (e: any) {
      result.groq = { error: e.message };
    }
  } else {
    result.groq = { configured: false };
  }
  if (process.env.GEMINI_API_KEY) {
    try {
      const geminiKey = process.env.GEMINI_API_KEY.trim().replace(/^["']|["']$/g, '');
      const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': geminiKey }
      });
      const data: any = await resp.json().catch(() => ({}));
      const rawModels: any[] = Array.isArray(data.models) ? data.models : [];
      result.gemini = {
        status: resp.status,
        models: rawModels.map(m => m.name.replace(/^models\//, '')),
        details: rawModels.map(m => ({
          name: m.name.replace(/^models\//, ''),
          displayName: m.displayName,
          supportedGenerationMethods: m.supportedGenerationMethods,
          inputTokenLimit: m.inputTokenLimit,
          outputTokenLimit: m.outputTokenLimit
        }))
      };
    } catch (e: any) {
      result.gemini = { error: e.message };
    }
  } else {
    result.gemini = { configured: false };
  }
  res.json(result);
});

// Hard gate to block runtime traffic before recovery is complete
app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
  if (appState !== 'HEALTHY') {
    return res.status(503).json({ error: 'Service Unavailable: Runtime is ' + appState });
  }
  next();
});

// -----------------------------------------------------------------------
// PUBLIC WEBHOOKS — Gateway raw-body cryptographic HMAC endpoints
// -----------------------------------------------------------------------
app.post('/api/billing/webhook/razorpay', async (req: Request, res: Response) => {
  const signature = req.headers['x-razorpay-signature'] as string;
  const rawBody = typeof (req as any).rawBody === 'string'
    ? (req as any).rawBody
    : JSON.stringify(req.body);

  try {
    const result = await paymentGatewayService.processRazorpayWebhook(rawBody, signature);
    res.status(200).json({ ok: true, ...result });
  } catch (err: any) {
    console.error('[RazorpayWebhookError]', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/billing/webhook/cashfree', async (req: Request, res: Response) => {
  const signature = req.headers['x-webhook-signature'] as string;
  const timestamp = req.headers['x-webhook-timestamp'] as string;
  const rawBody = typeof (req as any).rawBody === 'string'
    ? (req as any).rawBody
    : JSON.stringify(req.body);

  try {
    const result = await paymentGatewayService.processCashfreeWebhook(rawBody, signature, timestamp);
    res.status(200).json({ ok: true, ...result });
  } catch (err: any) {
    console.error('[CashfreeWebhookError]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Public commercial plan definitions and pricing catalog (accessible to guests and landing pages)
app.get('/api/billing/plans', (_req: Request, res: Response) => {
  res.json({
    plans: Object.values(COMMERCIAL_PLANS),
    topupPacks: Object.values(TOPUP_PACKS)
  });
});

// Enforce ExecutionPrincipal on all /api routes BELOW this point.
// Routes registered above (health, ready, webhooks, plans) are public infrastructure probes, catalogs, or signature verified.
app.use('/api', createPrincipalMiddleware());
app.use('/api', (req, _res, next) => withInferencePrincipal(req.principal!.userId, next));

// -----------------------------------------------------------------------
// COMMERCIAL PLATFORM ROUTERS
// -----------------------------------------------------------------------
app.use('/api/billing', createBillingRoutes());
app.use('/api/vision', createVisionRoutes());
app.use('/api/account', createAccountRoutes());
app.use('/api/builder', createBuilderRoutes(modelRouter));

// Inference diagnostics are operator actions, not public readiness probes.
const benchmarkSignal = Symbol('benchmarkSignal');
async function admitBenchmark(req: Request, res: Response, next: NextFunction) {
  const principal = req.principal!;
  const roles = principal.roles || [];
  const isAuthorized = roles.includes('admin') || roles.includes('operator');
  if (!isAuthorized) {
    res.status(403).json({ code: 'OPERATOR_REQUIRED', error: 'Operator authorization required.' });
    return;
  }
  const expected = req.path.endsWith('benchmark-groq') ? 'openai/gpt-oss-120b' : 'gemini-3.5-flash-lite';
  if (req.body?.model !== expected || typeof req.body?.prompt !== 'string') {
    res.status(400).json({ code: 'UNSUPPORTED_MODEL_IDENTIFIER', error: 'Unsupported benchmark model or prompt.' });
    return;
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
  (req as any)[benchmarkSignal] = signal;
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const admission = await modelRouter.capacityGuard.admit({ principalId: principal.userId, model: 'aira-fast', promptText: req.body.prompt, abortSignal: signal });
    if (admission.decision !== 'ADMIT_NOW') {
      res.setHeader('Retry-After', String(admission.retryAfterSeconds || 8));
      res.status(429).json({ code: admission.rejectionCode, error: admission.userMessage });
      return;
    }
    const release = () => { void admission.permit?.release().catch(() => {}); };
    res.once('finish', release);
    res.once('close', release);
    withInferenceReservation(modelRouter.capacityGuard, admission, next);
  } catch {
    res.status(503).json({ code: 'AIRA_PRIVATE_BETA_CAPACITY', error: 'Inference capacity unavailable.' });
  }
}

app.post('/api/ready/benchmark-groq', admitBenchmark, async (req: Request, res: Response) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: 'GROQ_API_KEY not configured' });
  }
  const { model, prompt, max_tokens, temperature } = req.body || {};
  if (!model || !prompt) {
    return res.status(400).json({ error: 'model and prompt required' });
  }

  const groqKey = process.env.GROQ_API_KEY.trim().replace(/^["']|["']$/g, '');
  const t0 = performance.now();
  let ttfb = 0;
  let firstDelta: number | null = null;
  let firstThinking: number | null = null;
  let contentDeltaCount = 0;
  let thinkingDeltaCount = 0;
  let text = '';
  let thinking = '';
  let providerModel: string | undefined;

  try {
    const upstreamRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: (req as any)[benchmarkSignal],
      headers: {
        Authorization: `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: max_tokens || 256,
        temperature: temperature !== undefined ? temperature : 0.7,
        stream: true
      })
    });

    ttfb = performance.now() - t0;
    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text();
      return res.status(upstreamRes.status).json({
        success: false,
        status: upstreamRes.status,
        ttfbMs: Math.round(ttfb),
        error: errBody
      });
    }

    const reader = upstreamRes.body?.getReader();
    if (!reader) throw new Error('No body stream from Groq');
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = performance.now();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (dataStr === '[DONE]') break;
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.model && !providerModel) providerModel = parsed.model;
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            if (firstDelta === null) firstDelta = now - t0;
            contentDeltaCount++;
            text += delta.content;
          }
          if (delta?.reasoning_content) {
            if (firstThinking === null) firstThinking = now - t0;
            thinkingDeltaCount++;
            thinking += delta.reasoning_content;
          }
        } catch {}
      }
    }

    const total = performance.now() - t0;
    res.json({
      success: true,
      model,
      providerModel,
      ttfbMs: Math.round(ttfb),
      ttftMs: firstDelta !== null ? Math.round(firstDelta) : null,
      firstThinkingMs: firstThinking !== null ? Math.round(firstThinking) : null,
      totalDurationMs: Math.round(total),
      contentDeltaCount,
      thinkingDeltaCount,
      text: text.trim(),
      thinking: thinking ? thinking.slice(0, 200) : undefined
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ready/benchmark-gemini', admitBenchmark, async (req: Request, res: Response) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
  }
  const { model, prompt, max_tokens, temperature } = req.body || {};
  if (!model || !prompt) {
    return res.status(400).json({ error: 'model and prompt required' });
  }

  const geminiKey = process.env.GEMINI_API_KEY.trim().replace(/^["']|["']$/g, '');
  const cleanModel = model.replace(/^models\//, '');
  const t0 = performance.now();
  let ttfb = 0;
  let firstDelta: number | null = null;
  let firstThinking: number | null = null;
  let contentDeltaCount = 0;
  let thinkingDeltaCount = 0;
  let text = '';
  let thinking = '';
  let usage: any = null;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:streamGenerateContent?alt=sse`;
    const upstreamRes = await fetch(url, {
      method: 'POST',
      signal: (req as any)[benchmarkSignal],
      headers: {
        'x-goog-api-key': geminiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: temperature !== undefined ? temperature : 0.7,
          maxOutputTokens: max_tokens || 256
        }
      })
    });

    ttfb = performance.now() - t0;
    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text();
      const sanitized = errBody.replaceAll(geminiKey, '[REDACTED]');
      return res.status(upstreamRes.status).json({
        success: false,
        status: upstreamRes.status,
        ttfbMs: Math.round(ttfb),
        error: sanitized
      });
    }

    const reader = upstreamRes.body?.getReader();
    if (!reader) throw new Error('No body stream from Gemini');
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(jsonStr);
          const candidate = parsed.candidates?.[0];
          if (parsed.usageMetadata) {
            usage = parsed.usageMetadata;
          }
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (part.thought) {
                if (firstThinking === null) {
                  firstThinking = performance.now() - t0;
                }
                thinkingDeltaCount++;
                thinking += part.text || '';
              } else if (part.text) {
                if (firstDelta === null) {
                  firstDelta = performance.now() - t0;
                }
                contentDeltaCount++;
                text += part.text;
              }
            }
          }
        } catch {
          // ignore SSE JSON boundary chunks
        }
      }
    }

    const total = performance.now() - t0;
    res.json({
      success: true,
      status: 200,
      model: cleanModel,
      providerModel: cleanModel,
      ttfbMs: Math.round(ttfb),
      ttftMs: firstDelta !== null ? Math.round(firstDelta) : null,
      firstThinkingMs: firstThinking !== null ? Math.round(firstThinking) : null,
      totalDurationMs: Math.round(total),
      contentDeltaCount,
      thinkingDeltaCount,
      text: text.trim(),
      thinking: thinking ? thinking.slice(0, 200) : undefined,
      usage
    });
  } catch (err: any) {
    const sanitized = err.message ? err.message.replaceAll(geminiKey, '[REDACTED]') : 'Unknown error';
    res.status(500).json({ success: false, error: sanitized });
  }
});

// Protected internal capacity diagnostics endpoint (Admin/Operator only)
app.get('/api/capacity/status', async (req: Request, res: Response) => {
  const principal = req.principal;
  if (!principal) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  }

  const roles = principal.roles || [];
  const scopes = principal.scopes || [];
  const isAuthorized =
    roles.includes('admin') ||
    roles.includes('operator') ||
    scopes.includes('admin') ||
    scopes.includes('operator') ||
    principal.userId === 'admin';

  if (!isAuthorized) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Admin or operator authorization required for internal capacity diagnostics'
    });
  }

  const diagnostics = await modelRouter.capacityGuard.getDiagnostics();
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(diagnostics);
});

// Initialize Core Subsystems
app.use('/api/user', createAccountRoutes());
const isDbConfigured = Boolean(process.env.DATABASE_URL?.trim());
const toolRegistry = new ToolRegistry(process.cwd());
const approvalKernel = new ApprovalKernel(new PostgresApprovalRepository(), new PostgresSessionGrantRepository());
const toolCallRepo = isDbConfigured ? new PostgresToolCallRepository() : new InMemoryToolCallRepository();
const toolGateway = new ToolGateway(toolCallRepo, approvalKernel, process.cwd());
const knowledgeEngine = new BrainV2KnowledgeEngine(undefined, { seedDefaults: !process.env.VERCEL });
const mcpHost = new McpHost(toolGateway);
const agentRepo = new PostgresAgentRepository();
const runRepo = isDbConfigured ? new PostgresRunRepository() : new InMemoryRunRepository();
const autoRepo = new PostgresAutomationRepository();
const autoRunRepo = new PostgresAutomationRunRepository();
const conversationSearchRepo = new ConversationSearchRepository();
const conversationEmbeddingProvider = createEmbeddingProvider();
const conversationEmbeddingIndexer = new ConversationEmbeddingIndexer(conversationSearchRepo, conversationEmbeddingProvider);
const conversationHybridSearch = new HybridConversationSearchService(conversationSearchRepo, conversationEmbeddingProvider);

const agentRuntime = new AgentRuntime(
  modelRouter,
  toolRegistry,
  approvalKernel,
  knowledgeEngine,
  runRepo,
  process.cwd(),
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  toolGateway
);
const automationEngine = new AutomationEngine(agentRuntime, autoRepo, autoRunRepo);
agentRuntime.setAutomationEngine(automationEngine);
if (isDbConfigured) {
  automationEngine.start();
}

// Recovery is deferred until the HTTP server is bound.

// Seed default agent if not exists (process singleton)
let hasSeededAgent = false;
async function seedDefaultAgent() {
  if (hasSeededAgent) return;
  hasSeededAgent = true;
  const existing = await agentRepo.getAgent('agent-default');
  if (!existing) {
    await agentRepo.saveAgent({
      id: 'agent-default',
      name: 'Default Agent',
      description: 'Aira default agent for verified reasoning.',
      instructions: 'You are Aira AI, an autonomous intelligence operating workspace. Maintain precise, verified reasoning.',
      modelPolicy: ModelPolicySchema.parse({ model: 'mock-deterministic' }),
      tools: [] as string[],
      memoryScopes: ['workspace'],
      approvalPolicy: 'autonomous',
      maxSteps: 10,
      timeoutMs: 60000,
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as AgentDefinition);
  }
}

let hasSeededAutomation = false;
async function seedDefaultAutomation() {
  if (hasSeededAutomation) return;
  hasSeededAutomation = true;
  const existing = await autoRepo.listAutomations();
  if (existing.length === 0) {
    await autoRepo.saveAutomation({
      id: 'auto_default',
      name: 'System Health Check & Knowledge Refresh',
      enabled: false,
      trigger: 'CRON',
      cronExpression: '0 0 * * *',
      conditions: {},
      agentId: 'agent_sys_monitor',
      objective: 'Audit workspace telemetry, check MCP node freshness, and report health metrics.',
      approvalPolicy: 'autonomous',
      lastRun: 0
    });
  }
}

async function seedDefaultsIdempotent() {
  if (hasSeededAgent && hasSeededAutomation) {
    console.log('[Bootstrap] guestBootstrapSkipped=true');
    return;
  }
  const t0 = performance.now();
  try {
    await seedDefaultAgent();
    await seedDefaultAutomation();
    const guestBootstrapMs = Math.round(performance.now() - t0);
    console.log(`[Bootstrap] guestBootstrapExecuted=true guestBootstrapMs=${guestBootstrapMs}`);
  } catch (err) {
    console.warn('[Bootstrap] Non-fatal default seed notice:', err);
  }
}

if (isDbConfigured && !process.env.VERCEL) {
  void seedDefaultsIdempotent();
}

// -----------------------------------------------------------------------
// MCP Servers (protected — requires ExecutionPrincipal)
// -----------------------------------------------------------------------
app.get('/api/mcp/servers', (_req: Request, res: Response) => {
  res.json(mcpHost.listServers());
});

// -----------------------------------------------------------------------
// Server-Authoritative Capability Registry
// -----------------------------------------------------------------------
app.get('/api/capabilities', (_req: Request, res: Response) => {
  res.json({
    capabilities: agentRuntime.getCapabilityRegistry().list()
  });
});

// -----------------------------------------------------------------------
// Durable Conversations + Hybrid Search Foundation
// -----------------------------------------------------------------------
app.post('/api/conversations/sync', async (req: Request, res: Response) => {
  try {
    console.log(`[API_CONV_SYNC] principalId: ${req.principal?.userId} hasAuth: ${!!req.headers.authorization}`);
    const body = req.body || {};
    if (body.principalId && body.principalId !== req.principal!.userId) {
      return res.status(400).json({ error: 'Forbidden: caller may not specify or forge principalId ownership' });
    }
    if (body.userId && body.userId !== req.principal!.userId) {
      return res.status(400).json({ error: 'Forbidden: caller may not specify or forge userId ownership' });
    }
    if (!body.id || !body.title || !Number.isFinite(Number(body.createdAt)) || !Number.isFinite(Number(body.updatedAt))) {
      return res.status(400).json({ error: 'id, title, createdAt and updatedAt are required.' });
    }

    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    if (rawMessages.length > 1000) {
      return res.status(413).json({ error: 'Conversation sync exceeds the 1000-message safety limit.' });
    }

    await conversationSearchRepo.syncConversation(req.principal!.userId, {
      id: String(body.id),
      title: String(body.title),
      projectId: body.projectId ? String(body.projectId) : undefined,
      isPinned: Boolean(body.isPinned),
      createdAt: Number(body.createdAt),
      updatedAt: Number(body.updatedAt),
      messages: rawMessages.map((message: any) => ({
        id: String(message.id || ''),
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || ''),
        createdAt: Number(message.createdAt || message.timestamp || body.updatedAt),
        runId: message.runId ? String(message.runId) : undefined
      }))
    });

    const indexing = await conversationEmbeddingIndexer.indexConversation(
      req.principal!.userId,
      String(body.id),
      64
    );

    res.status(200).json({
      status: 'SYNCED',
      conversationId: String(body.id),
      indexing
    });
  } catch (err: any) {
    if (isTemporaryDatabaseError(err)) {
      res.setHeader('Retry-After', '2');
      return res.status(503).json({
        code: 'CONVERSATION_STORAGE_TEMPORARILY_UNAVAILABLE',
        error: 'Conversation storage is temporarily unavailable. Retry shortly.'
      });
    }
    const status = String(err?.message || '').includes('ownership mismatch') ? 403 : 400;
    res.status(status).json({ error: err?.message || 'Conversation sync failed.' });
  }
});

app.get('/api/conversations', async (req: Request, res: Response) => {
  try {
    console.log(`[API_CONV_GET] principalId: ${req.principal?.userId} hasAuth: ${!!req.headers.authorization}`);
    const conversations = await conversationSearchRepo.listConversations(req.principal!.userId);
    console.log(`[API_CONV_GET] found ${conversations.length} for ${req.principal?.userId}`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ conversations });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to list conversations' });
  }
});

app.get('/api/conversations/:id', async (req: Request, res: Response) => {
  try {
    const conversation = await conversationSearchRepo.getConversation(
      req.principal!.userId,
      getParam(req.params.id)
    );

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({ conversation });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Conversation retrieval failed.' });
  }
});

app.delete('/api/conversations/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await conversationSearchRepo.deleteConversation(req.principal!.userId, getParam(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Conversation not found.' });
    res.status(204).send();
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Conversation deletion failed.' });
  }
});

app.get('/api/search/conversations', async (req: Request, res: Response) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) return res.status(400).json({ error: 'q is required.' });
    if (query.length > 500) return res.status(400).json({ error: 'Search query exceeds 500 characters.' });

    const parsedLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 10;
    const role = req.query.role === 'user' || req.query.role === 'assistant' ? req.query.role : undefined;
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;

    const result = await conversationHybridSearch.search(req.principal!.userId, {
      query,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 10,
      role,
      projectId
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Conversation search failed.' });
  }
});

app.get('/api/search/capabilities', async (_req: Request, res: Response) => {
  try {
    const vector = await conversationSearchRepo.getVectorCapability();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      lexical: 'READY',
      pgvector: vector.ready ? 'READY' : 'NOT_READY',
      embeddingProvider: conversationEmbeddingProvider.isConfigured() ? 'READY' : 'NOT_CONFIGURED',
      hybrid: vector.ready && conversationEmbeddingProvider.isConfigured() ? 'READY' : 'DEGRADED_LEXICAL'
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Search capability inspection failed.' });
  }
});


// -----------------------------------------------------------------------
// Runs Management
// -----------------------------------------------------------------------
function isRunOwnedByPrincipal(
  run: { principalId: string; workspaceId?: string | null },
  principal: { userId: string; workspaceId?: string }
): boolean {
  return run.principalId === principal.userId &&
    (run.workspaceId || undefined) === (principal.workspaceId || undefined);
}

app.post('/api/runs', async (req: Request, res: Response) => {
  try {
    const parsed = CreateRunRequestSchema.parse(req.body);
    const run = await agentRuntime.createAndExecuteRun(parsed, req.principal!);
    res.status(201).json(run);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Invalid run creation payload.' });
  }
});

app.get('/api/runs', async (req: Request, res: Response) => {
  const allRuns = await agentRuntime.listRuns();
  res.json(allRuns.filter(r => isRunOwnedByPrincipal(r, req.principal!)));
});

app.get('/api/runs/:id', async (req: Request, res: Response) => {
  const run = await agentRuntime.getRun(getParam(req.params.id));
  if (!run || !isRunOwnedByPrincipal(run, req.principal!)) {
    return res.status(404).json({ error: `Run with id "${getParam(req.params.id)}" not found.` });
  }

  // If this run has durable specialist tasks, reflect their latest terminal progress
  if (['QUEUED', 'RUNNING'].includes(run.state)) {
    try {
      const specialistRepo = agentRuntime.getSpecialistTaskRepository();
      const tasks = await specialistRepo.listTasksByRun(run.id);
      if (tasks.length > 0) {
        const allCompleted = tasks.every(t => t.state === 'COMPLETED');
        const anyFailed = tasks.some(t => t.state === 'FAILED' || t.state === 'TIMED_OUT' || t.state === 'UNAVAILABLE');
        const anyCancelled = tasks.some(t => t.state === 'CANCELLED');

        if (allCompleted) {
          run.state = 'COMPLETED';
          const finalTask = tasks[tasks.length - 1];
          if (finalTask.resultOutput) {
            run.content = typeof finalTask.resultOutput === 'object'
              ? JSON.stringify(finalTask.resultOutput)
              : String(finalTask.resultOutput);
          }
          await runRepo.saveRun(run);
        } else if (anyFailed) {
          run.state = 'FAILED';
          await runRepo.saveRun(run);
        } else if (anyCancelled) {
          run.state = 'CANCELLED';
          await runRepo.saveRun(run);
        }
      }
    } catch {
      // Non-blocking telemetry reflection
    }
  }

  res.json(run);
});

app.post('/api/runs/:id/cancel', async (req: Request, res: Response) => {
  const run = await agentRuntime.getRun(getParam(req.params.id));
  if (!run || !isRunOwnedByPrincipal(run, req.principal!)) {
    return res.status(404).json({ error: 'Run not found.' });
  }
  const success = await agentRuntime.cancelRun(getParam(req.params.id));
  if (!success) {
    return res.status(400).json({ error: 'Cannot cancel run (either not found or in terminal state).' });
  }
  res.json({ status: 'CANCELLED', runId: getParam(req.params.id) });
});

app.post('/api/runs/:id/approve', async (req: Request, res: Response) => {
  try {
    const { requestId, decision } = req.body;
    const approval = await approvalKernel.getPendingRequest(requestId);
    if (!approval || approval.runId !== getParam(req.params.id)) {
      return res.status(404).json({ error: 'Approval request not found.' });
    }

    const resolverPrincipal = req.principal!;
    const run = await agentRuntime.getRun(approval.runId);
    if (!run || !isRunOwnedByPrincipal(run, resolverPrincipal)) {
      return res.status(404).json({ error: 'Approval request not found.' });
    }

    const parsedDecision = ApprovalDecisionSchema.parse(decision);
    const success = await agentRuntime.submitApproval(
      requestId,
      parsedDecision,
      resolverPrincipal,
      getParam(req.params.id)
    );
    if (!success) {
      return res.status(400).json({ error: 'Could not apply approval decision.' });
    }
    res.json({ status: 'DECISION_RECORDED', decision: parsedDecision });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// Durable Specialist Missions Management (Milestone 2A.1)
// -----------------------------------------------------------------------
app.post('/api/missions', async (req: Request, res: Response) => {
  try {
    const rawDag = req.body?.dag || req.body;
    const validation = validateTaskDAG(rawDag);
    if (!validation.valid) {
      return res.status(400).json({ error: `Invalid task DAG: ${validation.error}` });
    }

    const dag = rawDag as TaskDAG;
    const principal = req.principal;
    if (!principal?.userId || !principal.workspaceId) {
      return res.status(403).json({ error: 'Authenticated principal with an assigned workspace is required for durable missions.' });
    }

    const requestedWorkspaceId = req.body?.workspaceId;
    if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== principal.workspaceId) {
      return res.status(403).json({ error: 'Requested workspace does not match the authenticated principal workspace.' });
    }
    const workspaceId = principal.workspaceId;
    for (const task of dag.tasks) {
      const scopeValidation = validateDurableToolScopes(task.role, task.executionConstraints?.allowedTools || []);
      if (!scopeValidation.valid) {
        return res.status(403).json({ error: scopeValidation.error || 'Durable tool allowlist rejected.' });
      }
    }

    const runId = dag.runId;
    const missionId = req.body?.missionId || dag.dagId || `mission_${runId}`;
    const prompt = req.body?.prompt || `Durable specialist mission: ${dag.dagId}`;

    // A caller may reuse only a parent run owned by that same principal and workspace.
    const existingRun = await agentRuntime.getRun(runId);
    if (existingRun && (
      existingRun.principalId !== principal.userId ||
      existingRun.workspaceId !== workspaceId
    )) {
      return res.status(403).json({ error: 'Run owner or workspace does not match the authenticated principal.' });
    }
    if (existingRun && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(existingRun.state)) {
      return res.status(409).json({ error: 'Durable missions cannot be added to a terminal parent run.' });
    }

    // Ensure parent run row exists in public.runs (foreign key constraint).
    if (!existingRun) {
      const now = Date.now();
      const parentRun: Run = {
        id: runId,
        principalId: principal.userId,
        principalScopes: principal.scopes || [],
        sessionId: principal.sessionId || `sess_${principal.userId}`,
        workspaceId,
        prompt,
        intent: 'TOOL_ACTION',
        state: 'QUEUED',
        modelPolicy: ModelPolicySchema.parse({ model: 'mock-deterministic' }),
        context: {},
        content: '',
        thinking: '',
        toolsUsed: ['calculator'],
        toolCalls: [],
        toolResults: [],
        artifacts: [],
        citations: [],
        stepCount: 0,
        maxSteps: 10,
        createdAt: now,
        updatedAt: now
      };
      if (runRepo.createRunIfAbsent) await runRepo.createRunIfAbsent(parentRun);
      else await runRepo.saveRun(parentRun);
    }

    const verifiedParentRun = await agentRuntime.getRun(runId);
    if (!verifiedParentRun || verifiedParentRun.principalId !== principal.userId || verifiedParentRun.workspaceId !== workspaceId) {
      return res.status(403).json({ error: 'Parent run owner or workspace changed during durable mission admission.' });
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(verifiedParentRun.state)) {
      return res.status(409).json({ error: 'Durable missions cannot be added to a terminal parent run.' });
    }

    // Submit DAG into durable scheduler with server-derived owner/workspace.
    const createdTasks = await agentRuntime.getDurableTaskScheduler().submitDAG(dag, principal, {
      missionId,
      workspaceId
    });

    res.status(201).json({
      status: 'QUEUED',
      state: 'QUEUED',
      missionId,
      runId,
      dagId: dag.dagId,
      tasksCount: createdTasks.length,
      createdAt: Date.now()
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to submit durable mission.' });
  }
});

app.get('/api/missions/:id', async (req: Request, res: Response) => {
  try {
    const id = getParam(req.params.id);
    const specialistRepo = agentRuntime.getSpecialistTaskRepository();
    
    // Search by runId or missionId
    let tasks = await specialistRepo.listTasksByRun(id);
    let runId = id;
    if (tasks.length === 0) {
      tasks = await specialistRepo.listTasksByMission(id);
      if (tasks.length > 0) {
        runId = tasks[0].runId;
      }
    }

    if (tasks.length === 0) {
      return res.status(404).json({ error: `Mission or run "${id}" not found.` });
    }

    // Enforce principal and workspace isolation for every task in the aggregate.
    const firstTask = tasks[0];
    if (!req.principal?.workspaceId || tasks.some((task) =>
      task.principalId !== req.principal!.userId || task.workspaceId !== req.principal!.workspaceId
    )) {
      return res.status(404).json({ error: `Mission "${id}" not found.` });
    }

    // Determine aggregate outcome
    const completedTasks = tasks.filter(t => t.state === 'COMPLETED');
    const failedTasks = tasks.filter(t => t.state === 'FAILED' || t.state === 'TIMED_OUT' || t.state === 'UNAVAILABLE');
    const cancelledTasks = tasks.filter(t => t.state === 'CANCELLED');
    const runningTasks = tasks.filter(t => t.state === 'RUNNING' || t.state === 'CLAIMED');

    let state = 'QUEUED';
    let outcome: string | undefined = undefined;

    if (cancelledTasks.length > 0) {
      state = 'CANCELLED';
      outcome = 'CANCELLED';
    } else if (failedTasks.length > 0) {
      state = 'FAILED';
      outcome = 'FAILED';
    } else if (completedTasks.length === tasks.length) {
      state = 'COMPLETED';
      outcome = 'COMPLETED';
    } else if (runningTasks.length > 0) {
      state = 'RUNNING';
    }

    // Extract output if completed
    let finalOutput: any = undefined;
    if (completedTasks.length > 0) {
      const lastCompleted = completedTasks[completedTasks.length - 1];
      finalOutput = lastCompleted.resultOutput;
    }

    // Sync parent run state if mission reached COMPLETED
    if (state === 'COMPLETED') {
      const parentRun = await agentRuntime.getRun(runId);
      if (parentRun && parentRun.state !== 'COMPLETED') {
        parentRun.state = 'COMPLETED';
        parentRun.content = typeof finalOutput === 'object' && finalOutput !== null
          ? JSON.stringify(finalOutput)
          : String(finalOutput ?? 'COMPLETED');
        parentRun.completedAt = Date.now();
        await runRepo.saveRun(parentRun);
      }
    }

    res.json({
      missionId: firstTask.missionId || id,
      runId,
      state,
      status: state,
      outcome,
      totalTasks: tasks.length,
      completedTasks: completedTasks.length,
      failedTasks: failedTasks.length,
      cancelledTasks: cancelledTasks.length,
      output: finalOutput,
      tasks: tasks.map(t => ({
        id: t.id,
        role: t.role,
        state: t.state,
        outcome: t.outcome,
        fencingToken: t.fencingToken,
        output: t.resultOutput,
        checkpoints: t.checkpoints,
        error: t.errorDetails
      }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal server error retrieving mission.' });
  }
});

app.get('/api/missions', async (req: Request, res: Response) => {
  try {
    const specialistRepo = agentRuntime.getSpecialistTaskRepository();
    const principal = req.principal;
    if (!principal?.userId || !principal.workspaceId) {
      return res.status(403).json({ error: 'Authenticated principal with an assigned workspace is required.' });
    }
    const tasks = await specialistRepo.listTasksByPrincipal(principal.userId);
    res.json(tasks.filter((task) => task.workspaceId === principal.workspaceId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// SSE Stream for Run
// -----------------------------------------------------------------------
app.get('/api/runs/:id/events', async (req: Request, res: Response) => {
  const runId = getParam(req.params.id);
  const run = await agentRuntime.getRun(runId);

  if (!run || !isRunOwnedByPrincipal(run, req.principal!)) {
    return res.status(404).json({ error: `Run ${runId} not found.` });
  }

  // Parse cursor — strict numeric validation.
  // Accepts only non-negative integers represented as pure digit strings.
  // Rejects: "abc", "-1", "12abc", "banana", "1.5", empty strings.
  // Returns HTTP 400 on invalid cursor so clients get deterministic feedback.
  let cursor = -1;
  const lastEventId = req.headers['last-event-id'];
  const queryAfter = req.query.after;

  const STRICT_INT_RE = /^\d+$/; // only decimal digits, no sign, no dots, no whitespace

  const parseStrictCursor = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!STRICT_INT_RE.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    return n;
  };

  if (typeof lastEventId === 'string' && lastEventId.trim() !== '') {
    const parsed = parseStrictCursor(lastEventId);
    if (parsed === null) {
      return res.status(400).json({
        error: `Invalid Last-Event-ID: "${lastEventId}". Must be a non-negative integer.`
      });
    }
    cursor = parsed;
  } else if (typeof queryAfter === 'string' && queryAfter.trim() !== '') {
    const parsed = parseStrictCursor(queryAfter);
    if (parsed === null) {
      return res.status(400).json({
        error: `Invalid ?after parameter: "${queryAfter}". Must be a non-negative integer.`
      });
    }
    cursor = parsed;
  }


  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const writeSseEvent = (event: any) => {
    if (event.sequence !== undefined) {
      res.write(`id: ${event.sequence}\n`);
    }
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  };

  const stream = agentRuntime.getEventStream(runId);
  const bufferedLiveEvents: any[] = [];
  let isReplaying = true;
  let isClosed = false;

  const onLiveEvent = (event: any) => {
    if (isReplaying) {
      bufferedLiveEvents.push(event);
    } else {
      writeSseEvent(event);
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
        closeCleanly();
      }
    }
  };

  const closeCleanly = () => {
    if (isClosed) return;
    isClosed = true;
    stream.off('event', onLiveEvent);
    res.end();
  };

  req.on('close', () => {
    isClosed = true;
    stream.off('event', onLiveEvent);
  });

  // 1. Subscribe to live events
  stream.on('event', onLiveEvent);

  if (req.query.__test_hook_replay_race) {
    await new Promise(r => setTimeout(r, 500));
  }

  try {
    // 2. High-water mark
    const highWaterSequence = await runRepo.getLatestEventSequence(runId);
    
    // 3. Fetch past events
    const pastEvents = cursor >= 0 
      ? await runRepo.getRunEventsAfter(runId, cursor)
      : await runRepo.getRunEvents(runId);
    
    // 4. Emit past events up to high water
    let terminalEventSeen = false;
    for (const evt of pastEvents) {
      if (evt.sequence !== undefined && evt.sequence <= highWaterSequence) {
        writeSseEvent(evt);
        if (['run.completed', 'run.failed', 'run.cancelled'].includes(evt.type)) {
          terminalEventSeen = true;
        }
      }
    }

    // 5. Transition to live
    isReplaying = false;
    
    if (terminalEventSeen) {
      closeCleanly();
      return;
    }

    // 6. Flush buffer
    for (const evt of bufferedLiveEvents) {
      const alreadyReplayed = pastEvents.some(p => p.eventId === evt.eventId);
      if (!alreadyReplayed && (evt.sequence === undefined || evt.sequence > highWaterSequence)) {
        writeSseEvent(evt);
        if (['run.completed', 'run.failed', 'run.cancelled'].includes(evt.type)) {
          terminalEventSeen = true;
        }
      }
    }
    
    if (terminalEventSeen) {
      closeCleanly();
      return;
    }

    // If run is already terminal but terminal event wasn't seen (somehow?), ensure we close
    const latestRun = await agentRuntime.getRun(runId);
    if (latestRun && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(latestRun.state)) {
       // It's terminal but we might have missed the terminal event if it happened before we queried highWaterSequence but after we queried events?
       // That shouldn't happen. But just in case:
       closeCleanly();
    }
  } catch (err: any) {
    if (!isClosed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      closeCleanly();
    }
  }
});

// -----------------------------------------------------------------------
// Backward-Compatible Streaming Chat Endpoint
// -----------------------------------------------------------------------
app.post('/api/chat/stream', async (req: Request, res: Response) => {
  let admission: any = undefined;
  try {
    const { messages, history, prompt, model: rawModel, extendedThinking, systemPrompt, contextSubgraph, attachments, conversationId, intent } = req.body;
    const model = normalizeModelIdentifier(rawModel);
    const promptText = prompt || (Array.isArray(messages)
      ? [...messages].reverse().find((m: any) => m.role === 'user')?.content || ''
      : '');

    const contextHistory = Array.isArray(history)
      ? history
      : Array.isArray(messages)
      ? messages.slice(0, -1)
      : [];

    const tRequestReceived = performance.now();
    let tCapacityAdmitted: number | null = null;
    let tRunCreated: number | null = null;
    let tFirstDelta: number | null = null;
    let deltaCount = 0;
    let thinkingCount = 0;
    let executedModel = model || 'aira-auto';
    let executedProvider = 'unknown';

    const principalId = req.principal?.userId || (req as any).guestSession?.id || 'anonymous';
    const capacityConfig = modelRouter.capacityGuard.getConfig();
    const isFastTarget = modelRouter.capacityGuard.isFastTarget(model);

    // Section 20: Bounded context history for Fast mode
    let effectiveHistory = contextHistory;
    if (isFastTarget && Array.isArray(contextHistory) && contextHistory.length > capacityConfig.maxContextTurns) {
      effectiveHistory = contextHistory.slice(-capacityConfig.maxContextTurns);
    }

    // Commercial Entitlement Gate: Consume 1 standard chat unit and record reasoning boost if active
    try {
      if (principalId && !principalId.startsWith('test-') && principalId !== 'anonymous') {
        await commercialBillingService.consumeStandardChat(principalId, 1);
        if (extendedThinking || model === 'aira-auto') {
          await commercialBillingService.tryConsumeReasoningBoost(principalId).catch(() => false);
        }
      }
    } catch (quotaErr: any) {
      if (quotaErr.message?.includes('DAILY_STANDARD_LIMIT_EXCEEDED') || quotaErr.message?.includes('MONTHLY_STANDARD_LIMIT_EXCEEDED')) {
        return res.status(429).json({
          error: quotaErr.message,
          code: 'USER_RATE_LIMIT',
          retryAfterSeconds: 3600
        });
      }
    }

    const clientAbort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) clientAbort.abort(new Error('CLIENT_CLOSED'));
    });

    let headersFlushed = false;
    admission = await modelRouter.capacityGuard.admit(
      {
        principalId,
        model,
        promptText,
        contextHistory: effectiveHistory,
        abortSignal: clientAbort.signal
      },
      (queueProgress) => {
        if (!headersFlushed) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders?.();
          headersFlushed = true;
        }
        res.write(`event: queue_status\ndata: ${JSON.stringify(queueProgress)}\n\n`);
      }
    );
    tCapacityAdmitted = performance.now();

    if (admission.decision === 'REJECT_CAPACITY') {
      const retryAfter = admission.retryAfterSeconds || 8;
      const userMessage = admission.userMessage || 'Private beta capacity is temporarily full. Please retry shortly.';
      const code = admission.rejectionCode || 'AIRA_PRIVATE_BETA_CAPACITY';

      if (!headersFlushed) {
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: userMessage,
          code,
          retryAfterSeconds: retryAfter
        });
      } else {
        res.write(`event: error\ndata: ${JSON.stringify({
          error: userMessage,
          code,
          retryAfterSeconds: retryAfter
        })}\n\n`);
        return res.end();
      }
    }

    if (!headersFlushed) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      headersFlushed = true;
    }

    const run = await withInferenceReservation(modelRouter.capacityGuard, admission, () => agentRuntime.createRun({
      prompt: promptText,
      conversationId: conversationId || undefined,
      attachments: Array.isArray(attachments) ? attachments : undefined,
      systemPrompt: (systemPrompt || '') + (contextSubgraph ? `\n\n${contextSubgraph}` : ''),
      context: { history: effectiveHistory },
      intent: (typeof intent === 'string' && intent.trim()) ? intent.trim() as any : undefined,
      modelPolicy: {
        model: model || 'aira-auto',
        extendedThinking: Boolean(extendedThinking),
      }
    }, req.principal!), clientAbort.signal);
    if (clientAbort.signal.aborted) {
      await admission.permit?.release();
      await agentRuntime.cancelRun(run.id);
      return res.end();
    }
    tRunCreated = performance.now();
    res.write(`event: run_started\ndata: ${JSON.stringify({ runId: run.id })}\n\n`);

    const stream = agentRuntime.getEventStream(run.id);

    let permitReleased = false;
    const releasePermitIfHeld = async () => {
      if (admission?.permit && !permitReleased) {
        permitReleased = true;
        try {
          await admission.permit.release();
        } catch (releaseErr) {
          console.warn('[CHAT_STREAM] Error releasing capacity permit:', releaseErr);
        }
      }
    };

    const finalizeAndEmitMetrics = async () => {
      const tCompleted = performance.now();
      const totalMs = Math.round(tCompleted - tRequestReceived);
      const ttftMs = tFirstDelta !== null ? Math.round(tFirstDelta - tRequestReceived) : null;
      const capacityAdmissionMs = tCapacityAdmitted !== null ? Math.round(tCapacityAdmitted - tRequestReceived) : null;
      const runCreationMs = (tRunCreated !== null && tCapacityAdmitted !== null) ? Math.round(tRunCreated - tCapacityAdmitted) : null;

      const capacityDbRoundTrips = admission?.telemetry?.dbRoundTrips ?? (admission?.permit ? 1 : 0);
      const capacityTransactionMs = admission?.telemetry?.transactionMs ?? capacityAdmissionMs;
      const capacityLockWaitMs = admission?.telemetry?.lockWaitMs ?? 0;

      const dbTele = agentRuntime.getRunDbTelemetry(run.id) || {
        dbCriticalPathMs: 0,
        dbAcquireMs: 0,
        dbQueryCountBeforeProvider: 0,
        dbQueryCountBeforeFirstToken: 0,
        dbDeferredWriteCount: 0
      };

      await releasePermitIfHeld();
      const capacityMetrics = modelRouter.capacityGuard ? {
        queueDepth: modelRouter.capacityGuard.getQueueDepth()
      } : {};

      console.log(`event=chat_latency request_id=${req.headers['x-request-id'] || run.id} run_id=${run.id} model=${executedModel} provider=${executedProvider} ttft_ms=${ttftMs} total_ms=${totalMs} capacity_admission_ms=${capacityAdmissionMs} capacity_db_roundtrips=${capacityDbRoundTrips} capacity_trx_ms=${capacityTransactionMs} capacity_lock_wait_ms=${capacityLockWaitMs} run_creation_ms=${runCreationMs} delta_count=${deltaCount} thinking_count=${thinkingCount} db_critical_path_ms=${dbTele.dbCriticalPathMs} db_acquire_ms=${dbTele.dbAcquireMs} db_queries_pre_provider=${dbTele.dbQueryCountBeforeProvider} db_queries_pre_token=${dbTele.dbQueryCountBeforeFirstToken} db_deferred_writes=${dbTele.dbDeferredWriteCount} capacity_queue_depth=${capacityMetrics.queueDepth ?? 0}`);
      res.write(`event: latency_metrics\ndata: ${JSON.stringify({
        requestId: run.id,
        ttftMs,
        totalMs,
        capacityAdmissionMs,
        capacityDbRoundTrips,
        capacityTransactionMs,
        capacityLockWaitMs,
        runCreationMs,
        deltaCount,
        thinkingCount,
        executedModel,
        executedProvider,
        dbCriticalPathMs: dbTele.dbCriticalPathMs,
        dbAcquireMs: dbTele.dbAcquireMs,
        dbQueryCountBeforeProvider: dbTele.dbQueryCountBeforeProvider,
        dbQueryCountBeforeFirstToken: dbTele.dbQueryCountBeforeFirstToken,
        dbDeferredWriteCount: dbTele.dbDeferredWriteCount,
        capacity: capacityMetrics
      })}\n\n`);
    };

    const handler = async (evt: any) => {
      if (evt.type === 'routing.decision') {
        res.write(`event: routing_decision\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'model.provenance') {
        executedModel = evt.data?.executedModel || executedModel;
        executedProvider = evt.data?.provider || executedProvider;
        res.write(`event: model_provenance\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'capability.unready') {
        res.write(`event: capability_unready\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'content.delta') {
        if (tFirstDelta === null) tFirstDelta = performance.now();
        deltaCount++;
        res.write(`event: content_delta\ndata: ${JSON.stringify({ text: evt.data.delta })}\n\n`);
      } else if (evt.type === 'thinking.delta') {
        thinkingCount++;
        res.write(`event: thinking_delta\ndata: ${JSON.stringify({ thinking: evt.data.delta })}\n\n`);
      } else if (evt.type === 'workflow.created' || evt.type === 'workflow.started') {
        res.write(`event: workflow_started\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'workflow.step.started') {
        res.write(`event: workflow_step_started\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'workflow.step.progress') {
        res.write(`event: workflow_step_progress\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'workflow.step.completed') {
        res.write(`event: workflow_step_completed\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'workflow.step.failed') {
        res.write(`event: workflow_step_failed\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'workflow.completed') {
        await finalizeAndEmitMetrics();
        res.write(`event: workflow_completed\ndata: ${JSON.stringify(evt.data)}\n\n`);
        res.write(`event: done\ndata: [DONE]\n\n`);
        stream.off('event', handler);
        res.end();
      } else if (evt.type === 'artifact.created') {
        res.write(`event: artifact_open\ndata: ${JSON.stringify(evt.data)}\n\n`);
        res.write(`event: artifact_delta\ndata: ${JSON.stringify({ chunk: evt.data.content })}\n\n`);
        res.write(`event: artifact_close\ndata: ${JSON.stringify({ id: evt.data.id })}\n\n`);
      } else if (evt.type === 'approval.required') {
        await releasePermitIfHeld();
        res.write(`event: approval_required\ndata: ${JSON.stringify(evt.data)}\n\n`);
        res.write(`event: done\ndata: [DONE]\n\n`);
        stream.off('event', handler);
        res.end();
      } else if (evt.type === 'tool.started') {
        res.write(`event: tool_started\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'tool.completed') {
        res.write(`event: tool_completed\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'source.added') {
        res.write(`event: source_added\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'run.failed') {
        await finalizeAndEmitMetrics();
        const failure = evt.data?.error || 'Aira runtime failed before producing a response';
        console.error(`[CHAT_STREAM_RUN_FAILED] run_id=${run.id} model=${executedModel}:`, failure);
        const storageFailure = isTemporaryDatabaseError(new Error(String(failure)));
        res.write(`event: error\ndata: ${JSON.stringify({
          error: storageFailure ? 'Temporary database connectivity problem. Please retry your request.' : 'Aira could not complete this request.',
          code: storageFailure ? 'DATABASE_TEMPORARILY_UNAVAILABLE' : 'RUN_FAILED',
          details: String(failure),
        })}\n\n`);
        stream.off('event', handler);
        res.end();
      } else if (evt.type === 'run.cancelled') {
        await finalizeAndEmitMetrics();
        res.write(`event: error\ndata: ${JSON.stringify({
          error: evt.data?.error || 'Aira run was cancelled',
        })}\n\n`);
        stream.off('event', handler);
        res.end();
      } else if (evt.type === 'run.completed') {
        await finalizeAndEmitMetrics();
        res.write(`event: done\ndata: [DONE]\n\n`);
        stream.off('event', handler);
        res.end();
      }
    };

    stream.on('event', handler);
    res.on('close', async () => {
      if (res.writableEnded) return;
      await releasePermitIfHeld();
      stream.off('event', handler);
      agentRuntime.cancelRun(run.id).catch(() => {});
    });

    await withInferenceReservation(modelRouter.capacityGuard, admission, () => agentRuntime.startRun(run.id), clientAbort.signal);
  } catch (err: any) {
    if (admission?.permit) {
      await admission.permit.release().catch(() => {});
    }
    if (err instanceof UnsupportedModelIdentifierError && !res.headersSent) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    console.error('Chat stream failed', { code: err?.code, message: err?.message });
    const databaseUnavailable = isTemporaryDatabaseError(err);
    const code = databaseUnavailable ? 'DATABASE_TEMPORARILY_UNAVAILABLE' : 'CHAT_STREAM_FAILED';
    const message = databaseUnavailable
      ? 'Temporary database connectivity problem. Please retry your request.'
      : 'Aira could not complete this request.';
    if (!res.headersSent) {
      res.status(databaseUnavailable ? 503 : 500).json({ error: message, code });
    } else {
      res.write(`event: error\ndata: ${JSON.stringify({ error: message, code })}\n\n`);
      res.end();
    }
  }
});

// -----------------------------------------------------------------------
// Tool Gateway & Definitions
// -----------------------------------------------------------------------
app.get('/api/tools', (_req: Request, res: Response) => {
  res.json({
    tools: toolGateway.listDefinitions(),
    audit: toolRegistry.getAuditLog().slice(-20)
  });
});

app.post('/api/tools/execute', async (req: Request, res: Response) => {
  try {
    const { toolName, toolId, arguments: args, input, idempotencyKey, runId } = req.body;
    const name = toolName || toolId;
    if (!name) {
      return res.status(400).json({ error: 'toolName or toolId is required.' });
    }
    const effectiveRunId = runId || `run_direct_${Date.now()}`;
    const result = await toolGateway.execute({
      toolName: name,
      arguments: args || input || {},
      context: {
        runId: effectiveRunId,
        principal: req.principal!,
        idempotencyKey
      }
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tools/connectors', async (req: Request, res: Response) => {
  try {
    const connectors = await toolGateway.getConnectorRegistry().getStatusForPrincipal(req.principal!);
    res.json({ connectors });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tools/calls', async (req: Request, res: Response) => {
  try {
    const calls = await toolCallRepo.listToolCallsForPrincipal(req.principal!.userId);
    res.json(calls);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tools/calls/:id', async (req: Request, res: Response) => {
  try {
    const call = await toolCallRepo.getToolCall(getParam(req.params.id));
    if (!call || call.principalId !== req.principal!.userId) {
      return res.status(404).json({ error: `Tool call with id "${getParam(req.params.id)}" not found.` });
    }
    res.json(call);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tools/calls/:id/cancel', async (req: Request, res: Response) => {
  try {
    const success = await toolGateway.cancel(getParam(req.params.id), req.principal!);
    if (!success) {
      return res.status(400).json({ error: 'Cannot cancel tool call (either not found, not owned, or already terminal).' });
    }
    res.json({ status: 'CANCELLED', toolCallId: getParam(req.params.id) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// Knowledge Engine (Brain v2) — Principal-Scoped & Isolated (P0 Security)
// -----------------------------------------------------------------------
app.get('/api/knowledge/sources', async (req: Request, res: Response) => {
  const scope: PrincipalScope = {
    principalId: req.principal?.userId,
    workspaceId: req.principal?.workspaceId,
    isSystem: false
  };
  res.json({
    sources: await knowledgeEngine.getSources(scope),
    memories: await knowledgeEngine.getMemories(scope)
  });
});

app.get('/api/knowledge/sources/:id', async (req: Request, res: Response) => {
  const scope: PrincipalScope = {
    principalId: req.principal?.userId,
    workspaceId: req.principal?.workspaceId,
    isSystem: false
  };
  const source = await knowledgeEngine.getSource(getParam(req.params.id), scope);
  if (!source) {
    return res.status(404).json({ error: 'Source not found or access denied.' });
  }
  res.json({ source });
});

app.delete('/api/knowledge/sources/:id', async (req: Request, res: Response) => {
  const scope: PrincipalScope = {
    principalId: req.principal?.userId,
    workspaceId: req.principal?.workspaceId,
    isSystem: false
  };
  const deleted = await knowledgeEngine.deleteSource(getParam(req.params.id), scope);
  if (!deleted) {
    return res.status(404).json({ error: 'Source not found or deletion not permitted.' });
  }
  res.json({ success: true, id: getParam(req.params.id) });
});

app.post('/api/knowledge/ingest', async (req: Request, res: Response) => {
  const { title, content, mimeType, uri, projectId, principalId, userId } = req.body;
  if (principalId && principalId !== req.principal?.userId) {
    return res.status(400).json({ error: 'Forbidden: caller may not specify or forge principalId ownership' });
  }
  if (userId && userId !== req.principal?.userId) {
    return res.status(400).json({ error: 'Forbidden: caller may not specify or forge userId ownership' });
  }
  if (!title || !content) {
    return res.status(400).json({ error: 'title and content are required.' });
  }
  const scope: PrincipalScope = {
    principalId: req.principal?.userId,
    workspaceId: req.principal?.workspaceId,
    isSystem: false
  };
  const result = await knowledgeEngine.ingestDocument(title, content, mimeType, uri, projectId, scope);
  res.status(201).json(result);
});

app.get('/api/knowledge/graph', async (req: Request, res: Response) => {
  const scope: PrincipalScope = {
    principalId: req.principal?.userId,
    workspaceId: req.principal?.workspaceId,
    isSystem: false
  };
  res.json(await knowledgeEngine.getKnowledgeGraph(scope));
});

app.post('/api/knowledge/search', async (req: Request, res: Response) => {
  const { query, limit } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required.' });
  const scope: PrincipalScope = {
    principalId: req.principal?.userId,
    workspaceId: req.principal?.workspaceId,
    isSystem: false
  };
  const results = await knowledgeEngine.search(String(query), limit ? Number(limit) : 5, scope);
  res.json({ results });
});

app.post('/api/knowledge/memories', async (req: Request, res: Response) => {
  const { key, value, category, provenance, principalId, userId } = req.body;
  if (principalId && principalId !== req.principal?.userId) {
    return res.status(400).json({ error: 'Forbidden: caller may not specify or forge principalId ownership' });
  }
  if (userId && userId !== req.principal?.userId) {
    return res.status(400).json({ error: 'Forbidden: caller may not specify or forge userId ownership' });
  }
  if (!key || !value) {
    return res.status(400).json({ error: 'key and value are required.' });
  }
  const scope: PrincipalScope = {
    principalId: req.principal?.userId,
    workspaceId: req.principal?.workspaceId,
    isSystem: false
  };
  const memory = await knowledgeEngine.saveMemory(key, value, category || 'fact', provenance || 'user', scope);
  res.status(201).json({ memory });
});

// -----------------------------------------------------------------------
// Agents — Full CRUD (Audit 16)
// -----------------------------------------------------------------------

app.post('/api/agents', async (req: Request, res: Response) => {
  const verifiedUserId = req.principal?.userId;
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized: missing verified principal' });
  }

  if (req.body?.principalId && req.body.principalId !== verifiedUserId) {
    return res.status(400).json({
      error: 'Forbidden: caller may not specify or forge principalId ownership'
    });
  }

  const { name, instructions, modelPolicy, tools, memoryScopes, approvalPolicy, maxSteps, timeoutPolicy } = req.body;
  if (!name || !instructions) {
    return res.status(400).json({ error: 'name and instructions are required.' });
  }
  const now = Date.now();
  const agent: AgentDefinition = {
    id: `agent_${crypto.randomUUID().slice(0, 8)}`,
    principalId: verifiedUserId,
    name,
    description: req.body.description || '',
    instructions,
    modelPolicy,
    tools: tools || [],
    memoryScopes: memoryScopes || ['workspace'],
    approvalPolicy: approvalPolicy || 'autonomous',
    maxSteps: maxSteps || 10,
    timeoutMs: timeoutPolicy?.maxMs || 60000,
    createdAt: now,
    updatedAt: now
  } as any;
  await agentRepo.saveAgent(agent, verifiedUserId);
  res.status(201).json(agent);
});

app.get('/api/agents', async (req: Request, res: Response) => {
  const verifiedUserId = req.principal?.userId;
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized: missing verified principal' });
  }
  res.json(await agentRepo.listAgents(verifiedUserId));
});

app.get('/api/agents/:id', async (req: Request, res: Response) => {
  const verifiedUserId = req.principal?.userId;
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized: missing verified principal' });
  }
  const agent = await agentRepo.getAgent(getParam(req.params.id), verifiedUserId);
  if (!agent) return res.status(404).json({ error: `Agent "${getParam(req.params.id)}" not found.` });
  res.json(agent);
});

app.patch('/api/agents/:id', async (req: Request, res: Response) => {
  const verifiedUserId = req.principal?.userId;
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized: missing verified principal' });
  }

  if (req.body?.principalId && req.body.principalId !== verifiedUserId) {
    return res.status(400).json({
      error: 'Forbidden: caller may not alter or forge principalId ownership'
    });
  }

  const agent = await agentRepo.getAgent(getParam(req.params.id), verifiedUserId);
  if (!agent) return res.status(404).json({ error: `Agent "${getParam(req.params.id)}" not found.` });
  const updates = req.body as Partial<AgentDefinition>;
  delete (updates as any).id;
  delete (updates as any).principalId;
  delete (updates as any).createdAt;
  Object.assign(agent, updates, { updatedAt: Date.now() });
  await agentRepo.saveAgent(agent, verifiedUserId);
  res.json(agent);
});

app.delete('/api/agents/:id', async (req: Request, res: Response) => {
  const verifiedUserId = req.principal?.userId;
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized: missing verified principal' });
  }
  const deleted = await agentRepo.deleteAgent(getParam(req.params.id), verifiedUserId);
  if (!deleted) {
    return res.status(404).json({ error: `Agent "${getParam(req.params.id)}" not found.` });
  }
  res.status(204).send();
});

app.post('/api/agents/:id/run', async (req: Request, res: Response) => {
  const verifiedUserId = req.principal?.userId;
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized: missing verified principal' });
  }
  const agent = await agentRepo.getAgent(getParam(req.params.id), verifiedUserId);
  if (!agent) return res.status(404).json({ error: `Agent "${getParam(req.params.id)}" not found.` });
  try {
    const run = await agentRuntime.createRun({
      prompt: req.body.prompt || agent.instructions,
      systemPrompt: agent.instructions,
      intent: 'AGENT_MISSION',
      modelPolicy: agent.modelPolicy
    }, req.principal!);
    await agentRuntime.startRun(run.id);
    const completedRun = await agentRuntime.getRun(run.id);
    res.status(201).json({ runId: run.id, state: completedRun?.state || 'COMPLETED', content: completedRun?.content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// Automations — Full CRUD (Audit 14 & 12 Ownership Enforced)
// -----------------------------------------------------------------------
app.get('/api/automations/capabilities', async (_req: Request, res: Response) => {
  res.json({
    scheduler: automationEngine.getSchedulerStatus()
  });
});

app.get('/api/automations', async (req: Request, res: Response) => {
  res.json(await automationEngine.listAutomations(req.principal?.userId));
});

app.post('/api/automations', async (req: Request, res: Response) => {
  const verifiedUserId = req.principal?.userId;
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized: missing verified principal' });
  }

  const clientOpId = (req.headers['x-client-operation-id'] as string) || req.body?.clientOperationId;

  let sideEffectCommitted = false;
  let automationResult: any = null;

  try {
    if (req.body?.principalId && req.body.principalId !== verifiedUserId) {
      return res.status(400).json({
        error: 'Forbidden: caller may not specify or forge principalId ownership'
      });
    }

    const raw = {
      ...req.body,
      principalId: verifiedUserId
    };
    const parsed = AutomationDefinitionSchema.omit({ id: true }).parse(raw);

    // Server-side durable principal-scoped idempotency
    if (clientOpId) {
      const check = await durableIdempotencyManager.beginOrGet(
        verifiedUserId,
        clientOpId,
        'AUTOMATION_CREATE',
        parsed
      );
      if (check.isReplay) {
        return res.status(check.statusCode).json(check.responseBody);
      }
    }

    automationResult = await automationEngine.createAutomation(parsed, clientOpId);
    sideEffectCommitted = true;

    if (clientOpId) {
      await durableIdempotencyManager.complete(verifiedUserId, clientOpId, 201, automationResult);
    }

    res.status(201).json(automationResult);
  } catch (err: any) {
    if (clientOpId && verifiedUserId) {
      if (!(err instanceof IdempotencyConflictError || err instanceof IdempotencyInProgressError)) {
        await durableIdempotencyManager.fail(verifiedUserId, clientOpId, {
          sideEffectCommitted,
          result: automationResult,
          error: err.message
        }).catch(() => {});
      }
    }
    const status = err.statusCode || (
      err.code === 'IDEMPOTENCY_CONFLICT' || err.code === 'IDEMPOTENCY_IN_PROGRESS' || err.code === 'IDEMPOTENCY_UNCERTAIN_OUTCOME'
        ? 409
        : (err.code === 'IDEMPOTENCY_DATABASE_UNAVAILABLE' ? 503 : 400)
    );
    res.status(status).json({ error: err.message, code: err.code });
  }
});

app.get('/api/automations/:id', async (req: Request, res: Response) => {
  try {
    const item = await automationEngine.getAutomation(getParam(req.params.id), req.principal?.userId);
    if (!item) return res.status(404).json({ error: `Automation "${getParam(req.params.id)}" not found.` });
    res.json(item);
  } catch {
    res.status(404).json({ error: `Automation "${getParam(req.params.id)}" not found.` });
  }
});


app.patch('/api/automations/:id', async (req: Request, res: Response) => {
  try {
    const verifiedUserId = req.principal?.userId;
    if (!verifiedUserId) {
      return res.status(401).json({ error: 'Unauthorized: missing verified principal' });
    }

    // Defense-in-depth: reject ownership/identity field manipulation at route layer
    const REJECTED_FIELDS = ['principalId', 'id', 'trigger'];
    for (const field of REJECTED_FIELDS) {
      if (field in (req.body ?? {})) {
        return res.status(400).json({
          error: `Forbidden: field "${field}" is immutable and cannot be changed via PATCH.`,
          code: 'IMMUTABLE_FIELD'
        });
      }
    }

    const updated = await automationEngine.patchAutomation(getParam(req.params.id), req.body, verifiedUserId);
    res.json(updated);
  } catch (err: any) {
    const status = err.statusCode ?? (err.message?.includes('not found') ? 404 : 400);
    res.status(status).json({ error: err.message, code: err.code });
  }
});


app.delete('/api/automations/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await automationEngine.deleteAutomation(getParam(req.params.id), req.principal?.userId);
    if (!deleted) return res.status(404).json({ error: `Automation "${getParam(req.params.id)}" not found.` });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: `Automation "${getParam(req.params.id)}" not found.` });
  }
});

app.post('/api/automations/:id/trigger', async (req: Request, res: Response) => {
  try {
    const verifiedUserId = req.principal?.userId;
    if (!verifiedUserId) {
      return res.status(401).json({ error: 'Unauthorized: missing verified principal' });
    }
    const runId = await automationEngine.triggerNow(getParam(req.params.id), verifiedUserId);
    res.json({ runId, status: 'TRIGGERED' });
  } catch (err: any) {
    const status = err.message?.includes('ACCESS_DENIED') ? 403 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/automations/:id/runs', async (req: Request, res: Response) => {
  try {
    const item = await automationEngine.getAutomation(getParam(req.params.id), req.principal?.userId);
    if (!item) return res.status(404).json({ error: `Automation "${getParam(req.params.id)}" not found.` });
    const runs = await automationEngine.getAutomationRuns(getParam(req.params.id), req.principal?.userId);
    res.json(runs);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/automations/:id/enable', async (req: Request, res: Response) => {
  try {
    const verifiedUserId = req.principal?.userId;
    if (!verifiedUserId) {
      return res.status(401).json({ error: 'Unauthorized: missing verified principal' });
    }
    const item = await automationEngine.toggleAutomation(getParam(req.params.id), true, verifiedUserId);
    res.json(item);
  } catch (err: any) {
    const status = err.statusCode || (err.code === 'SCHEDULER_UNAVAILABLE' ? 400 : (err.message?.includes('ACCESS_DENIED') ? 403 : 404));
    res.status(status).json({ error: err.message, code: err.code });
  }
});

app.post('/api/automations/:id/disable', async (req: Request, res: Response) => {
  try {
    const verifiedUserId = req.principal?.userId;
    if (!verifiedUserId) {
      return res.status(401).json({ error: 'Unauthorized: missing verified principal' });
    }
    const item = await automationEngine.toggleAutomation(getParam(req.params.id), false, verifiedUserId);
    res.json(item);
  } catch (err: any) {
    const status = err.statusCode || (err.message?.includes('ACCESS_DENIED') ? 403 : 404);
    res.status(status).json({ error: err.message });
  }
});

// Platform / Serverless cron execution endpoint (Policy B: Authenticated & Authorized)
const handleCronCycleExecution = async (req: Request, res: Response) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(503).json({
      error: 'Autonomous scheduler is not configured in this environment: CRON_SECRET is missing.',
      code: 'SCHEDULER_UNCONFIGURED'
    });
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized: missing bearer token for cron execution.',
      code: 'UNAUTHORIZED'
    });
  }

  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(cronSecret);
  if (tokenBuf.length !== secretBuf.length || !crypto.timingSafeEqual(tokenBuf, secretBuf)) {
    return res.status(401).json({
      error: 'Unauthorized: invalid cron authorization token.',
      code: 'UNAUTHORIZED'
    });
  }

  try {
    const result = await automationEngine.runScheduledCronCycle();
    res.json({ status: 'CRON_CYCLE_EXECUTED', timestamp: Date.now(), result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

app.get('/api/automations/cron/execute', handleCronCycleExecution);
app.post('/api/automations/cron/execute', handleCronCycleExecution);

// -----------------------------------------------------------------------
// Workflows — Server-Authoritative Execution Engine (Phase 18)
// -----------------------------------------------------------------------

app.get('/api/workflows/runs', async (req: Request, res: Response) => {
  try {
    const wfRepo = agentRuntime.getWorkflowRepository();
    const runs = await wfRepo.listWorkflowRuns(req.principal!.userId);
    res.json(runs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workflows/runs/:id', async (req: Request, res: Response) => {
  try {
    const wfRepo = agentRuntime.getWorkflowRepository();
    const wfRun = await wfRepo.getWorkflowRun(getParam(req.params.id));
    if (!wfRun || wfRun.principalId !== req.principal!.userId) {
      return res.status(404).json({ error: `Workflow run "${getParam(req.params.id)}" not found.` });
    }
    const steps = await wfRepo.getWorkflowSteps(wfRun.id);
    const definition = await wfRepo.getWorkflowDefinition(wfRun.workflowId);
    res.json({ ...wfRun, steps, definition });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workflows/runs', async (req: Request, res: Response) => {
  try {
    const { prompt, definition, principalId, userId } = req.body || {};
    if (principalId && principalId !== req.principal?.userId) {
      return res.status(400).json({ error: 'Forbidden: caller may not specify or forge principalId ownership' });
    }
    if (userId && userId !== req.principal?.userId) {
      return res.status(400).json({ error: 'Forbidden: caller may not specify or forge userId ownership' });
    }
    if (!prompt && !definition) {
      return res.status(400).json({ error: 'Either "prompt" or "definition" is required.' });
    }

    const principal = req.principal!;
    const wfCompiler = agentRuntime.getWorkflowCompiler();
    const wfEngine = agentRuntime.getWorkflowEngine();

    let wfDef: any;
    if (definition) {
      wfDef = WorkflowDefinitionSchema.parse(definition);
      const dagValidation = validateWorkflowDag(wfDef);
      if (!dagValidation.valid) {
        return res.status(400).json({ error: dagValidation.error || 'Invalid workflow DAG' });
      }
    } else {
      wfDef = await wfCompiler.compile(prompt, principal);
    }

    const airaRun = await agentRuntime.createRun({
      prompt: prompt || wfDef.name,
      intent: 'WORKFLOW'
    }, principal);

    const wfRun = await wfEngine.createWorkflowRun(wfDef, airaRun, principal);
    await wfEngine.executeWorkflowRun(wfRun.id);
    const updatedWfRun = await agentRuntime.getWorkflowRepository().getWorkflowRun(wfRun.id);
    const steps = await agentRuntime.getWorkflowRepository().getWorkflowSteps(wfRun.id);

    res.status(201).json({ ...(updatedWfRun || wfRun), steps });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/workflows/runs/:id/cancel', async (req: Request, res: Response) => {
  try {
    const wfRepo = agentRuntime.getWorkflowRepository();
    const wfRun = await wfRepo.getWorkflowRun(getParam(req.params.id));
    if (!wfRun || wfRun.principalId !== req.principal!.userId) {
      return res.status(404).json({ error: `Workflow run "${getParam(req.params.id)}" not found.` });
    }

    const wfEngine = agentRuntime.getWorkflowEngine();
    const cancelled = await wfEngine.cancelWorkflow(wfRun.id, req.principal!);
    if (!cancelled) {
      return res.status(400).json({ error: 'Cannot cancel workflow run (not found or in terminal state).' });
    }

    res.json({ status: 'CANCELLED', workflowRunId: wfRun.id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/workflows/runs/:id/steps/:stepId/approve', async (req: Request, res: Response) => {
  try {
    const { decision } = req.body;
    if (!['APPROVE', 'REJECT'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be APPROVE or REJECT' });
    }

    const wfRepo = agentRuntime.getWorkflowRepository();
    const wfRun = await wfRepo.getWorkflowRun(getParam(req.params.id));
    if (!wfRun || wfRun.principalId !== req.principal!.userId) {
      return res.status(404).json({ error: `Workflow run "${getParam(req.params.id)}" not found.` });
    }

    const wfEngine = agentRuntime.getWorkflowEngine();
    const success = await wfEngine.resolveStepApproval(
      wfRun.id,
      getParam(req.params.stepId),
      decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      req.principal!
    );

    if (!success) {
      return res.status(400).json({ error: 'Could not resolve approval for step.' });
    }

    res.json({ status: 'DECISION_RECORDED', decision });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

if (process.env.NODE_ENV === 'test') {
  app.get('/api/test-unhandled-server-error', () => {
    throw new Error('Simulated unexpected server error');
  });
}

app.use((req: Request, res: Response) => {
  const sanitized = sanitizeUrlForLogging(req.url);
  process.stdout.write(`[API_404] ${req.method} ${sanitized}\n`);
  res.status(404).json({ error: `Not found: ${req.method} ${sanitized}` });
});

// -----------------------------------------------------------------------
// Global Error Handler (Audit 27 — catches uncaught route errors)
// -----------------------------------------------------------------------
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof UntrustedOriginError || err?.code === 'CORS_ORIGIN_DENIED' || err?.name === 'UntrustedOriginError') {
    const rawOrigin = typeof err.origin === 'string' ? err.origin : (req.headers.origin as string) || 'unknown';
    const sanitizedOrigin = rawOrigin.slice(0, 200).replace(/[\r\n\t]/g, '');
    const sanitizedRoute = sanitizeUrlForLogging(req.originalUrl || req.url || 'unknown').slice(0, 200).replace(/[\r\n\t]/g, '');
    process.stdout.write(
      `[SECURITY_EVENT] event=cors_origin_rejected origin=${sanitizedOrigin} route=${sanitizedRoute} status=403\n`
    );
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('access-control-allow-origin');
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }
  process.stderr.write(`[API_ERROR] ${err.message}\n`);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// -----------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------
if (!process.env.VERCEL) {
  const apiWorkerOwner = `api-worker-${process.pid}-${crypto.randomUUID()}`;
  let approvalOutboxPoll: NodeJS.Timeout | undefined;
  const server = app.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(`AIRA Runtime API Server v2026.2.0 listening on port ${PORT}\n`);
    process.stdout.write(`NODE_ENV: ${process.env.NODE_ENV || 'development'}\n`);
    process.stdout.write(`Providers: ${modelRouter.listProviders().join(', ') || 'none (dev mock active)'}\n`);
    
    appState = 'RECOVERING';
    agentRuntime.dispatchApprovalResumptions(`${apiWorkerOwner}-approval-outbox`)
      .then(() => agentRuntime.recoverInterruptedRuns(`${apiWorkerOwner}-recovery`)).then(() => {
      appState = 'HEALTHY';
      approvalOutboxPoll = setInterval(() => {
        void agentRuntime.dispatchApprovalResumptions(`${apiWorkerOwner}-approval-outbox`).catch((err) => {
          console.error('Approval resumption outbox poll failed:', err);
        });
      }, 5000);
      approvalOutboxPoll.unref();
      process.stdout.write('Startup recovery complete. API is HEALTHY.\n');
    }).catch(err => {
      console.error('Failed to recover interrupted runs. Failing closed:', err);
      appState = 'FAILED';
      process.exit(1);
    });
  });

  process.on('SIGINT', () => {
    if (approvalOutboxPoll) clearInterval(approvalOutboxPoll);
    automationEngine.stop();
    server.close(() => {
      process.stdout.write('AIRA API Server stopped cleanly.\n');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    automationEngine.stop();
    server.close(() => process.exit(0));
  });
} else {
  // When running as a Vercel serverless function, immediately mark as healthy 
  // so the middleware does not block requests with 503.
  appState = 'HEALTHY';
}

export default app;

