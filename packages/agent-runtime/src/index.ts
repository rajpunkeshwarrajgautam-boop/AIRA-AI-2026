import { executeBotLoop } from '../../aira-bot/src/loop.js';
import type { Bot } from '../../aira-bot/src/contracts.js';
import { BotRepository } from '../../aira-bot/src/repository.js';
import { BotOrchestrationRepository } from '../../aira-bot/src/orchestration.js';
import { EventEmitter } from 'events';
import { hostname } from 'node:os';
import * as crypto from 'crypto';
import {
  Run,
  RunState,
  StreamingEvent,
  StreamingEventType,
  CreateRunRequest,
  ModelPolicy,
  ToolCall,
  ToolResult,
  Citation,
  Artifact,
  ApprovalDecision,
  ExecutionPrincipal
} from '../../contracts/src/index.js';
import { ModelRouter, ChatMessageInput } from '../../model-router/src/index.js';
import { ToolRegistry } from '../../tool-runtime/src/index.js';
import { ApprovalKernel } from '../../approvals/src/index.js';
import { BrainV2KnowledgeEngine } from '../../knowledge/src/index.js';

import { RunRepository } from './repositories.js';

const EXECUTION_LEASE_LOST = 'EXECUTION_LEASE_LOST';
function executionLeaseTtl(): number {
  const parsed = Number(process.env.AIRA_RUN_LEASE_TTL_MS || 120_000);
  return Number.isFinite(parsed) ? Math.max(15_000, Math.min(parsed, 10 * 60_000)) : 120_000;
}

