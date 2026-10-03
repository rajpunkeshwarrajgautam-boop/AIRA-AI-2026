import { EventEmitter } from 'events';
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
  ApprovalDecision
} from '../../contracts/src/index.js';
import { ModelRouter, ChatMessageInput } from '../../model-router/src/index.js';
import { ToolRegistry } from '../../tool-runtime/src/index.js';
import { ApprovalKernel } from '../../approvals/src/index.js';
import { BrainV2KnowledgeEngine } from '../../knowledge/src/index.js';

import { RunRepository } from './repositories.js';

export class AgentRuntime extends EventEmitter {
  private eventStreams: Map<string, EventEmitter> = new Map();
  private pendingResumptions: Map<string, (decision: ApprovalDecision) => void> = new Map();

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
    const event: StreamingEvent = {
      eventId: `evt_${crypto.randomUUID().slice(0, 8)}`,
      runId,
      type,
      timestamp: Date.now(),
      data
    };
    stream.emit('event', event);
    this.emit('run_event', { runId, event });
    await this.runRepo.appendRunEvent(event).catch(console.error);
  }

  public async createAndExecuteRun(request: CreateRunRequest): Promise<Run> {
    const runId = `run_${crypto.randomUUID().slice(0, 10)}`;
    const now = Date.now();

    const policy: ModelPolicy = this.modelRouter.resolvePolicy(
      request.modelPolicy?.model || 'aira-auto',
      request.intent
    );

    const run: Run = {
      id: runId,
      userId: 'user-default',
      projectId: request.projectId,
      conversationId: request.conversationId,
      intent: request.intent || 'ANSWER',
      state: 'QUEUED',
      modelPolicy: policy,
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      context: request.context || {},
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
    await this.emitRunEvent(runId, 'run.created', { runId, state: run.state });

    // Asynchronously execute run loop
    setImmediate(() => {
      this.executeRunLoop(runId).catch(err => {
        this.transitionRunState(runId, 'FAILED', err.message).catch(console.error);
      });
    });

    return run;
  }

  public async cancelRun(runId: string): Promise<boolean> {
    const run = await this.runRepo.getRun(runId);
    if (!run || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) {
      return false;
    }
    await this.transitionRunState(runId, 'CANCELLED');
    const resumeFn = this.pendingResumptions.get(runId);
    if (resumeFn) {
      this.pendingResumptions.delete(runId);
      resumeFn('REJECT');
    }
    return true;
  }

  public async submitApproval(requestId: string, decision: ApprovalDecision): Promise<boolean> {
    const { approved, request } = this.approvalKernel.decide(requestId, decision);
    const run = await this.runRepo.getRun(request.runId);
    if (run) {
      run.pendingApproval = request;
      await this.runRepo.saveRun(run);
    }
    await this.emitRunEvent(request.runId, 'approval.resolved', { requestId, decision, approved });

    const resumeFn = this.pendingResumptions.get(request.runId);
    if (resumeFn) {
      this.pendingResumptions.delete(request.runId);
      resumeFn(decision);
      return true;
    }
    return false;
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

    await this.transitionRunState(runId, 'RUNNING');
    run = await this.runRepo.getRun(runId); // refresh
    if (!run) return;

    // 1. Knowledge Search Context
    const knowledgeResults = this.knowledgeEngine.search(run.prompt, 3);
    const citations: Citation[] = knowledgeResults.map(r => r.citation);
    run.citations = citations;
    await this.runRepo.saveRun(run);
    for (const cite of citations) {
      await this.emitRunEvent(runId, 'source.added', cite);
    }

    // 2. Prepare Messages
    const messages: ChatMessageInput[] = [];
    if (run.systemPrompt) {
      messages.push({ role: 'system', content: run.systemPrompt });
    } else {
      messages.push({
        role: 'system',
        content: `You are Aira AI, an autonomous intelligence operating workspace. Maintain precise, verified reasoning.`
      });
    }
    messages.push({ role: 'user', content: run.prompt });

    // 3. Tool Execution if requested
    const isToolAction = run.intent === 'TOOL_ACTION' ||
      run.prompt.toLowerCase().includes('search') ||
      run.prompt.toLowerCase().includes('calc') ||
      run.prompt.toLowerCase().includes('read') ||
      run.prompt.toLowerCase().includes('shell') ||
      run.prompt.toLowerCase().includes('run command');

    if (isToolAction) {
      let selectedToolName = 'web_search';
      let selectedArgs: Record<string, unknown> = { query: run.prompt };

      if (run.prompt.toLowerCase().includes('calc')) {
        selectedToolName = 'calculator';
        selectedArgs = { expression: '1024 * 4' };
      } else if (run.prompt.toLowerCase().includes('shell') || run.prompt.toLowerCase().includes('run command')) {
        selectedToolName = 'system_shell';
        selectedArgs = { command: 'echo Aira Execution Subsystem Online' };
      } else if (run.prompt.toLowerCase().includes('read')) {
        selectedToolName = 'file_system_read';
        selectedArgs = { filePath: 'package.json' };
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
      await this.runRepo.saveRun(run);

      await this.emitRunEvent(runId, 'tool.requested', toolCall);

      // Check permissions and approvals
      const isApproved = this.approvalKernel.isToolCallApproved(
        runId,
        selectedToolName,
        toolDef?.permissionLevel || 'READ'
      );

      if (!isApproved && toolDef?.permissionLevel === 'DESTRUCTIVE') {
        await this.transitionRunState(runId, 'WAITING_FOR_APPROVAL');
        const req = this.approvalKernel.createRequest(
          runId,
          toolCall,
          toolDef.permissionLevel,
          `Tool execution "${selectedToolName}" requires user confirmation due to DESTRUCTIVE policy.`
        );
        run.pendingApproval = req;
        await this.runRepo.saveRun(run);

        await this.emitRunEvent(runId, 'approval.required', req);

        // Await decision
        const decision: ApprovalDecision = await new Promise((resolve) => {
          this.pendingResumptions.set(runId, resolve);
        });

        if (decision === 'REJECT') {
          await this.transitionRunState(runId, 'FAILED', 'User rejected required tool approval.');
          return;
        }

        await this.transitionRunState(runId, 'RUNNING');
      }

      // Execute Tool
      await this.transitionRunState(runId, 'WAITING_FOR_TOOL');
      await this.emitRunEvent(runId, 'tool.started', { callId: toolCall.id, name: selectedToolName });

      const toolResult: ToolResult = await this.toolRegistry.execute(toolCall, {
        runId,
        workspaceRoot: this.workspaceRoot,
        sessionGrantedTools: new Set()
      });

      run.toolResults.push(toolResult);
      await this.runRepo.saveRun(run);
      await this.emitRunEvent(runId, 'tool.completed', toolResult);

      await this.transitionRunState(runId, 'RUNNING');

      messages.push({
        role: 'assistant',
        content: `I executed tool ${selectedToolName}.`
      });
      messages.push({
        role: 'tool',
        name: selectedToolName,
        toolCallId: toolCall.id,
        content: JSON.stringify(toolResult.output || toolResult.error)
      });
    }

    // 4. Model Synthesis Stream
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

    // 5. Artifact Extraction if output contains code or structured blocks
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
    }

    await this.transitionRunState(runId, 'COMPLETED');
  }
}
