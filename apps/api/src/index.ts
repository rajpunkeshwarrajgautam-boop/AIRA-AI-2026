import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { ModelRouter } from '../../../packages/model-router/src/index.js';
import { ToolRegistry, ToolGateway, PostgresToolCallRepository } from '../../../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../../../packages/approvals/src/index.js';
import { PostgresApprovalRepository, PostgresSessionGrantRepository } from '../../../packages/approvals/src/repositories.js';
import { BrainV2KnowledgeEngine } from '../../../packages/knowledge/src/index.js';
import { McpHost } from '../../../packages/mcp/src/index.js';
import { AgentRuntime } from '../../../packages/agent-runtime/src/index.js';
import { AutomationEngine } from '../../../packages/automation/src/index.js';
import { PostgresAgentRepository, PostgresRunRepository } from '../../../packages/agent-runtime/src/repositories.js';
import { PostgresAutomationRepository, PostgresAutomationRunRepository } from '../../../packages/automation/src/repositories.js';
import {
  ConversationSearchRepository,
  ConversationEmbeddingIndexer,
  HybridConversationSearchService,
  createEmbeddingProvider
} from '../../../packages/retrieval/src/index.js';
import {
  CreateRunRequestSchema,
  ApprovalDecisionSchema,
  AutomationDefinitionSchema,
  AgentDefinition,
  WorkflowDefinitionSchema,
  validateWorkflowDag
} from '../../../packages/contracts/src/index.js';

// -----------------------------------------------------------------------
// Production startup assertions
// -----------------------------------------------------------------------
if (process.env.NODE_ENV === 'production') {
  const hasProvider = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.NVIDIA_API_KEY;
  if (!hasProvider) {
    process.stderr.write(
      '[STARTUP_ASSERTION] FAIL: Production requires at least one provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or NVIDIA_API_KEY).\n'
    );
    process.exit(1);
  }

  if (!process.env.AIRA_SESSION_SECRET || process.env.AIRA_SESSION_SECRET.trim().length < 32) {
    process.stderr.write(
      '[STARTUP_ASSERTION] FAIL: Production requires AIRA_SESSION_SECRET with at least 32 characters.\n'
    );
    process.exit(1);
  }
}

import { createPrincipalMiddleware } from './middleware/principal.js';
import { createSessionAuthMiddleware, ensureAuthenticatedSession } from './auth/session-auth.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

// Audit 28: Body size limits
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: false }));

// Resolve a trusted first-party session cookie before principal enforcement.
// This middleware never trusts client-supplied user/session headers in production.
app.use(createSessionAuthMiddleware());

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

app.get('/api/ready', (_req: Request, res: Response) => {
  if (appState === 'HEALTHY') {
    res.status(200).json({ status: 'READY', timestamp: Date.now() });
  } else {
    res.status(503).json({ status: appState, timestamp: Date.now() });
  }
});

// Hard gate to block runtime traffic before recovery is complete
app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
  if (appState !== 'HEALTHY') {
    return res.status(503).json({ error: 'Service Unavailable: Runtime is ' + appState });
  }
  next();
});

// Enforce ExecutionPrincipal on all /api routes BELOW this point.
// Routes registered above (health, ready) are public infrastructure probes.
app.use('/api', createPrincipalMiddleware());

// Initialize Core Subsystems
const modelRouter = new ModelRouter();
const toolRegistry = new ToolRegistry(process.cwd());
const approvalKernel = new ApprovalKernel(new PostgresApprovalRepository(), new PostgresSessionGrantRepository());
const toolCallRepo = new PostgresToolCallRepository();
const toolGateway = new ToolGateway(toolCallRepo, approvalKernel, process.cwd());
const knowledgeEngine = new BrainV2KnowledgeEngine();
const mcpHost = new McpHost(toolGateway);
const agentRepo = new PostgresAgentRepository();
const runRepo = new PostgresRunRepository();
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
automationEngine.start();

// Recovery is deferred until the HTTP server is bound.

// Seed default agent if not exists
async function seedDefaultAgent() {
  const existing = await agentRepo.getAgent('agent-default');
  if (!existing) {
    await agentRepo.saveAgent({
      id: 'agent-default',
      name: 'Default Agent',
      instructions: 'You are Aira AI, an autonomous intelligence operating workspace. Maintain precise, verified reasoning.',
      modelPolicy: { model: 'mock-deterministic' },
      tools: [],
      memoryScopes: ['workspace'],
      approvalPolicy: 'autonomous',
      maxSteps: 10,
      timeoutMs: 60000,
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as AgentDefinition);
  }
}
seedDefaultAgent().catch(console.error);

async function seedDefaultAutomation() {
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastRun: 0
    });
  }
}
seedDefaultAutomation().catch(console.error);

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
    const body = req.body || {};
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
    const status = String(err?.message || '').includes('ownership mismatch') ? 403 : 400;
    res.status(status).json({ error: err?.message || 'Conversation sync failed.' });
  }
});

