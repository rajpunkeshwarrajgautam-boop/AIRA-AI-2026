import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { isDeepStrictEqual } from 'node:util';
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
  ExecutionPrincipal,
  ModelProvenance
} from '../../contracts/src/index.js';
import { ModelRouter, ChatMessageInput, isModelMatch } from '../../model-router/src/index.js';
import { ToolRegistry, ToolGateway, PostgresToolCallRepository } from '../../tool-runtime/src/index.js';
import { configuredSearchProviders } from '../../tool-runtime/src/search-providers.js';
import { ApprovalKernel } from '../../approvals/src/index.js';
import { BrainV2KnowledgeEngine } from '../../knowledge/src/index.js';

import { RunRepository } from './repositories.js';
import { CapabilityRegistry } from './registry.js';
import { ServerIntentRouter } from './router.js';
import { ResearchService } from './research.js';
import { buildResearchEvidenceContext, buildResearchSourcesAppendix, isResearchToolCallDump, renderGroundedResearchFallback, sanitizeCitationMarkers, verifiedWebCitations, verifiedSearchCitationsFromToolResults } from './research-evidence.js';
import { WorkflowRepository, PostgresWorkflowRepository } from './workflow-repositories.js';
import { WorkflowEngine } from './workflow-engine.js';
import { WorkflowCompiler } from './workflow-compiler.js';
import { buildDurableHistorySystemMessage } from './memory-policy.js';
import { InstructionResolver } from './behavioral/instruction-resolver.js';
import { AdaptiveSynthesizer } from './behavioral/adaptive-synthesizer.js';
import { ToolRecoveryEngine } from './behavioral/tool-recovery-engine.js';
import { selectExecutableTool, selectMissionFollowUp } from './tool-selector.js';
import { compileSupportedMission, validateDurableMission, verifyMissionEvidence, type DurableMissionProgress } from './mission-plan.js';
import { compileModelMission, validateStoredModelMission, type AnyMissionProgress } from './model-mission.js';
import { verifyFinalMissionOutcome } from './independent-outcome.js';
import { DurableDelegations, delegatedScopes, delegationKey, type Specialist, type Delegation } from './specialist-delegation.js';

