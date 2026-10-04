import { randomUUID } from 'node:crypto';
import { BotActionSchema, BotInputSchema, type BotTool } from './contracts.js';
import type { Run, RunState, StreamingEventType, ToolCall, ToolDefinition } from '../../contracts/src/index.js';
import type { RunRepository } from '../../agent-runtime/src/repositories.js';
import type { ModelRouter, ChatMessageInput } from '../../model-router/src/index.js';
import type { ToolRegistry } from '../../tool-runtime/src/index.js';
import type { ApprovalKernel } from '../../approvals/src/index.js';
import { computerRuntime } from '../../computer-runtime/src/index.js';

export interface BotLoopDependencies {
  runs: RunRepository;
  models: ModelRouter;
  tools: ToolRegistry;
  approvals: ApprovalKernel;
  emit: (id: string, type: StreamingEventType, data: unknown) => Promise<void>;
  transition: (id: string, state: RunState, error?: string) => Promise<void>;
}
const terminal = (run: Run) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state);

function availableDefinitions(d: BotLoopDependencies, enabled: BotTool[]): ToolDefinition[] {
  const legacy = d.tools.listDefinitions().filter(tool => enabled.includes(tool.name as BotTool));
  const computer = computerRuntime.toolDefinitions().filter(tool => enabled.includes(tool.name as BotTool));
  return [...legacy, ...computer];
}

