import {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepDefinition,
  WorkflowStepExecution,
  WorkflowStepState,
  ApprovalDecision,
  validateWorkflowDag,
  ExecutionPrincipal,
  Run,
  Artifact
} from '../../contracts/src/index.js';
import { WorkflowRepository } from './workflow-repositories.js';
import { RunRepository } from './repositories.js';
import { ApprovalKernel } from '../../approvals/src/index.js';
import { ToolRegistry, ToolGateway } from '../../tool-runtime/src/index.js';
import { ModelRouter } from '../../model-router/src/index.js';
import { ResearchService } from './research.js';

export class WorkflowEngine {
  constructor(
    private workflowRepo: WorkflowRepository,
    private runRepo: RunRepository,
    private approvalKernel: ApprovalKernel,
    private toolRegistry: ToolRegistry,
    private modelRouter: ModelRouter,
    private workspaceRoot: string = process.cwd(),
    private eventEmitterCallback?: (runId: string, type: any, data: any) => Promise<void>,
    private toolGateway?: ToolGateway,
    private researchService?: ResearchService
  ) {}

  /**
   * Create a new workflow run and link it to an Aira Run
   */
  public async createWorkflowRun(
    definition: WorkflowDefinition,
    run: Run,
    principal: ExecutionPrincipal
  ): Promise<WorkflowRun> {
    const dagResult = validateWorkflowDag(definition);
    if (!dagResult.valid) {
      throw new Error(`Invalid workflow DAG: ${dagResult.error}`);
    }

    await this.workflowRepo.saveWorkflowDefinition(definition);

    const initialStepStates: Record<string, WorkflowStepState> = {};
    const initialStepAttempts: Record<string, number> = {};

    for (const step of definition.steps) {
      initialStepStates[step.stepId] = 'PENDING';
      initialStepAttempts[step.stepId] = 0;
    }

    const workflowRun: WorkflowRun = {
      id: `wfrun_${run.id}`,
      workflowId: definition.workflowId,
      runId: run.id,
      principalId: principal.userId,
      sessionId: principal.sessionId,
      state: 'CREATED',
      stepStates: initialStepStates,
      stepOutputs: {},
      stepAttempts: initialStepAttempts,
      artifacts: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // Save parent workflowRun before child steps to satisfy foreign key constraint
    await this.workflowRepo.saveWorkflowRun(workflowRun);

    for (const step of definition.steps) {
      const stepExecution: WorkflowStepExecution = {
        id: `step_exec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        workflowRunId: workflowRun.id,
        stepId: step.stepId,
        name: step.name,
        state: 'PENDING',
        dependsOn: step.dependsOn,
        attempt: 0,
        input: step.input,
        sideEffectLevel: step.sideEffectLevel,
        approvalRequired: step.approvalRequired,
        idempotencyKey: step.idempotencyKey
      };
      await this.workflowRepo.saveWorkflowStep(stepExecution);
    }
    await this.emitWorkflowEvent(run.id, 'workflow.created', {
      workflowRunId: workflowRun.id,
      workflowId: definition.workflowId,
      name: definition.name,
      totalSteps: definition.steps.length
    });

    return workflowRun;
  }

  /**
   * Main DAG Execution Loop
   */
  public async executeWorkflowRun(workflowRunId: string): Promise<void> {
    let workflowRun = await this.workflowRepo.getWorkflowRun(workflowRunId);
    if (!workflowRun) return;

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(workflowRun.state)) {
      return;
    }

    const definition = await this.workflowRepo.getWorkflowDefinition(workflowRun.workflowId);
    if (!definition) {
      await this.failWorkflow(workflowRun, `Workflow definition "${workflowRun.workflowId}" not found.`);
      return;
    }

    if (workflowRun.state === 'CREATED' || workflowRun.state === 'QUEUED') {
      workflowRun.state = 'RUNNING';
      workflowRun.updatedAt = Date.now();
      await this.workflowRepo.saveWorkflowRun(workflowRun);
      await this.emitWorkflowEvent(workflowRun.runId, 'workflow.started', {
        workflowRunId: workflowRun.id,
        workflowId: definition.workflowId
      });
    }

    // Step Scheduling Loop
    while (true) {
      workflowRun = (await this.workflowRepo.getWorkflowRun(workflowRunId))!;
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_FOR_APPROVAL'].includes(workflowRun.state)) {
        break;
      }

      // Check if all steps have reached terminal state
      const allTerminal = definition.steps.every(step => {
        const s = workflowRun!.stepStates[step.stepId];
        return s === 'COMPLETED' || s === 'SKIPPED' || s === 'FAILED';
      });

      if (allTerminal) {
        const hasFailures = definition.steps.some(step => workflowRun!.stepStates[step.stepId] === 'FAILED');
        if (hasFailures) {
          await this.failWorkflow(workflowRun, 'One or more workflow steps failed.');
        } else {
          await this.completeWorkflow(workflowRun, definition);
        }
        break;
      }

      // Find steps ready for execution
      const readySteps: WorkflowStepDefinition[] = [];
      let skippedAnyInThisIteration = false;
      for (const step of definition.steps) {
        const currentState = workflowRun.stepStates[step.stepId];
        if (currentState === 'READY') {
          readySteps.push(step);
          continue;
        }
        if (currentState !== 'PENDING') continue;

        // Check dependencies
        let canRun = true;
        let hasDependencyFailure = false;

        for (const depId of step.dependsOn) {
          const depState = workflowRun.stepStates[depId];
          if (depState === 'FAILED' || depState === 'SKIPPED') {
            hasDependencyFailure = true;
            break;
          }
          if (depState !== 'COMPLETED') {
            canRun = false;
            break;
          }
        }

        if (hasDependencyFailure) {
          // Skip this step as upstream dependency failed
          workflowRun.stepStates[step.stepId] = 'SKIPPED';
          await this.updateStepState(workflowRun.id, step.stepId, 'SKIPPED', undefined, 'Skipped due to upstream dependency failure');
          skippedAnyInThisIteration = true;
          continue;
        }

        if (canRun) {
          readySteps.push(step);
        }
      }

      if (skippedAnyInThisIteration) {
        // Persist the skipped step states in workflowRun
        await this.withRunLock(workflowRunId, async () => {
          const fresh = (await this.workflowRepo.getWorkflowRun(workflowRunId))!;
          for (const step of definition.steps) {
            if (workflowRun!.stepStates[step.stepId] === 'SKIPPED') {
              fresh.stepStates[step.stepId] = 'SKIPPED';
            }
          }
          fresh.updatedAt = Date.now();
          await this.workflowRepo.saveWorkflowRun(fresh);
          workflowRun = fresh;
        });

        // Re-check if all steps are now terminal!
        const nowAllTerminal = definition.steps.every(step => {
          const s = workflowRun!.stepStates[step.stepId];
          return s === 'COMPLETED' || s === 'SKIPPED' || s === 'FAILED';
        });
        if (nowAllTerminal) {
          const hasFailures = definition.steps.some(step => workflowRun!.stepStates[step.stepId] === 'FAILED');
          if (hasFailures) {
            await this.failWorkflow(workflowRun!, 'One or more workflow steps failed.');
          } else {
            await this.completeWorkflow(workflowRun!, definition);
          }
          break;
        }
      }

      if (readySteps.length === 0) {
        // No steps currently ready. Check if any are running OR waiting for approval
        const runningCount = Object.values(workflowRun.stepStates).filter(s => s === 'RUNNING').length;
        const waitingApprovalCount = Object.values(workflowRun.stepStates).filter(s => s === 'WAITING_FOR_APPROVAL').length;
        if (waitingApprovalCount > 0 || workflowRun.state === 'WAITING_FOR_APPROVAL') {
          // Workflow is paused waiting for user approval, NOT stalled!
          break;
        }
        if (runningCount === 0) {
          // Deadlock or unresolvable dependencies
          await this.failWorkflow(workflowRun, 'Workflow stalled: no steps can proceed.');
        }
        break;
      }

      // Concurrency bounding
      const maxConcurrency = definition.executionPolicy?.maxConcurrentSteps || 3;
      const stepsToRun = readySteps.slice(0, maxConcurrency);

      // Execute ready steps in parallel
      const stepPromises = stepsToRun.map(step => this.executeStep(workflowRunId, step, definition));
      await Promise.all(stepPromises);

      // Reload workflow run state to reflect step completions
      workflowRun = (await this.workflowRepo.getWorkflowRun(workflowRunId))!;
      if (workflowRun.state === 'WAITING_FOR_APPROVAL') {
        break; // Pause execution loop until user approves
      }
    }
  }

  private runLocks: Map<string, Promise<any>> = new Map();

  private async withRunLock<T>(workflowRunId: string, fn: () => Promise<T>): Promise<T> {
    const currentLock = this.runLocks.get(workflowRunId) || Promise.resolve();
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => { release = resolve; });
    this.runLocks.set(workflowRunId, currentLock.then(() => nextLock));
    try {
      await currentLock;
      return await fn();
    } finally {
      release!();
    }
  }

  /**
   * Execute a single workflow step with retries, approvals, and idempotency
   */
  private async executeStep(
    workflowRunId: string,
    stepDef: WorkflowStepDefinition,
    _definition: WorkflowDefinition
  ): Promise<void> {
    let workflowRun = (await this.workflowRepo.getWorkflowRun(workflowRunId))!;
    const runId = workflowRun.runId;

    // 1. Idempotency Check
    if (stepDef.idempotencyKey) {
      const existing = await this.workflowRepo.getStepByIdempotencyKey(stepDef.idempotencyKey);
      if (existing && existing.state === 'COMPLETED') {
        await this.withRunLock(workflowRunId, async () => {
          const fresh = (await this.workflowRepo.getWorkflowRun(workflowRunId))!;
          fresh.stepStates[stepDef.stepId] = 'COMPLETED';
          fresh.stepOutputs[stepDef.stepId] = existing.output;
          await this.workflowRepo.saveWorkflowRun(fresh);
        });
        await this.emitWorkflowEvent(runId, 'workflow.step.completed', {
          stepId: stepDef.stepId,
          name: stepDef.name,
          reusedFromIdempotencyKey: stepDef.idempotencyKey,
          output: existing.output
        });
        return;
      }
    }

    // 2. Approval Check
    const isAlreadyApproved = workflowRun.stepStates[stepDef.stepId] === 'READY';
    const requiresApproval = !isAlreadyApproved && (stepDef.approvalRequired ||
      stepDef.sideEffectLevel === 'DESTRUCTIVE' ||
      (stepDef.sideEffectLevel === 'WRITE' && stepDef.approvalRequired));

    if (requiresApproval) {
      const isApproved = await this.approvalKernel.isToolCallApproved(
        runId,
        `workflow_step_${stepDef.stepId}`,
        stepDef.sideEffectLevel,
        workflowRun.principalId
      );

      if (!isApproved) {
        await this.withRunLock(workflowRunId, async () => {
          const fresh = (await this.workflowRepo.getWorkflowRun(workflowRunId))!;
          fresh.state = 'WAITING_FOR_APPROVAL';
          fresh.pendingApprovalStepId = stepDef.stepId;
          fresh.stepStates[stepDef.stepId] = 'WAITING_FOR_APPROVAL';
          fresh.updatedAt = Date.now();
          await this.workflowRepo.saveWorkflowRun(fresh);
        });

        await this.updateStepState(workflowRun.id, stepDef.stepId, 'WAITING_FOR_APPROVAL');

        const approvalReq = await this.approvalKernel.createRequest(
          runId,
          {
            id: `call_step_${stepDef.stepId}`,
            toolId: `workflow_step_${stepDef.stepId}`,
            name: stepDef.name,
            arguments: stepDef.input,
            timestamp: Date.now()
          },
          stepDef.sideEffectLevel,
          `Workflow step "${stepDef.name}" requires user approval before execution.`
        );

        // Update run pending approval
        const airaRun = await this.runRepo.getRun(runId);
        if (airaRun) {
          airaRun.state = 'WAITING_FOR_APPROVAL';
          airaRun.pendingApproval = approvalReq;
          await this.runRepo.saveRun(airaRun);
        }

        await this.emitWorkflowEvent(runId, 'approval.required', approvalReq);
        return;
      }
    }

    // 3. Mark Step RUNNING
    let attempt = 1;
    await this.withRunLock(workflowRunId, async () => {
      const fresh = (await this.workflowRepo.getWorkflowRun(workflowRunId))!;
      fresh.stepStates[stepDef.stepId] = 'RUNNING';
      attempt = (fresh.stepAttempts[stepDef.stepId] || 0) + 1;
      fresh.stepAttempts[stepDef.stepId] = attempt;
      fresh.updatedAt = Date.now();
      await this.workflowRepo.saveWorkflowRun(fresh);
      workflowRun = fresh;
    });

    await this.updateStepState(workflowRun.id, stepDef.stepId, 'RUNNING', undefined, undefined, attempt);
    await this.emitWorkflowEvent(runId, 'workflow.step.started', {
      stepId: stepDef.stepId,
      name: stepDef.name,
      attempt
    });

    // 4. Resolve Step Inputs from dependencies
    const resolvedInput = this.resolveStepInput(stepDef, workflowRun);

    // 5. Execute Step with Retries
    const maxAttempts = stepDef.retry?.maxAttempts || 3;
    const initialBackoff = stepDef.retry?.backoffMs || 500;
    const backoffFactor = stepDef.retry?.factor || 2;

    let currentAttempt = attempt;
    let stepOutput: any = null;
    let stepError: string | null = null;

    while (currentAttempt <= maxAttempts) {
      try {
        stepOutput = await this.executeStepCapability(stepDef, resolvedInput, workflowRun);
        stepError = null;
        break; // Success!
      } catch (err: any) {
        stepError = err.message || String(err);
        const isNonRetryable = stepError.includes('Access denied') ||
          stepError.includes('Permission denied') ||
          stepError.includes('TOOL_PERMISSION_DENIED') ||
          stepError.includes('lacks required scope') ||
          stepError.includes('Cycle detected') ||
          stepError.includes('Validation failed') ||
          stepError.includes('cannot depend on itself');

        if (isNonRetryable || currentAttempt >= maxAttempts) {
          break;
        }

        // Exponential backoff
        const delay = initialBackoff * Math.pow(backoffFactor, currentAttempt - 1);
        await new Promise(r => setTimeout(r, Math.min(delay, 5000)));
        currentAttempt++;
        await this.withRunLock(workflowRunId, async () => {
          const fresh = (await this.workflowRepo.getWorkflowRun(workflowRunId))!;
          fresh.stepAttempts[stepDef.stepId] = currentAttempt;
          await this.workflowRepo.saveWorkflowRun(fresh);
          workflowRun = fresh;
        });
      }
    }

    // 6. Handle Step Outcome
    await this.withRunLock(workflowRunId, async () => {
      const fresh = (await this.workflowRepo.getWorkflowRun(workflowRunId))!;
      if (stepError) {
        fresh.stepStates[stepDef.stepId] = 'FAILED';
      } else {
        fresh.stepStates[stepDef.stepId] = 'COMPLETED';
        fresh.stepOutputs[stepDef.stepId] = stepOutput;
      }
      fresh.updatedAt = Date.now();
      await this.workflowRepo.saveWorkflowRun(fresh);
      workflowRun = fresh;
    });

    if (stepError) {
      await this.updateStepState(workflowRun.id, stepDef.stepId, 'FAILED', undefined, stepError, currentAttempt);
      await this.emitWorkflowEvent(runId, 'workflow.step.failed', {
        stepId: stepDef.stepId,
        name: stepDef.name,
        error: stepError,
        attempts: currentAttempt
      });
    } else {
      await this.updateStepState(workflowRun.id, stepDef.stepId, 'COMPLETED', stepOutput, undefined, currentAttempt);
      await this.emitWorkflowEvent(runId, 'workflow.step.completed', {
        stepId: stepDef.stepId,
        name: stepDef.name,
        output: stepOutput,
        attempts: currentAttempt
      });
    }
  }

  /**
   * Execute the actual capability or tool for a step
   */
  private async executeStepCapability(
    stepDef: WorkflowStepDefinition,
    input: any,
    workflowRun: WorkflowRun
  ): Promise<any> {
    const capability = stepDef.capability || 'ANSWER';

    if (stepDef.type === 'TOOL' || capability === 'TOOL_ACTION') {
      const toolName = stepDef.toolName || input.toolName || 'calculator';
      const args = input.args || input;

      if (this.toolGateway) {
        const parentRun = await this.runRepo.getRun(workflowRun.runId);
        const result = await this.toolGateway.execute({
          toolName,
          arguments: args,
          context: {
            runId: workflowRun.runId,
            workflowRunId: workflowRun.id,
            principal: {
              userId: workflowRun.principalId,
              sessionId: workflowRun.sessionId,
              roles: ['member'],
              scopes: parentRun?.principalScopes || ['*']
            },
            idempotencyKey: stepDef.idempotencyKey,
            workspaceRoot: this.workspaceRoot
          }
        });
        if (result.isError) {
          throw new Error(result.error || `Tool "${toolName}" failed.`);
        }
        return result.output;
      }

      const result = await this.toolRegistry.execute(
        {
          id: `tool_${Date.now()}`,
          name: toolName,
          toolId: `tool_${toolName}`,
          arguments: args,
          timestamp: Date.now()
        },
        {
          runId: workflowRun.runId,
          workspaceRoot: this.workspaceRoot,
          sessionGrantedTools: new Set()
        }
      );
      if (result.isError) {
        throw new Error(result.error || `Tool "${toolName}" failed.`);
      }
      return result.output;
    }

    if (capability === 'RESEARCH') {
      const topic = input.topic || input.prompt || stepDef.name;
      
      if (!this.researchService) {
        return { topic, status: 'RESEARCH_PROVIDER_NOT_READY', summary: 'Research service is unavailable.' };
      }
      const evidence = await this.researchService.executeResearch({ prompt: topic, runId: workflowRun.runId });
      if (evidence.freshnessRequired && (!evidence.providerReady || evidence.citations.length === 0)) {
        return { topic, status: 'RESEARCH_PROVIDER_NOT_READY', summary: 'Live research evidence is unavailable; no current claims synthesized.' };
      }
      const researchResults = evidence.citations.map(c => `[${c.sourceTitle}] ${c.snippet}`).join('\n\n');

      const airaRun = await this.runRepo.getRun(workflowRun.runId);
      const requestedModel = airaRun?.modelPolicy?.model || 'aira-auto';
      const policy = this.modelRouter.resolvePolicy(requestedModel, 'RESEARCH');
      const adapter = this.modelRouter.getAdapter(policy);
      
      const now = new Date();
      const currentContextMsg = `AIRA RUNTIME CONTEXT
Current date: ${now.toDateString()}
Current UTC time: ${now.toISOString()}`;

      const prompt = `Conduct comprehensive research on: "${topic}". Decompose key claims, cite authoritative sources with DOI/dates, and synthesize findings.\n\nRetrieved Evidence:\n${researchResults}`;
      const res = await adapter.complete([
        { role: 'system', content: 'You are Aira AI operating in rigorous research mode. Deliver evidence-backed synthesis with citations.\n' + currentContextMsg },
        { role: 'user', content: prompt }
      ], policy);
      return { topic, summary: res.text };
    }

    if (stepDef.type === 'SYNTHESIS' || capability === 'ANSWER') {
      const prompt = input.prompt || `Synthesize findings from previous steps:\n${JSON.stringify(input, null, 2)}`;
      const airaRun = await this.runRepo.getRun(workflowRun.runId);
      const requestedModel = airaRun?.modelPolicy?.model || 'aira-auto';
      const policy = this.modelRouter.resolvePolicy(requestedModel, 'ANSWER');
      const adapter = this.modelRouter.getAdapter(policy);
      const res = await adapter.complete([
        { role: 'system', content: 'You are Aira AI executing workflow synthesis. Produce a structured, verifiable final report.' },
        { role: 'user', content: prompt }
      ], policy);
      return { report: res.text };
    }

    // Default: return input echoed with status
    return { status: 'OK', processedInput: input };
  }

  /**
   * Resolve step input parameters from upstream dependencies
   */
  private resolveStepInput(stepDef: WorkflowStepDefinition, workflowRun: WorkflowRun): any {
    const baseInput = { ...(stepDef.input || {}) };
    const upstreamOutputs: Record<string, any> = {};

    for (const depId of stepDef.dependsOn) {
      if (workflowRun.stepOutputs[depId] !== undefined) {
        upstreamOutputs[depId] = workflowRun.stepOutputs[depId];
      }
    }

    return {
      ...baseInput,
      upstreamOutputs,
      // If prompt has placeholder variables like {{steps.stepA.output}}
      resolvedPrompt: baseInput.prompt ? this.interpolateTemplate(baseInput.prompt, upstreamOutputs) : undefined
    };
  }

  private interpolateTemplate(template: string, outputs: Record<string, any>): string {
    return template.replace(/\{\{steps\.([^.]+)\.output\}\}/g, (_, stepId) => {
      const val = outputs[stepId];
      return val ? (typeof val === 'string' ? val : JSON.stringify(val)) : '';
    });
  }

  /**
   * Resume a workflow step after authenticated user approval
   */
  public async resolveStepApproval(
    workflowRunId: string,
    stepId: string,
    decision: 'APPROVED' | 'REJECTED' | ApprovalDecision,
    principal: ExecutionPrincipal,
    approvalRequestId?: string
  ): Promise<boolean> {
    const workflowRun = await this.workflowRepo.getWorkflowRun(workflowRunId);
    if (!workflowRun) return false;

    // Principal isolation
    if (workflowRun.principalId !== principal.userId) {
      throw new Error(`Unauthorized: Approval principal "${principal.userId}" does not match workflow owner.`);
    }

    if (workflowRun.state !== 'WAITING_FOR_APPROVAL' || workflowRun.pendingApprovalStepId !== stepId) {
      return false;
    }

    const airaRun = await this.runRepo.getRun(workflowRun.runId);
    const requestId = approvalRequestId || airaRun?.pendingApproval?.id;
    if (!requestId || airaRun?.pendingApproval?.id !== requestId) return false;

    const pendingRequest = await this.approvalKernel.getPendingRequest(requestId);
    if (
      !pendingRequest ||
      pendingRequest.runId !== workflowRun.runId ||
      pendingRequest.toolCall.id !== `call_step_${stepId}`
    ) {
      return false;
    }

    // Keep the legacy workflow API compatible: APPROVED has historically meant
    // a session grant. Explicit ApprovalDecision values retain their own scope.
    const approvalDecision: ApprovalDecision = decision === 'APPROVED'
      ? 'ALLOW_SESSION'
      : decision === 'REJECTED'
        ? 'REJECT'
        : decision;
    await this.approvalKernel.resolveWorkflowDecision(requestId, approvalDecision, principal.userId);

    if (approvalDecision === 'REJECT') {
      workflowRun.state = 'FAILED';
      workflowRun.error = `Approval rejected for step "${stepId}".`;
      workflowRun.stepStates[stepId] = 'FAILED';
      workflowRun.pendingApprovalStepId = undefined;
      workflowRun.updatedAt = Date.now();
      await this.workflowRepo.saveWorkflowRun(workflowRun);

      await this.updateStepState(workflowRun.id, stepId, 'FAILED', undefined, 'Approval rejected by user');
      await this.emitWorkflowEvent(workflowRun.runId, 'approval.resolved', {
        workflowRunId,
        stepId,
        decision: 'REJECTED'
      });
      await this.emitWorkflowEvent(workflowRun.runId, 'workflow.failed', {
        workflowRunId,
        error: workflowRun.error
      });
      return true;
    }

    // Approved: Set step to READY so execution loop resumes it
    workflowRun.state = 'RUNNING';
    workflowRun.pendingApprovalStepId = undefined;
    workflowRun.stepStates[stepId] = 'READY';
    workflowRun.updatedAt = Date.now();
    await this.workflowRepo.saveWorkflowRun(workflowRun);

    await this.emitWorkflowEvent(workflowRun.runId, 'approval.resolved', {
      workflowRunId,
      stepId,
      decision: 'APPROVED'
    });

    // Resume execution loop
    await this.executeWorkflowRun(workflowRunId);

    return true;
  }

  /**
   * Cancel an active workflow
   */
  public async cancelWorkflow(workflowRunId: string, principal: ExecutionPrincipal): Promise<boolean> {
    const workflowRun = await this.workflowRepo.getWorkflowRun(workflowRunId);
    if (!workflowRun) return false;

    if (workflowRun.principalId !== principal.userId) {
      throw new Error(`Unauthorized: Principal "${principal.userId}" does not match workflow owner.`);
    }

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(workflowRun.state)) {
      return false;
    }

    workflowRun.state = 'CANCELLED';
    workflowRun.updatedAt = Date.now();
    workflowRun.completedAt = Date.now();
    workflowRun.error = 'Workflow cancelled by user.';

    for (const [sId, sState] of Object.entries(workflowRun.stepStates)) {
      if (['PENDING', 'READY', 'RUNNING', 'WAITING_FOR_APPROVAL'].includes(sState)) {
        workflowRun.stepStates[sId] = 'CANCELLED';
        await this.updateStepState(workflowRun.id, sId, 'CANCELLED');
      }
    }

    await this.workflowRepo.saveWorkflowRun(workflowRun);

    const airaRun = await this.runRepo.getRun(workflowRun.runId);
    if (airaRun) {
      airaRun.state = 'CANCELLED';
      airaRun.error = 'Workflow cancelled by user.';
      airaRun.completedAt = Date.now();
      await this.runRepo.saveRun(airaRun);
    }

    await this.emitWorkflowEvent(workflowRun.runId, 'workflow.cancelled', {
      workflowRunId,
      cancelledAt: Date.now()
    });

    return true;
  }

  private async completeWorkflow(workflowRun: WorkflowRun, definition: WorkflowDefinition): Promise<void> {
    workflowRun.state = 'COMPLETED';
    workflowRun.completedAt = Date.now();
    workflowRun.updatedAt = Date.now();

    // Create durable workflow report artifact
    const artId = `art_wf_${Date.now()}`;
    const reportArtifact: Artifact = {
      id: artId,
      runId: workflowRun.runId,
      title: `Workflow Execution Report: ${definition.name}`,
      type: 'text/markdown',
      content: this.formatWorkflowReport(workflowRun, definition),
      version: 1,
      versions: [{
        version: 1,
        content: this.formatWorkflowReport(workflowRun, definition),
        timestamp: Date.now()
      }]
    };

    workflowRun.artifacts.push(reportArtifact);
    await this.workflowRepo.saveWorkflowRun(workflowRun);

    const airaRun = await this.runRepo.getRun(workflowRun.runId);
    if (airaRun) {
      airaRun.state = 'COMPLETED';
      airaRun.completedAt = Date.now();
      airaRun.artifacts.push(reportArtifact);
      airaRun.content = `## Workflow Execution Completed: ${definition.name}\n\n` +
        Object.entries(workflowRun.stepOutputs)
          .map(([sId, out]) => `### Step: ${sId}\n${typeof out === 'object' ? JSON.stringify(out, null, 2) : out}`)
          .join('\n\n');
      await this.runRepo.saveRun(airaRun);
    }

    await this.emitWorkflowEvent(workflowRun.runId, 'artifact.created', reportArtifact);
    await this.emitWorkflowEvent(workflowRun.runId, 'workflow.completed', {
      workflowRunId: workflowRun.id,
      completedAt: workflowRun.completedAt,
      totalSteps: definition.steps.length
    });
  }

  private async failWorkflow(workflowRun: WorkflowRun, errorMsg: string): Promise<void> {
    workflowRun.state = 'FAILED';
    workflowRun.error = errorMsg;
    workflowRun.completedAt = Date.now();
    workflowRun.updatedAt = Date.now();
    await this.workflowRepo.saveWorkflowRun(workflowRun);

    const airaRun = await this.runRepo.getRun(workflowRun.runId);
    if (airaRun) {
      airaRun.state = 'FAILED';
      airaRun.error = errorMsg;
      airaRun.completedAt = Date.now();
      await this.runRepo.saveRun(airaRun);
    }

    await this.emitWorkflowEvent(workflowRun.runId, 'workflow.failed', {
      workflowRunId: workflowRun.id,
      error: errorMsg
    });
  }

  private formatWorkflowReport(run: WorkflowRun, def: WorkflowDefinition): string {
    let md = `# Workflow Execution Summary: ${def.name}\n\n`;
    md += `- **Workflow ID**: \`${def.workflowId}\`\n`;
    md += `- **Execution Run ID**: \`${run.id}\`\n`;
    md += `- **State**: **${run.state}**\n`;
    md += `- **Completed At**: ${new Date(run.completedAt || Date.now()).toISOString()}\n\n`;
    md += `## Step Execution Details\n\n`;

    for (const step of def.steps) {
      const sState = run.stepStates[step.stepId] || 'UNKNOWN';
      const output = run.stepOutputs[step.stepId];
      const attempts = run.stepAttempts[step.stepId] || 1;
      md += `### ${step.name} (\`${step.stepId}\`)\n`;
      md += `- **Status**: ${sState}\n`;
      md += `- **Attempts**: ${attempts}\n`;
      if (output) {
        md += `- **Output**:\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`\n`;
      }
      md += `\n`;
    }
    return md;
  }

  private async updateStepState(
    workflowRunId: string,
    stepId: string,
    state: WorkflowStepState,
    output?: any,
    error?: string,
    attempt?: number
  ): Promise<void> {
    const steps = await this.workflowRepo.getWorkflowSteps(workflowRunId);
    const existing = steps.find(s => s.stepId === stepId);
    if (existing) {
      existing.state = state;
      if (output !== undefined) existing.output = output;
      if (error !== undefined) existing.error = error;
      if (attempt !== undefined) existing.attempt = attempt;
      if (state === 'RUNNING' && !existing.startedAt) existing.startedAt = Date.now();
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(state)) existing.completedAt = Date.now();
      await this.workflowRepo.saveWorkflowStep(existing);
    }
  }

  private async emitWorkflowEvent(runId: string, type: any, data: any): Promise<void> {
    if (this.eventEmitterCallback) {
      await this.eventEmitterCallback(runId, type, data);
    } else {
      const event = {
        eventId: `ev_wf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        runId,
        type,
        timestamp: Date.now(),
        data
      };
      await this.runRepo.appendRunEvent(event);
    }
  }
}
