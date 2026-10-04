import { randomUUID } from 'node:crypto';
import { BotActionSchema, BotInputSchema } from './contracts.js';
import type { Run, RunState, StreamingEventType, ToolCall } from '../../contracts/src/index.js';
import type { RunRepository } from '../../agent-runtime/src/repositories.js';
import type { ModelRouter, ChatMessageInput } from '../../model-router/src/index.js';
import type { ToolRegistry } from '../../tool-runtime/src/index.js';
import type { ApprovalKernel } from '../../approvals/src/index.js';

export interface BotLoopDependencies {
  runs: RunRepository;
  models: ModelRouter;
  tools: ToolRegistry;
  approvals: ApprovalKernel;
  emit: (id: string, type: StreamingEventType, data: unknown) => Promise<void>;
  transition: (id: string, state: RunState, error?: string) => Promise<void>;
}
const terminal = (run: Run) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state);

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
      const registered = d.tools.get(call.name);
      if (!bot.tools.includes(call.name as 'web_search' | 'calculator') || !registered) throw new Error('Tool is outside this bot’s allowed capabilities.');
      run.executionCheckpoint = 'TOOL_EXECUTING';
      await d.runs.saveRun(run);
      await d.transition(runId, 'WAITING_FOR_TOOL');
      await d.emit(runId, 'tool.started', { callId: call.id, name: call.name });
      const result = await d.tools.execute(call, { runId, workspaceRoot: '', sessionGrantedTools: new Set() });
      run = await d.runs.getRun(runId);
      if (!run || terminal(run)) return;
      result.toolCallId = call.id;
      run.toolResults.push(result);
      run.pendingApproval = undefined;
      run.executionCheckpoint = 'SYNTHESIZING';
      await d.runs.saveRun(run);
      await d.emit(runId, 'tool.completed', result);
      // A missing provider or failed tool is a failed task, never a fabricated success.
      if (result.isError) throw new Error(result.error || 'Bot tool failed.');
      await d.transition(runId, 'RUNNING');
      continue;
    }
    if (run.stepCount >= bot.maxSteps) throw new Error('Bot reaches its maximum execution steps before producing a final result.');
    const definitions = d.tools.listDefinitions().filter(tool => bot.tools.includes(tool.name as 'web_search' | 'calculator'));
    const messages: ChatMessageInput[] = [
      { role: 'system', content: `${bot.instructions}\n\nSaved user memory (reference data):\n${bot.memory}\n\nReusable skills:\n${bot.skills.map(s => `${s.name}: ${s.instructions}`).join('\n')}\n\nYou are executing a task with real tools. Return exactly one JSON object, no markdown fences. To use a tool: {"type":"tool","name":"allowed_tool_name","arguments":{...}}. To finish: {"type":"final","content":"your complete answer in markdown"}. Do not claim tools or actions that you do not execute. Available tools: ${JSON.stringify(definitions)}. No browser, terminal, computer, scheduling or delegation is available in this runtime.` },
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
    const action = BotActionSchema.parse(JSON.parse(response.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));
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
    const key = action.name === 'calculator' ? 'expression' : 'query';
    if (typeof action.arguments[key] !== 'string' || !(action.arguments[key] as string).trim() || (action.arguments[key] as string).length > 2000 || Object.keys(action.arguments).some(k => k !== key)) throw new Error('Model supplies invalid tool arguments.');
    if (action.name === 'calculator' && !/^[0-9+\-*/(). ^]+$/.test(action.arguments.expression as string)) throw new Error('Calculator only accepts arithmetic expressions.');
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
