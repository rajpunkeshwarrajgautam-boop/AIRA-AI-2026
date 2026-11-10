import http from 'node:http';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ============================================================================
// AIRA E2E OPAQUE-BOX TEST HARNESS
// Public Contracts & Reference HTTP Server
// ============================================================================

export type PlanTier = 'guest' | 'free' | 'plus' | 'pro';

export interface QuotaDefinition {
  dailyStandardChatLimit: number;
  monthlyPremiumCredits: number;
  complimentaryReasoningBoosts: number;
  savedAgentsLimit: number;
  maxProjects: number;
  maxMemories: number;
  concurrentInferenceLimit: number;
  browserToolAllowed: boolean;
  pythonSandboxAllowed: boolean;
  autonomousAgentAllowed: boolean;
}

export const TIER_QUOTAS: Record<PlanTier, QuotaDefinition> = {
  guest: {
    dailyStandardChatLimit: 5,
    monthlyPremiumCredits: 0,
    complimentaryReasoningBoosts: 0,
    savedAgentsLimit: 0,
    maxProjects: 0,
    maxMemories: 0,
    concurrentInferenceLimit: 1,
    browserToolAllowed: false,
    pythonSandboxAllowed: false,
    autonomousAgentAllowed: false
  },
  free: {
    dailyStandardChatLimit: 15,
    monthlyPremiumCredits: 100,
    complimentaryReasoningBoosts: 5,
    savedAgentsLimit: 0,
    maxProjects: 3,
    maxMemories: 50,
    concurrentInferenceLimit: 1,
    browserToolAllowed: false,
    pythonSandboxAllowed: false,
    autonomousAgentAllowed: false
  },
  plus: {
    dailyStandardChatLimit: 50,
    monthlyPremiumCredits: 3000,
    complimentaryReasoningBoosts: 50,
    savedAgentsLimit: 3,
    maxProjects: 10,
    maxMemories: 250,
    concurrentInferenceLimit: 1,
    browserToolAllowed: false,
    pythonSandboxAllowed: false,
    autonomousAgentAllowed: false
  },
  pro: {
    dailyStandardChatLimit: 150,
    monthlyPremiumCredits: 7500,
    complimentaryReasoningBoosts: 200,
    savedAgentsLimit: 50,
    maxProjects: 10000, // unlimited
    maxMemories: 10000, // unlimited
    concurrentInferenceLimit: 2,
    browserToolAllowed: true,
    pythonSandboxAllowed: true,
    autonomousAgentAllowed: true
  }
};

export const PLAN_MODEL_ALLOWLIST: Record<PlanTier, readonly string[]> = {
  guest: ['claude-3-haiku', 'gpt-4o-mini'],
  free: ['claude-3-5-haiku', 'gpt-4o-mini', 'gemini-1.5-flash', 'claude-3-haiku'],
  plus: [
    'claude-3-5-sonnet',
    'gpt-4o',
    'deepseek-r1',
    'claude-3-5-haiku',
    'gpt-4o-mini',
    'gemini-1.5-flash',
    'claude-3-haiku'
  ],
  pro: [
    'claude-3-opus',
    'o1',
    'o3-mini',
    'claude-3-5-sonnet',
    'gpt-4o',
    'deepseek-r1',
    'claude-3-5-haiku',
    'gpt-4o-mini',
    'gemini-1.5-flash',
    'claude-3-haiku'
  ]
};

export interface Announcement {
  id: string;
  version: string;
  title: string;
  summary: string;
  features: string[];
  publishedAt: string;
  minTier?: PlanTier;
}

export interface UserAccount {
  id: string;
  tier: PlanTier;
  isGuest: boolean;
  dailyChatsUsed: number;
  creditsRemaining: number;
  reasoningBoostsRemaining: number;
  lastResetDate: string;
  activeInferenceCount: number;
  onboarding: {
    completed: boolean;
    currentStage: string;
    skipped: boolean;
  };
  notificationPreferences: {
    announcements: boolean;
    productUpdates: boolean;
    tips: boolean;
  };
  dismissedAnnouncements: Set<string>;
  dismissedFeatureGuidance: Set<string>;
}

