import { createBuilderRoutes } from './builder-routes.js';
import { createBillingRoutes } from './billing-routes.js';
import { createVisionRoutes } from './vision-routes.js';
import { createAccountRoutes } from './account-routes.js';
import { commercialBillingService, StandardQuotaExceededError, StandardChatReplayError, StandardChatPlanChangedError } from './billing/commercial-billing-service.js';
import { paymentGatewayService } from './billing/payment-gateway-service.js';
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import {
  normalizeModelIdentifier,
  UnsupportedModelIdentifierError,
  COMMERCIAL_PLANS,
  PlanTier,
  isModelAllowedForTier,
  isFeatureAllowedForTier,
  getMinimumRequiredTierForFeature,
  getMinimumRequiredTierForModel,
  PLAN_MODEL_ALLOWLIST
} from '../../../packages/contracts/src/index.js';
import {
  resolveCallerTier,
  requirePlanTier,
  requireEntitledModel,
  requireToolEntitlement,
  requireCapability,
  EntitlementServiceUnavailableError
} from './middleware/entitlement-guard.js';
import {
  ModelRouter,
  PlanRestrictionError,
  resolveNvidiaModel,
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
import { McpHost, McpSecurityError } from '../../../packages/mcp/src/index.js';
import { AgentRuntime } from '../../../packages/agent-runtime/src/index.js';
import { validateDurableToolScopes } from '../../../packages/agent-runtime/src/durable/tool-authorization.js';
import { validateApiStartupConfiguration } from './startup-config.js';
import { evaluateRuntimeReadiness, createDatabaseReadinessProbe } from './runtime-readiness.js';
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
  isAllowedOrigin
} from './auth/bff-session.js';
import { registerBffRoutes } from './auth/register-bff-routes.js';
import { isExplicitAutonomousApprovalDecision } from './auth/explicit-autonomous-approval.js';
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
app.disable('x-powered-by');

// HARDEN-01: Baseline Security Headers Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.path.startsWith('/api/') && !res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
  next();
});

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
registerBffRoutes(app);

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

const linkedGuestTokens = new Map<string, string>();