app.delete('/api/conversations/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await conversationSearchRepo.deleteConversation(req.principal!.userId, req.params.id);
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
  res.json(allRuns.filter(r => r.principalId === req.principal!.userId));
});

app.get('/api/runs/:id', async (req: Request, res: Response) => {
  const run = await agentRuntime.getRun(req.params.id);
  if (!run || run.principalId !== req.principal!.userId) {
    return res.status(404).json({ error: `Run with id "${req.params.id}" not found.` });
  }
  res.json(run);
});

app.post('/api/runs/:id/cancel', async (req: Request, res: Response) => {
  const run = await agentRuntime.getRun(req.params.id);
  if (!run || run.principalId !== req.principal!.userId) {
    return res.status(404).json({ error: 'Run not found.' });
  }
  const success = await agentRuntime.cancelRun(req.params.id);
  if (!success) {
    return res.status(400).json({ error: 'Cannot cancel run (either not found or in terminal state).' });
  }
  res.json({ status: 'CANCELLED', runId: req.params.id });
});

app.post('/api/runs/:id/approve', async (req: Request, res: Response) => {
  try {
    const { requestId, decision } = req.body;
    const approval = await approvalKernel.getPendingRequest(requestId);
    if (!approval) return res.status(404).json({ error: 'Approval request not found.' });
    
    const run = await agentRuntime.getRun(approval.runId);
    if (!run || run.principalId !== req.principal!.userId) {
      return res.status(404).json({ error: 'Approval request not found.' });
    }

    const parsedDecision = ApprovalDecisionSchema.parse(decision);
    // Submit approval with current user's identity
    const success = await agentRuntime.submitApproval(requestId, parsedDecision);
    if (!success) {
      return res.status(400).json({ error: 'Could not apply approval decision.' });
    }
    res.json({ status: 'DECISION_RECORDED', decision: parsedDecision });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// SSE Stream for Run
// -----------------------------------------------------------------------
app.get('/api/runs/:id/events', async (req: Request, res: Response) => {
  const runId = req.params.id;
  const run = await agentRuntime.getRun(runId);

  if (!run || run.principalId !== req.principal!.userId) {
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
      if (evt.sequence !== undefined && evt.sequence > highWaterSequence) {
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
  try {
    const { messages, history, prompt, model, extendedThinking, systemPrompt, contextSubgraph, attachments, conversationId } = req.body;
    const promptText = prompt || (Array.isArray(messages)
      ? [...messages].reverse().find((m: any) => m.role === 'user')?.content || ''
      : '');

    const contextHistory = Array.isArray(history)
      ? history
      : Array.isArray(messages)
      ? messages.slice(0, -1)
      : [];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const run = await agentRuntime.createRun({
      prompt: promptText,
      conversationId: conversationId || undefined,
      attachments: Array.isArray(attachments) ? attachments : undefined,
      systemPrompt: (systemPrompt || '') + (contextSubgraph ? `\n\n${contextSubgraph}` : ''),
      context: { history: contextHistory },
      modelPolicy: {
        model: model || 'aira-auto',
        extendedThinking: Boolean(extendedThinking),
      }
    }, req.principal!);

    const stream = agentRuntime.getEventStream(run.id);

    const handler = (evt: any) => {
      if (evt.type === 'routing.decision') {
        res.write(`event: routing_decision\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'capability.unready') {
        res.write(`event: capability_unready\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'content.delta') {
        res.write(`event: content_delta\ndata: ${JSON.stringify({ text: evt.data.delta })}\n\n`);
      } else if (evt.type === 'thinking.delta') {
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
        res.write(`event: workflow_completed\ndata: ${JSON.stringify(evt.data)}\n\n`);
        res.write(`event: done\ndata: [DONE]\n\n`);
        stream.off('event', handler);
        res.end();
      } else if (evt.type === 'artifact.created') {
        res.write(`event: artifact_open\ndata: ${JSON.stringify(evt.data)}\n\n`);
        res.write(`event: artifact_delta\ndata: ${JSON.stringify({ chunk: evt.data.content })}\n\n`);
        res.write(`event: artifact_close\ndata: ${JSON.stringify({ id: evt.data.id })}\n\n`);
      } else if (evt.type === 'approval.required') {
        res.write(`event: approval_required\ndata: ${JSON.stringify(evt.data)}\n\n`);
        res.write(`event: done\ndata: [DONE]\n\n`);
        stream.off('event', handler);
        res.end();
      } else if (evt.type === 'tool.started') {
        res.write(`event: tool_started\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'tool.completed') {
        res.write(`event: tool_completed\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'run.failed') {
        res.write(`event: error\ndata: ${JSON.stringify({
          error: evt.data?.error || 'Aira runtime failed before producing a response',
        })}\n\n`);
        stream.off('event', handler);
        res.end();
      } else if (evt.type === 'run.cancelled') {
        res.write(`event: error\ndata: ${JSON.stringify({
          error: evt.data?.error || 'Aira run was cancelled',
        })}\n\n`);
        stream.off('event', handler);
        res.end();
      } else if (evt.type === 'run.completed') {
        res.write(`event: done\ndata: [DONE]\n\n`);
        stream.off('event', handler);
        res.end();
      }
    };

    stream.on('event', handler);
    req.on('close', () => {
      stream.off('event', handler);
    });

    await agentRuntime.startRun(run.id);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
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
    const call = await toolCallRepo.getToolCall(req.params.id);
    if (!call || call.principalId !== req.principal!.userId) {
      return res.status(404).json({ error: `Tool call with id "${req.params.id}" not found.` });
    }
    res.json(call);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tools/calls/:id/cancel', async (req: Request, res: Response) => {
  try {
    const success = await toolGateway.cancel(req.params.id, req.principal!);
    if (!success) {
      return res.status(400).json({ error: 'Cannot cancel tool call (either not found, not owned, or already terminal).' });
    }
    res.json({ status: 'CANCELLED', toolCallId: req.params.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// Knowledge Engine (Brain v2)
// -----------------------------------------------------------------------
app.get('/api/knowledge/sources', async (_req: Request, res: Response) => {
  res.json({
    sources: await knowledgeEngine.getSources(),
    memories: await knowledgeEngine.getMemories()
  });
});

app.post('/api/knowledge/ingest', async (req: Request, res: Response) => {
  const { title, content, mimeType, uri } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: 'title and content are required.' });
  }
  const result = await knowledgeEngine.ingestDocument(title, content, mimeType, uri);
  res.status(201).json(result);
});

app.get('/api/knowledge/graph', async (_req: Request, res: Response) => {
  res.json(await knowledgeEngine.getKnowledgeGraph());
});

app.post('/api/knowledge/search', async (req: Request, res: Response) => {
  const { query, limit } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required.' });
  const results = await knowledgeEngine.search(String(query), limit ? Number(limit) : 5);
  res.json({ results });
});

// -----------------------------------------------------------------------
// Agents — Full CRUD (Audit 16)
// -----------------------------------------------------------------------

app.post('/api/agents', async (req: Request, res: Response) => {
  const { name, instructions, modelPolicy, tools, memoryScopes, approvalPolicy, maxSteps, timeoutPolicy } = req.body;
  if (!name || !instructions) {
    return res.status(400).json({ error: 'name and instructions are required.' });
  }
  const now = Date.now();
  const agent: AgentDefinition = {
    id: `agent_${crypto.randomUUID().slice(0, 8)}`,
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
  await agentRepo.saveAgent(agent);
  res.status(201).json(agent);
});

app.get('/api/agents', async (_req: Request, res: Response) => {
  res.json(await agentRepo.listAgents());
});

app.get('/api/agents/:id', async (req: Request, res: Response) => {
  const agent = await agentRepo.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: `Agent "${req.params.id}" not found.` });
  res.json(agent);
});

app.patch('/api/agents/:id', async (req: Request, res: Response) => {
  const agent = await agentRepo.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: `Agent "${req.params.id}" not found.` });
  const updates = req.body as Partial<AgentDefinition>;
  delete (updates as any).id;
  delete (updates as any).createdAt;
  Object.assign(agent, updates, { updatedAt: Date.now() });
  await agentRepo.saveAgent(agent);
  res.json(agent);
});

app.delete('/api/agents/:id', async (req: Request, res: Response) => {
  const deleted = await agentRepo.deleteAgent(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: `Agent "${req.params.id}" not found.` });
  }
  res.status(204).send();
});

app.post('/api/agents/:id/run', async (req: Request, res: Response) => {
  const agent = await agentRepo.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: `Agent "${req.params.id}" not found.` });
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
app.get('/api/automations', async (req: Request, res: Response) => {
  res.json(await automationEngine.listAutomations(req.principal?.userId));
});

app.post('/api/automations', async (req: Request, res: Response) => {
  try {
    const raw = {
      ...req.body,
      principalId: req.body.principalId || req.principal?.userId || 'usr_anonymous'
    };
    const parsed = AutomationDefinitionSchema.omit({ id: true }).parse(raw);
    const item = await automationEngine.createAutomation(parsed);
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/automations/:id', async (req: Request, res: Response) => {
  const item = await automationEngine.getAutomation(req.params.id, req.principal?.userId);
  if (!item) return res.status(404).json({ error: `Automation "${req.params.id}" not found.` });
  res.json(item);
});

app.patch('/api/automations/:id', async (req: Request, res: Response) => {
  try {
    const updated = await automationEngine.patchAutomation(req.params.id, req.body, req.principal?.userId);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/automations/:id', async (req: Request, res: Response) => {
  const deleted = await automationEngine.deleteAutomation(req.params.id, req.principal?.userId);
  if (!deleted) return res.status(404).json({ error: `Automation "${req.params.id}" not found.` });
  res.status(204).send();
});

app.post('/api/automations/:id/trigger', async (req: Request, res: Response) => {
  try {
    const runId = await automationEngine.triggerNow(req.params.id, req.principal?.userId);
    res.json({ runId, status: 'TRIGGERED' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/automations/:id/runs', async (req: Request, res: Response) => {
  try {
    const item = await automationEngine.getAutomation(req.params.id, req.principal?.userId);
    if (!item) return res.status(404).json({ error: `Automation "${req.params.id}" not found.` });
    const runs = await automationEngine.getAutomationRuns(req.params.id);
    res.json(runs);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/automations/:id/enable', async (req: Request, res: Response) => {
  try {
    const item = await automationEngine.toggleAutomation(req.params.id, true, req.principal?.userId);
    res.json(item);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/automations/:id/disable', async (req: Request, res: Response) => {
  try {
    const item = await automationEngine.toggleAutomation(req.params.id, false, req.principal?.userId);
    res.json(item);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// Platform / Serverless cron execution endpoint
app.post('/api/automations/cron/execute', async (_req: Request, res: Response) => {
  try {
    await automationEngine.runScheduledCronCycle();
    res.json({ status: 'CRON_CYCLE_EXECUTED', timestamp: Date.now() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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
    const wfRun = await wfRepo.getWorkflowRun(req.params.id);
    if (!wfRun || wfRun.principalId !== req.principal!.userId) {
      return res.status(404).json({ error: `Workflow run "${req.params.id}" not found.` });
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
    const { prompt, definition } = req.body;
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
    const wfRun = await wfRepo.getWorkflowRun(req.params.id);
    if (!wfRun || wfRun.principalId !== req.principal!.userId) {
      return res.status(404).json({ error: `Workflow run "${req.params.id}" not found.` });
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
    const wfRun = await wfRepo.getWorkflowRun(req.params.id);
    if (!wfRun || wfRun.principalId !== req.principal!.userId) {
      return res.status(404).json({ error: `Workflow run "${req.params.id}" not found.` });
    }

    const wfEngine = agentRuntime.getWorkflowEngine();
    const success = await wfEngine.resolveStepApproval(
      wfRun.id,
      req.params.stepId,
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

// -----------------------------------------------------------------------
// Global Error Handler (Audit 27 — catches uncaught route errors)
// -----------------------------------------------------------------------
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  process.stderr.write(`[API_ERROR] ${err.message}\n`);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// -----------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------
if (!process.env.VERCEL) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(`AIRA Runtime API Server v2026.2.0 listening on port ${PORT}\n`);
    process.stdout.write(`NODE_ENV: ${process.env.NODE_ENV || 'development'}\n`);
    process.stdout.write(`Providers: ${modelRouter.listProviders().join(', ') || 'none (dev mock active)'}\n`);
    
    appState = 'RECOVERING';
    agentRuntime.recoverInterruptedRuns('api-worker-1').then(() => {
      appState = 'HEALTHY';
      process.stdout.write('Startup recovery complete. API is HEALTHY.\n');
    }).catch(err => {
      console.error('Failed to recover interrupted runs. Failing closed:', err);
      appState = 'FAILED';
      process.exit(1);
    });
  });

  process.on('SIGINT', () => {
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

