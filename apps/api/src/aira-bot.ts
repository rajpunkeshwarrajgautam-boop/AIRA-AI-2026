import { Router } from 'express';
import { BotInputSchema, BotTaskSchema, type BotTool, type BotInput } from '../../../packages/aira-bot/src/contracts.js';
import { BotRepository } from '../../../packages/aira-bot/src/repository.js';
import { BotOrchestrationRepository, BotRoutineEngine, RoutineInputSchema } from '../../../packages/aira-bot/src/orchestration.js';
import { BotSkillRepository, SkillInputSchema } from '../../../packages/aira-bot/src/skills.js';
import { botConnectorRuntime } from '../../../packages/aira-bot/src/connectors.js';
import type { AgentRuntime } from '../../../packages/agent-runtime/src/index.js';
import type { RunRepository } from '../../../packages/agent-runtime/src/repositories.js';
import type { ModelRouter } from '../../../packages/model-router/src/index.js';
import { ApprovalDecisionSchema } from '../../../packages/contracts/src/index.js';
import { computerRuntime as defaultComputerRuntime, type ManagedComputerRuntime } from '../../../packages/computer-runtime/src/managed.js';
import { computerActions } from '../../../packages/computer-runtime/src/actions.js';
import { randomUUID } from 'node:crypto';
import { db } from '../../../packages/db/src/index.js';