export class AgentRuntime extends EventEmitter {
  private eventStreams: Map<string, EventEmitter> = new Map();
  private botRepo = new BotRepository();
  private botOrchestration = new BotOrchestrationRepository();
  private readonly workerId = process.env.AIRA_WORKER_ID?.trim() || `worker:${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  private readonly executionLeaseTtlMs = executionLeaseTtl();

  constructor(
    private modelRouter: ModelRouter,
    private toolRegistry: ToolRegistry,
    private approvalKernel: ApprovalKernel,
    private knowledgeEngine: BrainV2KnowledgeEngine,
    private runRepo: RunRepository,
    private workspaceRoot = process.cwd()
  ) {
    super();
  }

  public getWorkerId(): string { return this.workerId; }

  public async getRun(runId: string): Promise<Run | undefined> {
    return this.runRepo.getRun(runId);
  }

  public async listRuns(): Promise<Run[]> {
    return this.runRepo.listRuns();
  }

  public getEventStream(runId: string): EventEmitter {
    let stream = this.eventStreams.get(runId);
    if (!stream) {
      stream = new EventEmitter();
      this.eventStreams.set(runId, stream);
    }
    return stream;
  }

  private async emitRunEvent(runId: string, type: StreamingEventType, data: any): Promise<void> {
    const stream = this.getEventStream(runId);
    let event: StreamingEvent = {
      eventId: `evt_${crypto.randomUUID().slice(0, 8)}`,
      runId,
      type,
      timestamp: Date.now(),
      data
    };
    event = await this.runRepo.appendRunEvent(event);
    stream.emit('event', event);
    this.emit('run_event', { runId, event });
  }

  public async createAndExecuteRun(request: CreateRunRequest, principal: ExecutionPrincipal, bot?: Bot, registerTask?: (run: Run) => Promise<void>): Promise<Run> {
    const runId = `run_${crypto.randomUUID().slice(0, 10)}`;
    const now = Date.now();
    const policy: ModelPolicy = this.modelRouter.resolvePolicy(request.modelPolicy?.model || 'aira-auto', request.intent);
    const run: Run = {
      id: runId,
      principalId: principal.userId,
      agentId: bot?.id || null,
      sessionId: principal.sessionId,
      workspaceId: principal.workspaceId || null,
      projectId: request.projectId || principal.projectId || null,
      conversationId: request.conversationId || null,
      intent: request.intent || 'ANSWER',
      state: 'QUEUED',
      modelPolicy: policy,
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      context: bot ? { ...(request.context || {}), airaBot: bot } : (request.context || {}),
      content: '', thinking: '', toolsUsed: [], toolCalls: [], toolResults: [], artifacts: [], citations: [],
      stepCount: 0, maxSteps: bot?.maxSteps || 10, createdAt: now, updatedAt: now
    };
    if (bot) this.modelRouter.getAdapter(policy);
    await this.runRepo.saveRun(run);
    await this.emitRunEvent(runId, 'run.created', { runId, state: run.state });
    if (registerTask) {
      try { await registerTask(run); }
      catch (err) { await this.transitionRunState(runId, 'FAILED', 'Task registration fails.'); throw err; }
    }
    setImmediate(() => {
      this.executeRunLoop(runId).catch(err => {
        this.transitionRunState(runId, 'FAILED', err.message).catch(console.error);
      });
    });
    return run;
  }

  public async delegateBot(parent: Run, targetBotId: string, objective: string): Promise<unknown> {
    if (!parent.agentId?.startsWith('bot_')) throw new Error('Only an Aira Bot run can delegate work.');
    const target = await this.botRepo.get(parent.principalId, targetBotId);
    if (!target) throw new Error('Target bot is not owned by this user or does not exist.');
    if (target.id === parent.agentId) throw new Error('A bot cannot delegate a task to itself.');
    const depth = Number(parent.context.delegationDepth || 0);
    if (!Number.isSafeInteger(depth) || depth < 0 || depth >= 3) throw new Error('Delegation depth limit reached.');
    const existingChain = Array.isArray(parent.context.delegationChain) ? parent.context.delegationChain.map(String) : [];
    const chain = [...existingChain, parent.agentId];
    if (chain.includes(target.id)) throw new Error('Delegation cycle detected.');

    let delegationId = '';
    const child = await this.createAndExecuteRun(
      {
        prompt: objective,
        intent: 'AGENT_MISSION',
        modelPolicy: { model: target.model },
        context: { delegationDepth: depth + 1, delegationChain: chain, parentRunId: parent.id, parentBotId: parent.agentId }
      },
      { userId: parent.principalId, sessionId: parent.sessionId, workspaceId: parent.workspaceId || undefined, projectId: parent.projectId || undefined },
      target,
      async created => {
        await this.botRepo.recordTask(parent.principalId, target.id, created.id, `[Delegated by ${parent.agentId}] ${objective}`);
        const delegation = await this.botOrchestration.createDelegation({
          ownerId: parent.principalId,
          parentBotId: parent.agentId!,
          targetBotId: target.id,
          parentRunId: parent.id,
          childRunId: created.id,
          objective
        });
        delegationId = delegation.id;
        await this.botOrchestration.notify({ ownerId: parent.principalId, botId: target.id, runId: created.id, kind: 'delegation_started', title: `${target.name} received delegated work`, message: objective });
      }
    );
    return { delegationId, childRunId: child.id, targetBotId: target.id, targetBotName: target.name, state: child.state, depth: depth + 1 };
  }

  public async delegationStatus(parent: Run, delegationId: string): Promise<unknown> {
    const delegation = await this.botOrchestration.getDelegation(parent.principalId, delegationId);
    if (!delegation || delegation.parentBotId !== parent.agentId) throw new Error('Delegation was not created by this bot run owner.');
    const child = await this.runRepo.getRun(delegation.childRunId);
    if (!child || child.principalId !== parent.principalId) throw new Error('Delegated child run is unavailable.');
    const synced = await this.botOrchestration.syncDelegation(parent.principalId, delegation.id, child);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(child.state) && !delegation.completedAt) {
      await this.botOrchestration.notify({
        ownerId: parent.principalId, botId: delegation.targetBotId, runId: child.id,
        kind: child.state === 'COMPLETED' ? 'delegation_completed' : 'delegation_failed',
        title: child.state === 'COMPLETED' ? 'Delegated task completed' : 'Delegated task needs attention',
        message: child.state === 'COMPLETED' ? child.content.slice(0, 500) : (child.error || child.state)
      });
    }
    return { delegation: synced || delegation, childRun: { id: child.id, state: child.state, content: child.content, error: child.error, artifacts: child.artifacts } };
  }

  public async cancelRun(runId: string): Promise<boolean> {
    const run = await this.runRepo.getRun(runId);
    if (!run || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return false;
    await this.transitionRunState(runId, 'CANCELLED', 'Run was cancelled programmatically.');
    return true;
  }

  public async pauseForHuman(runId: string, principalId: string, agentId: string): Promise<boolean> {
    const run = await this.runRepo.getRun(runId);
    if (!run || run.principalId !== principalId || run.agentId !== agentId || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return false;
    if (run.executionCheckpoint === 'TOOL_EXECUTING') return false;
    run.context = { ...run.context, humanTakeover: true };
    run.state = 'WAITING_FOR_TOOL';
    run.updatedAt = Date.now();
    await this.runRepo.saveRun(run);
    await this.emitRunEvent(runId, 'run.started', { state: run.state, reason: 'HUMAN_TAKEOVER' });
    return true;
  }

  public async resumeFromHuman(runId: string, principalId: string, agentId: string): Promise<boolean> {
    const run = await this.runRepo.getRun(runId);
    if (!run || run.principalId !== principalId || run.agentId !== agentId || run.context.humanTakeover !== true || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return false;
    const nextContext = { ...run.context };
    delete nextContext.humanTakeover;
    run.context = nextContext;
    run.state = 'RUNNING';
    run.updatedAt = Date.now();
    await this.runRepo.saveRun(run);
    await this.emitRunEvent(runId, 'run.started', { state: 'RUNNING', reason: 'HUMAN_CONTROL_RETURNED' });
    setImmediate(() => {
      this.executeRunLoop(runId).catch(err => this.transitionRunState(runId, 'FAILED', err.message).catch(console.error));
    });
    return true;
  }

  public async submitApproval(requestId: string, decision: ApprovalDecision): Promise<boolean> {
    const pending = await this.approvalKernel.getPendingRequest(requestId);
    if (!pending) return false;
    const current = await this.runRepo.getRun(pending.runId);
    if (!current || current.state !== 'WAITING_FOR_APPROVAL' || current.pendingApproval?.id !== requestId) return false;
    const { approved, request } = await this.approvalKernel.decide(requestId, decision, current.principalId);
    const run = await this.runRepo.getRun(request.runId);
    if (!run) return false;
    run.pendingApproval = request;
    if (decision === 'REJECT') {
      run.executionCheckpoint = 'COMPLETED';
      await this.runRepo.saveRun(run);
      await this.emitRunEvent(request.runId, 'approval.resolved', { requestId, decision, approved });
      await this.transitionRunState(request.runId, 'FAILED', 'User rejected required tool approval.');
      return true;
    }
    run.executionCheckpoint = 'TOOL_APPROVED';
    await this.runRepo.saveRun(run);
    await this.emitRunEvent(request.runId, 'approval.resolved', { requestId, decision, approved });
    await this.transitionRunState(request.runId, 'RUNNING');
    this.executeRunLoop(request.runId).catch(err => {
      this.transitionRunState(request.runId, 'FAILED', err.message).catch(console.error);
    });
    return true;
  }

  private async transitionRunState(runId: string, state: RunState, error?: string): Promise<void> {
    const run = await this.runRepo.getRun(runId);
    if (!run) return;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return;
    run.state = state;
    run.updatedAt = Date.now();
    if (error) run.error = error;
    if (state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED') run.completedAt = run.updatedAt;
    await this.runRepo.saveRun(run);
    const eventType: StreamingEventType = state === 'COMPLETED' ? 'run.completed' : state === 'FAILED' ? 'run.failed' : state === 'CANCELLED' ? 'run.cancelled' : 'run.started';
    await this.emitRunEvent(runId, eventType, { state, error });
  }

  private async executeRunLoop(runId: string): Promise<void> {
    const lease = await this.runRepo.claimExecution(runId, this.workerId, this.executionLeaseTtlMs);
    if (!lease) return;
    let lost = false;
    let renewing = false;
    const heartbeatEvery = Math.max(5_000, Math.floor(this.executionLeaseTtlMs / 3));
    const heartbeat = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      void this.runRepo.renewExecution(runId, this.workerId, lease.fence, this.executionLeaseTtlMs)
        .then(renewed => { if (!renewed) lost = true; })
        .catch(() => { lost = true; })
        .finally(() => { renewing = false; });
    }, heartbeatEvery);
    heartbeat.unref?.();

    const assertLease = async () => {
      if (lost || !await this.runRepo.assertExecution(runId, this.workerId, lease.fence)) {
        lost = true;
        throw new Error(EXECUTION_LEASE_LOST);
      }
    };

    try {
      await this.executeRunLoopOwned(runId, assertLease);
    } catch (error) {
      if ((error as Error).message === EXECUTION_LEASE_LOST || !await this.runRepo.assertExecution(runId, this.workerId, lease.fence)) {
        return;
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      await this.runRepo.releaseExecution(runId, this.workerId, lease.fence).catch(() => false);
    }
  }

  private async executeRunLoopOwned(runId: string, assertLease: () => Promise<void>): Promise<void> {
    await assertLease();
    const candidate = await this.runRepo.getRun(runId);
    if (candidate?.agentId?.startsWith('bot_')) {
      return executeBotLoop(runId, {
        runs: this.runRepo, models: this.modelRouter, tools: this.toolRegistry, approvals: this.approvalKernel,
        emit: (id, type, data) => this.emitRunEvent(id, type, data),
        transition: (id, state, error) => this.transitionRunState(id, state, error),
        assertLease,
        delegate: (parent, targetBotId, objective) => this.delegateBot(parent, targetBotId, objective),
        delegationStatus: (parent, delegationId) => this.delegationStatus(parent, delegationId)
      });
    }
    let run = await this.runRepo.getRun(runId);
    if (!run) return;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return;
    await assertLease();
    if (run.state !== 'RUNNING') await this.transitionRunState(runId, 'RUNNING');

    if (!run.executionCheckpoint) {
      const knowledgeResults = await this.knowledgeEngine.search(run.prompt, 3);
      await assertLease();
      const citations: Citation[] = knowledgeResults.map(r => r.citation);
      run.citations = citations;
      run.executionCheckpoint = 'KNOWLEDGE_READY';
      await this.runRepo.saveRun(run);
      for (const cite of citations) await this.emitRunEvent(runId, 'source.added', cite);
    }

    if (run.executionCheckpoint === 'KNOWLEDGE_READY') {
      const isToolAction = run.intent === 'TOOL_ACTION' || run.prompt.toLowerCase().includes('search') || run.prompt.toLowerCase().includes('calc') || run.prompt.toLowerCase().includes('read') || run.prompt.toLowerCase().includes('shell') || run.prompt.toLowerCase().includes('run command') || run.prompt.toLowerCase().includes('hang safe') || run.prompt.toLowerCase().includes('hang unsafe');
      if (isToolAction) {
        let selectedToolName = 'web_search';
        let selectedArgs: Record<string, unknown> = { query: run.prompt };
        if (run.prompt.toLowerCase().includes('calc')) { selectedToolName = 'calculator'; selectedArgs = { expression: '1024 * 4' }; }
        else if (run.prompt.toLowerCase().includes('shell') || run.prompt.toLowerCase().includes('run command')) { selectedToolName = 'system_shell'; selectedArgs = { command: 'echo Aira Execution Subsystem Online' }; }
        else if (run.prompt.toLowerCase().includes('read')) { selectedToolName = 'file_system_read'; selectedArgs = { filePath: 'package.json' }; }
        else if (run.prompt.toLowerCase().includes('hang safe')) { selectedToolName = 'hang_safe'; selectedArgs = {}; }
        else if (run.prompt.toLowerCase().includes('hang unsafe')) { selectedToolName = 'hang_unsafe'; selectedArgs = {}; }
        const toolDef = this.toolRegistry.get(selectedToolName)?.definition;
        const toolCall: ToolCall = { id: `call_${Date.now()}`, toolId: toolDef?.id || `tool_${selectedToolName}`, name: selectedToolName, arguments: selectedArgs, timestamp: Date.now(), status: 'PENDING' };
        await assertLease();
        run.toolsUsed.push(selectedToolName); run.toolCalls.push(toolCall); run.stepCount++; run.executionCheckpoint = 'TOOL_SELECTED';
        await this.runRepo.saveRun(run); await this.emitRunEvent(runId, 'tool.requested', toolCall);
      } else { await assertLease(); run.executionCheckpoint = 'SYNTHESIZING'; await this.runRepo.saveRun(run); }
    }

    if (run.executionCheckpoint === 'TOOL_SELECTED') {
      const toolCall = run.toolCalls[run.toolCalls.length - 1];
      const toolDef = this.toolRegistry.get(toolCall.name)?.definition;
      const isApproved = await this.approvalKernel.isToolCallApproved(runId, toolCall.name, toolDef?.permissionLevel || 'READ', run.principalId);
      await assertLease();
      if (!isApproved && toolDef?.permissionLevel === 'DESTRUCTIVE') {
        run.executionCheckpoint = 'WAITING_FOR_APPROVAL'; await this.runRepo.saveRun(run); await this.transitionRunState(runId, 'WAITING_FOR_APPROVAL');
        const req = await this.approvalKernel.createRequest(runId, toolCall, toolDef.permissionLevel, `Tool execution "${toolCall.name}" requires user confirmation due to DESTRUCTIVE policy.`);
        await assertLease();
        run = await this.runRepo.getRun(runId) as Run; run.pendingApproval = req; await this.runRepo.saveRun(run); await this.emitRunEvent(runId, 'approval.required', req); return;
      }
      run.executionCheckpoint = 'TOOL_APPROVED'; await this.runRepo.saveRun(run);
    }
    if (run.executionCheckpoint === 'WAITING_FOR_APPROVAL') return;

    if (run.executionCheckpoint === 'TOOL_APPROVED') {
      const toolCall = run.toolCalls[run.toolCalls.length - 1];
      await assertLease();
      run.executionCheckpoint = 'TOOL_EXECUTING'; await this.runRepo.saveRun(run);
      await this.transitionRunState(runId, 'WAITING_FOR_TOOL'); await this.emitRunEvent(runId, 'tool.started', { callId: toolCall.id, name: toolCall.name });
      await assertLease();
      const toolResult: ToolResult = await this.toolRegistry.execute(toolCall, { runId, workspaceRoot: this.workspaceRoot, sessionGrantedTools: new Set() });
      await assertLease();
      run = await this.runRepo.getRun(runId) as Run; run.toolResults.push(toolResult); run.executionCheckpoint = 'TOOL_COMPLETED'; await this.runRepo.saveRun(run); await this.emitRunEvent(runId, 'tool.completed', toolResult);
      await this.transitionRunState(runId, 'RUNNING'); run = await this.runRepo.getRun(runId) as Run; run.executionCheckpoint = 'SYNTHESIZING'; await this.runRepo.saveRun(run);
    }
    if (run.executionCheckpoint === 'TOOL_COMPLETED') { await assertLease(); run.executionCheckpoint = 'SYNTHESIZING'; await this.runRepo.saveRun(run); }

    if (run.executionCheckpoint === 'SYNTHESIZING') {
      const messages: ChatMessageInput[] = [];
      messages.push({ role: 'system', content: run.systemPrompt || 'You are Aira AI, an autonomous intelligence operating workspace. Maintain precise, verified reasoning.' });
      messages.push({ role: 'user', content: run.prompt });
      if (run.toolCalls.length > 0 && run.toolResults.length > 0) {
        const lastCall = run.toolCalls[run.toolCalls.length - 1]; const lastResult = run.toolResults[run.toolResults.length - 1];
        messages.push({ role: 'assistant', content: `I executed tool ${lastCall.name}.` });
        messages.push({ role: 'tool', name: lastCall.name, toolCallId: lastCall.id, content: JSON.stringify(lastResult.output || lastResult.error) });
      }
      await assertLease();
      const adapter = this.modelRouter.getAdapter(run.modelPolicy);
      await adapter.stream(messages, run.modelPolicy, async delta => {
        await assertLease();
        if (delta.thinking) { run.thinking += delta.thinking; await this.runRepo.saveRun(run); await this.emitRunEvent(runId, 'thinking.delta', { delta: delta.thinking }); }
        if (delta.text) { run.content += delta.text; await this.runRepo.saveRun(run); await this.emitRunEvent(runId, 'content.delta', { delta: delta.text }); }
      });
      await assertLease();
      run.executionCheckpoint = 'FINALIZING'; await this.runRepo.saveRun(run);
    }

    if (run.executionCheckpoint === 'FINALIZING') {
      await assertLease();
      if (run.content.includes('```')) {
        const artId = `art_${Date.now()}`;
        const artifact: Artifact = { id: artId, runId, title: 'Generated Analysis Artifact', type: 'application/vnd.ant.code', content: run.content, version: 1, versions: [{ version: 1, content: run.content, timestamp: Date.now() }] };
        run.artifacts.push(artifact); await this.runRepo.saveRun(run); await this.emitRunEvent(runId, 'artifact.created', artifact);
      }
      run.executionCheckpoint = 'COMPLETED'; await this.runRepo.saveRun(run); await this.transitionRunState(runId, 'COMPLETED');
    }
  }

  public async recoverInterruptedRuns(owner = this.workerId, ttlMs: number = 60_000): Promise<void> {
    const recoveryOwner = owner || this.workerId;
    const interrupted = await this.runRepo.getInterruptedRuns();
    for (const run of interrupted) {
      const claimed = await this.runRepo.claimInterruptedRun(run.id, recoveryOwner, ttlMs);
      if (claimed) {
        console.log(`Recovering interrupted run ${run.id}...`);
        this.resumeRun(run.id).catch(err => {
          console.error(`Error recovering run ${run.id}:`, err);
          this.transitionRunState(run.id, 'FAILED', `Recovery failed: ${err.message}`).catch(console.error);
        });
      }
    }
  }

  private async resumeRun(runId: string): Promise<void> {
    let run = await this.runRepo.getRun(runId);
    if (!run) return;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return;
    if (run.state === 'WAITING_FOR_APPROVAL' || run.executionCheckpoint === 'WAITING_FOR_APPROVAL' || run.context.humanTakeover === true) return;
    if (run.executionCheckpoint === 'TOOL_EXECUTING') {
      const toolCall = run.toolCalls[run.toolCalls.length - 1];
      const toolDef = this.toolRegistry.get(toolCall?.name)?.definition;
      const idempotencyClass = toolDef?.idempotencyClass || 'NON_IDEMPOTENT';
      if (idempotencyClass === 'NON_IDEMPOTENT' || idempotencyClass === 'EXTERNAL_SIDE_EFFECT') {
        await this.transitionRunState(runId, 'FAILED', 'Process crashed during non-idempotent tool execution'); return;
      }
      run.executionCheckpoint = 'TOOL_APPROVED'; run.state = 'RUNNING'; await this.runRepo.saveRun(run);
    }
    await this.executeRunLoop(runId);
  }
}