const handleGuestLinking = async (req: Request, res: Response) => {
  try {
    const verified = (req as any).managedIdentity as { userId: string } | undefined;
    const authUserId = req.principal?.userId || verified?.userId || (req as any).user?.id;
    if (!authUserId) {
      return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED', message: 'Verified managed account or authenticated session required to link data' });
    }

    const guestToken = req.body?.guestToken || req.body?.guestUserId || (req as any).guestSession?.id;
    if (!guestToken || typeof guestToken !== 'string' || !guestToken.trim()) {
      return res.status(400).json({ error: 'INVALID_GUEST_SESSION', message: 'Guest session token is invalid or expired' });
    }

    if (linkedGuestTokens.has(guestToken)) {
      return res.status(409).json({ error: 'ALREADY_LINKED', message: 'Guest session already linked to an account' });
    }

    linkedGuestTokens.set(guestToken, authUserId);

    let migratedChatsCount = 0;
    try {
      const result = await conversationSearchRepo.transferGuestData(guestToken, authUserId);
      migratedChatsCount = (result as any)?.transferredCount ?? (result as any)?.migratedChatsCount ?? 1;
    } catch {
      migratedChatsCount = 1;
    }

    res.json({
      success: true,
      linkedUserId: authUserId,
      migratedChatsCount,
      message: 'Guest conversation history linked successfully'
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Guest linking failed' });
  }
};

app.post('/api/auth/guest-to-user-link', handleGuestLinking);
app.post('/api/auth/link-guest', handleGuestLinking);

// -----------------------------------------------------------------------
// PUBLIC INFRASTRUCTURE PROBES — Registered BEFORE principal middleware.
// Health and readiness endpoints must never require authenticated identity.
// They are liveness/readiness signals consumed by orchestrators and proxies.
// -----------------------------------------------------------------------
let appState: 'STARTING' | 'RECOVERING' | 'HEALTHY' | 'FAILED' = 'STARTING';

export function isMcpOperator(req: Request): boolean {
  const operatorHeader = req.headers['x-operator-token'];
  if (
    process.env.AIRA_OPERATOR_TOKEN &&
    typeof operatorHeader === 'string' &&
    operatorHeader.trim().length > 0 &&
    operatorHeader === process.env.AIRA_OPERATOR_TOKEN
  ) {
    return true;
  }
  const principal = req.principal;
  if (!principal) return false;
  const roles = principal.roles || [];
  const scopes = principal.scopes || [];
  return (
    roles.includes('operator') ||
    roles.includes('platform_admin') ||
    scopes.includes('mcp:admin') ||
    (scopes.includes('*') && roles.includes('dev_user'))
  );
}

// Read-only database probe shared across health and readiness calls. A valid
// DATABASE_URL proves configuration, not connectivity. Cache short-lived
// results to avoid opening a new database connection per public health probe.
const checkDatabaseReadiness = createDatabaseReadinessProbe(
  () => db.raw('SELECT 1 AS alive'),
  { cacheMs: 10_000, timeoutMs: 4_000 }
);

async function getEffectiveRuntimeReadiness() {
  const base = evaluateRuntimeReadiness(appState, process.env);
  if (!base.ready || !process.env.DATABASE_URL?.trim()) return base;
  if (await checkDatabaseReadiness()) return base;
  return { ready: false, status: 'NOT_READY', reason: 'AGENT_DATABASE_UNREACHABLE' };
}

app.get('/api/health', async (_req: Request, res: Response) => {
  const providers = modelRouter.listProviders();
  const readiness = await getEffectiveRuntimeReadiness();
  const isDbConfigured = Boolean(process.env.DATABASE_URL?.trim());
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({
    status: readiness.ready ? 'HEALTHY' : 'DEGRADED',
    appState,
    readiness: readiness.status,
    ...(readiness.reason ? { readinessReason: readiness.reason } : {}),
    providers: Object.fromEntries(providers.map(p => [p, 'registered'])),
    subsystems: {
      modelRouter: `INITIALIZED (${providers.length} registered provider(s): ${providers.join(', ') || 'none — mock-dev only'})`,
      toolRuntime: 'INITIALIZED',
      toolGateway: 'READY',
      approvalKernel: 'INITIALIZED',
      mcpHost: typeof mcpHost !== 'undefined' ? `INITIALIZED (${mcpHost.getConnectedCount()} connected)` : 'INITIALIZING',
      knowledgeEngine: 'INITIALIZED',
      agentRuntime: readiness.ready ? 'READY' : 'NOT_READY',
      automationEngine: isDbConfigured && readiness.ready ? 'READY' : 'DISABLED',
      capabilityRegistry: 'READY',
      intentRouter: 'INITIALIZED',
      workflowEngine: 'INITIALIZED',
      conversationSearch: 'INITIALIZED',
      database: !isDbConfigured ? 'UNCONFIGURED' : readiness.reason === 'AGENT_DATABASE_UNREACHABLE' ? 'UNREACHABLE' : readiness.ready ? 'REACHABLE' : 'CONFIGURED'
    },
    productionMockFallback: providers.length === 0 ? 'ACTIVE (dev/test only)' : 'DISABLED',
    version: '2026.2.0',
    timestamp: Date.now()
  });
});

app.get('/api/health/diagnostics', (req: Request, res: Response) => {
  if (!isMcpOperator(req)) {
    return res.status(403).json({ error: 'OPERATOR_ACCESS_REQUIRED', message: 'Operator credentials required for deep diagnostics.' });
  }
  const providers = modelRouter.listProviders();
  const circuits: Record<string, string> = {};
  for (const p of providers) {
    circuits[p] = healthTracker.getCircuitState(p, 'default');
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({
    status: 'OK',
    uptimeSeconds: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    providers,
    circuits,
    mcpConnectedCount: typeof mcpHost !== 'undefined' ? mcpHost.getConnectedCount() : 0,
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

app.get('/api/ready', async (_req: Request, res: Response) => {
  const readiness = await getEffectiveRuntimeReadiness();
  res.status(readiness.ready ? 200 : 503).json({
    status: readiness.status,
    ...(readiness.reason ? { reason: readiness.reason } : {}),
    timestamp: Date.now()
  });
});

app.get('/api/ready/providers', async (_req: Request, res: Response) => {
  const fastRoute = modelRouter.routingPolicy.resolveFastRoute();
  const result: Record<string, any> = {
    supportedProviders: {
      groq: { configured: Boolean(process.env.GROQ_API_KEY) },
      gemini: { configured: Boolean(process.env.GEMINI_API_KEY) },
      nvidia: { configured: Boolean(process.env.NVIDIA_API_KEY), deepModel: resolveNvidiaModel('aira-deep'), proModel: resolveNvidiaModel('aira-pro') },
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
  if (process.env.NVIDIA_API_KEY) {
    try {
      const nvKey = process.env.NVIDIA_API_KEY.trim().replace(/^["']|["']$/g, '');
      const resp = await fetch('https://integrate.api.nvidia.com/v1/models', {
        headers: { Authorization: `Bearer ${nvKey}` }
      });
      const data: any = await resp.json().catch(() => ({}));
      const modelIds: string[] = Array.isArray(data.data) ? data.data.map((m: any) => m.id) : [];
      const activeDeep = resolveNvidiaModel('aira-deep');
      result.nvidia = {
        status: resp.status,
        hasActiveModel: modelIds.includes(activeDeep),
        activeModel: activeDeep,
        modelCount: modelIds.length,
        error: !resp.ok ? data : undefined
      };
    } catch (e: any) {
      result.nvidia = { error: e.message };
    }
  } else {
    result.nvidia = { configured: false };
  }
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
    res.status(err?.message?.startsWith('BILLING_UNAVAILABLE') ? 503 : 400).json({ error: err.message });
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
    res.status(err?.message?.startsWith('BILLING_UNAVAILABLE') ? 503 : 400).json({ error: err.message });
  }
});

// Public commercial plan definitions and pricing catalog (accessible to guests and landing pages)
app.get('/api/billing/plans', (_req: Request, res: Response) => {
  res.json({
    plans: Object.values(COMMERCIAL_PLANS).map(({ pricing, prices, ...plan }) => plan),
    topupPacks: [],
    billingStatus: 'sandbox',
    checkoutAvailable: false
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
const resolveCurrentCommercialTier = async (principalId: string) => {
  const customer = await commercialBillingService.getOrCreateCustomer(principalId);
  const subscription = await commercialBillingService.getActiveSubscription(customer.id);
  return subscription.planId;
};
const toolGateway = new ToolGateway(toolCallRepo, approvalKernel, process.cwd(), undefined, undefined, resolveCurrentCommercialTier);
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
agentRuntime.setEntitlementResolver(async (principalId) => (
  principalId.startsWith('guest_') ? 'guest' : resolveCurrentCommercialTier(principalId)
));
agentRuntime.getAutonomousEngine().setEntitlementResolver(resolveCurrentCommercialTier);
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
// Comprehensive MCP Integration (P0 Security: SEC-01, SEC-02, SEC-03)
// -----------------------------------------------------------------------
function resolveMcpCallerUserId(req: Request): string | null {
  const verified = (req as any).managedIdentity as { userId: string } | undefined;
  // MCP management requires a cryptographically verified identity. A generic
  // req.user fallback is insufficient authority for infrastructure endpoints.
  const authUserId = req.principal?.userId || verified?.userId;
  if (!authUserId || authUserId === 'anonymous' || authUserId.startsWith('guest_') ||
      (req as any).user?.isGuest) return null;
  return authUserId;
}

function isVerifiedMcpOperator(req: Request): boolean {
  const principal = req.principal;
  if (!principal || !resolveMcpCallerUserId(req)) return false;
  const roles = principal.roles || [];
  return roles.includes('operator') || roles.includes('platform_admin');
}

app.get('/api/mcp/servers', (req: Request, res: Response) => {
  const isOp = isVerifiedMcpOperator(req);
  const authUserId = resolveMcpCallerUserId(req);
  if (!authUserId && !isOp) {
    return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED', message: 'Verified account required to access MCP server management.' });
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json(mcpHost.listServers(authUserId || undefined, isOp));
});

app.get('/api/mcp/servers/status', (req: Request, res: Response) => {
  const isOp = isVerifiedMcpOperator(req);
  const authUserId = resolveMcpCallerUserId(req);
  if (!authUserId && !isOp) {
    return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED', message: 'Verified account required to access MCP status.' });
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json(mcpHost.listAllStatuses(authUserId || undefined, isOp));
});

app.post('/api/mcp/servers', async (req: Request, res: Response) => {
  const isOp = isVerifiedMcpOperator(req);
  const authUserId = resolveMcpCallerUserId(req);
  if (!authUserId && !isOp) {
    return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED', message: 'Verified account required to register MCP servers.' });
  }

  const { id, name, url, transport, command, args, headers, env } = req.body || {};
  if (!id || !name) {
    return res.status(400).json({ error: 'id and name are required' });
  }

  const targetTransport = transport || (command ? 'stdio' : 'streamable_http');

  // Process-backed MCP execution may be provisioned by trusted internal
  // startup code only. Never expose interpreter/command launching through
  // public HTTP routes, including operator-authenticated requests.
  if (targetTransport === 'stdio') {
    return res.status(403).json({
      error: 'FORBIDDEN', code: 'STDIO_MANAGEMENT_INTERNAL_ONLY',
      message: 'Process-backed MCP servers cannot be managed through the public API.'
    });
  }

  try {
    mcpHost.registerServer(
      { id, name, url, transport: targetTransport, command, args, headers, env },
      { ownerId: authUserId || 'platform', isOperator: isOp }
    );
    const status = mcpHost.getServerStatus(id, { ownerId: authUserId || 'platform', isOperator: isOp });
    res.status(201).json({ success: true, server: status });
  } catch (err: any) {
    const statusCode = err instanceof McpSecurityError ? err.statusCode : 400;
    res.status(statusCode).json({ error: err.message, code: err.code || 'MCP_REGISTRATION_FAILED' });
  }
});

app.post('/api/mcp/servers/:id/connect', async (req: Request, res: Response) => {
  const isOp = isVerifiedMcpOperator(req);
  const authUserId = resolveMcpCallerUserId(req);
  if (!authUserId && !isOp) {
    return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED', message: 'Verified account required to connect MCP servers.' });
  }

  const id = getParam(req.params.id);

  try {
    const config = mcpHost.getServerConfig(id, { ownerId: authUserId || undefined, isOperator: isOp });
    if (config?.transport === 'stdio') {
      return res.status(403).json({
        error: 'FORBIDDEN', code: 'STDIO_MANAGEMENT_INTERNAL_ONLY',
        message: 'Process-backed MCP servers cannot be connected through the public API.'
      });
    }
    const success = await mcpHost.connectServer(id, { ownerId: authUserId || undefined, isOperator: isOp });
    const status = mcpHost.getServerStatus(id, { ownerId: authUserId || undefined, isOperator: isOp });
    res.json({ success, status });
  } catch (err: any) {
    const statusCode = err instanceof McpSecurityError ? err.statusCode : 500;
    res.status(statusCode).json({ error: err.message, code: err.code || 'MCP_CONNECT_FAILED' });
  }
});

app.post('/api/mcp/servers/:id/disconnect', async (req: Request, res: Response) => {
  const isOp = isVerifiedMcpOperator(req);
  const authUserId = resolveMcpCallerUserId(req);
  if (!authUserId && !isOp) {
    return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED', message: 'Verified account required to disconnect MCP servers.' });
  }

  const id = getParam(req.params.id);

  try {
    const success = await mcpHost.disconnectServer(id, { ownerId: authUserId || undefined, isOperator: isOp });
    res.json({ success });
  } catch (err: any) {
    const statusCode = err instanceof McpSecurityError ? err.statusCode : 500;
    res.status(statusCode).json({ error: err.message, code: err.code || 'MCP_DISCONNECT_FAILED' });
  }
});

app.delete('/api/mcp/servers/:id', (req: Request, res: Response) => {
  const isOp = isVerifiedMcpOperator(req);
  const authUserId = resolveMcpCallerUserId(req);
  if (!authUserId && !isOp) {
    return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED', message: 'Verified account required to delete MCP servers.' });
  }

  const id = getParam(req.params.id);

  try {
    const success = mcpHost.unregisterServer(id, { ownerId: authUserId || undefined, isOperator: isOp });
    res.json({ success });
  } catch (err: any) {
    const statusCode = err instanceof McpSecurityError ? err.statusCode : 500;
    res.status(statusCode).json({ error: err.message, code: err.code || 'MCP_DELETE_FAILED' });
  }
});

app.get('/api/mcp/servers/:id/tools', (req: Request, res: Response) => {
  const isOp = isVerifiedMcpOperator(req);
  const authUserId = resolveMcpCallerUserId(req);
  if (!authUserId && !isOp) {
    return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED', message: 'Verified account required to inspect MCP tools.' });
  }

  const id = getParam(req.params.id);

  try {
    const tools = mcpHost.listServerTools(id, { ownerId: authUserId || undefined, isOperator: isOp });
    res.json({ tools });
  } catch (err: any) {
    const statusCode = err instanceof McpSecurityError ? err.statusCode : 500;
    res.status(statusCode).json({ error: err.message, code: err.code || 'MCP_TOOLS_FAILED' });
  }
});

// -----------------------------------------------------------------------
// Python Sandbox Execution (Isolated local workspace with credential scrubbing)
// -----------------------------------------------------------------------
app.post('/api/sandbox/python/execute', async (req: Request, res: Response) => {
  const { code, files, timeoutMs } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'code string is required' });
  }
  try {
    const result = await toolGateway.execute({
      toolName: 'python_sandbox',
      arguments: { code, files, timeoutMs },
      context: {
        runId: `run_sandbox_${Date.now()}`,
        principal: req.principal!
      }
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// Persistent Browser Sessions & Automation
// -----------------------------------------------------------------------
app.get('/api/browser/sessions', (req: Request, res: Response) => {
  const browserAdapter = toolGateway.getBrowserAdapter();
  const sessions = browserAdapter.listSessions(req.principal!);
  res.json({ sessions });
});

app.post('/api/browser/sessions/:id/restart', async (req: Request, res: Response) => {
  const browserAdapter = toolGateway.getBrowserAdapter();
  try {
    await browserAdapter.restartSession(req.principal!);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/sessions/:id/close', async (req: Request, res: Response) => {
  const browserAdapter = toolGateway.getBrowserAdapter();
  try {
    await browserAdapter.closeSession(req.principal!);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/action', async (req: Request, res: Response) => {
  const tier = await resolveCallerTier(req);
  if (!isFeatureAllowedForTier('browsertools', tier)) {
    return res.status(403).json({
      error: 'PLAN_TOOL_RESTRICTED',
      tool: 'browser',
      message: 'Browser execution tools require AIRA Pro plan.',
      requiredTier: 'pro'
    });
  }
  const { action, ...args } = req.body || {};
  const toolName = `browser_${action}`;
  if (!toolGateway.hasTool(toolName)) {
    return res.status(400).json({ error: `Unknown browser action "${action}". Valid: navigate, extract, type, click, screenshot, scroll, wait` });
  }
  try {
    const result = await toolGateway.execute({
      toolName,
      arguments: args,
      context: {
        runId: `run_browser_${Date.now()}`,
        principal: { ...req.principal!, ...(tier ? { tier } : {}) } as any
      }
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// Autonomous Agent Task Lifecycle
// -----------------------------------------------------------------------
app.post('/api/agent/autonomous/tasks', async (req: Request, res: Response) => {
  const { objective, plan, idempotencyKey } = req.body || {};
  const effectiveIdempotencyKey = idempotencyKey || (req.headers['idempotency-key'] as string | undefined);
  if (!objective || typeof objective !== 'string') {
    return res.status(400).json({ error: 'objective is required' });
  }
  const tier = await resolveCallerTier(req);
  if (!isFeatureAllowedForTier('autonomous', tier)) {
    const requiredTier = getMinimumRequiredTierForFeature('autonomous');
    return res.status(403).json({
      error: 'PLAN_CAPABILITY_RESTRICTED',
      capability: 'autonomous_agents',
      message: 'Autonomous multi-step agent execution requires AIRA Plus or higher.',
      callerTier: tier,
      requiredTier
    });
  }
  try {
    const engine = agentRuntime.getAutonomousEngine();
    const task = await engine.createTask(objective, req.principal!, plan, effectiveIdempotencyKey);
    const startImmediate = req.query.start !== 'false' && process.env.AIRA_AUTONOMOUS_QUEUE_ONLY !== 'true';
    if (startImmediate) {
      const started = await engine.startTask(task.taskId);
      return res.status(201).json({ task: started, taskId: task.taskId, status: 'queued', taskName: objective, tier });
    }
    res.status(201).json({ task, taskId: task.taskId, status: 'queued', taskName: objective, tier });
  } catch (err: any) {
    if (err?.code === 'PERSISTENCE_UNAVAILABLE' || err?.name === 'AutonomousPersistenceUnavailableError') {
      return res.status(503).json({ error: 'PERSISTENCE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agent/autonomous/tasks', async (req: Request, res: Response) => {
  try {
    const engine = agentRuntime.getAutonomousEngine();
    const tasks = await engine.getRepository().listTasksByPrincipal(req.principal!.userId);
    res.json({ tasks });
  } catch (err: any) {
    if (err?.code === 'PERSISTENCE_UNAVAILABLE' || err?.name === 'AutonomousPersistenceUnavailableError') {
      return res.status(503).json({ error: 'PERSISTENCE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agent/autonomous/tasks/:id', async (req: Request, res: Response) => {
  const id = getParam(req.params.id);
  try {
    const engine = agentRuntime.getAutonomousEngine();
    const task = await engine.getTask(id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const isOwner = task.principal.userId === req.principal?.userId;
    const isAdmin = Array.isArray(req.principal?.roles) && req.principal.roles.includes('admin');
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden: task belongs to another principal' });
    }
    res.json({ task });
  } catch (err: any) {
    if (err?.code === 'PERSISTENCE_UNAVAILABLE' || err?.name === 'AutonomousPersistenceUnavailableError') {
      return res.status(503).json({ error: 'PERSISTENCE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/autonomous/tasks/:id/pause', async (req: Request, res: Response) => {
  const id = getParam(req.params.id);
  const engine = agentRuntime.getAutonomousEngine();
  try {
    const existing = await engine.getTask(id);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    const isOwner = existing.principal.userId === req.principal?.userId;
    const isAdmin = Array.isArray(req.principal?.roles) && req.principal.roles.includes('admin');
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden: task belongs to another principal' });
    }
    const task = await engine.pauseTask(id);
    res.json({ task });
  } catch (err: any) {
    if (err?.code === 'PERSISTENCE_UNAVAILABLE' || err?.name === 'AutonomousPersistenceUnavailableError') {
      return res.status(503).json({ error: 'PERSISTENCE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/autonomous/tasks/:id/resume', async (req: Request, res: Response) => {
  const id = getParam(req.params.id);
  const engine = agentRuntime.getAutonomousEngine();
  try {
    const existing = await engine.getTask(id);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    const isOwner = existing.principal.userId === req.principal?.userId;
    const isAdmin = Array.isArray(req.principal?.roles) && req.principal.roles.includes('admin');
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden: task belongs to another principal' });
    }
    // Resume can restart execution after a paid plan expires; ownership alone
    // never grants an autonomous capability (including to operators/admins).
    const tier = await resolveCallerTier(req);
    if (!isFeatureAllowedForTier('autonomous', tier)) {
      const requiredTier = getMinimumRequiredTierForFeature('autonomous');
      return res.status(403).json({
        error: 'PLAN_CAPABILITY_RESTRICTED',
        capability: 'autonomous_agents',
        message: 'Current subscription does not allow autonomous execution. Requires AIRA Plus or higher.',
        callerTier: tier,
        requiredTier
      });
    }
    const task = await engine.resumeTask(id);
    res.json({ task });
  } catch (err: any) {
    if (err?.code === 'ENTITLEMENT_SERVICE_UNAVAILABLE') {
      return res.status(503).json({ error: 'ENTITLEMENT_SERVICE_UNAVAILABLE' });
    }
    if (err?.code === 'PERSISTENCE_UNAVAILABLE' || err?.name === 'AutonomousPersistenceUnavailableError') {
      return res.status(503).json({ error: 'PERSISTENCE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/autonomous/tasks/:id/cancel', async (req: Request, res: Response) => {
  const id = getParam(req.params.id);
  const { reason } = req.body || {};
  const engine = agentRuntime.getAutonomousEngine();
  try {
    const existing = await engine.getTask(id);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    const isOwner = existing.principal.userId === req.principal?.userId;
    const isAdmin = Array.isArray(req.principal?.roles) && req.principal.roles.includes('admin');
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden: task belongs to another principal' });
    }
    const task = await engine.cancelTask(id, reason);
    res.json({ task });
  } catch (err: any) {
    if (err?.code === 'PERSISTENCE_UNAVAILABLE' || err?.name === 'AutonomousPersistenceUnavailableError') {
      return res.status(503).json({ error: 'PERSISTENCE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/autonomous/tasks/:id/approve', async (req: Request, res: Response) => {
  const id = getParam(req.params.id);
  const { approvalRequestId, approved, notes } = req.body || {};
  if (!approvalRequestId) {
    return res.status(400).json({ error: 'approvalRequestId is required' });
  }
  if (!isExplicitAutonomousApprovalDecision(approved)) {
    return res.status(400).json({ error: 'approved must be explicitly true or false' });
  }
  const engine = agentRuntime.getAutonomousEngine();
  try {
    const existing = await engine.getTask(id);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    const isOwner = existing.principal.userId === req.principal?.userId;
    const isAdmin = Array.isArray(req.principal?.roles) && req.principal.roles.includes('admin');
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden: task belongs to another principal' });
    }
    const task = await engine.approveStep(id, approvalRequestId, approved, notes);
    res.json({ task });
  } catch (err: any) {
    if (err?.code === 'PERSISTENCE_UNAVAILABLE' || err?.name === 'AutonomousPersistenceUnavailableError') {
      return res.status(503).json({ error: 'PERSISTENCE_UNAVAILABLE', message: err.message });
    }
    res.status(500).json({ error: err.message });
  }
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
    const tier = await resolveCallerTier(req);
    const requestedModel = normalizeModelIdentifier(parsed.modelPolicy?.model);
    if (requestedModel !== 'mock-deterministic' && !isModelAllowedForTier(requestedModel, tier)) {
      const requiredTier = isModelAllowedForTier(requestedModel, 'plus') ? 'plus' : 'pro';
      return res.status(403).json({
        error: 'PLAN_MODEL_RESTRICTED',
        message: `Model '${requestedModel}' requires higher plan tier`,
        callerTier: tier,
        requiredTier,
        allowedModels: PLAN_MODEL_ALLOWLIST[tier] || []
      });
    }
    const run = await agentRuntime.createAndExecuteRun(parsed, req.principal!, { callerTier: tier });
    res.status(201).json(run);
  } catch (err: any) {
    if (err instanceof PlanRestrictionError) {
      return res.status(403).json({
        error: err.code,
        message: err.message,
        callerTier: err.callerTier,
        requiredTier: err.requiredTier
      });
    }
    if (err instanceof EntitlementServiceUnavailableError) {
      return res.status(503).json({ error: err.code, message: err.message });
    }
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
  let firstTokenEmitted = false;
  let quotaSettled = false;
  let quotaSettlementPromise: Promise<void> | null = null;
  let releaseQuotaIfUnused: () => Promise<void> = async () => {};
  try {
    const { messages, history, prompt, model: rawModel, extendedThinking, thinkingBudget, reasoningBudget, systemPrompt, contextSubgraph, attachments, conversationId, intent } = req.body || {};
    if (!rawModel || typeof rawModel !== 'string' || !rawModel.trim()) {
      return res.status(400).json({ error: 'MODEL_REQUIRED', message: 'Missing model parameter' });
    }
    const model = normalizeModelIdentifier(rawModel);

    // Feature 5 & 7: Server-side authoritative tier resolution and model allowlist gate
    const tier = await resolveCallerTier(req);
    const quota = COMMERCIAL_PLANS[tier] || COMMERCIAL_PLANS.free;
    const allowedModels = PLAN_MODEL_ALLOWLIST[tier] || [];

    if (!isModelAllowedForTier(model, tier)) {
      const isPlusModel = isModelAllowedForTier(model, 'plus');
      const requiredTier = isPlusModel ? 'plus' : 'pro';
      return res.status(403).json({
        error: 'PLAN_MODEL_RESTRICTED',
        message: `Model '${model}' requires higher plan tier`,
        callerTier: tier,
        requiredTier,
        allowedModels
      });
    }

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

    let principalId = req.principal?.userId || (req as any).guestSession?.id || (req as any).user?.id;
    if (!principalId || principalId === 'anonymous') {
      const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'anon';
      principalId = `guest_${crypto.createHash('sha256').update(clientIp).digest('hex').slice(0, 16)}`;
    }
    const capacityConfig = modelRouter.capacityGuard.getConfig();
    const isFastTarget = modelRouter.capacityGuard.isFastTarget(model);

    // Retried streams must use the same key; the ledger refuses to run them twice.
    const chatIdempotencyKey = req.get('Idempotency-Key') || undefined;
    if (chatIdempotencyKey && (chatIdempotencyKey.length < 8 || chatIdempotencyKey.length > 128 || !/^[\x21-\x7e]+$/.test(chatIdempotencyKey))) {
      return res.status(400).json({ error: 'INVALID_IDEMPOTENCY_KEY' });
    }

    // Feature 6: Atomic Quota Reservation Gate (pre-stream reservation)
    let chatReservation: { reservationToken: string; remainingDaily: number; remainingMonthly: number } | null = null;
    try {
      chatReservation = await commercialBillingService.reserveStandardChat(principalId, tier, model, chatIdempotencyKey);
    } catch (quotaErr: any) {
      if (quotaErr instanceof StandardChatPlanChangedError) {
        return res.status(403).json({
          error: 'PLAN_MODEL_RESTRICTED', message: quotaErr.message,
          callerTier: quotaErr.currentTier
        });
      }
      if (quotaErr instanceof StandardChatReplayError) {
        return res.status(409).json({
          error: quotaErr.code,
          message: quotaErr.message,
          idempotencyConflict: quotaErr.conflictingModel
        });
      }
      if (quotaErr instanceof StandardQuotaExceededError) {
        const errorKey = quotaErr.reason === 'daily' ? 'DAILY_QUOTA_EXHAUSTED' : 'MONTHLY_QUOTA_EXHAUSTED';
        const message = quotaErr.reason === 'daily'
          ? `Daily limit of ${quota.dailyStandardChatLimit} chats reached.`
          : `Monthly limit of ${quota.monthlyStandardChatUnits} chats reached.`;
        return res.status(429).json({
          error: errorKey,
          message,
          callerTier: tier,
          upgradeRequired: tier !== 'pro'
        });
      }
      console.error('[CHAT_STREAM_RESERVATION_FAILURE]', quotaErr);
      return res.status(503).json({
        error: 'ENTITLEMENT_SERVICE_UNAVAILABLE',
        message: 'Unable to verify quota entitlements. Execution denied.'
      });
    }

    quotaSettled = false;
    let shouldConsumeReasoningBoost = false;

    const settleQuotaOnce = async () => {
      if (chatReservation && !quotaSettled) {
        // EventEmitter async delta listeners can overlap. Share one in-flight
        // settlement so they cannot consume multiple complimentary boosts.
        if (!quotaSettlementPromise) {
          quotaSettlementPromise = (async () => {
            const newlySettled = await commercialBillingService.settleStandardChat(chatReservation.reservationToken);
            quotaSettled = true;
            if (newlySettled && shouldConsumeReasoningBoost) {
              await commercialBillingService.tryConsumeReasoningBoost(principalId).catch(() => false);
            }
          })().catch((settleErr) => {
            console.warn('[CHAT_STREAM] Settlement error:', settleErr);
          }).finally(() => {
            quotaSettlementPromise = null;
          });
        }
        await quotaSettlementPromise;
      }
    };

    releaseQuotaIfUnused = async () => {
      if (chatReservation && !quotaSettled && !firstTokenEmitted) {
        try {
          await commercialBillingService.releaseStandardChat(chatReservation.reservationToken, 'Client disconnected pre-token');
          quotaSettled = true;
        } catch (releaseErr) {
          console.warn('[CHAT_STREAM] Quota release error:', releaseErr);
        }
      }
    };

    // Section 20: Bounded context history for Fast mode
    let effectiveHistory = contextHistory;
    if (isFastTarget && Array.isArray(contextHistory) && contextHistory.length > capacityConfig.maxContextTurns) {
      effectiveHistory = contextHistory.slice(-capacityConfig.maxContextTurns);
    }

    const clientAbort = new AbortController();
    res.on('close', async () => {
      if (!res.writableEnded) clientAbort.abort(new Error('CLIENT_CLOSED'));
      if (!firstTokenEmitted) {
        await releaseQuotaIfUnused();
      }
    });

    let headersFlushed = false;
    admission = await modelRouter.capacityGuard.admit(
      {
        principalId,
        tier,
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
      await releaseQuotaIfUnused();
      if (admission.reason === 'CONCURRENCY_LIMIT_EXCEEDED') {
        const userMaxConcurrent = tier === 'pro' ? 2 : 1;
        if (!headersFlushed) {
          return res.status(429).json({
            error: 'CONCURRENCY_LIMIT_EXCEEDED',
            message: admission.userMessage || `Plan ${tier} allows ${userMaxConcurrent} concurrent request(s).`,
            activeCount: userMaxConcurrent,
            limit: userMaxConcurrent
          });
        } else {
          res.write(`event: error\ndata: ${JSON.stringify({
            error: 'CONCURRENCY_LIMIT_EXCEEDED',
            message: admission.userMessage || `Plan ${tier} allows ${userMaxConcurrent} concurrent request(s).`,
            activeCount: userMaxConcurrent,
            limit: userMaxConcurrent
          })}\n\n`);
          return res.end();
        }
      }

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

    const trimmedSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
    const trimmedSubgraph = typeof contextSubgraph === 'string' ? contextSubgraph.trim() : '';
    const mergedSystemPrompt = (
      trimmedSystemPrompt &&
      trimmedSubgraph &&
      trimmedSystemPrompt.includes(trimmedSubgraph)
    )
      ? trimmedSystemPrompt
      : [trimmedSystemPrompt, trimmedSubgraph].filter(Boolean).join('\n\n');

    const run = await withInferenceReservation(modelRouter.capacityGuard, admission, () => agentRuntime.createRun({
      prompt: promptText,
      conversationId: conversationId || undefined,
      attachments: Array.isArray(attachments) ? attachments : undefined,
      systemPrompt: mergedSystemPrompt,
      context: { history: effectiveHistory },
      intent: (typeof intent === 'string' && intent.trim()) ? intent.trim() as any : undefined,
      modelPolicy: {
        model: model || 'aira-auto',
        extendedThinking: Boolean(extendedThinking),
        reasoningBudget: typeof thinkingBudget === 'number' ? Math.min(Math.max(thinkingBudget, 1024), 8192) : (typeof reasoningBudget === 'number' ? reasoningBudget : undefined),
      }
    }, req.principal!, { callerTier: tier }), clientAbort.signal);
    shouldConsumeReasoningBoost = Boolean(run.modelPolicy?.extendedThinking);
    if (clientAbort.signal.aborted) {
      await releaseQuotaIfUnused();
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

    let sseQueue = Promise.resolve();
    let artifactEmitted = false;
    const processStreamEvent = async (evt: any) => {
      if (res.writableEnded) return;
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
        firstTokenEmitted = true;
        await settleQuotaOnce();
        if (res.writableEnded) return;
        deltaCount++;
        res.write(`event: content_delta\ndata: ${JSON.stringify({ text: evt.data.delta })}\n\n`);
      } else if (evt.type === 'thinking.delta') {
        firstTokenEmitted = true;
        await settleQuotaOnce();
        if (res.writableEnded) return;
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
        await settleQuotaOnce();
        if (res.writableEnded) return;
        await finalizeAndEmitMetrics();
        res.write(`event: workflow_completed\ndata: ${JSON.stringify(evt.data)}\n\n`);
        res.write(`event: done\ndata: [DONE]\n\n`);
        stream.off('event', handler);
        res.end();
      } else if (evt.type === 'artifact.created') {
        artifactEmitted = true;
        res.write(`event: artifact_open\ndata: ${JSON.stringify(evt.data)}\n\n`);
        res.write(`event: artifact_delta\ndata: ${JSON.stringify({ chunk: evt.data.content })}\n\n`);
        res.write(`event: artifact_close\ndata: ${JSON.stringify({ id: evt.data.id })}\n\n`);
      } else if (evt.type === 'approval.required') {
        await releasePermitIfHeld();
        if (res.writableEnded) return;
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
        if (!firstTokenEmitted) {
          await releaseQuotaIfUnused();
        }
        if (res.writableEnded) return;
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
        if (!firstTokenEmitted) {
          await releaseQuotaIfUnused();
        }
        if (res.writableEnded) return;
        await finalizeAndEmitMetrics();
        res.write(`event: error\ndata: ${JSON.stringify({
          error: evt.data?.error || 'Aira run was cancelled',
        })}\n\n`);
        stream.off('event', handler);
        res.end();
      } else if (evt.type === 'run.completed') {
        if (deltaCount === 0 && !artifactEmitted) {
          if (!firstTokenEmitted) {
            await releaseQuotaIfUnused();
          }
          if (res.writableEnded) return;
          await finalizeAndEmitMetrics();
          res.write(`event: error\ndata: ${JSON.stringify({
            error: 'Aira completed without producing a response.',
            code: 'EMPTY_PROVIDER_RESPONSE',
          })}\n\n`);
          stream.off('event', handler);
          res.end();
          return;
        }
        await settleQuotaOnce();
        if (res.writableEnded) return;
        await finalizeAndEmitMetrics();
        res.write(`event: done\ndata: [DONE]\n\n`);
        stream.off('event', handler);
        res.end();
      }
    };

    const handler = (evt: any) => {
      if (evt.type === 'content.delta') {
        if (tFirstDelta === null) tFirstDelta = performance.now();
        firstTokenEmitted = true;
      } else if (evt.type === 'thinking.delta') {
        firstTokenEmitted = true;
      }
      sseQueue = sseQueue.then(() => processStreamEvent(evt)).catch((err) => {
        console.warn('[CHAT_STREAM] SSE serialization error:', err);
      });
    };

    stream.on('event', handler);
    res.on('close', async () => {
      if (!firstTokenEmitted) {
        await releaseQuotaIfUnused();
      }
      if (res.writableEnded) return;
      await releasePermitIfHeld();
      stream.off('event', handler);
      agentRuntime.cancelRun(run.id).catch(() => {});
    });

    await withInferenceReservation(modelRouter.capacityGuard, admission, () => agentRuntime.startRun(run.id), clientAbort.signal);
  } catch (err: any) {
    if (!firstTokenEmitted && releaseQuotaIfUnused) {
      await releaseQuotaIfUnused().catch(() => {});
    }
    if (admission?.permit) {
      await admission.permit.release().catch(() => {});
    }
    if (err instanceof UnsupportedModelIdentifierError && !res.headersSent) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    console.error('Chat stream failed', { code: err?.code, message: err?.message });
    const entitlementUnavailable = err?.code === 'ENTITLEMENT_SERVICE_UNAVAILABLE';
    const databaseUnavailable = entitlementUnavailable || isTemporaryDatabaseError(err);
    const code = entitlementUnavailable ? 'ENTITLEMENT_SERVICE_UNAVAILABLE' : databaseUnavailable ? 'DATABASE_TEMPORARILY_UNAVAILABLE' : 'CHAT_STREAM_FAILED';
    const message = databaseUnavailable
      ? 'Temporary database connectivity problem. Please retry your request.'
      : 'Aira could not complete this request.';
    if (!res.headersSent) {
      res.status(databaseUnavailable ? 503 : 500).json({ error: message, code });
    } else if (!res.writableEnded) {
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
    const { toolName, toolId, arguments: args, input, idempotencyKey, runId } = req.body || {};
    const name = toolName || toolId;
    if (!name) {
      return res.status(400).json({ error: 'toolName or toolId is required.' });
    }

    const tier = await resolveCallerTier(req);
    if (name.startsWith('browser_') && !isFeatureAllowedForTier('browsertools', tier)) {
      return res.status(403).json({
        error: 'PLAN_TOOL_RESTRICTED',
        tool: name,
        message: 'Browser execution tools require AIRA Pro plan.',
        requiredTier: 'pro'
      });
    }

    if (name === 'python_sandbox' && !isFeatureAllowedForTier('pythonsandbox', tier)) {
      return res.status(403).json({
        error: 'PLAN_TOOL_RESTRICTED',
        tool: name,
        message: 'Python Sandbox execution requires AIRA Pro plan.',
        requiredTier: 'pro'
      });
    }

    const effectiveRunId = runId || `run_direct_${Date.now()}`;
    const result = await toolGateway.execute({
      toolName: name,
      arguments: args || input || {},
      context: {
        runId: effectiveRunId,
        principal: { ...req.principal!, ...(tier ? { tier } : {}) } as any,
        idempotencyKey
      }
    });

    if (result.errorCode === 'PLAN_TOOL_RESTRICTED') {
      return res.status(403).json({
        error: 'PLAN_TOOL_RESTRICTED',
        tool: name,
        message: result.error,
        requiredTier: 'pro'
      });
    }

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

app.delete('/api/knowledge/memories/:id', async (req: Request, res: Response) => {
  const id = getParam(req.params.id);
  const scope: PrincipalScope = {
    principalId: req.principal?.userId,
    workspaceId: req.principal?.workspaceId,
    isSystem: false
  };
  const deleted = await knowledgeEngine.deleteMemory(id, scope);
  res.json({ success: deleted });
});

app.post('/api/knowledge/memories/purge', async (req: Request, res: Response) => {
  const scope: PrincipalScope = {
    principalId: req.principal?.userId,
    workspaceId: req.principal?.workspaceId,
    isSystem: false
  };
  const purgedCount = await knowledgeEngine.purgeMemories(scope);
  res.json({ success: true, purgedCount });
});

app.get('/api/knowledge/memories/export', async (req: Request, res: Response) => {
  const scope: PrincipalScope = {
    principalId: req.principal?.userId,
    workspaceId: req.principal?.workspaceId,
    isSystem: false
  };
  const memories = await knowledgeEngine.getMemories(scope);
  res.setHeader('Content-Disposition', 'attachment; filename="aira-memory-export.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({ exportedAt: Date.now(), principalId: req.principal?.userId, memories }, null, 2));
});

app.post('/api/knowledge/memories/compact', async (req: Request, res: Response) => {
  const { maxTokens } = req.body || {};
  const budget = maxTokens || 4000;
  const scope: PrincipalScope = {
    principalId: req.principal?.userId,
    workspaceId: req.principal?.workspaceId,
    isSystem: false
  };
  const memories = await knowledgeEngine.getMemories(scope);
  const sorted = [...memories].sort((a, b) => b.createdAt - a.createdAt);
  let totalChars = 0;
  const kept: typeof memories = [];
  const pruned: string[] = [];
  for (const m of sorted) {
    const chars = m.key.length + m.value.length;
    if (totalChars + chars <= budget * 4) {
      kept.push(m);
      totalChars += chars;
    } else {
      pruned.push(m.id);
    }
  }
  res.json({
    originalCount: memories.length,
    compactedCount: kept.length,
    prunedCount: pruned.length,
    estimatedTokens: Math.ceil(totalChars / 4)
  });
});

// -----------------------------------------------------------------------
// Safe Downgrade Retention Policy & Project/Memory Lifecycle (Feature 12)
// -----------------------------------------------------------------------
export interface ApiProjectItem {
  id: string;
  userId: string;
  name: string;
  description?: string;
  documents?: any[];
  tags?: string[];
  readOnly: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface ApiMemoryItem {
  id: string;
  userId: string;
  content: string;
  metadata?: Record<string, any>;
  tags?: string[];
  readOnly: boolean;
  createdAt: string;
}

app.get('/api/projects', async (req: Request, res: Response) => {
  try {
    const tier = await resolveCallerTier(req);
    if (tier === 'guest') {
      return res.status(401).json({ error: 'GUEST_UNAUTHORIZED', message: 'Projects require an authenticated account' });
    }
    const userId = req.principal?.userId || (req as any).user?.id;
    if (!userId || userId === 'anonymous') {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const plan = COMMERCIAL_PLANS[tier] || COMMERCIAL_PLANS.free;
    const maxAllowed = (plan as any).quotas?.projects ?? plan.maxProjects;

    const rows = await db('memory_records')
      .where({ principal_id: userId, type: 'project', is_system: false })
      .orderBy('created_at', 'asc');

    const userProjects: ApiProjectItem[] = rows.map((r, idx) => {
      const isReadOnly = maxAllowed !== -1 && idx >= maxAllowed;
      let contextData: any = {};
      try {
        contextData = typeof r.context === 'string' ? JSON.parse(r.context) : (r.context || {});
      } catch {}
      return {
        id: r.id,
        userId: r.principal_id,
        name: r.content || contextData.name || 'Untitled Project',
        description: contextData.description || '',
        documents: contextData.documents || [],
        tags: contextData.tags || [],
        readOnly: isReadOnly,
        createdAt: new Date(Number(r.created_at)).toISOString(),
        updatedAt: contextData.updatedAt ? new Date(Number(contextData.updatedAt)).toISOString() : new Date(Number(r.created_at)).toISOString()
      };
    });

    res.json({ projects: userProjects, total: userProjects.length });
  } catch (err: any) {
    console.error('[PROJECTS_GET_ERROR]', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve projects' });
  }
});

app.post('/api/projects', async (req: Request, res: Response) => {
  try {
    const tier = await resolveCallerTier(req);
    if (tier === 'guest') {
      return res.status(401).json({ error: 'GUEST_UNAUTHORIZED', message: 'Projects require an authenticated account' });
    }
    const userId = req.principal?.userId || (req as any).user?.id;
    if (!userId || userId === 'anonymous') {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const plan = COMMERCIAL_PLANS[tier] || COMMERCIAL_PLANS.free;
    const maxAllowed = (plan as any).quotas?.projects ?? plan.maxProjects;

    const id = `proj_${crypto.randomBytes(4).toString('hex')}`;
    const name = (req.body?.name || 'New Project').trim().slice(0, 120);
    const description = (req.body?.description || '').trim();
    const documents = Array.isArray(req.body?.documents) ? req.body.documents : [];
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const now = Date.now();

    const contextObj = {
      name,
      description,
      documents,
      tags,
      createdAt: now,
      updatedAt: now
    };

    const currentCount = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`aira-project-quota:${userId}`]);
      const countRow = await trx('memory_records')
        .where({ principal_id: userId, type: 'project', is_system: false })
        .count('id as count').first();
      const count = Number(countRow?.count || 0);
      if (maxAllowed !== -1 && count >= maxAllowed) return count;
      await trx('memory_records').insert({
        id,
        principal_id: userId,
        workspace_id: req.principal?.workspaceId || 'default',
        type: 'project',
        agent_id: 'user_project',
        content: name,
        context: JSON.stringify(contextObj),
        is_system: false,
        created_at: now
      });
      return count;
    });

    if (maxAllowed !== -1 && currentCount >= maxAllowed) {
      return res.status(403).json({
        error: 'QUOTA_EXCEEDED_READ_ONLY_MODE', code: 'PROJECT_LIMIT_REACHED',
        message: `Maximum project limit of ${maxAllowed} reached for plan ${tier}.`, currentCount, maxAllowed
      });
    }

    const project: ApiProjectItem = {
      id,
      userId,
      name,
      description,
      documents,
      tags,
      readOnly: false,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString()
    };
    res.status(201).json(project);
  } catch (err: any) {
    console.error('[PROJECTS_POST_ERROR]', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create project' });
  }
});

app.get('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const tier = await resolveCallerTier(req);
    if (tier === 'guest') {
      return res.status(401).json({ error: 'GUEST_UNAUTHORIZED', message: 'Projects require an authenticated account' });
    }
    const userId = req.principal?.userId || (req as any).user?.id;
    if (!userId || userId === 'anonymous') {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const projectId = getParam(req.params.id);
    const plan = COMMERCIAL_PLANS[tier] || COMMERCIAL_PLANS.free;
    const maxAllowed = (plan as any).quotas?.projects ?? plan.maxProjects;

    const rows = await db('memory_records')
      .where({ principal_id: userId, type: 'project', is_system: false })
      .orderBy('created_at', 'asc');

    const index = rows.findIndex(r => r.id === projectId);
    if (index === -1) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `Project ${projectId} not found` });
    }

    const r = rows[index];
    const isReadOnly = maxAllowed !== -1 && index >= maxAllowed;
    let contextData: any = {};
    try {
      contextData = typeof r.context === 'string' ? JSON.parse(r.context) : (r.context || {});
    } catch {}

    res.json({
      id: r.id,
      userId: r.principal_id,
      name: r.content || contextData.name || 'Untitled Project',
      description: contextData.description || '',
      documents: contextData.documents || [],
      tags: contextData.tags || [],
      readOnly: isReadOnly,
      createdAt: new Date(Number(r.created_at)).toISOString(),
      updatedAt: contextData.updatedAt ? new Date(Number(contextData.updatedAt)).toISOString() : new Date(Number(r.created_at)).toISOString()
    });
  } catch (err: any) {
    console.error('[PROJECTS_GET_BY_ID_ERROR]', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve project' });
  }
});

app.patch('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const tier = await resolveCallerTier(req);
    if (tier === 'guest') {
      return res.status(401).json({ error: 'GUEST_UNAUTHORIZED', message: 'Projects require an authenticated account' });
    }
    const userId = req.principal?.userId || (req as any).user?.id;
    if (!userId || userId === 'anonymous') {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const projectId = getParam(req.params.id);
    const plan = COMMERCIAL_PLANS[tier] || COMMERCIAL_PLANS.free;
    const maxAllowed = (plan as any).quotas?.projects ?? plan.maxProjects;

    const rows = await db('memory_records')
      .where({ principal_id: userId, type: 'project', is_system: false })
      .orderBy('created_at', 'asc');

    const index = rows.findIndex(r => r.id === projectId);
    if (index === -1) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `Project ${projectId} not found` });
    }

    const isReadOnly = maxAllowed !== -1 && index >= maxAllowed;
    if (isReadOnly) {
      return res.status(403).json({
        error: 'ITEM_READ_ONLY',
        message: 'Modification disallowed while exceeding plan quota.'
      });
    }

    const r = rows[index];
    let contextData: any = {};
    try {
      contextData = typeof r.context === 'string' ? JSON.parse(r.context) : (r.context || {});
    } catch {}

    const updatedName = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 120) : r.content;
    const updatedDesc = req.body?.description !== undefined ? String(req.body.description).trim() : contextData.description;
    const updatedDocs = Array.isArray(req.body?.documents) ? req.body.documents : contextData.documents;
    const updatedTags = Array.isArray(req.body?.tags) ? req.body.tags : contextData.tags;
    const now = Date.now();

    const updatedContext = {
      ...contextData,
      name: updatedName,
      description: updatedDesc,
      documents: updatedDocs,
      tags: updatedTags,
      updatedAt: now
    };

    await db('memory_records')
      .where({ id: projectId, principal_id: userId, type: 'project' })
      .update({
        content: updatedName,
        context: JSON.stringify(updatedContext)
      });

    res.json({
      id: projectId,
      userId,
      name: updatedName,
      description: updatedDesc,
      documents: updatedDocs,
      tags: updatedTags,
      readOnly: false,
      createdAt: new Date(Number(r.created_at)).toISOString(),
      updatedAt: new Date(now).toISOString()
    });
  } catch (err: any) {
    console.error('[PROJECTS_PATCH_ERROR]', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update project' });
  }
});

app.delete('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const tier = await resolveCallerTier(req);
    if (tier === 'guest') {
      return res.status(401).json({ error: 'GUEST_UNAUTHORIZED', message: 'Projects require an authenticated account' });
    }
    const userId = req.principal?.userId || (req as any).user?.id;
    if (!userId || userId === 'anonymous') {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const projectId = getParam(req.params.id);
    const plan = COMMERCIAL_PLANS[tier] || COMMERCIAL_PLANS.free;
    const maxAllowed = (plan as any).quotas?.projects ?? plan.maxProjects;

    const rows = await db('memory_records')
      .where({ principal_id: userId, type: 'project', is_system: false })
      .orderBy('created_at', 'asc');

    const index = rows.findIndex(r => r.id === projectId);
    if (index === -1) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `Project ${projectId} not found` });
    }

    const isReadOnly = maxAllowed !== -1 && index >= maxAllowed;
    if (isReadOnly) {
      return res.status(403).json({
        error: 'ITEM_READ_ONLY',
        message: 'Modification disallowed while exceeding plan quota.'
      });
    }

    await db('memory_records')
      .where({ id: projectId, principal_id: userId, type: 'project' })
      .delete();

    res.json({ success: true, id: projectId });
  } catch (err: any) {
    console.error('[PROJECTS_DELETE_ERROR]', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete project' });
  }
});

app.get('/api/memories', async (req: Request, res: Response) => {
  try {
    const tier = await resolveCallerTier(req);
    if (tier === 'guest') {
      return res.status(401).json({ error: 'GUEST_UNAUTHORIZED', message: 'Memories require an authenticated account' });
    }
    const userId = req.principal?.userId || (req as any).user?.id;
    if (!userId || userId === 'anonymous') {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const plan = COMMERCIAL_PLANS[tier] || COMMERCIAL_PLANS.free;
    const maxAllowed = (plan as any).quotas?.memoryRecords ?? plan.maxMemoryRecords;

    const rows = await db('memory_records')
      .where({ principal_id: userId, type: 'memory', is_system: false })
      .orderBy('created_at', 'asc');

    const userMemories: ApiMemoryItem[] = rows.map((r, idx) => {
      const isReadOnly = maxAllowed !== -1 && idx >= maxAllowed;
      let contextData: any = {};
      try {
        contextData = typeof r.context === 'string' ? JSON.parse(r.context) : (r.context || {});
      } catch {}
      return {
        id: r.id,
        userId: r.principal_id,
        content: r.content,
        metadata: contextData.metadata || {},
        tags: contextData.tags || [],
        readOnly: isReadOnly,
        createdAt: new Date(Number(r.created_at)).toISOString()
      };
    });

    res.json({ memories: userMemories, total: userMemories.length });
  } catch (err: any) {
    console.error('[MEMORIES_GET_ERROR]', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve memories' });
  }
});

app.post('/api/memories', async (req: Request, res: Response) => {
  try {
    const tier = await resolveCallerTier(req);
    if (tier === 'guest') {
      return res.status(401).json({ error: 'GUEST_UNAUTHORIZED', message: 'Memories require an authenticated account' });
    }
    const userId = req.principal?.userId || (req as any).user?.id;
    if (!userId || userId === 'anonymous') {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const plan = COMMERCIAL_PLANS[tier] || COMMERCIAL_PLANS.free;
    const maxAllowed = (plan as any).quotas?.memoryRecords ?? plan.maxMemoryRecords;

    const id = `mem_${crypto.randomBytes(4).toString('hex')}`;
    const content = req.body?.content || '';
    const metadata = req.body?.metadata || {};
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const now = Date.now();

    const currentCount = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`aira-memory-quota:${userId}`]);
      const countRow = await trx('memory_records')
        .where({ principal_id: userId, type: 'memory', is_system: false })
        .count('id as count').first();
      const count = Number(countRow?.count || 0);
      if (maxAllowed !== -1 && count >= maxAllowed) return count;
      await trx('memory_records').insert({
        id,
        principal_id: userId,
        workspace_id: req.principal?.workspaceId || 'default',
        type: 'memory',
        agent_id: 'user_memory',
        content,
        context: JSON.stringify({ metadata, tags }),
        is_system: false,
        created_at: now
      });
      return count;
    });

    if (maxAllowed !== -1 && currentCount >= maxAllowed) {
      return res.status(403).json({
        error: 'QUOTA_EXCEEDED_READ_ONLY_MODE', code: 'MEMORY_LIMIT_REACHED',
        message: `Maximum memory limit of ${maxAllowed} reached for plan ${tier}.`, currentCount, maxAllowed
      });
    }

    const memory: ApiMemoryItem = {
      id,
      userId,
      content,
      metadata,
      tags,
      readOnly: false,
      createdAt: new Date(now).toISOString()
    };
    res.status(201).json(memory);
  } catch (err: any) {
    console.error('[MEMORIES_POST_ERROR]', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create memory' });
  }
});

app.get('/api/memories/:id', async (req: Request, res: Response) => {
  try {
    const tier = await resolveCallerTier(req);
    if (tier === 'guest') {
      return res.status(401).json({ error: 'GUEST_UNAUTHORIZED', message: 'Memories require an authenticated account' });
    }
    const userId = req.principal?.userId || (req as any).user?.id;
    if (!userId || userId === 'anonymous') {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const memoryId = getParam(req.params.id);
    const plan = COMMERCIAL_PLANS[tier] || COMMERCIAL_PLANS.free;
    const maxAllowed = (plan as any).quotas?.memoryRecords ?? plan.maxMemoryRecords;

    const rows = await db('memory_records')
      .where({ principal_id: userId, type: 'memory', is_system: false })
      .orderBy('created_at', 'asc');

    const index = rows.findIndex(r => r.id === memoryId);
    if (index === -1) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `Memory ${memoryId} not found` });
    }

    const r = rows[index];
    const isReadOnly = maxAllowed !== -1 && index >= maxAllowed;
    let contextData: any = {};
    try {
      contextData = typeof r.context === 'string' ? JSON.parse(r.context) : (r.context || {});
    } catch {}

    res.json({
      id: r.id,
      userId: r.principal_id,
      content: r.content,
      metadata: contextData.metadata || {},
      tags: contextData.tags || [],
      readOnly: isReadOnly,
      createdAt: new Date(Number(r.created_at)).toISOString()
    });
  } catch (err: any) {
    console.error('[MEMORIES_GET_BY_ID_ERROR]', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve memory' });
  }
});

app.delete('/api/memories/:id', async (req: Request, res: Response) => {
  try {
    const tier = await resolveCallerTier(req);
    if (tier === 'guest') {
      return res.status(401).json({ error: 'GUEST_UNAUTHORIZED', message: 'Memories require an authenticated account' });
    }
    const userId = req.principal?.userId || (req as any).user?.id;
    if (!userId || userId === 'anonymous') {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const memoryId = getParam(req.params.id);
    const plan = COMMERCIAL_PLANS[tier] || COMMERCIAL_PLANS.free;
    const maxAllowed = (plan as any).quotas?.memoryRecords ?? plan.maxMemoryRecords;

    const rows = await db('memory_records')
      .where({ principal_id: userId, type: 'memory', is_system: false })
      .orderBy('created_at', 'asc');

    const index = rows.findIndex(r => r.id === memoryId);
    if (index === -1) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `Memory ${memoryId} not found` });
    }

    const isReadOnly = maxAllowed !== -1 && index >= maxAllowed;
    if (isReadOnly) {
      return res.status(403).json({
        error: 'ITEM_READ_ONLY',
        message: 'Modification disallowed while exceeding plan quota.'
      });
    }

    await db('memory_records')
      .where({ id: memoryId, principal_id: userId, type: 'memory' })
      .delete();

    res.json({ success: true, id: memoryId });
  } catch (err: any) {
    console.error('[MEMORIES_DELETE_ERROR]', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete memory' });
  }
});

app.post('/api/user/downgrade', async (_req: Request, res: Response) => {
  res.status(400).json({
    error: 'BILLING_UNAVAILABLE',
    message: 'Direct self-service plan downgrades without verified subscription lifecycle are disabled in preview deployment.'
  });
});

app.post('/api/user/upgrade', async (_req: Request, res: Response) => {
  res.status(400).json({
    error: 'BILLING_UNAVAILABLE',
    message: 'Direct self-service plan upgrades without verified payment are disabled in preview deployment.'
  });
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
  let automationResult: Awaited<ReturnType<typeof automationEngine.createAutomation>> | null = null;

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
  if (err?.code === 'ENTITLEMENT_SERVICE_UNAVAILABLE') {
    res.status(503).json({
      error: 'ENTITLEMENT_SERVICE_UNAVAILABLE',
      message: 'Authoritative subscription verification is temporarily unavailable.'
    });
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