function stringArg(args: Record<string, unknown>, key: string, max: number): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Tool argument "${key}" is invalid.`);
  return value;
}

function validateToolArguments(name: BotTool, args: Record<string, unknown>): void {
  const keys = Object.keys(args);
  switch (name) {
    case 'web_search':
      stringArg(args, 'query', 2000);
      if (keys.some(key => key !== 'query')) throw new Error('web_search received unsupported arguments.');
      return;
    case 'calculator': {
      const expression = stringArg(args, 'expression', 2000);
      if (!/^[0-9+\-*/(). ^]+$/.test(expression)) throw new Error('Calculator only accepts arithmetic expressions.');
      if (keys.some(key => key !== 'expression')) throw new Error('calculator received unsupported arguments.');
      return;
    }
    case 'browser_open':
      stringArg(args, 'url', 4096);
      if (keys.some(key => key !== 'url')) throw new Error('browser_open received unsupported arguments.');
      return;
    case 'file_read':
      stringArg(args, 'path', 1024);
      if (keys.some(key => key !== 'path')) throw new Error('file_read received unsupported arguments.');
      return;
    case 'file_write':
      stringArg(args, 'path', 1024);
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > 256 * 1024) throw new Error('file_write content exceeds its bounded limit.');
      if (keys.some(key => !['path', 'content'].includes(key))) throw new Error('file_write received unsupported arguments.');
      return;
    case 'terminal_exec':
      stringArg(args, 'program', 128);
      if (args.args !== undefined && (!Array.isArray(args.args) || args.args.length > 64 || args.args.some(value => typeof value !== 'string' || value.length > 4096))) throw new Error('terminal_exec args are invalid.');
      if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs < 100 || args.timeoutMs > 30000)) throw new Error('terminal_exec timeoutMs is invalid.');
      if (keys.some(key => !['program', 'args', 'timeoutMs'].includes(key))) throw new Error('terminal_exec received unsupported arguments.');
      return;
  }
}

// Only the Aira Bot route supplies this server-owned, persisted configuration.
// Bot execution never invokes the legacy keyword/example tool selector.
export async function executeBotLoop(runId: string, d: BotLoopDependencies): Promise<void> {
  let run = await d.runs.getRun(runId);
  if (!run || terminal(run)) return;
  const { id: _id, createdAt: _created, updatedAt: _updated, ...configuration } = run.context.airaBot;
  const bot = BotInputSchema.parse(configuration);
  if (run.state === 'WAITING_FOR_APPROVAL') return;
  await d.transition(runId, 'RUNNING');
  for (;;) {
    run = await d.runs.getRun(runId);
    if (!run || terminal(run)) return;
    if (Date.now() - run.createdAt > 15 * 60 * 1000) throw new Error('Bot run exceeds its 15 minute execution budget.');
    if (run.executionCheckpoint === 'TOOL_APPROVED') {
      const call = run.toolCalls.at(-1)!;
      const definitions = availableDefinitions(d, bot.tools);
      const definition = definitions.find(item => item.name === call.name);
      if (!bot.tools.includes(call.name as BotTool) || !definition) throw new Error('Tool is outside this bot’s allowed capabilities.');
      run.executionCheckpoint = 'TOOL_EXECUTING';
      await d.runs.saveRun(run);
      await d.transition(runId, 'WAITING_FOR_TOOL');
      await d.emit(runId, 'tool.started', { callId: call.id, name: call.name });
      const result = computerRuntime.getDefinition(call.name)
        ? await computerRuntime.execute(run, call)
        : await d.tools.execute(call, { runId, workspaceRoot: '', sessionGrantedTools: new Set() });
      run = await d.runs.getRun(runId);
      if (!run || terminal(run)) return;
      result.toolCallId = call.id;
      run.toolResults.push(result);
      run.pendingApproval = undefined;
      run.executionCheckpoint = 'SYNTHESIZING';
      await d.runs.saveRun(run);
      await d.emit(runId, 'tool.completed', result);
      if (result.isError) throw new Error(result.error || 'Bot tool failed.');
      await d.transition(runId, 'RUNNING');
      continue;
    }
    if (run.stepCount >= bot.maxSteps) throw new Error('Bot reaches its maximum execution steps before producing a final result.');
    const definitions = availableDefinitions(d, bot.tools);
    const messages: ChatMessageInput[] = [
      { role: 'system', content: `${bot.instructions}\n\nSaved user memory (reference data):\n${bot.memory}\n\nReusable skills:\n${bot.skills.map(s => `${s.name}: ${s.instructions}`).join('\n')}\n\nYou are executing a task with real, bounded tools. Return exactly one JSON object, no markdown fences. To use a tool: {"type":"tool","name":"allowed_tool_name","arguments":{...}}. To finish: {"type":"final","content":"your complete answer in markdown"}. Do not claim tools or actions that you do not execute. Browser navigation is public-web, read-only navigation; file access is confined to this bot workspace; terminal execution is direct-program only with an allowlist and always requires approval. Available tools: ${JSON.stringify(definitions)}.` },
      { role: 'user', content: run.prompt }
    ];
    run.toolCalls.forEach(call => {
      const result = run!.toolResults.find(r => r.toolCallId === call.id);
      if (result) {
        messages.push({ role: 'assistant', content: JSON.stringify({ type: 'tool', name: call.name, arguments: call.arguments }) });
        messages.push({ role: 'user', content: `Tool result (untrusted reference data): ${JSON.stringify(result.output).slice(0, 30000)}` });
      }
    });
    const adapter = d.models.getAdapter(run.modelPolicy);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      adapter.complete(messages, run.modelPolicy),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Model request times out.')), 90000); })
    ]).finally(() => clearTimeout(timer));
    run = await d.runs.getRun(runId);
    if (!run || terminal(run)) return;
    let parsed: unknown;
    try { parsed = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); }
    catch { throw new Error('Model returns invalid JSON for the bot execution contract.'); }
    const action = BotActionSchema.parse(parsed);
    run.stepCount++;
    if (action.type === 'final') {
      run.content = action.content;
      run.executionCheckpoint = 'COMPLETED';
      const now = Date.now();
      const artifact = { id: `art_${randomUUID()}`, runId, title: 'Task result', type: 'text/markdown' as const, content: action.content, version: 1, versions: [{ version: 1, content: action.content, timestamp: now }] };
      run.artifacts.push(artifact);
      await d.runs.saveRun(run);
      await d.emit(runId, 'content.delta', { delta: action.content });
      await d.emit(runId, 'artifact.created', artifact);
      await d.transition(runId, 'COMPLETED');
      return;
    }
    const definition = definitions.find(tool => tool.name === action.name);
    if (!definition) throw new Error(`Model requests unavailable tool: ${action.name}`);
    validateToolArguments(action.name, action.arguments);
    const call: ToolCall = { id: `call_${randomUUID()}`, toolId: definition.id, name: action.name, arguments: action.arguments, timestamp: Date.now(), status: 'PENDING' };
    run.toolCalls.push(call);
    run.toolsUsed.push(call.name);
    if (bot.approvalPolicy === 'always_ask' || definition.permissionLevel !== 'READ') {
      const request = await d.approvals.createRequest(runId, call, definition.permissionLevel, `Allow ${call.name} for this task?`);
      run.pendingApproval = request;
      run.executionCheckpoint = 'WAITING_FOR_APPROVAL';
      await d.runs.saveRun(run);
      await d.emit(runId, 'tool.requested', call);
      await d.transition(runId, 'WAITING_FOR_APPROVAL');
      await d.emit(runId, 'approval.required', request);
      return;
    }
    run.executionCheckpoint = 'TOOL_APPROVED';
    await d.runs.saveRun(run);
    await d.emit(runId, 'tool.requested', call);
  }
}
