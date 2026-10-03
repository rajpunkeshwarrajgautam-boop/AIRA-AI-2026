import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { ModelRouter } from '../../../packages/model-router/src/index.js';
import { ToolRegistry } from '../../../packages/tool-runtime/src/index.js';
import { ApprovalKernel } from '../../../packages/approvals/src/index.js';
import { BrainV2KnowledgeEngine } from '../../../packages/knowledge/src/index.js';
import { McpHost } from '../../../packages/mcp/src/index.js';
import { AgentRuntime } from '../../../packages/agent-runtime/src/index.js';
import { AutomationEngine } from '../../../packages/automation/src/index.js';
import { PostgresAgentRepository, PostgresRunRepository } from '../../../packages/agent-runtime/src/repositories.js';
import { PostgresAutomationRepository } from '../../../packages/automation/src/repositories.js';
import {
  CreateRunRequestSchema,
  ApprovalDecisionSchema,
  AutomationDefinitionSchema,
  AgentDefinition
} from '../../../packages/contracts/src/index.js';

// -----------------------------------------------------------------------
// Production startup assertions
// -----------------------------------------------------------------------
if (process.env.NODE_ENV === 'production') {
  const hasProvider = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  if (!hasProvider) {
    process.stderr.write(
      '[STARTUP_ASSERTION] FAIL: Production requires at least one provider key (ANTHROPIC_API_KEY or OPENAI_API_KEY).\n' +
      'The server will start but all model completions will fail with CONFIGURATION_ERROR.\n'
    );
  }
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

// Audit 28: Body size limits
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: false }));

// Initialize Core Subsystems
const modelRouter = new ModelRouter();
const toolRegistry = new ToolRegistry(process.cwd());
const approvalKernel = new ApprovalKernel();
const knowledgeEngine = new BrainV2KnowledgeEngine();
const mcpHost = new McpHost(toolRegistry);
const agentRepo = new PostgresAgentRepository();
const runRepo = new PostgresRunRepository();
const autoRepo = new PostgresAutomationRepository();

const agentRuntime = new AgentRuntime(
  modelRouter,
  toolRegistry,
  approvalKernel,
  knowledgeEngine,
  runRepo,
  process.cwd()
);
const automationEngine = new AutomationEngine(agentRuntime, autoRepo);
automationEngine.start();

