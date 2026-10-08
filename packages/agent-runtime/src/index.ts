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
import { ToolRegistry, ToolGateway, PostgresToolCallRepository } from '../../tool-runtime/src/index.js';
import { ApprovalKernel } from '../../approvals/src/index.js';
import { BrainV2KnowledgeEngine } from '../../knowledge/src/index.js';

import { RunRepository } from './repositories.js';
import { CapabilityRegistry } from './registry.js';
import { ServerIntentRouter } from './router.js';
import { WorkflowRepository, PostgresWorkflowRepository } from './workflow-repositories.js';
import { WorkflowEngine } from './workflow-engine.js';
import { WorkflowCompiler } from './workflow-compiler.js';

export class AgentRuntime extends EventEmitter {
  private eventStreams: Map<string, EventEmitter> = new Map();
  private router: ServerIntentRouter;
  private workflowRepo: WorkflowRepository;
  private workflowEngine: WorkflowEngine;
  private workflowCompiler: WorkflowCompiler;
  private toolGateway: ToolGateway;

  constructor(
    private modelRouter: ModelRouter,
    private toolRegistry: ToolRegistry,
    private approvalKernel: ApprovalKernel,
    private knowledgeEngine: BrainV2KnowledgeEngine,
    private runRepo: RunRepository,
    private workspaceRoot = process.cwd(),
    private capabilityRegistry: CapabilityRegistry = new CapabilityRegistry(),
    router?: ServerIntentRouter,
    workflowRepo?: WorkflowRepository,
    workflowEngine?: WorkflowEngine,
    workflowCompiler?: WorkflowCompiler,
    toolGateway?: ToolGateway
  ) {
    super();
    this.toolGateway = toolGateway || new ToolGateway(new PostgresToolCallRepository(), this.approvalKernel, this.workspaceRoot);
    this.router = router || new ServerIntentRouter(this.capabilityRegistry, this.modelRouter);
    this.workflowRepo = workflowRepo || new PostgresWorkflowRepository();
    this.workflowCompiler = workflowCompiler || new WorkflowCompiler(this.modelRouter);
    this.workflowEngine = workflowEngine || new WorkflowEngine(
      this.workflowRepo,
      this.runRepo,
      this.approvalKernel,
      this.toolRegistry,
      this.modelRouter,
      this.workspaceRoot,
      (runId, type, data) => this.emitRunEvent(runId, type, data),
      this.toolGateway
    );
  }

  public getToolGateway(): ToolGateway {
    return this.toolGateway;
  }

  public getCapabilityRegistry(): CapabilityRegistry {
    return this.capabilityRegistry;
  }

  public getRouter(): ServerIntentRouter {
    return this.router;
  }

  public getWorkflowEngine(): WorkflowEngine {
    return this.workflowEngine;
  }

  public getWorkflowRepository(): WorkflowRepository {
    return this.workflowRepo;
  }