export interface ProjectItem {
  id: string;
  userId: string;
  name: string;
  readOnly: boolean;
  createdAt: string;
}

export interface MemoryItem {
  id: string;
  userId: string;
  content: string;
  readOnly: boolean;
  createdAt: string;
}

export interface GuestSession {
  token: string;
  guestId: string;
  chatsUsed: number;
  conversations: Array<{ id: string; title: string; messages: any[] }>;
  createdAt: number;
  linkedUserId?: string;
}

// ----------------------------------------------------------------------------
// Test Server Implementation
// ----------------------------------------------------------------------------
export class E2ETestServer {
  private server: http.Server | null = null;
  public url: string = '';
  public users = new Map<string, UserAccount>();
  public projects = new Map<string, ProjectItem>();
  public memories = new Map<string, MemoryItem>();
  public guestSessions = new Map<string, GuestSession>();
  public announcements: Announcement[] = [];
  public featureFlagOverrides = new Map<string, boolean>();

  constructor() {
    this.seedDefaultData();
  }

  public seedDefaultData() {
    this.announcements = [
      {
        id: 'ann-2026-v2',
        version: '2026.2.0',
        title: 'Introducing AIRA Autonomous Agents & Pro Tools',
        summary: 'Explore full browser automation, python sandbox, and 4-tier entitlement system.',
        features: ['Pro Browser Automation', 'Python Sandbox', 'Contextual Upgrades'],
        publishedAt: '2026-11-01T00:00:00Z'
      },
      {
        id: 'ann-2026-v1',
        version: '2026.1.0',
        title: 'AIRA Next-Gen Reasoning Models',
        summary: 'DeepSeek R1 and OpenAI o1 reasoning boost support now available for Plus & Pro.',
        features: ['Reasoning Boosts', 'Artifact Studio v2'],
        publishedAt: '2026-10-15T00:00:00Z'
      }
    ];
  }

  public getOrCreateUser(userId: string, tier: PlanTier = 'free', isGuest: boolean = false): UserAccount {
    if (!this.users.has(userId)) {
      const quota = TIER_QUOTAS[tier];
      this.users.set(userId, {
        id: userId,
        tier,
        isGuest,
        dailyChatsUsed: 0,
        creditsRemaining: quota.monthlyPremiumCredits,
        reasoningBoostsRemaining: quota.complimentaryReasoningBoosts,
        lastResetDate: new Date().toISOString().split('T')[0],
        activeInferenceCount: 0,
        onboarding: {
          completed: false,
          currentStage: 'intro',
          skipped: false
        },
        notificationPreferences: {
          announcements: true,
          productUpdates: true,
          tips: true
        },
        dismissedAnnouncements: new Set<string>(),
        dismissedFeatureGuidance: new Set<string>()
      });
    }
    return this.users.get(userId)!;
  }

