import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import {
  Run,
  RunState,
  StreamingEvent,
  StreamingEventType,
  CreateRunRequest,
  ModelPolicy,
  ModelPolicySchema,
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
import { CapabilityRegistry } from './registry.js';
import { ServerIntentRouter } from './router.js';

export class AgentRuntime extends EventEmitter {
  private eventStreams: Map<string, EventEmitter> = new Map();
  private router: ServerIntentRouter;

  constructor(
    private modelRouter: ModelRouter,
    private toolRegistry: ToolRegistry,
    private approvalKernel: ApprovalKernel,
    private knowledgeEngine: BrainV2KnowledgeEngine,
    private runRepo: RunRepository,
    private workspaceRoot = process.cwd(),
    private capabilityRegistry: CapabilityRegistry = new CapabilityRegistry(),
    router?: ServerIntentRouter
  ) {
    super();
    this.router = router || new ServerIntentRouter(this.capabilityRegistry, this.modelRouter);
  }

  public getCapabilityRegistry(): CapabilityRegistry {
    return this.capabilityRegistry;
  }

  public getRouter(): ServerIntentRouter {
    return this.router;
  }

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
    
    // Persist event first to obtain sequence and ensure durability
    event = await this.runRepo.appendRunEvent(event);
    
    stream.emit('event', event);
    this.emit('run_event', { runId, event });
  }

  public async createRun(request: CreateRunRequest, principal: ExecutionPrincipal): Promise<Run> {
    const runId = `run_${crypto.randomUUID().slice(0, 10)}`;
    const now = Date.now();

    // 1. Authoritative Server Intent Routing & Policy Gate
    const routingDecision = await this.router.route({
      prompt: request.prompt,
      principal,
      advisoryIntent: request.intent,
      context: request.context
    });

    const basePolicy = this.modelRouter.resolvePolicy(
      request.modelPolicy?.model || 'aira-auto',
      routingDecision.intent
    );
    const requestedPolicy = request.modelPolicy;
    const extendedThinking = requestedPolicy?.extendedThinking ?? basePolicy.extendedThinking;

    const policy: ModelPolicy = ModelPolicySchema.parse({
      ...basePolicy,
      temperature: requestedPolicy?.temperature ?? basePolicy.temperature,
      maxTokens: requestedPolicy?.maxTokens ?? (extendedThinking ? Math.max(basePolicy.maxTokens, 8192) : basePolicy.maxTokens),
      extendedThinking,
      reasoningBudget: requestedPolicy?.reasoningBudget ?? (extendedThinking ? (basePolicy.reasoningBudget ?? 2048) : undefined),
    });

    const run: Run = {
      id: runId,
      principalId: principal.userId,
      agentId: null,
      sessionId: principal.sessionId,
      workspaceId: principal.workspaceId || null,
      projectId: request.projectId || principal.projectId || null,
      conversationId: request.conversationId || null,
      intent: routingDecision.intent,
      routingDecision,
      state: 'QUEUED',
      modelPolicy: policy,
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      context: {
        ...(request.context || {}),
        routingDecision
      },
      content: '',
      thinking: '',
      toolsUsed: [],
      toolCalls: [],
      toolResults: [],
      artifacts: [],
      citations: [],
      stepCount: 0,
      maxSteps: 10,
      createdAt: now,
      updatedAt: now
    };

    await this.runRepo.saveRun(run);
    return run;
  }

  public async startRun(runId: string): Promise<void> {
    const run = await this.runRepo.getRun(runId);
    if (!run) return;
    await this.emitRunEvent(runId, 'run.created', { runId, state: run.state });
    if (run.routingDecision) {
      await this.emitRunEvent(runId, 'routing.decision', run.routingDecision);
    }
    try {
      await this.executeRunLoop(runId);
    } catch (err: any) {
      await this.transitionRunState(runId, 'FAILED', err.message);
    }
  }

  public async createAndExecuteRun(request: CreateRunRequest, principal: ExecutionPrincipal): Promise<Run> {
    const run = await this.createRun(request, principal);
    // Asynchronously execute run loop
    setImmediate(() => {
      this.startRun(run.id).catch(console.error);
    });
    return run;
  }

  public async cancelRun(runId: string): Promise<boolean> {
    const run = await this.runRepo.getRun(runId);
    if (!run || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) {
      return false;
    }
    await this.transitionRunState(runId, 'CANCELLED', 'Run was cancelled programmatically.');
    return true;
  }

  public async submitApproval(requestId: string, decision: ApprovalDecision): Promise<boolean> {
    const { approved, request } = await this.approvalKernel.decide(requestId, decision);
    const run = await this.runRepo.getRun(request.runId);
    if (!run) {
      return false;
    }
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
    
    // Resume execution asynchronously (do not await)
    this.executeRunLoop(request.runId).catch(err => {
      console.error(`Error resuming run loop for ${request.runId}:`, err);
    });
    
    return true;
  }

  private async transitionRunState(runId: string, state: RunState, error?: string): Promise<void> {
    const run = await this.runRepo.getRun(runId);
    if (!run) return;

    run.state = state;
    run.updatedAt = Date.now();
    if (error) run.error = error;
    if (state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED') {
      run.completedAt = run.updatedAt;
    }
    await this.runRepo.saveRun(run);

    const eventType: StreamingEventType =
      state === 'COMPLETED' ? 'run.completed' :
      state === 'FAILED' ? 'run.failed' :
      state === 'CANCELLED' ? 'run.cancelled' :
      state === 'RUNNING' ? 'run.started' : 'run.started';

    await this.emitRunEvent(runId, eventType, { state, error });
  }

  private async executeRunLoop(runId: string): Promise<void> {
    let run = await this.runRepo.getRun(runId);
    if (!run) return;

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return;

    // Checkpoint 0: Capability readiness gate
    if (run.routingDecision?.executionTarget === 'CAPABILITY_NOT_READY') {
      const msg = `The requested capability (${run.intent}) is currently in development and not yet available for direct execution. (Target: ${run.routingDecision.executionTarget})`;
      run.content = msg;
      run.executionCheckpoint = 'COMPLETED';
      await this.runRepo.saveRun(run);
      await this.emitRunEvent(runId, 'capability.unready', {
        intent: run.intent,
        target: run.routingDecision.executionTarget,
        message: msg
      });
      await this.emitRunEvent(runId, 'content.delta', { delta: msg });
      await this.transitionRunState(runId, 'COMPLETED');
      return;
    }

    if (run.state !== 'RUNNING') {
      await this.transitionRunState(runId, 'RUNNING');
    }
    
    // Checkpoint 1: Knowledge Search Context
    if (!run.executionCheckpoint) {
      const searchCount = run.intent === 'RESEARCH' ? 5 : 3;
      const knowledgeResults = await this.knowledgeEngine.search(run.prompt, searchCount);
      const citations: Citation[] = knowledgeResults.map(r => r.citation);
      run.citations = citations;
      run.executionCheckpoint = 'KNOWLEDGE_READY';
      await this.runRepo.saveRun(run);
      for (const cite of citations) {
        await this.emitRunEvent(runId, 'source.added', cite);
      }
    }

    // Checkpoint 2: Prepare tool selection if needed
    if (run.executionCheckpoint === 'KNOWLEDGE_READY') {
      const isToolAction = run.intent === 'TOOL_ACTION';
      const isAgentMission = run.intent === 'AGENT_MISSION';

      if (isToolAction || isAgentMission) {
        let selectedToolName = 'web_search';
        let selectedArgs: Record<string, unknown> = { query: run.prompt };

        if (run.prompt.toLowerCase().includes('calc') || /calculate|\b\d+\s*[-+*/]\s*\d+/.test(run.prompt.toLowerCase())) {
          selectedToolName = 'calculator';
          selectedArgs = { expression: '1024 * 4' };
        } else if (
          run.routingDecision?.sideEffectLevel === 'DESTRUCTIVE' ||
          run.prompt.toLowerCase().includes('shell') ||
          run.prompt.toLowerCase().includes('run command') ||
          run.prompt.toLowerCase().includes('rm -rf') ||
          run.prompt.toLowerCase().includes('delete') ||
          run.prompt.toLowerCase().includes('drop')
        ) {
          selectedToolName = 'system_shell';
          selectedArgs = { command: run.prompt };
        } else if (
          run.prompt.toLowerCase().includes('read') ||
          run.prompt.toLowerCase().includes('inspect') ||
          run.prompt.toLowerCase().includes('structure') ||
          run.prompt.toLowerCase().includes('analyze')
        ) {
          selectedToolName = 'file_system_read';
          selectedArgs = { filePath: 'package.json' };
        } else if (run.prompt.toLowerCase().includes('hang safe')) {
          selectedToolName = 'hang_safe';
          selectedArgs = {};
        } else if (run.prompt.toLowerCase().includes('hang unsafe')) {
          selectedToolName = 'hang_unsafe';
          selectedArgs = {};
        }

        const toolDef = this.toolRegistry.get(selectedToolName)?.definition;
        const toolCall: ToolCall = {
          id: `call_${Date.now()}`,
          toolId: toolDef?.id || `tool_${selectedToolName}`,
          name: selectedToolName,
          arguments: selectedArgs,
          timestamp: Date.now()
        };

        run.toolsUsed.push(selectedToolName);
        run.toolCalls.push(toolCall);
        run.stepCount++;
        run.executionCheckpoint = 'TOOL_SELECTED';
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'tool.requested', toolCall);
      } else {
        run.executionCheckpoint = 'SYNTHESIZING';
        await this.runRepo.saveRun(run);
      }
    }

    // Checkpoint 3: Approval Check
    if (run.executionCheckpoint === 'TOOL_SELECTED') {
      const toolCall = run.toolCalls[run.toolCalls.length - 1];
      const toolDef = this.toolRegistry.get(toolCall.name)?.definition;
      
      const isApproved = await this.approvalKernel.isToolCallApproved(
        runId,
        toolCall.name,
        toolDef?.permissionLevel || 'READ',
        run.principalId
      );

      const requiresApproval = (!isApproved) && (
        toolDef?.permissionLevel === 'DESTRUCTIVE' ||
        run.routingDecision?.sideEffectLevel === 'DESTRUCTIVE' ||
        (Boolean(run.routingDecision?.approvalRequired) && toolDef?.permissionLevel !== 'READ')
      );

      if (requiresApproval) {
        run.executionCheckpoint = 'WAITING_FOR_APPROVAL';
        await this.runRepo.saveRun(run);
        
        await this.transitionRunState(runId, 'WAITING_FOR_APPROVAL');
        const req = await this.approvalKernel.createRequest(
          runId,
          toolCall,
          toolDef?.permissionLevel || 'DESTRUCTIVE',
          `Tool execution "${toolCall.name}" requires user confirmation due to ${run.routingDecision?.sideEffectLevel || toolDef?.permissionLevel || 'DESTRUCTIVE'} policy.`
        );
        run = await this.runRepo.getRun(runId) as Run; // reload
        run.pendingApproval = req;
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'approval.required', req);
        return; // Suspend
      } else {
        run.executionCheckpoint = 'TOOL_APPROVED';
        await this.runRepo.saveRun(run);
      }
    }

    if (run.executionCheckpoint === 'WAITING_FOR_APPROVAL') {
      return; // Already suspended, waiting for external approval
    }

    // Checkpoint 4: Execute Tool
    if (run.executionCheckpoint === 'TOOL_APPROVED') {
      const toolCall = run.toolCalls[run.toolCalls.length - 1];
      run.executionCheckpoint = 'TOOL_EXECUTING';
      await this.runRepo.saveRun(run);

      await this.transitionRunState(runId, 'WAITING_FOR_TOOL');
      await this.emitRunEvent(runId, 'tool.started', { callId: toolCall.id, name: toolCall.name });

      const toolResult: ToolResult = await this.toolRegistry.execute(toolCall, {
        runId,
        workspaceRoot: this.workspaceRoot,
        sessionGrantedTools: new Set()
      });

      run = await this.runRepo.getRun(runId) as Run; // reload after async tool execution
      run.toolResults.push(toolResult);
      run.executionCheckpoint = 'TOOL_COMPLETED';
      await this.runRepo.saveRun(run);
      await this.emitRunEvent(runId, 'tool.completed', toolResult);

      await this.transitionRunState(runId, 'RUNNING');
      
      run = await this.runRepo.getRun(runId) as Run;
      run.executionCheckpoint = 'SYNTHESIZING';
      await this.runRepo.saveRun(run);
    }

    if (run.executionCheckpoint === 'TOOL_COMPLETED') {
      run.executionCheckpoint = 'SYNTHESIZING';
      await this.runRepo.saveRun(run);
    }

    // Checkpoint 5: Synthesis
    if (run.executionCheckpoint === 'SYNTHESIZING') {
      const messages: ChatMessageInput[] = [];
      if (run.systemPrompt) {
        messages.push({ role: 'system', content: run.systemPrompt });
      } else if (run.intent === 'RESEARCH') {
        messages.push({
          role: 'system',
          content: `You are Aira AI operating in rigorous Research mode. Provide evidence-backed synthesis, cite available sources, decompose key claims, and distinguish established facts from inference.`
        });
      } else if (run.intent === 'AGENT_MISSION') {
        messages.push({
          role: 'system',
          content: `You are Aira AI operating in Autonomous Mission mode. Deliver clear execution results, steps undertaken, verification findings, and a concise summary.`
        });
      } else {
        messages.push({
          role: 'system',
          content: `You are Aira AI, an autonomous intelligence operating workspace. Maintain precise, verified reasoning.`
        });
      }
      
      if (run.context && Array.isArray(run.context.history)) {
        messages.push(...run.context.history);
      }
      
      messages.push({ role: 'user', content: run.prompt });

      if (run.toolCalls.length > 0 && run.toolResults.length > 0) {
        const lastCall = run.toolCalls[run.toolCalls.length - 1];
        const lastResult = run.toolResults[run.toolResults.length - 1];
        messages.push({
          role: 'user',
          content: `[System Tool Execution Result for ${lastCall.name}]:\n${JSON.stringify(lastResult.output || lastResult.error, null, 2)}\n\nPlease synthesize your execution findings and provide the final mission plan and summary.`
        });
      }

      const adapter = this.modelRouter.getAdapter(run.modelPolicy);

      await adapter.stream(messages, run.modelPolicy, async (delta) => {
        if (delta.thinking) {
          run.thinking += delta.thinking;
          await this.runRepo.saveRun(run);
          await this.emitRunEvent(runId, 'thinking.delta', { delta: delta.thinking });
        }
        if (delta.text) {
          run.content += delta.text;
          await this.runRepo.saveRun(run);
          await this.emitRunEvent(runId, 'content.delta', { delta: delta.text });
        }
      });

      run.executionCheckpoint = 'FINALIZING';
      await this.runRepo.saveRun(run);
    }

    // Checkpoint 6: Artifacts & Completion
    if (run.executionCheckpoint === 'FINALIZING') {
      if (run.content.includes('```')) {
        const artId = `art_${Date.now()}`;
        const artifact: Artifact = {
          id: artId,
          runId,
          title: 'Generated Analysis Artifact',
          type: 'application/vnd.ant.code',
          content: run.content,
          version: 1,
          versions: [{
            version: 1,
            content: run.content,
            timestamp: Date.now()
          }]
        };
        run.artifacts.push(artifact);
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'artifact.created', artifact);
      } else if (run.intent === 'AGENT_MISSION') {
        const artId = `art_mission_${Date.now()}`;
        const artifact: Artifact = {
          id: artId,
          runId,
          title: `Mission Report: ${run.prompt.slice(0, 36)}`,
          type: 'text/markdown',
          content: `# Mission Execution Summary\n\n**Objective**: ${run.prompt}\n\n**Outcome**: ${run.content}\n\n**Status**: COMPLETED`,
          version: 1,
          versions: [{
            version: 1,
            content: `# Mission Execution Summary\n\n**Objective**: ${run.prompt}\n\n**Outcome**: ${run.content}\n\n**Status**: COMPLETED`,
            timestamp: Date.now()
          }]
        };
        run.artifacts.push(artifact);
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'artifact.created', artifact);
      }
      
      run.executionCheckpoint = 'COMPLETED';
      await this.runRepo.saveRun(run);
      await this.transitionRunState(runId, 'COMPLETED');
    }
  }

  public async recoverInterruptedRuns(owner: string, ttlMs: number = 60000): Promise<void> {
    const interrupted = await this.runRepo.getInterruptedRuns();
    for (const run of interrupted) {
      const claimed = await this.runRepo.claimInterruptedRun(run.id, owner, ttlMs);
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

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) {
      return;
    }

    if (run.state === 'WAITING_FOR_APPROVAL' || run.executionCheckpoint === 'WAITING_FOR_APPROVAL') {
      // Just waiting for user input, do nothing. It will resume when submitApproval is called.
      return;
    }

    if (run.executionCheckpoint === 'TOOL_EXECUTING') {
      const toolCall = run.toolCalls[run.toolCalls.length - 1];
      const toolDef = this.toolRegistry.get(toolCall?.name)?.definition;
      const idempotencyClass = toolDef?.idempotencyClass || 'NON_IDEMPOTENT';

      if (idempotencyClass === 'NON_IDEMPOTENT' || idempotencyClass === 'EXTERNAL_SIDE_EFFECT') {
        await this.transitionRunState(runId, 'FAILED', 'Process crashed during non-idempotent tool execution');
        return;
      } else {
        // Safe to retry
        run.executionCheckpoint = 'TOOL_APPROVED';
        run.state = 'RUNNING';
        await this.runRepo.saveRun(run);
      }
    }

    // Otherwise, just kick off the loop from the current checkpoint
    await this.executeRunLoop(runId);
  }
}