export class AgentRuntime extends EventEmitter {
  private eventStreams: Map<string, EventEmitter> = new Map();
  private router: ServerIntentRouter;
  private workflowRepo: WorkflowRepository;
  private workflowEngine: WorkflowEngine;
  private workflowCompiler: WorkflowCompiler;
  private toolGateway: ToolGateway;
  private researchService: ResearchService;
  private automationEngine?: any;
  private readonly delegatedLeases=new Map<string,{
    id:string;owner:string;worker:string;fence:number
  }>();
  private async assertDelegatedLease(runId:string):Promise<void>{
    const run=await this.runRepo.getRun(runId);
    if(!run?.context?.delegatedFrom)return;
    if(process.env.AIRA_SPECIALIST_WORKER_PROCESS!=='true')
      throw new Error('DELEGATION_DEDICATED_WORKER_REQUIRED');
    const lease=this.delegatedLeases.get(runId);
    if(!lease||lease.owner!==run.principalId)
      throw new Error('DELEGATED_WORKER_CLAIM_REQUIRED');
    await new DurableDelegations().assertClaim(
      lease.owner,lease.id,lease.worker,lease.fence
    );
  }

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
    this.researchService = new ResearchService(this.toolRegistry, this.knowledgeEngine);
    this.workflowEngine = workflowEngine || new WorkflowEngine(
      this.workflowRepo,
      this.runRepo,
      this.approvalKernel,
      this.toolRegistry,
      this.modelRouter,
      this.workspaceRoot,
      (runId, type, data) => this.emitRunEvent(runId, type, data),
      this.toolGateway,
      this.researchService
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

  public setAutomationEngine(engine: any): void {
    this.automationEngine = engine;
  }

  public getAutomationEngine(): any {
    return this.automationEngine;
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
    if (request.prompt.length > 1_000_000) {
      const error = new Error('PROMPT_TOO_LARGE');
      (error as Error & { code: string }).code = 'PROMPT_TOO_LARGE';
      throw error;
    }

    const runId = `run_${crypto.randomUUID().slice(0, 10)}`;
    const now = Date.now();

    // 1. Authoritative Server Intent Routing & Policy Gate
    const conversationHistory = (
      request.context?.conversationHistory ||
      request.context?.history
    ) as Array<{ role: string; content: string }> | undefined;

    const routingDecision = await this.router.route({
      prompt: request.prompt,
      principal,
      advisoryIntent: request.intent,
      context: request.context,
      conversationHistory
    });

    const execution = this.modelRouter.resolveExecution(
      request.modelPolicy?.model || 'aira-auto',
      routingDecision.intent
    );

    const basePolicy = execution.policy;
    const requestedPolicy = request.modelPolicy;
    const extendedThinking = requestedPolicy?.extendedThinking ?? basePolicy.extendedThinking;

    const policy: ModelPolicy = ModelPolicySchema.parse({
      ...basePolicy,
      temperature: requestedPolicy?.temperature ?? basePolicy.temperature,
      maxTokens: requestedPolicy?.maxTokens ?? (extendedThinking ? Math.max(basePolicy.maxTokens, 8192) : basePolicy.maxTokens),
      extendedThinking,
      reasoningBudget: requestedPolicy?.reasoningBudget ?? (extendedThinking ? (basePolicy.reasoningBudget ?? 2048) : undefined),
    });

    const provenance: ModelProvenance = {
      requestedModel: request.modelPolicy?.model || 'aira-auto',
      resolvedPolicyModel: execution.policy.model,
      provider: execution.provider,
      executedModel: execution.executedModel,
      plannedModel: execution.plannedModel || execution.executedModel,
      fallbackOccurred: execution.fallbackOccurred,
      fallbackReason: execution.fallbackReason,
      verified: false,
      executionStatus: 'PENDING',
      timestamp: now
    };

    // Never accept execution plans from client-provided request context.
    // The persisted mission state is exclusively created and advanced by the server.
    const safeContext = { ...(request.context || {}) };
    delete safeContext.__airaMissionV1;
    delete safeContext.__airaOutcomeVerificationV2;

    const run: Run = {
      id: runId,
      principalId: principal.userId,
      principalScopes: principal.scopes || [],
      agentId: null,
      sessionId: principal.sessionId,
      workspaceId: principal.workspaceId || null,
      projectId: request.projectId || principal.projectId || null,
      conversationId: request.conversationId || null,
      intent: routingDecision.intent,
      routingDecision,
      provenance,
      state: 'QUEUED',
      modelPolicy: policy,
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      context: {
        ...safeContext,
        attachments: request.attachments,
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

  /**
   * Delegates a real, read-only child run with narrowed permissions and a
   * PostgreSQL parent/child record. Cannot invoke browser writes or shells.
   * This is server-authoritative orchestration; model planning of delegations
   * is NOT enabled until planner policies explicitly support it.
   */
  public async delegateSpecialist(
    parentRunId: string,
    specialist: Specialist,
    objective: string,
    requestedScopes: string[],
    principal: ExecutionPrincipal
  ): Promise<Delegation> {
    if (process.env.AIRA_SPECIALIST_DELEGATION_ENABLED !== 'true')
      throw new Error('SPECIALIST_DELEGATION_NOT_ENABLED');
    // Never accept durable child tasks unless a continuously polling worker
    // is configured. API setImmediate is not a durable scheduler.
    if(process.env.AIRA_SPECIALIST_WORKER_ENABLED !== 'true')
      throw new Error('SPECIALIST_WORKER_NOT_CONFIGURED');
    if (typeof objective !== 'string' || objective.length < 5 || objective.length > 16000)
      throw new Error('DELEGATION_INVALID_OBJECTIVE');
    const parent = await this.runRepo.getRun(parentRunId);
    if (!parent || parent.principalId !== principal.userId ||
        parent.sessionId !== principal.sessionId ||
        !['QUEUED','RUNNING','WAITING_FOR_APPROVAL','WAITING_FOR_TOOL'].includes(parent.state))
      throw new Error('DELEGATION_PARENT_NOT_AUTHORIZED');
    const scopes = delegatedScopes(
      parent.principalScopes.filter(s => (principal.scopes || []).includes(s)),
      requestedScopes, specialist
    );
    const repo = new DurableDelegations();
    const key = delegationKey(parent.id, specialist, objective);
    const existing = await repo.findByKey(principal.userId, parent.id, key);
    if (existing) {
      if (!isDeepStrictEqual(existing.scopes, scopes))
        throw new Error('DELEGATION_IDEMPOTENCY_SCOPE_CONFLICT');
      return existing;
    }
    // Create a real AIRA run; never create an artificial specialist response.
    const childPrincipal: ExecutionPrincipal = {
      ...principal, scopes, workspaceId: parent.workspaceId || undefined,
      projectId: parent.projectId || undefined
    };
    const child = await this.createRun({
      prompt: objective, intent: 'AGENT_MISSION',
      modelPolicy: { model: parent.modelPolicy.model },
      context: { specialist, delegatedFrom: parent.id }
    }, childPrincipal);
    try {
      if (child.provenance?.provider === 'mock') throw new Error('DELEGATION_LIVE_MODEL_REQUIRED');
      const row = await repo.register(parent, child, specialist, objective, scopes, key);
      // Commit-and-return: dedicated worker acquires this durable row.
      // Never execute the child inside the ephemeral HTTP request process.
      return row;
    } catch (err) {
      // Never leave an unlinked orphan child runnable after a racing request.
      child.state = 'CANCELLED';
      child.error = 'DELEGATION_REGISTRATION_ABORTED';
      await this.runRepo.saveRun(child);
      const winner = await repo.findByKey(principal.userId, parent.id, key);
      if (winner && isDeepStrictEqual(winner.scopes, scopes)) return winner;
      throw err;
    }
  }

  /** Only the separate worker process may execute a DB-claimed child. */
  public async executeClaimedSpecialist(
    delegationId:string, ownerId:string, worker:string, fence:number,recovered:boolean
  ):Promise<'TERMINAL'|'WAITING'|'STILL_RUNNING'>{
    if(process.env.AIRA_SPECIALIST_WORKER_PROCESS!=='true' ||
       process.env.AIRA_SPECIALIST_WORKER_ENABLED!=='true')
      throw new Error('DELEGATION_DEDICATED_WORKER_REQUIRED');
    const registry=new DurableDelegations();
    await registry.assertClaim(ownerId,delegationId,worker,fence);
    const record=await registry.get(ownerId,delegationId);
    if(!record)throw new Error('DELEGATION_NOT_FOUND');
    const child=await this.runRepo.getRun(record.childRunId);
    if(!child || child.principalId!==ownerId)
      throw new Error('DELEGATION_CHILD_OWNER_MISMATCH');
    await registry.assertChildAuthorized(
      child,record.parentRunId,record.specialist
    );
    if(['COMPLETED','FAILED','CANCELLED'].includes(child.state))return 'TERMINAL';
    if(child.state==='WAITING_FOR_APPROVAL' ||
       child.executionCheckpoint==='WAITING_FOR_APPROVAL') return 'WAITING';
    this.delegatedLeases.set(child.id,{id:delegationId,owner:ownerId,worker,fence});
    try{
    // Reclaimed execution always goes through the existing crash-recovery
    // classifier, including the non-idempotent replay fence.
    if(recovered || child.executionCheckpoint==='TOOL_EXECUTING') {
      await this.resumeRun(child.id);
    } else {
      await this.startRun(child.id);
    }
    await registry.assertClaim(ownerId,delegationId,worker,fence);
    const fresh=await this.runRepo.getRun(child.id);
    if(!fresh)throw new Error('DELEGATION_CHILD_DISAPPEARED');
    if(['COMPLETED','FAILED','CANCELLED'].includes(fresh.state))return 'TERMINAL';
    if(fresh.state==='WAITING_FOR_APPROVAL' ||
       fresh.executionCheckpoint==='WAITING_FOR_APPROVAL')return 'WAITING';
    return 'STILL_RUNNING';
    } finally {
      this.delegatedLeases.delete(child.id);
    }
  }

  public async listSpecialistDelegations(parentRunId: string, principal: ExecutionPrincipal): Promise<Delegation[]> {
    const parent = await this.runRepo.getRun(parentRunId);
    if (!parent || parent.principalId !== principal.userId)
      throw new Error('DELEGATION_PARENT_NOT_AUTHORIZED');
    return new DurableDelegations().list(principal.userId, parentRunId);
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
      const latest=await this.runRepo.getRun(runId);
      if(latest?.context?.delegatedFrom){
        try{await this.assertDelegatedLease(runId);}
        catch{
          // An expired/fenced old process cannot mark a newer worker's
          // child FAILED after it lost execution authority.
          return;
        }
      }
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
    if(process.env.AIRA_SPECIALIST_DELEGATION_ENABLED === 'true'){
      // Bounded DB cascade before closing parent prevents orphaned descendants.
      await new DurableDelegations().cancelTree(run.principalId,runId);
    }
    await this.transitionRunState(runId, 'CANCELLED', 'Run was cancelled programmatically.');
    return true;
  }

  public async submitApproval(requestId: string, decision: ApprovalDecision): Promise<boolean> {
    const pending = await this.approvalKernel.getPendingRequest(requestId);
    if (!pending) return false;
    const run = await this.runRepo.getRun(pending.runId);
    if (!run) return false;
    // The API verifies request ownership before invoking this method. Persist
    // the authenticated run owner as the approval principal, not an absent
    // or caller-supplied resolvedBy value.
    const { approved, request } = await this.approvalKernel.decide(
      requestId, decision, run.principalId
    );
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

    if(run.context?.delegatedFrom){
      const resumed=await new DurableDelegations().wakeApprovedChild(
        run.principalId,request.runId
      );
      if(!resumed)throw new Error('DELEGATED_APPROVAL_RECOVERY_NOT_QUEUED');
      // Child execution is owned by the dedicated worker; never run here.
      return true;
    }

    // Ordinary non-delegated run resumes its existing execution path.
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
    if (state === 'FAILED' && run.provenance) {
      run.provenance.verified = false;
      run.provenance.executionStatus = 'FAILED';
    }
    await this.runRepo.saveRun(run);

    if (state === 'FAILED' && run.provenance) {
      await this.emitRunEvent(runId, 'model.provenance', run.provenance);
    }

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

    // A delegated child may not treat its own context, model-selected tool,
    // or prior approval as authorization. Reconcile with PostgreSQL on every
    // entry/recovery and again before dispatching additional tool calls.
    const childParent = run.context?.delegatedFrom;
    if(childParent)await this.assertDelegatedLease(runId);
    const childSpecialist = run.context?.specialist;
    if (childParent !== undefined || childSpecialist !== undefined) {
      try {
        if(typeof childParent!=='string' || !['repository','research','verification'].includes(childSpecialist) ||
          !['AGENT_MISSION','TOOL_ACTION'].includes(run.intent)) {
          throw new Error('DELEGATED_CHILD_POLICY_INVALID');
        }
        const checkpointTool=['TOOL_SELECTED','TOOL_APPROVED','TOOL_EXECUTING','TOOL_COMPLETED'].includes(
          run.executionCheckpoint||''
        ) ? run.toolCalls[run.toolCalls.length-1]?.name : undefined;
        await new DurableDelegations().assertChildAuthorized(
          run,childParent,childSpecialist,checkpointTool
        );
        if(checkpointTool){
          const def=this.toolGateway.getTool(checkpointTool)?.definition||
            this.toolRegistry.get(checkpointTool)?.definition;
          if(!def || def.permissionLevel!=='READ' ||
            (def.sideEffectLevel!=='READ'&&def.sideEffectLevel!=='NONE')) {
            throw new Error('DELEGATED_TOOL_REQUIRES_UNAUTHORIZED_MUTATION');
          }
        }
      } catch(err:any){
        const message='DELEGATED_EXECUTION_BLOCKED: '+String(err?.message||err);
        run.error=message;
        run.content=message;
        run.executionCheckpoint='TOOL_FAILED';
        await this.runRepo.saveRun(run);
        await this.transitionRunState(runId,'FAILED',message);
        return;
      }
    }

    // No persisted model-plan tool can ever reach the approval or execution
    // gateway without passing the server HMAC, scope and exact-call gates.
    // Recheck on every restart, not only after the tool returned.
    const stored = run.context?.__airaMissionV1 as AnyMissionProgress | undefined;
    if (stored?.version === 2) {
      const step = stored.plan?.steps?.[stored.dispatched - 1];
      const tool = run.toolCalls[run.toolCalls.length - 1];
      const definition = tool ? this.toolGateway.getTool(tool.name)?.definition : undefined;
      const valid = validateStoredModelMission(
        run.prompt, stored, process.env.AIRA_AGENT_PLAN_SIGNING_KEY || '',
        this.toolGateway.listDefinitions(), run.principalScopes || []
      );
      if (!valid || !step || !tool || stored.currentCallId !== tool.id ||
          tool.name !== step.toolName ||
          !isDeepStrictEqual(tool.arguments, step.arguments) ||
          definition?.permissionLevel !== 'READ' ||
          (definition?.sideEffectLevel !== 'READ' && definition?.sideEffectLevel !== 'NONE')) {
        const msg = 'MODEL_MISSION_INTEGRITY_FAILURE: persisted executable plan or tool call was not authorized.';
        run.content = msg;
        run.error = msg;
        run.executionCheckpoint = 'TOOL_FAILED';
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'content.delta', { delta: msg });
        await this.transitionRunState(runId, 'FAILED', msg);
        return;
      }
    }

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

    // Checkpoint 0.1: Immediate Clarification Delivery for Ambiguous Queries
    if (run.routingDecision?.metadata?.reasoningStrategy === 'CLARIFY_AMBIGUOUS' && run.routingDecision?.metadata?.clarificationPrompt) {
      if (run.state !== 'RUNNING') {
        await this.transitionRunState(runId, 'RUNNING');
      }
      const clarificationMsg = run.routingDecision.metadata.clarificationPrompt;
      run.content = clarificationMsg;
      run.executionCheckpoint = 'COMPLETED';
      await this.runRepo.saveRun(run);
      await this.emitRunEvent(runId, 'content.delta', { delta: clarificationMsg });
      await this.transitionRunState(runId, 'COMPLETED');
      return;
    }

    // Checkpoint 0.4: Automation Engine execution target
    if (run.routingDecision?.executionTarget === 'AUTOMATION_ENGINE' || run.intent === 'AUTOMATION_CREATE') {
      if (run.state !== 'RUNNING') {
        await this.transitionRunState(runId, 'RUNNING');
      }

      if (!this.automationEngine) {
        const errorMsg = 'AUTOMATION_ENGINE_NOT_AVAILABLE: AutomationEngine is not configured on this runtime.';
        run.content = errorMsg;
        run.executionCheckpoint = 'COMPLETED';
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'content.delta', { delta: errorMsg });
        await this.transitionRunState(runId, 'FAILED', errorMsg);
        return;
      }

      try {
        const pLower = run.prompt.toLowerCase();
        let cronExpr = '0 9 * * 1';
        let name = 'Scheduled Automation';

        if (pLower.includes('monday') && (pLower.includes('9 am') || pLower.includes('9am'))) {
          cronExpr = '0 9 * * 1';
          name = 'Weekly Monday 9 AM Summary';
        } else if (pLower.includes('daily') || pLower.includes('every day')) {
          cronExpr = '0 9 * * *';
          name = 'Daily Report';
        } else if (pLower.includes('hourly') || pLower.includes('every hour')) {
          cronExpr = '0 * * * *';
          name = 'Hourly Update';
        } else {
          name = `Automation: ${run.prompt.slice(0, 36)}`;
        }

        const autoDef = await this.automationEngine.createAutomation({
          name,
          principalId: run.principalId,
          enabled: true,
          trigger: 'CRON',
          cronExpression: cronExpr,
          agentId: 'agent-default',
          objective: run.prompt,
          conditions: {},
          approvalPolicy: 'autonomous'
        });

        const successMsg = `Successfully created durable scheduled automation "${autoDef.name}" (ID: ${autoDef.id}) with cron expression "${cronExpr}". Principal owner: ${run.principalId}. The schedule is saved in durable Postgres storage.`;
        run.content = successMsg;
        run.executionCheckpoint = 'COMPLETED';
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'content.delta', { delta: successMsg });
        await this.transitionRunState(runId, 'COMPLETED');
        return;
      } catch (err: any) {
        const errorMsg = `Failed to create automation: ${err.message}`;
        run.content = errorMsg;
        run.executionCheckpoint = 'COMPLETED';
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'content.delta', { delta: errorMsg });
        await this.transitionRunState(runId, 'FAILED', errorMsg);
        return;
      }
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
      const isResearchIntent = run.intent === 'RESEARCH';
      const isAgentMissionWithResearch = run.intent === 'AGENT_MISSION' && (
        run.prompt.toLowerCase().includes('latest') ||
        run.prompt.toLowerCase().includes('recent') ||
        run.prompt.toLowerCase().includes('compare the sources') ||
        run.prompt.toLowerCase().includes('sources') ||
        run.prompt.toLowerCase().includes('research')
      );

      if (isResearchIntent || isAgentMissionWithResearch) {
        const detectedSubject = run.routingDecision?.metadata?.detectedSubject;
        const topic = run.routingDecision?.metadata?.topic;
        const researchPrompt = detectedSubject && topic === 'FINANCIAL' && !/\b(?:share|stock|price|quote|trading)\b/i.test(run.prompt)
          ? `${detectedSubject} current share price stock quote premarket regular market timestamp`
          : detectedSubject && topic === 'WEATHER' && !/\b(?:weather|forecast|temperature)\b/i.test(run.prompt)
          ? `${detectedSubject} weather today current conditions forecast`
          : detectedSubject && topic === 'BOX_OFFICE' && !/\b(?:box\s+office|gross|collection)\b/i.test(run.prompt)
          ? `${detectedSubject} box office worldwide gross Box Office Mojo The Numbers`
          : run.prompt;

        const researchResult = await this.researchService.executeResearch({
          prompt: researchPrompt,
          runId,
          topic,
          location: topic === 'WEATHER' ? (detectedSubject || undefined) : undefined,
          principal: run.principal
        });

        if (researchResult.freshnessRequired && !researchResult.providerReady) {
          const msg = `RESEARCH_PROVIDER_NOT_READY: Live web-search evidence is unavailable. Configure TAVILY_API_KEY or EXA_API_KEY, or check provider quota and connectivity. Aira does not invent citations.`;
          run.content = msg;
          run.executionCheckpoint = 'COMPLETED';
          await this.runRepo.saveRun(run);
          await this.emitRunEvent(runId, 'content.delta', { delta: msg });
          await this.transitionRunState(runId, 'COMPLETED');
          return;
        }
        
        run.citations = researchResult.citations;
        
        // Preserve real execution outputs, not just the generated tool-call request.
        if (researchResult.toolCalls.length > 0) {
          for (const tc of researchResult.toolCalls) {
            run.toolsUsed.push(tc.name);
            run.toolCalls.push(tc);
            run.stepCount++;
          }
          run.toolResults.push(...researchResult.toolResults);
        }
      } else {
        const scope = run.principal ? { principalId: run.principal.userId, workspaceId: run.principal.workspaceId, isSystem: false } : undefined;
        const knowledgeResults = await this.knowledgeEngine.search(run.prompt, 3, scope);
        run.citations = knowledgeResults.map(r => r.citation);
      }
      run.executionCheckpoint = 'KNOWLEDGE_READY';
      await this.runRepo.saveRun(run);
      for (const cite of run.citations) {
        await this.emitRunEvent(runId, 'source.added', cite);
      }
    }

    // Checkpoint 2: Prepare tool selection if needed
    if (run.executionCheckpoint === 'KNOWLEDGE_READY') {
      const isToolAction = run.intent === 'TOOL_ACTION';
      const isAgentMission = run.intent === 'AGENT_MISSION';

      if (isToolAction || isAgentMission) {
        let missionPlan: ReturnType<typeof compileSupportedMission> | import('./model-mission.js').ModelMissionPlan =
          compileSupportedMission(run.prompt);
        let planSignature: string | undefined;
        // The model can propose only when no real deterministic mission matches.
        // Fail closed rather than inventing an unsupported task if planning fails.
        if (!missionPlan && isAgentMission && process.env.AIRA_MODEL_MISSIONS_ENABLED === 'true') {
          try {
            const proposed = await compileModelMission(
              run.prompt, this.modelRouter, run.modelPolicy,
              this.toolGateway.listDefinitions(), run.principalScopes || [],
              process.env.AIRA_AGENT_PLAN_SIGNING_KEY || ''
            );
            missionPlan = proposed.plan;
            planSignature = proposed.planSignature;
          } catch (err: any) {
            const message = 'MODEL_MISSION_PLANNING_FAILED: ' + String(err?.message || err);
            run.content = message;
            run.error = message;
            run.executionCheckpoint = 'TOOL_FAILED';
            await this.runRepo.saveRun(run);
            await this.emitRunEvent(runId, 'content.delta', { delta: message });
            await this.transitionRunState(runId, 'FAILED', message);
            return;
          }
        }
        const firstMissionStep = missionPlan?.steps[0];
        const selected = firstMissionStep
          ? { ok: true as const, name: firstMissionStep.toolName, args: firstMissionStep.arguments }
          : selectExecutableTool(run.prompt, isAgentMission ? 'AGENT_MISSION' : 'TOOL_ACTION', {
              allowDiagnosticTools: process.env.NODE_ENV === 'test'
            });
        if (!selected.ok) {
          const message = `${selected.code}: ${selected.reason}`;
          run.content = message;
          run.error = message;
          run.executionCheckpoint = 'TOOL_FAILED';
          await this.runRepo.saveRun(run);
          await this.emitRunEvent(runId, 'content.delta', { delta: message });
          await this.transitionRunState(runId, 'FAILED', message);
          return;
        }

        const selectedToolName = selected.name;
        const selectedArgs = selected.args;
        if (typeof childParent === 'string' && childSpecialist) {
          try {
            await new DurableDelegations().assertChildAuthorized(
              run,childParent,childSpecialist,selectedToolName
            );
          }catch(err:any){
            const message='DELEGATED_TOOL_REJECTED: '+String(err?.message||err);
            run.error=message;
            run.executionCheckpoint='TOOL_FAILED';
            await this.runRepo.saveRun(run);
            await this.transitionRunState(runId,'FAILED',message);
            return;
          }
        }
        if (!this.toolGateway.getTool(selectedToolName) && !this.toolRegistry.get(selectedToolName)) {
          const message = `TOOL_UNAVAILABLE: ${selectedToolName} is not registered in this runtime. No simulated execution was performed.`;
          run.content = message;
          run.error = message;
          run.executionCheckpoint = 'TOOL_FAILED';
          await this.runRepo.saveRun(run);
          await this.emitRunEvent(runId, 'content.delta', { delta: message });
          await this.transitionRunState(runId, 'FAILED', message);
          return;
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
        if (missionPlan) {
          run.context.__airaMissionV1 = missionPlan.version === 2
            ? {
                version: 2,
                plan: missionPlan,
                dispatched: 1,
                verified: [],
                currentCallId: toolCall.id,
                planSignature: planSignature || ''
              }
            : {
                version: 1,
                plan: missionPlan,
                dispatched: 1,
                verified: [],
                currentCallId: toolCall.id
              } satisfies AnyMissionProgress;
        }
        run.executionCheckpoint = 'TOOL_SELECTED';
        await this.runRepo.saveRun(run);
        if (missionPlan) {
          await this.emitRunEvent(runId, 'tool.progress', {
            status: 'MISSION_PLANNED',
            objective: run.prompt,
            steps: missionPlan.steps.map(step => ({ id: step.id, tool: step.toolName, purpose: step.purpose }))
          });
        }
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
      
      const isApproved = toolCall.name === 'isolated_application_build'
        ? await this.approvalKernel.isExactToolCallApproved(runId, toolCall, run.principalId)
        : await this.approvalKernel.isToolCallApproved(
            runId, toolCall.name, toolDef?.permissionLevel || 'READ', run.principalId
          );

      const requiresApproval = (!isApproved) && (
        toolDef?.approvalPolicy === 'require_approval' ||
        toolDef?.approvalPolicy === 'always_ask' ||
        toolDef?.permissionLevel === 'WRITE' ||
        toolDef?.permissionLevel === 'EXTERNAL_COMMUNICATION' ||
        toolDef?.permissionLevel === 'FINANCIAL' ||
        toolDef?.sideEffectLevel === 'WRITE' ||
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
      await this.assertDelegatedLease(runId);
      const toolCall = run.toolCalls[run.toolCalls.length - 1];
      run.executionCheckpoint = 'TOOL_EXECUTING';
      await this.runRepo.saveRun(run);

      await this.transitionRunState(runId, 'WAITING_FOR_TOOL');
      await this.emitRunEvent(runId, 'tool.started', { callId: toolCall.id, name: toolCall.name });

      let toolResult: ToolResult;
      const registeredWithGateway = this.toolGateway.getTool(toolCall.name);
      if (registeredWithGateway) {
        await this.assertDelegatedLease(runId);
        toolResult = await this.toolGateway.execute({
          toolName: toolCall.name,
          arguments: toolCall.arguments,
          context: {
            runId,
            principal: {
              userId: run.principalId,
              sessionId: run.sessionId,
              roles: ['member'],
              scopes: run.principalScopes || []
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
      // Parent cancellation can mark a child CANCELLED during an asynchronous
      // read. Never resurrect that cancelled run with a late tool result.
      if(!run || ['CANCELLED','FAILED'].includes(run.state)) return;

      const recoveryEngine = new ToolRecoveryEngine();
      let finalToolResult = toolResult;
      let completionCheck = recoveryEngine.verifyCompletion(toolCall.name, finalToolResult);

      const toolDef = this.toolGateway.getTool(toolCall.name)?.definition || this.toolRegistry.get(toolCall.name)?.definition;
      const isIdempotent = toolDef ? (toolDef.sideEffects === 'NONE' || toolDef.sideEffects === 'READ') : false;
      const alternativeTools: string[] = [];
      if (toolCall.name === 'web_search') alternativeTools.push('tavily_search', 'exa_search');
      else if (toolCall.name === 'browser_navigate') alternativeTools.push('browser_screenshot');

      let attempt = 0;
      while (!completionCheck.verified && attempt < 2) {
        const decision = recoveryEngine.evaluateFailure(
          {
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            isIdempotent,
            requiresApproval: toolDef?.requiresApproval || false,
            alternativeTools
          },
          attempt,
          completionCheck.reason || 'Tool execution unverified',
          finalToolResult
        );

        if (decision.action === 'RETRY') {
          attempt = decision.attempt;
          await this.emitRunEvent(runId, 'tool.progress', {
            status: 'RETRYING',
            attempt,
            explanation: decision.explanation
          });
          await new Promise(r => setTimeout(r, 100 * attempt));

          if (this.toolGateway.getTool(toolCall.name)) {
            finalToolResult = await this.toolGateway.execute({
              toolName: toolCall.name,
              arguments: toolCall.arguments,
              context: {
                runId,
                principal: { userId: run.principalId, sessionId: run.sessionId, roles: ['member'], scopes: run.principalScopes || [] },
                workspaceRoot: this.workspaceRoot
              },
              callId: `${toolCall.id}_retry_${attempt}`
            });
          } else {
            finalToolResult = await this.toolRegistry.execute(toolCall, {
              runId,
              workspaceRoot: this.workspaceRoot,
              sessionGrantedTools: new Set()
            });
          }
          completionCheck = recoveryEngine.verifyCompletion(toolCall.name, finalToolResult);
        } else if (decision.action === 'FALLBACK_TOOL' && decision.alternativeTool) {
          const fallbackTool = decision.alternativeTool;
          await this.emitRunEvent(runId, 'tool.progress', {
            status: 'FALLBACK',
            fallbackTool,
            explanation: decision.explanation
          });
          if (this.toolGateway.getTool(fallbackTool)) {
            finalToolResult = await this.toolGateway.execute({
              toolName: fallbackTool,
              arguments: toolCall.arguments,
              context: {
                runId,
                principal: { userId: run.principalId, sessionId: run.sessionId, roles: ['member'], scopes: run.principalScopes || [] },
                workspaceRoot: this.workspaceRoot
              },
              callId: `${toolCall.id}_fallback_${fallbackTool}`
            });
          }
          completionCheck = recoveryEngine.verifyCompletion(fallbackTool, finalToolResult);
          break;
        } else if (decision.action === 'ASK_APPROVAL') {
          run.executionCheckpoint = 'WAITING_FOR_APPROVAL';
          run.state = 'BLOCKED';
          run.error = decision.explanation;
          if(childParent)await this.assertDelegatedLease(runId);
      run.toolResults.push(finalToolResult);
          await this.runRepo.saveRun(run);
          await this.emitRunEvent(runId, 'tool.approval_required', {
            toolName: toolCall.name,
            explanation: decision.explanation
          });
          return;
        } else {
          // ABORT_PERMANENT_ERROR
          break;
        }
      }

      run.toolResults.push(finalToolResult);

      if (!completionCheck.verified) {
        // Enforce zero fabricated success: failed tool must NEVER emit tool.completed or advance to TOOL_COMPLETED
        run.executionCheckpoint = 'TOOL_FAILED';
        run.state = 'FAILED';
        run.error = completionCheck.reason || 'Tool execution failed verification';
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'tool.failed', {
          toolName: toolCall.name,
          error: completionCheck.reason,
          state: completionCheck.state
        });
        await this.transitionRunState(runId, 'FAILED', run.error);
        return;
      } else {
        run.executionCheckpoint = 'TOOL_COMPLETED';
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'tool.completed', finalToolResult);

        await this.transitionRunState(runId, 'RUNNING');
        
        // Leave TOOL_COMPLETED durable until evidence is checked and the next
        // mission step is dispatched below, including after process recovery.
        run = await this.runRepo.getRun(runId) as Run;
      }
    }

    if (run.executionCheckpoint === 'TOOL_COMPLETED' && (run.intent === 'AGENT_MISSION' || run.intent === 'TOOL_ACTION')) {
      const progress = run.context?.__airaMissionV1 as AnyMissionProgress | undefined;
      if (progress) {
        const lastCall = run.toolCalls[run.toolCalls.length - 1];
        const lastResult = run.toolResults[run.toolResults.length - 1];
        const currentStep = progress.plan?.steps?.[progress.dispatched - 1];
        const valid = progress.version === 2
          ? validateStoredModelMission(run.prompt, progress,
              process.env.AIRA_AGENT_PLAN_SIGNING_KEY || '',
              this.toolGateway.listDefinitions(), run.principalScopes || [])
          : validateDurableMission(run.prompt, progress);
        const evidence = currentStep ? verifyMissionEvidence(currentStep, lastResult) :
          { verified: false, reason: 'Missing mission step' };

        if (!valid || !currentStep || progress.currentCallId !== lastCall?.id ||
            currentStep.toolName !== lastCall.name ||
            !isDeepStrictEqual(currentStep.arguments, lastCall.arguments) ||
            !evidence.verified) {
          const message = 'MISSION_VERIFICATION_FAILED: ' +
            (!valid ? 'Persisted plan does not match the original request.' : evidence.reason);
          run.error = message;
          run.content = message;
          run.executionCheckpoint = 'TOOL_FAILED';
          await this.runRepo.saveRun(run);
          await this.emitRunEvent(runId, 'content.delta', { delta: message });
          await this.transitionRunState(runId, 'FAILED', message);
          return;
        }

        if (progress.verified.length === progress.dispatched - 1) {
          progress.verified.push(currentStep.id);
          await this.runRepo.saveRun(run);
          await this.emitRunEvent(runId, 'tool.progress', {
            status: 'MISSION_STEP_VERIFIED', stepId: currentStep.id,
            step: progress.dispatched, total: progress.plan.steps.length,
            evidence: evidence.reason
          });
        }

        const nextStep = progress.plan.steps[progress.dispatched];
        if (nextStep) {
          if (run.stepCount >= run.maxSteps) {
            const message = 'MISSION_STEP_LIMIT: Execution stopped at the configured maxSteps bound.';
            run.error = message;
            run.content = message;
            run.executionCheckpoint = 'TOOL_FAILED';
            await this.runRepo.saveRun(run);
            await this.transitionRunState(runId, 'FAILED', message);
            return;
          }

          const toolDef = this.toolGateway.getTool(nextStep.toolName)?.definition ||
            this.toolRegistry.get(nextStep.toolName)?.definition;
          if (!toolDef || toolDef.permissionLevel !== 'READ' ||
              (toolDef.sideEffectLevel !== 'READ' && toolDef.sideEffectLevel !== 'NONE')) {
            const message = 'MISSION_TOOL_UNAVAILABLE: Next mission step is not an available read-only tool.';
            run.error = message;
            run.content = message;
            run.executionCheckpoint = 'TOOL_FAILED';
            await this.runRepo.saveRun(run);
            await this.transitionRunState(runId, 'FAILED', message);
            return;
          }

          const nextCall: ToolCall = {
            id: `call_${crypto.randomUUID()}`,
            toolId: toolDef.id,
            name: nextStep.toolName,
            arguments: nextStep.arguments,
            timestamp: Date.now()
          };
          run.toolsUsed.push(nextCall.name);
          run.toolCalls.push(nextCall);
          run.stepCount++;
          progress.dispatched++;
          progress.currentCallId = nextCall.id;
          run.executionCheckpoint = 'TOOL_SELECTED';
          await this.runRepo.saveRun(run);
          await this.emitRunEvent(runId, 'tool.requested', nextCall);
          return this.executeRunLoop(runId);
        }

        // Independent readback is a separate gate from successful adapter calls.
        if (progress.version === 2) {
          const outcome = await verifyFinalMissionOutcome(
            progress.plan.steps, run.toolCalls, run.toolResults, this.workspaceRoot, run.principalId
          );
          run.context.__airaOutcomeVerificationV2 = outcome;
          await this.runRepo.saveRun(run);
          await this.emitRunEvent(runId, 'tool.progress', {
            status: outcome.status,
            verifiedSteps: outcome.evidence.filter(e => e.verified).length,
            totalSteps: progress.plan.steps.length
          });
          if (outcome.status !== 'COMPLETED_VERIFIED') {
            const message = 'MISSION_OUTCOME_NOT_VERIFIED: ' +
              String(outcome.evidence.find(item => !item.verified)?.reason || 'Missing independent evidence');
            run.error = message;
            run.content = message;
            run.executionCheckpoint = 'TOOL_FAILED';
            await this.runRepo.saveRun(run);
            await this.emitRunEvent(runId, 'content.delta', { delta: message });
            await this.transitionRunState(runId, 'FAILED', message);
            return;
          }
        }
        // All steps and their independently observable postconditions are now verified.
        run.executionCheckpoint = 'SYNTHESIZING';
        await this.runRepo.saveRun(run);
      } else {
        // Preserve bounded mission behavior for in-flight legacy runs.
        const continuation = selectMissionFollowUp(run.prompt, run.stepCount);
        if (continuation) {
          const def = this.toolGateway.getTool(continuation.name)?.definition ||
            this.toolRegistry.get(continuation.name)?.definition;
          if (def && def.permissionLevel === 'READ' && run.stepCount < run.maxSteps) {
            const nextCall: ToolCall = {
              id: `call_${crypto.randomUUID()}`,
              toolId: def.id, name: continuation.name,
              arguments: continuation.args, timestamp: Date.now()
            };
            run.toolsUsed.push(nextCall.name);
            run.toolCalls.push(nextCall);
            run.stepCount++;
            run.executionCheckpoint = 'TOOL_SELECTED';
            await this.runRepo.saveRun(run);
            await this.emitRunEvent(runId, 'tool.requested', nextCall);
            return this.executeRunLoop(runId);
          }
        }
      }
    }

    if (run.executionCheckpoint === 'TOOL_COMPLETED' || run.executionCheckpoint === 'TOOL_FAILED') {
      run.executionCheckpoint = 'SYNTHESIZING';
      await this.runRepo.saveRun(run);
    }

    // Checkpoint 5: Synthesis
    if (run.executionCheckpoint === 'SYNTHESIZING') {
      const messages: ChatMessageInput[] = [];

      let durablePastHistory = '';
      try {
        const priorRuns = await this.runRepo.searchRunsForPrincipal(run.principalId, run.prompt, 4);
        const otherRuns = priorRuns.filter(r => r.id !== runId && r.state === 'COMPLETED' && r.content);
        if (otherRuns.length > 0) {
          durablePastHistory = otherRuns.map(r => {
            const dateStr = new Date(r.createdAt).toISOString();
            return `[Prior Run on ${dateStr}]:\nUser: ${r.prompt}\nAira: ${r.content.slice(0, 400)}`;
          }).join('\n\n');
        }
      } catch (memErr) {
        console.warn('Could not query durable prior run history for principal:', memErr);
      }

      const instructionResolver = new InstructionResolver();
      const adaptiveSynthesizer = new AdaptiveSynthesizer();

      const resolvedInstructions = instructionResolver.resolve({
        userPrompt: run.prompt,
        activeProjectId: run.projectId || undefined,
        activeUserId: run.principalId,
        customInstructions: run.systemPrompt
      });

      const writingProfile = adaptiveSynthesizer.deriveProfile(run.prompt, resolvedInstructions);
      const systemDirective = adaptiveSynthesizer.buildSystemDirective(writingProfile);

      if (run.intent === 'RESEARCH') {
        messages.push({
          role: 'system',
          content: `${systemDirective}\n\nYou are operating in rigorous Research mode. Provide evidence-backed synthesis, cite available sources, decompose key claims, and distinguish established facts from inference. Do NOT manufacture citations or claims without evidence.`
        });
      } else if (run.intent === 'AGENT_MISSION') {
        messages.push({
          role: 'system',
          content: `${systemDirective}\n\nYou are operating in Autonomous Mission mode. Distinguish observed tool outputs from analysis, report each actually verified action, and never claim edits, deployments, browser interactions, or other actions not evidenced by the execution results. If evidence is insufficient, explicitly state the limitation.`
        });
      } else if (resolvedInstructions.effectiveInstructions.length > 0) {
        messages.push({
          role: 'system',
          content: `${systemDirective}\n\nContextual Guidelines:\n${resolvedInstructions.effectiveInstructions.join('\n')}`
        });
      } else {
        messages.push({
          role: 'system',
          content: systemDirective
        });
      }

      if (durablePastHistory) {
        messages.push({
          role: 'system',
          content: buildDurableHistorySystemMessage(
            run.principalId,
            durablePastHistory,
            run.prompt
          )
        });
      }
      
      if (run.provenance) {
        await this.emitRunEvent(runId, 'model.provenance', run.provenance);
      }

      const now = new Date();
      const liveSearchProviders = configuredSearchProviders();
      const prov = run.provenance;
      const executedModel = prov?.executedModel || run.modelPolicy.model;
      const executedProvider = prov?.provider || 'unknown';
      const providerLabel = executedProvider === 'nvidia' ? 'NVIDIA NIM'
        : executedProvider === 'anthropic' ? 'Anthropic'
        : executedProvider === 'openai' ? 'OpenAI'
        : executedProvider === 'mock' ? 'Deterministic Mock'
        : 'Unknown Provider';

      const currentContextMsg = `AIRA RUNTIME CONTEXT & IDENTITY PROVENANCE:
Current date: ${now.toDateString()}
Current UTC time: ${now.toISOString()}
Platform: AIRA AI 2026 (Autonomous Operating Workspace)
Execution Model: ${executedModel}
Execution Provider: ${providerLabel}
Requested Model: ${prov?.requestedModel || run.modelPolicy.model}
${prov?.fallbackOccurred ? `Routing Notice: Provider fallback occurred (${prov.fallbackReason || 'preferred provider unavailable'}).` : ''}

CAPABILITY & IDENTITY INVARIANTS:
1. Model Identity Accuracy:
   - When asked what model powers you or generated this response, state truthfully that you are AIRA AI operating with ${executedModel} via ${providerLabel}.
   - Never claim to be "powered by Claude 3.7", "Anthropic Claude", "OpenAI GPT", or any other model unless that model is explicitly the Execution Model above.
   - Do NOT adopt model claims from retrieved memories, project conventions, or conversational context that contradict your runtime Execution Model.
2. Operational Capabilities:
   - Web Search: ${liveSearchProviders.length > 0 ? `OPERATIONAL (${liveSearchProviders.join(', ')})` : 'NOT_CONFIGURED'}
   - Multi-step Workflows: OPERATIONAL (via workflow engine DAG execution).
   - Tool Execution: OPERATIONAL (system tools execute subject to principal permissions).
   - Memory Vault UI: BROWSER_LOCAL_ONLY. Vault entries persist in that browser's localStorage for the user's own reference, but they are NOT connected to this server-side chat model.
   - This server chat cannot automatically access, read, search, or recall Memory Vault UI entries, even in a later conversation in the same browser. Never imply that manually adding a Vault entry enables Aira to recall it in future chats.
   - Recent completed server-side run history may be retrieved for the same principal as bounded conversational context; it is separate from the browser-local Vault and is NOT a guaranteed permanent user-controlled memory store.
   - For a request to remember a fact across future conversations, never assert the fact was saved, persisted to Memory Vault, or will automatically be recalled later. Explain that a manual Vault entry can preserve it for the user to view, but server chat cannot read Vault entries automatically.
   - You must NOT claim access to tools or features that are not operational. You do not have unrestricted local OS or device access without tool execution.
3. Model vs Platform Distinction:
   - AIRA AI is the workspace and application platform.
   - The foundation model powering this generation is ${executedModel}.
   - Distinguish the platform features from the underlying model capabilities.`;

      messages.push({
        role: 'system',
        content: currentContextMsg
      });

      if (run.context && Array.isArray(run.context.history)) {
        messages.push(...run.context.history);
      }

      if (run.context?.attachments && Array.isArray(run.context.attachments) && run.context.attachments.length > 0) {
        const attDocs = run.context.attachments.map((a: any) => `[Uploaded Attachment: ${a.name} (${a.type || 'text'}, ${a.size || 0} bytes)]:\n${a.content || '(binary or external file content)'}`).join('\n\n');
        messages.push({
          role: 'user',
          content: `User uploaded attachments:\n${attDocs}`
        });
      }
      
      messages.push({ role: 'user', content: run.prompt });
      // TOOL_ACTION web searches must use the same guarded synthesis as RESEARCH.
      const executedSearchEvidence = verifiedSearchCitationsFromToolResults(run.toolCalls, run.toolResults);
      const liveEvidence = verifiedWebCitations([...(run.citations || []), ...executedSearchEvidence]);
      if (executedSearchEvidence.length > 0) {
        run.citations = liveEvidence;
        await this.runRepo.saveRun(run);
      }
      const hasExecutedSearch = run.toolCalls.some(call =>
        ['web_search', 'tavily_search', 'exa_search'].includes(call.name)
      );
      const guardedSearchSynthesis = liveEvidence.length > 0 || hasExecutedSearch;


      if (run.toolCalls.length > 0 && run.toolResults.length > 0) {
        const toolSummaries = run.toolCalls.map((call, idx) => {
          const res = run.toolResults[idx];
          if (['web_search', 'tavily_search', 'exa_search'].includes(call.name) && liveEvidence.length > 0) {
            return `[Tool Call ${idx + 1}: ${call.name}]: Executed web-search results are supplied separately as verified source data. Answer the user; do not emit search-request JSON.`;
          }
          return `[Tool Call ${idx + 1}: ${call.name}]:\nArgs: ${JSON.stringify(call.arguments)}\nOutput: ${JSON.stringify(res ? (res.output || res.error) : 'Pending')}`;
        }).join('\n\n');
        messages.push({
          role: 'user',
          content: `[System Tool Execution Findings]:\n${toolSummaries}\n\nPlease synthesize your execution findings and provide the final response.`
        });
      }

      if (liveEvidence.length > 0) {
        const topic = run.routingDecision?.metadata?.topic;
        messages.push({ role: 'system', content: buildResearchEvidenceContext(liveEvidence, topic) });
      }
      const adapter = this.modelRouter.getAdapter(run.modelPolicy);
      // Research text must be screened before it is exposed to the UI.
      // A model emitting repeated JSON search arguments is NOT executing tools.
      let researchDraft = '';

      let completionResult: ModelCompletionResult;
      try {
        completionResult = await adapter.stream(messages, run.modelPolicy, async (delta) => {
          if (delta.thinking) {
            run.thinking += delta.thinking;
            await this.runRepo.saveRun(run);
            await this.emitRunEvent(runId, 'thinking.delta', { delta: delta.thinking });
          }
          if (delta.text) {
            if (guardedSearchSynthesis) {
              researchDraft += delta.text;
            } else {
              run.content += delta.text;
              await this.runRepo.saveRun(run);
              await this.emitRunEvent(runId, 'content.delta', { delta: delta.text });
            }
          }
        });
      } catch (streamErr: any) {
        await this.transitionRunState(runId, 'FAILED', streamErr.message);
        throw streamErr;
      }

      // Reconcile outbound & upstream models and confirm execution provenance
      if (run.provenance) {
        const outboundModel = completionResult?.outboundModel || run.provenance.plannedModel || run.provenance.executedModel;
        const upstreamModel = (typeof completionResult?.model === 'string' && completionResult.model.trim().length > 0)
          ? completionResult.model.trim()
          : undefined;

        run.provenance.outboundModel = outboundModel;
        run.provenance.upstreamResponseModel = upstreamModel;
        run.provenance.executedModel = upstreamModel || outboundModel;

        const isVerified = Boolean(upstreamModel && isModelMatch(outboundModel, upstreamModel));
        run.provenance.verified = isVerified;
        run.provenance.executionStatus = run.provenance.fallbackOccurred ? 'FALLBACK' : 'SUCCESS';
        run.provenance.timestamp = Date.now();
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'model.provenance', run.provenance);
      }

      if (guardedSearchSynthesis) {
        const synthesized = researchDraft.trim();
        const answer = liveEvidence.length === 0
          ? 'Live web search did not return verified sources. I cannot provide a sourced answer for this request.'
          : (!synthesized || isResearchToolCallDump(synthesized))
          ? renderGroundedResearchFallback(liveEvidence)
          : synthesized;
        const sanitizedAnswer = sanitizeCitationMarkers(answer, liveEvidence.length);
        const finalText = sanitizedAnswer + buildResearchSourcesAppendix(liveEvidence);
        run.content += finalText;
        await this.runRepo.saveRun(run);
        await this.emitRunEvent(runId, 'content.delta', { delta: finalText });
      }

      run.executionCheckpoint = 'FINALIZING';
      await this.runRepo.saveRun(run);
    }

    // Checkpoint 6: Artifacts & Completion
    if (run.executionCheckpoint === 'FINALIZING') {
      run.content = sanitizeCitationMarkers(run.content, run.citations?.length || 5);
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
      // Delegated child runs belong exclusively to the separately leased
      // specialist dispatcher. General API startup recovery must not steal
      // their authority or mark them failed without a worker fence.
      if(run.context?.delegatedFrom)continue;
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

      // Only server-validated read-only plans may replay. Their exact plan and
      // call arguments must match before resuming an interrupted adapter call.
      // Other operations still follow the existing non-idempotent crash fence.
      const progress = run.context?.__airaMissionV1 as AnyMissionProgress | undefined;
      const step = progress?.plan?.steps?.[progress.dispatched - 1];
      const gatewayDefinition = toolCall ? this.toolGateway.getTool(toolCall.name)?.definition : undefined;
      const replayableMissionRead = Boolean(
        progress && (progress.version === 2
          ? validateStoredModelMission(run.prompt, progress,
              process.env.AIRA_AGENT_PLAN_SIGNING_KEY || '',
              this.toolGateway.listDefinitions(), run.principalScopes || [])
          : validateDurableMission(run.prompt, progress)) &&
        step && toolCall && progress.currentCallId === toolCall.id &&
        step.toolName === toolCall.name &&
        isDeepStrictEqual(step.arguments, toolCall.arguments) &&
        gatewayDefinition?.permissionLevel === 'READ' &&
        gatewayDefinition.sideEffectLevel === 'READ'
      );

      if (!replayableMissionRead &&
          (idempotencyClass === 'NON_IDEMPOTENT' || idempotencyClass === 'EXTERNAL_SIDE_EFFECT')) {
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
export * from './git-policy.js';