  public async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'INTERNAL_SERVER_ERROR', message: err.message }));
        }
      });

      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address() as any;
        this.url = `http://127.0.0.1:${address.port}`;
        resolve(this.url);
      });

      this.server.on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async parseJson(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        if (!body) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({});
        }
      });
    });
  }

  private resolvePrincipal(req: http.IncomingMessage): { user: UserAccount; guestSession?: GuestSession } {
    const authHeader = req.headers['authorization'] || '';
    const customUserHeader = (req.headers['x-user-id'] as string) || '';
    const customTierHeader = (req.headers['x-user-tier'] as string) || '';
    const guestToken = (req.headers['x-guest-token'] as string) || '';

    if (guestToken && this.guestSessions.has(guestToken)) {
      const gs = this.guestSessions.get(guestToken)!;
      let user = this.users.get(gs.guestId);
      if (!user) {
        user = this.getOrCreateUser(gs.guestId, 'guest', true);
      }
      return { user, guestSession: gs };
    }

    if (customUserHeader) {
      const tier = (['guest', 'free', 'plus', 'pro'].includes(customTierHeader) ? customTierHeader : 'free') as PlanTier;
      const isGuest = tier === 'guest';
      return { user: this.getOrCreateUser(customUserHeader, tier, isGuest) };
    }

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (token.startsWith('usr_')) {
        return { user: this.getOrCreateUser(token, 'free', false) };
      }
      if (token.startsWith('plus_')) {
        return { user: this.getOrCreateUser(token, 'plus', false) };
      }
      if (token.startsWith('pro_')) {
        return { user: this.getOrCreateUser(token, 'pro', false) };
      }
      if (token.startsWith('guest_')) {
        return { user: this.getOrCreateUser(token, 'guest', true) };
      }
    }

    // Default to anonymous guest
    const guestId = 'guest_ephemeral_' + crypto.randomBytes(4).toString('hex');
    return { user: this.getOrCreateUser(guestId, 'guest', true) };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase();

    // CORS & Health
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-id, x-user-tier, x-guest-token'
      });
      res.end();
      return;
    }

    if (pathname === '/api/ready') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', timestamp: new Date().toISOString() }));
      return;
    }

    const { user, guestSession } = this.resolvePrincipal(req);
    const body = await this.parseJson(req);

    // Endpoint: GET /api/user/entitlements
    if (pathname === '/api/user/entitlements' && method === 'GET') {
      const quota = TIER_QUOTAS[user.tier];
      const models = PLAN_MODEL_ALLOWLIST[user.tier];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tier: user.tier,
          isGuest: user.isGuest,
          quotas: quota,
          allowedModels: models,
          usage: {
            dailyChatsUsed: user.dailyChatsUsed,
            dailyChatsLimit: quota.dailyStandardChatLimit,
            creditsRemaining: user.creditsRemaining,
            reasoningBoostsRemaining: user.reasoningBoostsRemaining,
            activeInferencePermits: user.activeInferenceCount,
            concurrentLimit: quota.concurrentInferenceLimit
          }
        })
      );
      return;
    }

    // Endpoint: GET /api/user/usage
    if (pathname === '/api/user/usage' && method === 'GET') {
      const quota = TIER_QUOTAS[user.tier];
      const now = new Date();
      const tomorrowUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          planId: user.tier,
          planName: user.tier === 'guest' ? 'AIRA Guest' : user.tier === 'free' ? 'AIRA Free' : user.tier === 'plus' ? 'AIRA Plus' : 'AIRA Pro',
          dailyChatsUsed: user.dailyChatsUsed,
          dailyChatsLimit: quota.dailyStandardChatLimit,
          remainingDailyChats: Math.max(0, quota.dailyStandardChatLimit - user.dailyChatsUsed),
          monthlyCreditsRemaining: user.creditsRemaining,
          reasoningBoostsRemaining: user.reasoningBoostsRemaining,
          resetAt: tomorrowUtc.toISOString(),
          paymentCollectionDisabled: true,
          billingStatus: 'No active charges — billing integration strictly isolated'
        })
      );
      return;
    }

    // Endpoint: POST /api/user/upgrade
    if (pathname === '/api/user/upgrade' && method === 'POST') {
      const targetTier = body.tier as PlanTier;
      if (!['free', 'plus', 'pro'].includes(targetTier)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INVALID_PLAN_TIER', message: 'Target plan tier is invalid' }));
        return;
      }
      user.tier = targetTier;
      user.isGuest = false;
      const quota = TIER_QUOTAS[targetTier];
      user.creditsRemaining = quota.monthlyPremiumCredits;
      user.reasoningBoostsRemaining = quota.complimentaryReasoningBoosts;

      // Unlock any read-only items that now fit in new quota
      for (const p of this.projects.values()) {
        if (p.userId === user.id) p.readOnly = false;
      }
      for (const m of this.memories.values()) {
        if (m.userId === user.id) m.readOnly = false;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          tier: user.tier,
          message: `Successfully upgraded to ${targetTier}`,
          quotas: quota,
          featureDiscoveryUnlocked: targetTier === 'plus' ? ['agent_mode', 'reasoning_boosts'] : targetTier === 'pro' ? ['browser_tools', 'python_sandbox', 'autonomous_workers'] : []
        })
      );
      return;
    }

    // Endpoint: POST /api/user/downgrade
    if (pathname === '/api/user/downgrade' && method === 'POST') {
      const targetTier = body.tier as PlanTier;
      if (!['free', 'plus'].includes(targetTier)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INVALID_DOWNGRADE_TIER' }));
        return;
      }
      user.tier = targetTier;
      const quota = TIER_QUOTAS[targetTier];

      // Safe downgrade retention: retain excess projects & memories in read-only state
      const userProjects = Array.from(this.projects.values()).filter((p) => p.userId === user.id);
      userProjects.forEach((p, idx) => {
        p.readOnly = idx >= quota.maxProjects;
      });

      const userMemories = Array.from(this.memories.values()).filter((m) => m.userId === user.id);
      userMemories.forEach((m, idx) => {
        m.readOnly = idx >= quota.maxMemories;
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          tier: user.tier,
          message: `Downgraded to ${targetTier}. Data retained safely in read-only mode.`,
          retainedProjects: userProjects.length,
          readOnlyProjectsCount: userProjects.filter((p) => p.readOnly).length,
          retainedMemories: userMemories.length,
          readOnlyMemoriesCount: userMemories.filter((m) => m.readOnly).length
        })
      );
      return;
    }

    // Endpoint: POST /api/chat/stream
    if (pathname === '/api/chat/stream' && method === 'POST') {
      const model = (body.model || '').toLowerCase().trim();
      const quota = TIER_QUOTAS[user.tier];
      const allowed = PLAN_MODEL_ALLOWLIST[user.tier];

      if (!model) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'MODEL_REQUIRED', message: 'Missing model parameter' }));
        return;
      }

      // 1. Model Allowlist Gate
      if (!allowed.includes(model)) {
        const isPlusModel = PLAN_MODEL_ALLOWLIST.plus.includes(model);
        const requiredTier = isPlusModel ? 'plus' : 'pro';
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'PLAN_MODEL_RESTRICTED',
            message: `Model '${model}' requires higher plan tier`,
            callerTier: user.tier,
            requiredTier,
            allowedModels: allowed
          })
        );
        return;
      }

      // 2. Daily Quota Gate
      if (user.dailyChatsUsed >= quota.dailyStandardChatLimit) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'DAILY_QUOTA_EXHAUSTED',
            message: `Daily limit of ${quota.dailyStandardChatLimit} chats reached.`,
            callerTier: user.tier,
            upgradeRequired: user.tier !== 'pro'
          })
        );
        return;
      }

      // 3. Dynamic Concurrency Permit Gate
      if (user.activeInferenceCount >= quota.concurrentInferenceLimit) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'CONCURRENCY_LIMIT_EXCEEDED',
            message: `Plan ${user.tier} allows ${quota.concurrentInferenceLimit} concurrent request(s).`,
            activeCount: user.activeInferenceCount,
            limit: quota.concurrentInferenceLimit
          })
        );
        return;
      }

      // Acquire concurrency permit
      user.activeInferenceCount++;

      // Simulate streaming response
      const simulateImmediateDisconnect = body.simulateImmediateDisconnect === true;
      const simulateDisconnectAfterChunk = body.simulateDisconnectAfterChunk === true;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      if (simulateImmediateDisconnect) {
        // Disconnect before first content chunk
        user.activeInferenceCount = Math.max(0, user.activeInferenceCount - 1);
        res.destroy(); // Quota not consumed!
        return;
      }

      // Emit first chunk
      res.write(`data: ${JSON.stringify({ delta: 'Hello', model })}\n\n`);
      user.dailyChatsUsed++; // Committed once content is emitted!

      if (simulateDisconnectAfterChunk) {
        user.activeInferenceCount = Math.max(0, user.activeInferenceCount - 1);
        res.destroy();
        return;
      }

      // Complete stream
      res.write(`data: ${JSON.stringify({ delta: ' world!', finish_reason: 'stop' })}\n\n`);
      res.write('data: [DONE]\n\n');
      user.activeInferenceCount = Math.max(0, user.activeInferenceCount - 1);
      res.end();
      return;
    }

    // Endpoint: POST /api/tools/execute
    if (pathname === '/api/tools/execute' && method === 'POST') {
      const toolName = body.toolName || '';
      const quota = TIER_QUOTAS[user.tier];

      if (toolName.startsWith('browser_')) {
        if (!quota.browserToolAllowed) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'PLAN_TOOL_RESTRICTED',
              tool: toolName,
              message: 'Browser execution tools require AIRA Pro plan.',
              requiredTier: 'pro'
            })
          );
          return;
        }
      }

      if (toolName === 'python_sandbox') {
        if (!quota.pythonSandboxAllowed) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'PLAN_TOOL_RESTRICTED',
              tool: toolName,
              message: 'Python Sandbox execution requires AIRA Pro plan.',
              requiredTier: 'pro'
            })
          );
          return;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          tool: toolName,
          result: { output: `Executed ${toolName} successfully` }
        })
      );
      return;
    }

    // Endpoint: POST /api/agent/autonomous/tasks
    if (pathname === '/api/agent/autonomous/tasks' && method === 'POST') {
      const quota = TIER_QUOTAS[user.tier];
      if (!quota.autonomousAgentAllowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'PLAN_CAPABILITY_RESTRICTED',
            capability: 'autonomous_agents',
            message: 'Autonomous multi-step agent execution is restricted to AIRA Pro.',
            requiredTier: 'pro'
          })
        );
        return;
      }

      const taskId = 'task_' + crypto.randomBytes(6).toString('hex');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          taskId,
          status: 'queued',
          taskName: body.taskName || 'Autonomous Task',
          tier: user.tier
        })
      );
      return;
    }

    // Endpoint: GET & POST /api/projects
    if (pathname === '/api/projects') {
      if (user.isGuest) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'GUEST_UNAUTHORIZED', message: 'Projects require an authenticated account' }));
        return;
      }
      if (method === 'GET') {
        const userProjects = Array.from(this.projects.values()).filter((p) => p.userId === user.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects: userProjects, total: userProjects.length }));
        return;
      }
      if (method === 'POST') {
        const userProjects = Array.from(this.projects.values()).filter((p) => p.userId === user.id);
        const quota = TIER_QUOTAS[user.tier];
        if (userProjects.length >= quota.maxProjects) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'QUOTA_EXCEEDED_READ_ONLY_MODE',
              message: `Maximum project limit of ${quota.maxProjects} reached for plan ${user.tier}.`,
              currentCount: userProjects.length,
              maxAllowed: quota.maxProjects
            })
          );
          return;
        }

        const project: ProjectItem = {
          id: 'proj_' + crypto.randomBytes(4).toString('hex'),
          userId: user.id,
          name: body.name || 'New Project',
          readOnly: false,
          createdAt: new Date().toISOString()
        };
        this.projects.set(project.id, project);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(project));
        return;
      }
    }

    // Endpoint: GET & POST /api/memories
    if (pathname === '/api/memories') {
      if (user.isGuest) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'GUEST_UNAUTHORIZED', message: 'Memories require an authenticated account' }));
        return;
      }
      if (method === 'GET') {
        const userMemories = Array.from(this.memories.values()).filter((m) => m.userId === user.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ memories: userMemories, total: userMemories.length }));
        return;
      }
      if (method === 'POST') {
        const userMemories = Array.from(this.memories.values()).filter((m) => m.userId === user.id);
        const quota = TIER_QUOTAS[user.tier];
        if (userMemories.length >= quota.maxMemories) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'QUOTA_EXCEEDED_READ_ONLY_MODE',
              message: `Maximum memory limit of ${quota.maxMemories} reached for plan ${user.tier}.`,
              currentCount: userMemories.length,
              maxAllowed: quota.maxMemories
            })
          );
          return;
        }

        const memory: MemoryItem = {
          id: 'mem_' + crypto.randomBytes(4).toString('hex'),
          userId: user.id,
          content: body.content || '',
          readOnly: false,
          createdAt: new Date().toISOString()
        };
        this.memories.set(memory.id, memory);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(memory));
        return;
      }
    }

    // Endpoint: GET /api/announcements
    if (pathname === '/api/announcements' && method === 'GET') {
      const active = this.announcements.filter((a) => {
        if (a.minTier === 'pro' && user.tier !== 'pro') return false;
        if (a.minTier === 'plus' && user.tier === 'guest') return false;
        return true;
      });
      const unreadCount = active.filter((a) => !user.dismissedAnnouncements.has(a.id)).length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          announcements: active,
          unreadCount,
          dismissedIds: Array.from(user.dismissedAnnouncements)
        })
      );
      return;
    }

    // Endpoint: POST /api/announcements/dismiss
    if (pathname === '/api/announcements/dismiss' && method === 'POST') {
      const annId = body.id;
      if (annId) {
        user.dismissedAnnouncements.add(annId);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, dismissedId: annId }));
      return;
    }

    // Endpoint: GET & POST /api/user/onboarding
    if (pathname === '/api/user/onboarding') {
      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(user.onboarding));
        return;
      }
      if (method === 'POST') {
        const action = body.action;
        if (action === 'stage') {
          user.onboarding.currentStage = body.stage || user.onboarding.currentStage;
        } else if (action === 'finish') {
          user.onboarding.completed = true;
          user.onboarding.currentStage = 'plans';
        } else if (action === 'skip') {
          user.onboarding.skipped = true;
          user.onboarding.completed = true;
        } else if (action === 'restart') {
          user.onboarding.completed = false;
          user.onboarding.skipped = false;
          user.onboarding.currentStage = 'intro';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, onboarding: user.onboarding }));
        return;
      }
    }

    // Endpoint: GET /api/feature-flags
    if (pathname === '/api/feature-flags' && method === 'GET') {
      const flags: Record<string, boolean> = {
        entitlements_v2: true,
        whats_new_announcements: true,
        onboarding_walkthrough: true,
        agent_mode_plus: user.tier === 'plus' || user.tier === 'pro',
        pro_tools_execution: user.tier === 'pro',
        autonomous_agents: user.tier === 'pro',
        safe_downgrade_retention: true
      };
      // Apply runtime overrides
      for (const [key, val] of this.featureFlagOverrides.entries()) {
        flags[key] = val;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ flags }));
      return;
    }

    // Endpoint: POST /api/feature-flags/override
    if (pathname === '/api/feature-flags/override' && method === 'POST') {
      const { key, value } = body;
      if (typeof key === 'string' && typeof value === 'boolean') {
        this.featureFlagOverrides.set(key, value);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, overrides: Object.fromEntries(this.featureFlagOverrides) }));
      return;
    }

    // Endpoint: POST /api/auth/guest-to-user-link
    if (pathname === '/api/auth/guest-to-user-link' && method === 'POST') {
      const guestToken = body.guestToken;
      if (!guestToken || !this.guestSessions.has(guestToken)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INVALID_GUEST_SESSION', message: 'Guest session token is invalid or expired' }));
        return;
      }
      const gs = this.guestSessions.get(guestToken)!;
      if (gs.linkedUserId) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ALREADY_LINKED', message: 'Guest session already linked to an account' }));
        return;
      }
      gs.linkedUserId = user.id;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          linkedUserId: user.id,
          migratedChatsCount: gs.conversations.length,
          message: 'Guest conversation history linked successfully'
        })
      );
      return;
    }

    // Endpoint: GET & POST /api/notification-preferences
    if (pathname === '/api/notification-preferences') {
      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(user.notificationPreferences));
        return;
      }
      if (method === 'POST') {
        if (typeof body.announcements === 'boolean') user.notificationPreferences.announcements = body.announcements;
        if (typeof body.productUpdates === 'boolean') user.notificationPreferences.productUpdates = body.productUpdates;
        if (typeof body.tips === 'boolean') user.notificationPreferences.tips = body.tips;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, preferences: user.notificationPreferences }));
        return;
      }
    }

    // Endpoint: POST /api/capability-discovery/evaluate
    if (pathname === '/api/capability-discovery/evaluate' && method === 'POST') {
      const prompt = (body.prompt || '').toLowerCase();
      let requiredTier: PlanTier | null = null;
      let reason = '';
      let recommendedFeature = '';

      if (
        prompt.includes('python sandbox') ||
        (prompt.includes('python') &&
          (prompt.includes('run') || prompt.includes('sandbox') || prompt.includes('execute') || prompt.includes('code')))
      ) {
        requiredTier = 'pro';
        reason = 'Python code execution requires AIRA Pro.';
        recommendedFeature = 'Python Sandbox';
      } else if (prompt.includes('browse') || prompt.includes('browser automate') || prompt.includes('browse web')) {
        requiredTier = 'pro';
        reason = 'Browser automation tools require AIRA Pro.';
        recommendedFeature = 'Browser Automation Tools';
      } else if (prompt.includes('deep reasoning') || prompt.includes('complex logic proof') || prompt.includes('reasoning proof')) {
        if (user.tier === 'guest' || user.tier === 'free') {
          requiredTier = 'plus';
          reason = 'Advanced reasoning models are unlocked on AIRA Plus and Pro.';
          recommendedFeature = 'Reasoning Boosts';
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          promptEvaluated: true,
          upgradeRecommended:
            requiredTier !== null &&
            (user.tier === 'guest' ||
              (user.tier === 'free' && requiredTier !== 'free') ||
              (user.tier === 'plus' && requiredTier === 'pro')),
          requiredTier,
          reason,
          recommendedFeature
        })
      );
      return;
    }

    // 404 Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND', path: pathname }));
  }
}

