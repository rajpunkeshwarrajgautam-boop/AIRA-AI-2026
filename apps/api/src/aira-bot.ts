import { Router } from 'express';
import { BotInputSchema, BotTaskSchema, type BotTool } from '../../../packages/aira-bot/src/contracts.js';
import { BotRepository } from '../../../packages/aira-bot/src/repository.js';
import type { AgentRuntime } from '../../../packages/agent-runtime/src/index.js';
import type { RunRepository } from '../../../packages/agent-runtime/src/repositories.js';
import type { ModelRouter } from '../../../packages/model-router/src/index.js';
import { ApprovalDecisionSchema } from '../../../packages/contracts/src/index.js';
import { computerRuntime } from '../../../packages/computer-runtime/src/index.js';

export function createBotRouter(runtime: AgentRuntime, runs: RunRepository, models: ModelRouter) {
  const router = Router();
  const bots = new BotRepository();
  const availableComputerTools = () => computerRuntime.toolDefinitions().map(tool => tool.name);
  router.get('/capabilities', (_req, res) => res.json({
    models: models.listProviders().flatMap(p => p === 'anthropic' ? ['claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku'] : p === 'openai' ? ['gpt-4o', 'gpt-4o-mini'] : []),
    tools: ['calculator', ...(process.env.BRAVE_SEARCH_API_KEY ? ['web_search'] : []), ...availableComputerTools()],
    computer: computerRuntime.enabled, delegation: false, scheduling: false,
    auth: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? 'development' : 'host-principal'
  }));
  router.get('/bots', async (req, res) => res.json(await bots.list(req.principal!.userId)));
  router.post('/bots', async (req, res) => {
    const parsed = BotInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid bot configuration.', details: parsed.error.flatten() });
    const unavailable = parsed.data.tools.filter(tool => !['calculator', ...(process.env.BRAVE_SEARCH_API_KEY ? ['web_search'] : []), ...availableComputerTools()].includes(tool));
    if (unavailable.length) return res.status(400).json({ error: `Unavailable bot capabilities: ${unavailable.join(', ')}` });
    res.status(201).json(await bots.create(req.principal!.userId, parsed.data));
  });
  router.get('/bots/:id', async (req, res) => {
    const bot = await bots.get(req.principal!.userId, String(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    res.json(bot);
  });
  router.patch('/bots/:id', async (req, res) => {
    const owner = req.principal!.userId;
    const bot = await bots.get(owner, String(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = bot;
    const parsed = BotInputSchema.safeParse({ ...input, ...req.body });
    if (!parsed.success) return res.status(400).json({ error: 'Invalid bot configuration.' });
    const unavailable = parsed.data.tools.filter(tool => !['calculator', ...(process.env.BRAVE_SEARCH_API_KEY ? ['web_search'] : []), ...availableComputerTools()].includes(tool));
    if (unavailable.length) return res.status(400).json({ error: `Unavailable bot capabilities: ${unavailable.join(', ')}` });
    res.json(await bots.update(owner, bot.id, parsed.data));
  });
  router.delete('/bots/:id', async (req, res) => {
    try {
      if (!await bots.remove(req.principal!.userId, String(req.params.id))) return res.status(404).json({ error: 'Bot not found.' });
      await computerRuntime.stop(req.principal!.userId, String(req.params.id)).catch(() => undefined);
      res.status(204).end();
    } catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });

  // Computer routes are owned by the same principal and bot boundary as task execution.
  router.use('/bots/:id/computer', async (req, res, next) => {
    const bot = await bots.get(req.principal!.userId, String(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    res.locals.ownedBot = bot;
    next();
  });
  router.get('/bots/:id/computer', async (req, res) => res.json(await computerRuntime.status(req.principal!.userId, String(req.params.id))));
  router.post('/bots/:id/computer/start', async (req, res) => {
    try { res.json(await computerRuntime.start(req.principal!.userId, String(req.params.id))); }
    catch (err) { res.status(503).json({ error: (err as Error).message }); }
  });
  router.post('/bots/:id/computer/stop', async (req, res) => res.json(await computerRuntime.stop(req.principal!.userId, String(req.params.id))));
  router.get('/bots/:id/computer/files', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.some(tool => tool === 'file_read' || tool === 'file_write')) return res.status(403).json({ error: 'Enable file access for this bot first.' });
    res.json(await computerRuntime.listFiles(req.principal!.userId, String(req.params.id)));
  });
  router.get('/bots/:id/computer/file', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.includes('file_read')) return res.status(403).json({ error: 'Enable file_read for this bot first.' });
    if (typeof req.query.path !== 'string') return res.status(400).json({ error: 'A workspace path is required.' });
    try { res.json(await computerRuntime.readText(req.principal!.userId, String(req.params.id), req.query.path)); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  router.put('/bots/:id/computer/file', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.includes('file_write')) return res.status(403).json({ error: 'Enable file_write for this bot first.' });
    if (req.body?.confirm !== true || typeof req.body?.path !== 'string' || typeof req.body?.content !== 'string') return res.status(400).json({ error: 'A confirmed path and text content are required.' });
    try { res.json(await computerRuntime.writeText(req.principal!.userId, String(req.params.id), req.body.path, req.body.content)); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  router.post('/bots/:id/computer/browser/open', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.includes('browser_open')) return res.status(403).json({ error: 'Enable browser_open for this bot first.' });
    if (typeof req.body?.url !== 'string') return res.status(400).json({ error: 'A public URL is required.' });
    try { res.json(await computerRuntime.open(req.principal!.userId, String(req.params.id), req.body.url)); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  router.post('/bots/:id/computer/terminal', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.includes('terminal_exec')) return res.status(403).json({ error: 'Enable terminal_exec for this bot first.' });
    if (req.body?.confirm !== true || typeof req.body?.program !== 'string' || (req.body?.args !== undefined && !Array.isArray(req.body.args))) return res.status(400).json({ error: 'A confirmed program and optional argument array are required.' });
    try { res.json(await computerRuntime.terminal(req.principal!.userId, String(req.params.id), req.body.program, (req.body.args || []).map(String), Number(req.body.timeoutMs) || 20_000)); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  router.post('/bots/:id/tasks', async (req, res) => {
    const bot = await bots.get(req.principal!.userId, String(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    const parsed = BotTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'A task objective is required (maximum 16,000 characters).' });
    const unavailable = bot.tools.filter(tool => !['calculator', ...(process.env.BRAVE_SEARCH_API_KEY ? ['web_search'] : []), ...availableComputerTools()].includes(tool));
    if (unavailable.length) return res.status(503).json({ error: `Bot requires unavailable capabilities: ${unavailable.join(', ')}` });
    const model = bot.model === 'aira-auto' ? (models.listProviders().includes('anthropic') ? 'claude-3-7-sonnet' : 'gpt-4o') : bot.model;
    try { models.getAdapter(models.resolvePolicy(model, 'AGENT_MISSION')); }
    catch (err) { return res.status(503).json({ error: (err as Error).message }); }
    let task: Awaited<ReturnType<BotRepository['recordTask']>> | undefined;
    const run = await runtime.createAndExecuteRun({ prompt: parsed.data.prompt, intent: 'AGENT_MISSION', modelPolicy: { model } }, req.principal!, bot, async created => {
      task = await bots.recordTask(req.principal!.userId, bot.id, created.id, parsed.data.prompt);
    });
    res.status(201).json({ task, run });
  });
  router.get('/bots/:id/tasks', async (req, res) => {
    const bot = await bots.get(req.principal!.userId, String(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    const tasks = await bots.tasks(req.principal!.userId, bot.id);
    const records = await Promise.all(tasks.map(async task => ({ ...task, run: await runtime.getRun(task.run_id) })));
    res.json(records);
  });
  router.use('/runs/:id', async (req, res, next) => {
    const run = await runtime.getRun(String(req.params.id));
    if (!run || run.principalId !== req.principal!.userId || !run.agentId?.startsWith('bot_') || !await bots.get(req.principal!.userId, run.agentId)) return res.status(404).json({ error: 'Bot run not found.' });
    res.locals.botRun = run;
    next();
  });
  router.get('/runs/:id', (_req, res) => res.json(res.locals.botRun));
  router.get('/runs/:id/events', async (req, res) => {
    const raw = req.query.after;
    if (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) return res.status(400).json({ error: 'Invalid event cursor.' });
    const run = res.locals.botRun;
    res.json(raw === undefined ? await runs.getRunEvents(run.id) : await runs.getRunEventsAfter(run.id, Number(raw)));
  });
  router.post('/runs/:id/cancel', async (_req, res) => {
    if (!await runtime.cancelRun(res.locals.botRun.id)) return res.status(409).json({ error: 'Run is already terminal.' });
    res.json({ state: 'CANCELLED' });
  });
  router.post('/runs/:id/approval', async (req, res) => {
    const run = res.locals.botRun;
    const decision = ApprovalDecisionSchema.safeParse(req.body.decision);
    if (!decision.success || !['ALLOW_ONCE', 'REJECT'].includes(decision.data)) return res.status(400).json({ error: 'Choose ALLOW_ONCE or REJECT.' });
    if (!run.pendingApproval || run.pendingApproval.id !== req.body.requestId || run.state !== 'WAITING_FOR_APPROVAL') return res.status(409).json({ error: 'Approval is no longer pending.' });
    try {
      if (!await runtime.submitApproval(run.pendingApproval.id, decision.data)) return res.status(409).json({ error: 'Approval is no longer pending.' });
    } catch { return res.status(409).json({ error: 'Approval is already resolved.' }); }
    res.json({ status: 'DECISION_RECORDED' });
  });
  return router;
}