  public getWorkflowCompiler(): WorkflowCompiler {
    return this.workflowCompiler;
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
    const wfRun = await this.workflowRepo.getWorkflowRunByRunId(runId);
    if (wfRun && ['CREATED', 'QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL'].includes(wfRun.state)) {
      const principal: ExecutionPrincipal = {
        userId: run.principalId,
        sessionId: run.sessionId,
        role: 'user'
      };
      await this.workflowEngine.cancelWorkflow(wfRun.id, principal);
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
    
    // Check if this approval was for a workflow step
    if (typeof request.toolCall?.toolId === 'string' && request.toolCall.toolId.startsWith('workflow_step_')) {
      const wfRun = await this.workflowRepo.getWorkflowRunByRunId(request.runId);
      if (wfRun && wfRun.state === 'WAITING_FOR_APPROVAL' && wfRun.pendingApprovalStepId) {
        const principal: ExecutionPrincipal = {
          userId: run.principalId,
          sessionId: run.sessionId,
          role: 'user'
        };
        await this.workflowEngine.resolveStepApproval(
          wfRun.id,
          wfRun.pendingApprovalStepId,
          decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          principal
        );
        return true;
      }
    }

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

    // Checkpoint 0.5: Workflow Engine execution target
    if (run.routingDecision?.executionTarget === 'WORKFLOW_ENGINE') {
      if (run.state !== 'RUNNING') {
        await this.transitionRunState(runId, 'RUNNING');
      }

      let wfRun = await this.workflowRepo.getWorkflowRunByRunId(runId);
      if (!wfRun) {
        const principal: ExecutionPrincipal = {
          userId: run.principalId,
          sessionId: run.sessionId || `sess_${run.principalId}`,
          role: 'user',
          workspaceId: run.workspaceId || undefined
        };
        const wfDef = await this.workflowCompiler.compile(run.prompt, principal);
        wfRun = await this.workflowEngine.createWorkflowRun(wfDef, run, principal);
        run.executionCheckpoint = 'WORKFLOW_RUNNING';
        await this.runRepo.saveRun(run);
      }

      await this.workflowEngine.executeWorkflowRun(wfRun.id);

      const updatedWfRun = await this.workflowRepo.getWorkflowRun(wfRun.id);
      if (updatedWfRun?.state === 'COMPLETED') {
        const freshRun = await this.runRepo.getRun(runId);
        if (freshRun && freshRun.state !== 'COMPLETED') {
          await this.transitionRunState(runId, 'COMPLETED');
        }
      } else if (updatedWfRun?.state === 'FAILED') {
        const freshRun = await this.runRepo.getRun(runId);
        if (freshRun && freshRun.state !== 'FAILED') {
          await this.transitionRunState(runId, 'FAILED', updatedWfRun.error || 'Workflow execution failed.');
        }
      }
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

        const urlMatch = run.prompt.match(/https?:\/\/[^\s"'<>]+/);
        if (urlMatch) {
          selectedToolName = 'browser_navigate';
          selectedArgs = { url: urlMatch[0] };
        } else if (run.prompt.toLowerCase().includes('form') && (run.prompt.toLowerCase().includes('populate') || run.prompt.toLowerCase().includes('fill') || run.prompt.toLowerCase().includes('submit'))) {
          selectedToolName = 'browser_type';
          selectedArgs = { selector: 'form input', text: 'AIRA 2026 Test' };
        } else if (run.prompt.toLowerCase().includes('github') && run.prompt.toLowerCase().includes('commit')) {
          selectedToolName = 'repo_git_log';
          selectedArgs = { count: 1 };
        } else if (run.prompt.toLowerCase().includes('git status') || run.prompt.toLowerCase().includes('repo status')) {
          selectedToolName = 'repo_git_status';
          selectedArgs = {};
        } else if (run.prompt.toLowerCase().includes('calc') || /calculate|\b\d+\s*[-+*/]\s*\d+/.test(run.prompt.toLowerCase())) {
          selectedToolName = 'calculator';
          const exprMatch = run.prompt.match(/([0-9+\-*/().^ ]+)/);
          selectedArgs = { expression: exprMatch ? exprMatch[0].trim() : '1024 * 4' };
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

        const toolDef = this.toolGateway.getTool(selectedToolName)?.definition || this.toolRegistry.get(selectedToolName)?.definition;
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
      const toolDef = this.toolGateway.getTool(toolCall.name)?.definition || this.toolRegistry.get(toolCall.name)?.definition;
      
      const isApproved = await this.approvalKernel.isToolCallApproved(
        runId,
        toolCall.name,
        toolDef?.permissionLevel || 'READ',
        run.principalId
      );

      const requiresApproval = (!isApproved) && (
        toolDef?.permissionLevel === 'DESTRUCTIVE' ||
        toolDef?.sideEffectLevel === 'DESTRUCTIVE' ||
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

      let toolResult: ToolResult;
      const registeredWithGateway = this.toolGateway.getTool(toolCall.name);
      if (registeredWithGateway) {
        toolResult = await this.toolGateway.execute({
          toolName: toolCall.name,
          arguments: toolCall.arguments,
          context: {
            runId,
            principal: {
              userId: run.principalId,
              sessionId: run.sessionId,
              roles: ['member']
            },
            workspaceRoot: this.workspaceRoot
          },
          callId: toolCall.id
        });
      } else {
        toolResult = await this.toolRegistry.execute(toolCall, {
          runId,
          workspaceRoot: this.workspaceRoot,
          sessionGrantedTools: new Set()
        });
      }

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

    if (run.executionCheckpoint === 'WORKFLOW_RUNNING') {
      const wfRun = await this.workflowRepo.getWorkflowRunByRunId(runId);
      if (wfRun && ['RUNNING', 'CREATED', 'QUEUED'].includes(wfRun.state)) {
        await this.workflowEngine.executeWorkflowRun(wfRun.id);
        return;
      }
    }

    // Otherwise, just kick off the loop from the current checkpoint
    await this.executeRunLoop(runId);
  }
}

export * from './workflow-engine.js';
export * from './workflow-compiler.js';
export * from './workflow-repositories.js';
export * from './registry.js';
export * from './router.js';
export * from './repositories.js';