// ----------------------------------------------------------------------------
// Opaque E2E Test Client
// ----------------------------------------------------------------------------
export class E2ETestClient {
  public baseUrl: string;
  public headers: Record<string, string> = {};

  constructor(baseUrl: string, auth?: { token?: string; userId?: string; tier?: PlanTier; guestToken?: string }) {
    this.baseUrl = baseUrl;
    if (auth?.token) {
      this.headers['Authorization'] = `Bearer ${auth.token}`;
    }
    if (auth?.userId) {
      this.headers['x-user-id'] = auth.userId;
    }
    if (auth?.tier) {
      this.headers['x-user-tier'] = auth.tier;
    }
    if (auth?.guestToken) {
      this.headers['x-guest-token'] = auth.guestToken;
    }
  }

  public async fetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    const mergedHeaders = { ...this.headers, ...(options.headers as any) };
    return fetch(url, { ...options, headers: mergedHeaders });
  }

  public async getEntitlements(): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/user/entitlements');
    const body = await res.json();
    return { status: res.status, body };
  }

  public async getUsage(): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/user/usage');
    const body = await res.json();
    return { status: res.status, body };
  }

  public async upgrade(tier: PlanTier): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/user/upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier })
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  public async downgrade(tier: PlanTier): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/user/downgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier })
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  public async chatStream(
    model: string,
    options: { simulateImmediateDisconnect?: boolean; simulateDisconnectAfterChunk?: boolean } = {}
  ): Promise<{ status: number; chunks: string[]; body?: any }> {
    try {
      const res = await this.fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...options })
      });

      if (res.status !== 200) {
        const body = await res.json().catch(() => ({}));
        return { status: res.status, chunks: [], body };
      }

      const text = await res.text();
      const chunks = text
        .split('\n\n')
        .filter((s) => s.startsWith('data: '))
        .map((s) => s.replace('data: ', ''));
      return { status: res.status, chunks };
    } catch (err: any) {
      if (options.simulateImmediateDisconnect || options.simulateDisconnectAfterChunk) {
        return { status: 499, chunks: [] }; // Client disconnected cleanly
      }
      throw err;
    }
  }

  public async executeTool(toolName: string, params: any = {}): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/tools/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName, params })
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  public async createAutonomousTask(taskName: string): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/agent/autonomous/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskName })
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  public async getProjects(): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/projects');
    const body = await res.json();
    return { status: res.status, body };
  }

  public async createProject(name: string): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  public async getMemories(): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/memories');
    const body = await res.json();
    return { status: res.status, body };
  }

  public async createMemory(content: string): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  public async getAnnouncements(): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/announcements');
    const body = await res.json();
    return { status: res.status, body };
  }

  public async dismissAnnouncement(id: string): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/announcements/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  public async getOnboarding(): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/user/onboarding');
    const body = await res.json();
    return { status: res.status, body };
  }

  public async updateOnboarding(action: 'stage' | 'finish' | 'skip' | 'restart', stage?: string): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/user/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, stage })
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  public async getFeatureFlags(): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/feature-flags');
    const body = await res.json();
    return { status: res.status, body };
  }

  public async setFeatureFlagOverride(key: string, value: boolean): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/feature-flags/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value })
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  public async linkGuestSession(guestToken: string): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/auth/guest-to-user-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestToken })
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  public async getNotificationPreferences(): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/notification-preferences');
    const body = await res.json();
    return { status: res.status, body };
  }

  public async updateNotificationPreferences(prefs: any): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/notification-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs)
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  public async evaluateCapability(prompt: string): Promise<{ status: number; body: any }> {
    const res = await this.fetch('/api/capability-discovery/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const body = await res.json();
    return { status: res.status, body };
  }
}