export function createBotRouter(runtime: AgentRuntime, runs: RunRepository, models: ModelRouter, options: { computer?: ManagedComputerRuntime; routineLeader?: () => Promise<boolean>; manageScheduling?: boolean } = {}) {
  const computerRuntime = options.computer || defaultComputerRuntime;
  const router = Object.assign(Router(), { stop: () => {} });
  const bots = new BotRepository();
  const skills = new BotSkillRepository();
  const orchestration = new BotOrchestrationRepository();
  const schedulingEnabled = process.env.AIRA_BOT_ROUTINES_ENABLED === 'true' || process.env.NODE_ENV !== 'production';
  const routineEngine = new BotRoutineEngine(runtime, orchestration, bots, options.routineLeader);
  if (schedulingEnabled && process.env.NODE_ENV !== 'test' && options.manageScheduling !== false) routineEngine.start();
  router.stop = () => routineEngine.stop();
  const availableComputerTools = () => computerRuntime.toolDefinitions().map(tool => tool.name);
  const connectorTools = () => botConnectorRuntime.configuredIds().length ? ['connector_list', 'connector_call'] : [];
  const availableTools = () => ['calculator', ...(process.env.BRAVE_SEARCH_API_KEY ? ['web_search'] : []), ...availableComputerTools(), 'delegate_bot', 'delegation_status', ...connectorTools()];
  const terminalStates = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

  async function validateBindings(owner: string, input: BotInput): Promise<void> {
    await skills.requireOwned(owner, input.skillIds);
    const unavailableConnectors = input.connectorIds.filter(id => !botConnectorRuntime.has(id));
    if (unavailableConnectors.length) throw new Error(`Unavailable bot connectors: ${unavailableConnectors.join(', ')}`);
  }

  function leaseToken(req: any): string {
    const raw = req.headers['x-aira-computer-lease'];
    if (typeof raw !== 'string' || !raw) throw new Error('Take control of this computer before interacting with it.');
    return raw;
  }

  router.get('/capabilities', (_req, res) => res.json({
    models: models.listProviders().flatMap(p => p === 'anthropic' ? ['claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku'] : p === 'openai' ? ['gpt-4o', 'gpt-4o-mini'] : []),
    tools: availableTools(),
    connectors: botConnectorRuntime.summaries().map(connector => ({ id: connector.id, name: connector.name, allowedTools: connector.allowedTools })),
    computer: computerRuntime.enabled,
    computerProvider: { kind: computerRuntime.providerKind, isolation: computerRuntime.providerKind === 'docker' ? 'docker-container' : 'host-process', interactive: availableComputerTools().some(tool => tool === 'browser_click') },
    delegation: true,
    scheduling: schedulingEnabled,
    auth: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? 'development' : 'host-principal'
  }));

  // Reusable skills are owner-scoped library objects. Bots store only selected skill IDs;
  // execution snapshots the current instructions into the run before the first model step.
  router.get('/skills', async (req, res) => res.json(await skills.list(req.principal!.userId)));
  router.post('/skills', async (req, res) => {
    const parsed = SkillInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid reusable skill.', details: parsed.error.flatten() });
    try { res.status(201).json(await skills.create(req.principal!.userId, parsed.data)); }
    catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  router.patch('/skills/:id', async (req, res) => {
    const owner = req.principal!.userId;
    const current = await skills.get(owner, String(req.params.id));
    if (!current) return res.status(404).json({ error: 'Reusable skill not found.' });
    const parsed = SkillInputSchema.safeParse({ name: current.name, description: current.description, instructions: current.instructions, ...req.body });
    if (!parsed.success) return res.status(400).json({ error: 'Invalid reusable skill.', details: parsed.error.flatten() });
    try { res.json(await skills.update(owner, current.id, parsed.data)); }
    catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  router.delete('/skills/:id', async (req, res) => {
    try {
      if (!await skills.remove(req.principal!.userId, String(req.params.id))) return res.status(404).json({ error: 'Reusable skill not found.' });
      res.status(204).end();
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });

  router.get('/bots', async (req, res) => res.json(await bots.list(req.principal!.userId)));
  router.post('/bots', async (req, res) => {
    const parsed = BotInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid bot configuration.', details: parsed.error.flatten() });
    const unavailable = parsed.data.tools.filter(tool => !availableTools().includes(tool));
    if (unavailable.length) return res.status(400).json({ error: `Unavailable bot capabilities: ${unavailable.join(', ')}` });
    try { await validateBindings(req.principal!.userId, parsed.data); }
    catch (error) { return res.status(400).json({ error: (error as Error).message }); }
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
    const unavailable = parsed.data.tools.filter(tool => !availableTools().includes(tool));
    if (unavailable.length) return res.status(400).json({ error: `Unavailable bot capabilities: ${unavailable.join(', ')}` });
    try { await validateBindings(owner, parsed.data); }
    catch (error) { return res.status(400).json({ error: (error as Error).message }); }
    res.json(await bots.update(owner, bot.id, parsed.data));
  });
  router.delete('/bots/:id', async (req, res) => {
    try {
      if (!await bots.remove(req.principal!.userId, String(req.params.id))) return res.status(404).json({ error: 'Bot not found.' });
      res.status(204).end();
    } catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });

  router.get('/bots/:id/routines', async (req, res) => {
    const owner = req.principal!.userId;
    if (!await bots.get(owner, String(req.params.id))) return res.status(404).json({ error: 'Bot not found.' });
    res.json(await orchestration.listRoutines(owner, String(req.params.id)));
  });
  router.post('/bots/:id/routines', async (req, res) => {
    if (!schedulingEnabled) return res.status(503).json({ error: 'Bot routines are disabled on this host.' });
    const owner = req.principal!.userId;
    const bot = await bots.get(owner, String(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    const parsed = RoutineInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid routine configuration.', details: parsed.error.flatten() });
    res.status(201).json(await orchestration.createRoutine(owner, bot.id, parsed.data));
  });
  router.patch('/bots/:id/routines/:routineId', async (req, res) => {
    if (!schedulingEnabled) return res.status(503).json({ error: 'Bot routines are disabled on this host.' });
    const owner = req.principal!.userId;
    if (!await bots.get(owner, String(req.params.id))) return res.status(404).json({ error: 'Bot not found.' });
    const existing = await orchestration.getRoutine(owner, String(req.params.routineId));
    if (!existing || existing.botId !== String(req.params.id)) return res.status(404).json({ error: 'Routine not found.' });
    const parsed = RoutineInputSchema.safeParse({ name: existing.name, objective: existing.objective, cronExpression: existing.cronExpression, timezone: existing.timezone, enabled: existing.enabled, ...req.body });
    if (!parsed.success) return res.status(400).json({ error: 'Invalid routine configuration.', details: parsed.error.flatten() });
    res.json(await orchestration.updateRoutine(owner, existing.id, parsed.data));
  });
  router.delete('/bots/:id/routines/:routineId', async (req, res) => {
    const owner = req.principal!.userId;
    const existing = await orchestration.getRoutine(owner, String(req.params.routineId));
    if (!existing || existing.botId !== String(req.params.id)) return res.status(404).json({ error: 'Routine not found.' });
    await orchestration.deleteRoutine(owner, existing.id);
    res.status(204).end();
  });
  router.get('/bots/:id/routines/:routineId/runs', async (req, res) => {
    const owner = req.principal!.userId;
    const existing = await orchestration.getRoutine(owner, String(req.params.routineId));
    if (!existing || existing.botId !== String(req.params.id)) return res.status(404).json({ error: 'Routine not found.' });
    const records = await orchestration.routineRuns(owner, existing.id);
    res.json(await Promise.all(records.map(async record => ({ ...record, run: record.runId ? await runtime.getRun(record.runId) : undefined }))));
  });

  router.get('/bots/:id/delegations', async (req, res) => {
    const owner = req.principal!.userId;
    if (!await bots.get(owner, String(req.params.id))) return res.status(404).json({ error: 'Bot not found.' });
    const records = await orchestration.listDelegations(owner, String(req.params.id));
    res.json(await Promise.all(records.map(async delegation => ({ ...delegation, childRun: await runtime.getRun(delegation.childRunId) }))));
  });

  router.get('/notifications', async (req, res) => res.json(await orchestration.notifications(req.principal!.userId, req.query.unread === 'true')));
  router.post('/notifications/:id/read', async (req, res) => {
    if (!await orchestration.markNotificationRead(req.principal!.userId, String(req.params.id))) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ status: 'READ' });
  });

  router.use('/bots/:id/computer', async (req, res, next) => {
    const bot = await bots.get(req.principal!.userId, String(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    res.locals.ownedBot = bot;
    if (['POST', 'PUT'].includes(req.method) && !/^\/(takeover|release|actions)(\/|$)/.test(req.path) &&
      (req.path !== '/start' || req.headers['x-aira-computer-lease'])) {
      try {
        const key = req.headers['idempotency-key'] || randomUUID();
        if (typeof key !== 'string' || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) return res.status(400).json({ error: 'Invalid Idempotency-Key.' });
        res.setHeader('Idempotency-Key', key);
        await computerRuntime.withHuman(req.principal!.userId, String(req.params.id), leaseToken(req), key, next);
      } catch (error) { res.status(409).json({ error: (error as Error).message }); }
      return;
    }
    next();
  });

  router.get('/bots/:id/computer', async (req, res) => res.json(await computerRuntime.status(req.principal!.userId, String(req.params.id))));
  router.post('/bots/:id/computer/start', async (req, res) => {
    try { res.json(await computerRuntime.start(req.principal!.userId, String(req.params.id))); }
    catch (err) { res.status(503).json({ error: (err as Error).message }); }
  });
  router.post('/bots/:id/computer/stop', async (req, res) => {
    try { leaseToken(req); res.json(await computerRuntime.stop(req.principal!.userId, String(req.params.id))); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });
  router.post('/bots/:id/computer/suspend', async (req, res) => {
    try { leaseToken(req); res.json(await computerRuntime.suspend(req.principal!.userId, String(req.params.id))); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });

  router.post('/bots/:id/computer/takeover', async (req, res) => {
    const owner = req.principal!.userId;
    const botId = String(req.params.id);
    const active = (await runtime.listRuns()).filter(run => run.principalId === owner && run.agentId === botId && !terminalStates.has(run.state));
    if (active.some(run => run.executionCheckpoint === 'TOOL_EXECUTING')) return res.status(409).json({ error: 'A computer action is currently executing. Take control after it reaches a checkpoint.' });
    const paused: string[] = [];
    for (const run of active) {
      if (run.state === 'WAITING_FOR_APPROVAL' || run.context.humanTakeover === true) continue;
      if (!await runtime.pauseForHuman(run.id, owner, botId)) {
        for (const id of paused) await runtime.resumeFromHuman(id, owner, botId).catch(() => false);
        return res.status(409).json({ error: 'The bot reached an unsafe takeover boundary. Retry after the current action completes.' });
      }
      paused.push(run.id);
    }
    try {
      const acquisition = await computerRuntime.takeover(owner, botId, req.principal!.sessionId);
      res.json({ leaseToken: acquisition.lease.token, expiresAt: acquisition.lease.expiresAt, pausedRunIds: paused, preemptedRunId: acquisition.preempted?.mode === 'BOT' ? acquisition.preempted.holderId.replace(/^run:/, '').split(':execution:')[0] : undefined, status: await computerRuntime.status(owner, botId) });
    } catch (error) {
      for (const id of paused) await runtime.resumeFromHuman(id, owner, botId).catch(() => false);
      res.status(409).json({ error: (error as Error).message });
    }
  });

  router.post('/bots/:id/computer/release', async (req, res) => {
    const owner = req.principal!.userId;
    const botId = String(req.params.id);
    const token = typeof req.body?.leaseToken === 'string' ? req.body.leaseToken : '';
    const released = await computerRuntime.releaseHuman(owner, botId, token);
    if (!released || released.mode !== 'HUMAN') return res.status(409).json({ error: 'Computer takeover lease is no longer active.' });
    const resumed: string[] = [];
    const runsForBot = (await runtime.listRuns()).filter(run => run.principalId === owner && run.agentId === botId && run.context.humanTakeover === true && !terminalStates.has(run.state));
    for (const run of runsForBot) if (await runtime.resumeFromHuman(run.id, owner, botId)) resumed.push(run.id);
    res.json({ resumedRunIds: resumed, status: await computerRuntime.status(owner, botId) });
  });

  router.get('/bots/:id/computer/events', async (req, res) => {
    const raw = req.query.after;
    if (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) return res.status(400).json({ error: 'Invalid computer event cursor.' });
    res.json(await computerRuntime.events(req.principal!.userId, String(req.params.id), raw === undefined ? 0 : Number(raw)));
  });

  router.get('/bots/:id/computer/events/stream', async (req, res) => {
    const raw = req.query.after;
    if (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) return res.status(400).json({ error: 'Invalid computer event cursor.' });
    const owner = req.principal!.userId;
    const botId = String(req.params.id);
    let cursor = raw === undefined ? 0 : Number(raw);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    let flushing = false;
    const flush = async () => {
      if (flushing || res.destroyed) return;
      flushing = true;
      try { for (const event of await computerRuntime.events(owner, botId, cursor)) {
        cursor = Math.max(cursor, event.sequence);
        res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } } catch { res.end(); }
      finally { flushing = false; }
    };
    await flush();
    const timer = setInterval(() => void flush(), 750);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    req.on('close', () => { clearInterval(timer); clearInterval(heartbeat); });
  });

  router.get('/bots/:id/computer/files', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.some(tool => tool === 'file_read' || tool === 'file_write')) return res.status(403).json({ error: 'Enable file access for this bot first.' });
    res.json(await computerRuntime.listFiles(req.principal!.userId, String(req.params.id)));
  });
  router.get('/bots/:id/computer/actions', async (req, res) => {
    res.json(await computerActions.unresolved(req.principal!.userId, String(req.params.id)));
  });
  router.post('/bots/:id/computer/actions/:actionId/acknowledge', async (req, res) => {
    if (req.body?.acknowledgeMayHaveExecuted !== true) return res.status(400).json({ error: 'Explicit acknowledgement that the action may have executed is required.' });
    try {
      const changed = await computerActions.acknowledge(req.principal!.userId, String(req.params.id), String(req.params.actionId), computerRuntime.provider);
      res.status(changed ? 200 : 409).json({ status: changed ? 'ABANDONED' : 'NOT_UNCERTAIN' });
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
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
    if (typeof req.body?.path !== 'string' || typeof req.body?.content !== 'string') return res.status(400).json({ error: 'A path and text content are required.' });
    try { leaseToken(req); res.json(await computerRuntime.writeText(req.principal!.userId, String(req.params.id), req.body.path, req.body.content)); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });

  router.post('/bots/:id/computer/browser/open', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.includes('browser_open')) return res.status(403).json({ error: 'Enable browser_open for this bot first.' });
    if (typeof req.body?.url !== 'string') return res.status(400).json({ error: 'A public URL is required.' });
    try { leaseToken(req); res.json(await computerRuntime.open(req.principal!.userId, String(req.params.id), req.body.url)); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });
  router.post('/bots/:id/computer/browser/click', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.includes('browser_click')) return res.status(403).json({ error: 'Enable browser_click for this bot first.' });
    if (typeof req.body?.selector !== 'string') return res.status(400).json({ error: 'A CSS selector is required.' });
    try { leaseToken(req); res.json(await computerRuntime.click(req.principal!.userId, String(req.params.id), req.body.selector)); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });
  router.post('/bots/:id/computer/browser/type', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.includes('browser_type')) return res.status(403).json({ error: 'Enable browser_type for this bot first.' });
    if (typeof req.body?.selector !== 'string' || typeof req.body?.text !== 'string') return res.status(400).json({ error: 'A selector and text are required.' });
    try { leaseToken(req); res.json(await computerRuntime.type(req.principal!.userId, String(req.params.id), req.body.selector, req.body.text, req.body.submit === true)); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });
  router.post('/bots/:id/computer/browser/scroll', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.includes('browser_scroll')) return res.status(403).json({ error: 'Enable browser_scroll for this bot first.' });
    if (typeof req.body?.deltaY !== 'number') return res.status(400).json({ error: 'A numeric deltaY is required.' });
    try { leaseToken(req); res.json(await computerRuntime.scroll(req.principal!.userId, String(req.params.id), req.body.deltaY)); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });
  router.post('/bots/:id/computer/browser/wait', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.includes('browser_wait')) return res.status(403).json({ error: 'Enable browser_wait for this bot first.' });
    if (typeof req.body?.selector !== 'string') return res.status(400).json({ error: 'A CSS selector is required.' });
    try { leaseToken(req); res.json(await computerRuntime.waitFor(req.principal!.userId, String(req.params.id), req.body.selector, Number(req.body?.timeoutMs) || 5000)); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });
  router.post('/bots/:id/computer/browser/screenshot', async (req, res) => {
    try { leaseToken(req); res.json(await computerRuntime.screenshot(req.principal!.userId, String(req.params.id))); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });
  router.post('/bots/:id/computer/terminal', async (req, res) => {
    const bot = res.locals.ownedBot as { tools: BotTool[] };
    if (!bot.tools.includes('terminal_exec')) return res.status(403).json({ error: 'Enable terminal_exec for this bot first.' });
    if (typeof req.body?.program !== 'string' || (req.body?.args !== undefined && !Array.isArray(req.body.args))) return res.status(400).json({ error: 'A program and optional argument array are required.' });
    try { leaseToken(req); res.json(await computerRuntime.terminal(req.principal!.userId, String(req.params.id), req.body.program, (req.body.args || []).map(String), Number(req.body.timeoutMs) || 20_000)); }
    catch (err) { res.status(409).json({ error: (err as Error).message }); }
  });

  router.post('/bots/:id/tasks', async (req, res) => {
    const bot = await bots.get(req.principal!.userId, String(req.params.id));
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    const parsed = BotTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'A task objective is required (maximum 16,000 characters).' });
    const unavailable = bot.tools.filter(tool => !availableTools().includes(tool));
    if (unavailable.length) return res.status(503).json({ error: `Bot requires unavailable capabilities: ${unavailable.join(', ')}` });
    const unavailableConnectors = bot.connectorIds.filter(id => !botConnectorRuntime.has(id));
    if (unavailableConnectors.length) return res.status(503).json({ error: `Bot requires unavailable connectors: ${unavailableConnectors.join(', ')}` });
    try { await skills.requireOwned(req.principal!.userId, bot.skillIds); }
    catch (error) { return res.status(409).json({ error: (error as Error).message }); }
    const model = bot.model === 'aira-auto' ? (models.listProviders().includes('anthropic') ? 'claude-3-7-sonnet' : 'gpt-4o') : bot.model;
    try { models.getAdapter(models.resolvePolicy(model, 'AGENT_MISSION')); }
    catch (err) { return res.status(503).json({ error: (err as Error).message }); }
    let task: Awaited<ReturnType<BotRepository['recordTask']>> | undefined;
    const run = await runtime.createAndExecuteRun({ prompt: parsed.data.prompt, intent: 'AGENT_MISSION', modelPolicy: { model } }, req.principal!, bot, undefined, async created => {
      await db.transaction(async trx => {
        await runs.saveRun(created, trx);
        task = await bots.recordTask(req.principal!.userId, bot.id, created.id, parsed.data.prompt, trx);
      });
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
    const run = res.locals.botRun;
    if (!await runtime.cancelRun(run.id)) return res.status(409).json({ error: 'Run is already terminal.' });
    await computerRuntime.releaseRun(run.principalId, run.id);
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