// Seed default agent if not exists
async function seedDefaultAgent() {
  const existing = await agentRepo.getAgent('user-default');
  if (!existing) {
    await agentRepo.saveAgent({
      id: 'user-default',
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
// Health Check
// -----------------------------------------------------------------------
app.get('/api/health', (_req: Request, res: Response) => {
  const providers = modelRouter.listProviders();
  res.json({
    status: 'HEALTHY',
    subsystems: {
      modelRouter: `ONLINE (${providers.length} provider(s): ${providers.join(', ') || 'none — mock-dev only'})`,
      toolRuntime: 'ONLINE',
      approvalKernel: 'ONLINE',
      mcpHost: 'ONLINE',
      knowledgeEngine: 'ONLINE',
      agentRuntime: 'ONLINE',
      automationEngine: 'ONLINE'
    },
    productionMockFallback: providers.length === 0 ? 'ACTIVE (dev/test only)' : 'DISABLED',
    version: '2026.2.0',
    timestamp: Date.now()
  });
});

// -----------------------------------------------------------------------
// MCP Servers
// -----------------------------------------------------------------------
app.get('/api/mcp/servers', (_req: Request, res: Response) => {
  res.json(mcpHost.listServers());
});

// -----------------------------------------------------------------------
// Runs Management
// -----------------------------------------------------------------------
app.post('/api/runs', async (req: Request, res: Response) => {
  try {
    const parsed = CreateRunRequestSchema.parse(req.body);
    const run = await agentRuntime.createAndExecuteRun(parsed);
    res.status(201).json(run);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Invalid run creation payload.' });
  }
});

app.get('/api/runs', async (_req: Request, res: Response) => {
  res.json(await agentRuntime.listRuns());
});

app.get('/api/runs/:id', async (req: Request, res: Response) => {
  const run = await agentRuntime.getRun(req.params.id);
  if (!run) {
    return res.status(404).json({ error: `Run with id "${req.params.id}" not found.` });
  }
  res.json(run);
});

app.post('/api/runs/:id/cancel', async (req: Request, res: Response) => {
  const success = await agentRuntime.cancelRun(req.params.id);
  if (!success) {
    return res.status(400).json({ error: 'Cannot cancel run (either not found or in terminal state).' });
  }
  res.json({ status: 'CANCELLED', runId: req.params.id });
});

app.post('/api/runs/:id/approve', async (req: Request, res: Response) => {
  try {
    const { requestId, decision } = req.body;
    const parsedDecision = ApprovalDecisionSchema.parse(decision);
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

  if (!run) {
    return res.status(404).json({ error: `Run ${runId} not found.` });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const stream = agentRuntime.getEventStream(runId);
  const onEvent = (event: any) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  stream.on('event', onEvent);
  req.on('close', () => {
    stream.off('event', onEvent);
  });
});

// -----------------------------------------------------------------------
// Backward-Compatible Streaming Chat Endpoint
// -----------------------------------------------------------------------
app.post('/api/chat/stream', async (req: Request, res: Response) => {
  try {
    const { messages, history, prompt, model, systemPrompt, contextSubgraph } = req.body;
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

    const run = await agentRuntime.createAndExecuteRun({
      prompt: promptText,
      systemPrompt: (systemPrompt || '') + (contextSubgraph ? `\n\n${contextSubgraph}` : ''),
      context: { history: contextHistory },
      modelPolicy: { model: model || 'aira-auto' }
    });

    const stream = agentRuntime.getEventStream(run.id);

    const handler = (evt: any) => {
      if (evt.type === 'content.delta') {
        res.write(`event: content_delta\ndata: ${JSON.stringify({ text: evt.data.delta })}\n\n`);
      } else if (evt.type === 'thinking.delta') {
        res.write(`event: thinking_delta\ndata: ${JSON.stringify({ thinking: evt.data.delta })}\n\n`);
      } else if (evt.type === 'artifact.created') {
        res.write(`event: artifact_open\ndata: ${JSON.stringify(evt.data)}\n\n`);
        res.write(`event: artifact_delta\ndata: ${JSON.stringify({ chunk: evt.data.content })}\n\n`);
        res.write(`event: artifact_close\ndata: ${JSON.stringify({ id: evt.data.id })}\n\n`);
      } else if (evt.type === 'approval.required') {
        res.write(`event: approval_required\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'tool.started') {
        res.write(`event: tool_started\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'tool.completed') {
        res.write(`event: tool_completed\ndata: ${JSON.stringify(evt.data)}\n\n`);
      } else if (evt.type === 'run.completed' || evt.type === 'run.failed' || evt.type === 'run.cancelled') {
        res.write(`event: done\ndata: [DONE]\n\n`);
        stream.off('event', handler);
        res.end();
      }
    };

    stream.on('event', handler);
    req.on('close', () => {
      stream.off('event', handler);
    });
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
// Tool Definitions
// -----------------------------------------------------------------------
app.get('/api/tools', (_req: Request, res: Response) => {
  res.json({
    tools: toolRegistry.listDefinitions(),
    audit: toolRegistry.getAuditLog().slice(-20)
  });
});

// -----------------------------------------------------------------------
// Knowledge Engine (Brain v2)
// -----------------------------------------------------------------------
app.get('/api/knowledge/sources', (_req: Request, res: Response) => {
  res.json({
    sources: knowledgeEngine.getSources(),
    memories: knowledgeEngine.getMemories()
  });
});

app.post('/api/knowledge/ingest', (req: Request, res: Response) => {
  const { title, content, mimeType, uri } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: 'title and content are required.' });
  }
  const result = knowledgeEngine.ingestDocument(title, content, mimeType, uri);
  res.status(201).json(result);
});

app.get('/api/knowledge/graph', (_req: Request, res: Response) => {
  res.json(knowledgeEngine.getKnowledgeGraph());
});

app.post('/api/knowledge/search', (req: Request, res: Response) => {
  const { query, limit } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required.' });
  const results = knowledgeEngine.search(String(query), limit ? Number(limit) : 5);
  res.json({ results });
});

// -----------------------------------------------------------------------
// Agents — Full CRUD (Audit 16)
// -----------------------------------------------------------------------
import crypto from 'crypto';

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
    const run = await agentRuntime.createAndExecuteRun({
      prompt: req.body.prompt || agent.instructions,
      systemPrompt: agent.instructions,
      intent: 'AGENT_MISSION',
      modelPolicy: agent.modelPolicy
    });
    res.status(201).json({ runId: run.id, state: run.state });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------
// Automations — Full CRUD (Audit 14)
// -----------------------------------------------------------------------
app.get('/api/automations', async (_req: Request, res: Response) => {
  res.json(await automationEngine.listAutomations());
});

app.post('/api/automations', async (req: Request, res: Response) => {
  try {
    const parsed = AutomationDefinitionSchema.omit({ id: true }).parse(req.body);
    const item = await automationEngine.createAutomation(parsed);
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/automations/:id', async (req: Request, res: Response) => {
  const item = await automationEngine.getAutomation(req.params.id);
  if (!item) return res.status(404).json({ error: `Automation "${req.params.id}" not found.` });
  res.json(item);
});

app.patch('/api/automations/:id', async (req: Request, res: Response) => {
  const item = await automationEngine.getAutomation(req.params.id);
  if (!item) return res.status(404).json({ error: `Automation "${req.params.id}" not found.` });
  try {
    const updated = await automationEngine.patchAutomation(req.params.id, req.body);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/automations/:id', async (req: Request, res: Response) => {
  const deleted = await automationEngine.deleteAutomation(req.params.id);
  if (!deleted) return res.status(404).json({ error: `Automation "${req.params.id}" not found.` });
  res.status(204).send();
});

app.post('/api/automations/:id/trigger', async (req: Request, res: Response) => {
  try {
    const runId = await automationEngine.triggerNow(req.params.id);
    res.json({ runId, status: 'TRIGGERED' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/automations/:id/enable', async (req: Request, res: Response) => {
  try {
    const item = await automationEngine.toggleAutomation(req.params.id, true);
    res.json(item);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/automations/:id/disable', async (req: Request, res: Response) => {
  try {
    const item = await automationEngine.toggleAutomation(req.params.id, false);
    res.json(item);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/api/automations/:id/runs', async (req: Request, res: Response) => {
  const item = automationEngine.getAutomation(req.params.id);
  if (!item) return res.status(404).json({ error: `Automation "${req.params.id}" not found.` });
  
  const allRuns = await agentRuntime.listRuns();
  const automationRuns = allRuns.filter((r: any) =>
    r.prompt?.startsWith(`[Automated Trigger: ${item.name}]`)
  );
  res.json(automationRuns);
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
const server = app.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`AIRA Runtime API Server v2026.2.0 listening on port ${PORT}\n`);
  process.stdout.write(`NODE_ENV: ${process.env.NODE_ENV || 'development'}\n`);
  process.stdout.write(`Providers: ${modelRouter.listProviders().join(', ') || 'none (dev mock active)'}\n`);
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