// ----------------------------------------------------------------------------
// Test Definition Registry & Runner
// ----------------------------------------------------------------------------
export interface TestCase {
  id: string;
  name: string;
  tier: 1 | 2 | 3 | 4;
  featureId?: number;
  fn: (server: E2ETestServer) => Promise<void> | void;
}

export interface TestResult {
  id: string;
  name: string;
  tier: 1 | 2 | 3 | 4;
  featureId?: number;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export class TestRegistry {
  public tests: TestCase[] = [];

  public register(testCase: TestCase) {
    this.tests.push(testCase);
  }

  public async run(server: E2ETestServer, tierFilter?: 1 | 2 | 3 | 4): Promise<TestResult[]> {
    const selected = tierFilter ? this.tests.filter((t) => t.tier === tierFilter) : this.tests;
    const results: TestResult[] = [];

    for (const testCase of selected) {
      const start = Date.now();
      try {
        await testCase.fn(server);
        results.push({
          id: testCase.id,
          name: testCase.name,
          tier: testCase.tier,
          featureId: testCase.featureId,
          passed: true,
          durationMs: Date.now() - start
        });
      } catch (err: any) {
        results.push({
          id: testCase.id,
          name: testCase.name,
          tier: testCase.tier,
          featureId: testCase.featureId,
          passed: false,
          durationMs: Date.now() - start,
          error: err.stack || err.message
        });
      }
    }
    return results;
  }
}

export const globalTestRegistry = new TestRegistry();
