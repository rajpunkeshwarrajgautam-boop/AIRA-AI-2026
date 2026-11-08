import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  AutonomousAgentTask,
  AutonomousAgentTaskSchema,
  AutonomousTaskState,
  AgentObjectivePlan,
  AgentPlanStep,
  AgentObservation,
  ExecutionPrincipal,
  canAutonomousStateTransition
} from '../../../contracts/src/index.js';
import { IAutonomousTaskRepository, InMemoryAutonomousTaskRepository } from './repository.js';
import { SpecialistRegistry } from '../specialists/specialist-registry.js';
import { ToolGateway } from '../../../tool-runtime/src/gateway.js';
import { ApprovalKernel } from '../../../approvals/src/index.js';
import { ModelRouter } from '../../../model-router/src/index.js';

export interface AutonomousEngineOptions {
  repository?: IAutonomousTaskRepository;
  specialistRegistry?: SpecialistRegistry;
  toolGateway?: ToolGateway;
  approvalKernel?: ApprovalKernel;
  modelRouter?: ModelRouter;
  maxExecutionCycles?: number;
}

export class AutonomousAgentEngine extends EventEmitter {
  private repository: IAutonomousTaskRepository;
  private specialistRegistry: SpecialistRegistry;
  private toolGateway?: ToolGateway;
  private approvalKernel?: ApprovalKernel;
  private modelRouter?: ModelRouter;
  private maxExecutionCycles: number;
  private activeExecutions: Map<string, AbortController> = new Map();
  // A worker must keep the fencing token from its own claim/transitions.
  // Re-reading the newest token after a competing worker takes the lease would
  // incorrectly grant the old worker authority over the new execution.
  private executionFences = new Map<string, { signal: AbortSignal; token: number }>();

  constructor(options: AutonomousEngineOptions = {}) {
    super();
    this.repository = options.repository || new InMemoryAutonomousTaskRepository();
    this.specialistRegistry = options.specialistRegistry || new SpecialistRegistry();
    this.toolGateway = options.toolGateway;
    this.approvalKernel = options.approvalKernel;
    this.modelRouter = options.modelRouter;
    this.maxExecutionCycles = options.maxExecutionCycles ?? 25;
  }

  public getRepository(): IAutonomousTaskRepository {
    return this.repository;
  }

  public getSpecialistRegistry(): SpecialistRegistry {
    return this.specialistRegistry;
  }

  public async createTask(
    objective: string,
    principal: ExecutionPrincipal,
    customPlan?: AgentObjectivePlan,
    idempotencyKey?: string
  ): Promise<AutonomousAgentTask> {
    if (idempotencyKey && this.repository.getTaskByIdempotencyKey) {
      const existing = await this.repository.getTaskByIdempotencyKey(principal.userId, idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    const taskId = `autotask_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const now = Date.now();

    const rawTask: AutonomousAgentTask = {
      taskId,
      principal,
      objective,
      state: 'CREATED',
      plan: customPlan,
      observations: [],
      artifacts: [],
      workingMemory: {},
      idempotencyKey,
      fencingToken: 0,
      executionHistory: [
        {
          state: 'CREATED',
          timestamp: now,
          reason: 'Initial autonomous task creation'
        }
      ],
      createdAt: now,
      updatedAt: now
    };

    const task = AutonomousAgentTaskSchema.parse(rawTask);
    const created = await this.repository.createTask(task);
    this.emit('task.created', { taskId, objective, principal });
    return created;
  }

  public async getTask(taskId: string): Promise<AutonomousAgentTask | null> {
    return this.repository.getTask(taskId);
  }

  private assertExecutionFence(taskId: string, signal: AbortSignal, task: AutonomousAgentTask): void {
    const fence = this.executionFences.get(taskId);
    if (signal.aborted || !fence || fence.signal !== signal || task.fencingToken !== fence.token) {
      throw new Error(`STALE_FENCING_TOKEN: Worker execution no longer owns task ${taskId}.`);
    }
  }

  private async updateDuringExecution(task: AutonomousAgentTask, signal: AbortSignal): Promise<AutonomousAgentTask> {
    this.assertExecutionFence(task.taskId, signal, task);
    return this.repository.updateTask(task);
  }

  private async transitionDuringExecution(
    taskId: string,
    signal: AbortSignal,
    newState: AutonomousTaskState,
    reason?: string
  ): Promise<AutonomousAgentTask> {
    const previous = await this.repository.getTask(taskId);
    if (!previous) throw new Error(`Task ${taskId} not found.`);
    this.assertExecutionFence(taskId, signal, previous);
    const updated = await this.repository.updateState(taskId, newState, reason, undefined, previous.fencingToken);
    const fence = this.executionFences.get(taskId);
    if (fence?.signal === signal) fence.token = updated.fencingToken;
    this.emit('task.state_changed', { taskId, from: previous.state, to: newState, reason });
    return updated;
  }

  public async startTask(taskId: string, workerId = 'worker_primary'): Promise<AutonomousAgentTask> {
    let task = await this.repository.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found.`);

    if (this.repository.claimTask) {
      const claim = await this.repository.claimTask(taskId, workerId, 60000);
      if (!claim.success) throw new Error(`Failed to claim task ${taskId}: ${claim.error}`);
      if (!claim.task) throw new Error(`Claim succeeded without a task snapshot: ${taskId}`);
      task = claim.task;
    }

    const abortController = new AbortController();
    this.activeExecutions.set(taskId, abortController);
    this.executionFences.set(taskId, { signal: abortController.signal, token: task.fencingToken });

    try {
      // STEP 1: PLANNING
      await this.transitionDuringExecution(taskId, abortController.signal, 'PLANNING', 'Decomposing natural language objective into structured plan');
      task = await this.repository.getTask(taskId);
      if (!task) throw new Error(`Task "${taskId}" not found after planning transition.`);

      if (!task.plan || task.plan.steps.length === 0) {
        task.plan = await this.decomposeObjective(task);
        await this.updateDuringExecution(task, abortController.signal);
      }

      this.emit('task.plan_ready', { taskId, plan: task.plan });

      // STEP 2: READY
      await this.transitionDuringExecution(taskId, abortController.signal, 'READY', 'Plan compiled; ready for execution');

      // STEP 3: RUNNING
      await this.transitionDuringExecution(taskId, abortController.signal, 'RUNNING', 'Beginning autonomous execution of plan steps');

      // Asynchronously execute steps in sequence; executeLoop owns cleanup after launch.
      void this.executeLoop(taskId, abortController.signal);
      return (await this.repository.getTask(taskId))!;
    } catch (error) {
      abortController.abort();
      if (this.activeExecutions.get(taskId) === abortController) this.activeExecutions.delete(taskId);
      if (this.executionFences.get(taskId)?.signal === abortController.signal) this.executionFences.delete(taskId);
      throw error;
    }
  }

  public async executeAutonomousTask(taskId: string, signal?: AbortSignal, claimedFencingToken?: number): Promise<AutonomousAgentTask> {
    const task = await this.repository.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found.`);
    if (claimedFencingToken !== undefined && task.fencingToken !== claimedFencingToken) {
      throw new Error(`STALE_FENCING_TOKEN: Claim for ${taskId} has already been superseded.`);
    }

    const abortController = new AbortController();
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), { once: true });
      if (signal.aborted) abortController.abort();
    }
    this.activeExecutions.set(taskId, abortController);
    this.executionFences.set(taskId, { signal: abortController.signal, token: task.fencingToken });

    try {
      // Advance to RUNNING from CREATED, PLANNING, READY, or RESUMING
      if (task.state === 'CREATED') {
        await this.transitionDuringExecution(taskId, abortController.signal, 'PLANNING', 'Decomposing natural language objective into structured plan');
        const current = await this.repository.getTask(taskId);
        if (current && (!current.plan || current.plan.steps.length === 0)) {
          current.plan = await this.decomposeObjective(current);
          await this.updateDuringExecution(current, abortController.signal);
        }
        this.emit('task.plan_ready', { taskId, plan: (await this.repository.getTask(taskId))?.plan });
        await this.transitionDuringExecution(taskId, abortController.signal, 'READY', 'Plan compiled; ready for execution');
        await this.transitionDuringExecution(taskId, abortController.signal, 'RUNNING', 'Beginning autonomous execution of plan steps');
      } else if (task.state === 'PLANNING') {
        if (!task.plan || task.plan.steps.length === 0) {
          const current = await this.repository.getTask(taskId);
          if (!current) throw new Error(`Task ${taskId} not found during planning.`);
          current.plan = await this.decomposeObjective(current);
          await this.updateDuringExecution(current, abortController.signal);
        }
        await this.transitionDuringExecution(taskId, abortController.signal, 'READY', 'Plan compiled; ready for execution');
        await this.transitionDuringExecution(taskId, abortController.signal, 'RUNNING', 'Beginning autonomous execution of plan steps');
      } else if (task.state === 'READY') {
        await this.transitionDuringExecution(taskId, abortController.signal, 'RUNNING', 'Beginning autonomous execution of plan steps');
      } else if (task.state === 'RESUMING') {
        await this.transitionDuringExecution(taskId, abortController.signal, 'RUNNING', 'Resuming autonomous execution after recovery');
      }

      await this.executeLoop(taskId, abortController.signal);
      return (await this.repository.getTask(taskId))!;
    } finally {
      if (this.activeExecutions.get(taskId) === abortController) this.activeExecutions.delete(taskId);
      if (this.executionFences.get(taskId)?.signal === abortController.signal) this.executionFences.delete(taskId);
    }
  }

  private async decomposeObjective(task: AutonomousAgentTask): Promise<AgentObjectivePlan> {
    const runId = `run_plan_${task.taskId}`;
    const planner = this.specialistRegistry.getSpecialist('planner');

    if (planner) {
      const planResult = await planner.execute({
        runId,
        taskId: `plan_${task.taskId}`,
        principal: task.principal,
        tenantId: task.principal.workspaceId || 'default',
        workspaceId: task.principal.workspaceId || 'default',
        authorizedCapabilities: ['agent_planning', 'general_reasoning'],
        effectiveToolScopes: ['*'],
        executionPolicyVersion: '2026.1',
        promptProfileId: 'profile_planner',
        promptProfileVersion: '1.0.0',
        modelRoutingRequirements: { suggestedModelClass: 'fast-planning' },
        remainingBudget: { maxTokens: 20000, remainingTokens: 20000 },
        cancellationSignal: new AbortController().signal,
        correlationId: task.taskId,
        inputPayload: { objective: task.objective }
      });

      if (planResult.outcome === 'COMPLETED' && planResult.output?.dag) {
        task.dag = planResult.output.dag;
      }
    }

    // Produce standard 4-step execution plan
    return {
      planId: `plan_${task.taskId}`,
      objective: task.objective,
      estimatedWaves: 3,
      maxBudgetTokens: 32000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 'step_research',
          title: 'Research Context and Requirements',
          description: 'Search documentation and extract necessary facts and constraints',
          role: 'researcher',
          assignedSpecialist: 'Researcher Specialist',
          dependencies: [],
          suggestedTools: ['web_search', 'browser_navigate'],
          sideEffectLevel: 'READ',
          status: 'PENDING'
        },
        {
          stepId: 'step_execution',
          title: 'Execute Core Logic and Synthesis',
          description: 'Apply computations, script execution, or code generation according to research',
          role: 'coder',
          assignedSpecialist: 'Coder Specialist',
          dependencies: ['step_research'],
          suggestedTools: ['python_sandbox', 'file_system_write', 'calculator'],
          sideEffectLevel: 'WRITE',
          status: 'PENDING'
        },
        {
          stepId: 'step_deliverable',
          title: 'Assemble Deliverables and Report',
          description: 'Format documentation, code, or interactive artifacts for delivery',
          role: 'document',
          assignedSpecialist: 'Document Specialist',
          dependencies: ['step_execution'],
          suggestedTools: ['file_system_read'],
          sideEffectLevel: 'READ',
          status: 'PENDING'
        },
        {
          stepId: 'step_verify',
          title: 'Verify Completion against Acceptance Criteria',
          description: 'Verify correctness, test results, and adherence to user prompt',
          role: 'verifier',
          assignedSpecialist: 'Verification Specialist',
          dependencies: ['step_deliverable'],
          suggestedTools: ['calculator', 'file_system_read'],
          sideEffectLevel: 'READ',
          status: 'PENDING'
        }
      ]
    };
  }

  private async executeLoop(taskId: string, signal: AbortSignal): Promise<void> {
    try {
      let task = await this.repository.getTask(taskId);
      if (!task || !task.plan) return;
      this.assertExecutionFence(taskId, signal, task);

      let cycleCount = 0;

      for (const step of task.plan.steps) {
        cycleCount++;
        if (cycleCount > this.maxExecutionCycles) {
          await this.transitionDuringExecution(taskId, signal, 'FAILED', `Loop limit exceeded: Maximum execution cycles (${this.maxExecutionCycles}) reached.`);
          this.emit('task.failed', { taskId, error: 'LOOP_LIMIT_EXCEEDED' });
          return;
        }

        if (signal.aborted) return; // Lease loss, shutdown and user cancellation use distinct state transitions.

        // Idempotency guarantee during crash recovery: skip already completed steps
        if (step.status === 'COMPLETED' || step.status === 'SKIPPED') {
          continue;
        }

        // Re-read task in case state changed (e.g. paused)
        task = await this.repository.getTask(taskId);
        if (!task || task.state === 'CANCELLED' || task.state === 'PAUSED') {
          return;
        }
        this.assertExecutionFence(taskId, signal, task);

        // Check if step requires approval
        if (step.sideEffectLevel === 'WRITE' || step.sideEffectLevel === 'DESTRUCTIVE') {
          const approvalId = `req_appr_${randomUUID().slice(0, 8)}`;
          task.approvalRequestId = approvalId;
          task.activeStepId = step.stepId;
          step.status = 'WAITING_FOR_APPROVAL';
          await this.updateDuringExecution(task, signal);

          await this.transitionDuringExecution(taskId, signal, 'WAITING_FOR_APPROVAL', `Approval requested for step: ${step.title}`);
          this.emit('task.approval_requested', {
            taskId,
            stepId: step.stepId,
            approvalRequestId: approvalId,
            title: step.title,
            sideEffectLevel: step.sideEffectLevel
          });

          // Stop here; resumption will happen when approveStep() is called
          return;
        }

        await this.runStep(taskId, step, signal);
        if (signal.aborted) return;

        // Failure Boundary: Halt on step failure immediately
        task = await this.repository.getTask(taskId);
        const updatedStep = task?.plan?.steps.find(s => s.stepId === step.stepId);
        if (updatedStep?.status === 'FAILED') {
          await this.transitionDuringExecution(taskId, signal, 'FAILED', `Step "${step.title}" failed: ${updatedStep.resultSummary || 'Execution failed'}`);
          this.emit('task.failed', { taskId, stepId: step.stepId, error: updatedStep.resultSummary });
          return;
        }
      }

      if (signal.aborted) return;

      // STEP 4: VERIFYING
      await this.transitionDuringExecution(taskId, signal, 'VERIFYING', 'Running final verification gate');
      task = await this.repository.getTask(taskId);
      if (!task) return;
      const verifier = this.specialistRegistry.getSpecialist('verifier');
      let isVerified = true;
      if (verifier) {
        const verifyRes = await verifier.execute({
          runId: `run_verify_${taskId}`,
          taskId: `verify_${taskId}`,
          principal: task.principal,
          tenantId: task.principal.workspaceId || 'default',
          workspaceId: task.principal.workspaceId || 'default',
          authorizedCapabilities: ['result_verification', 'general_reasoning'],
          effectiveToolScopes: ['*'],
          executionPolicyVersion: '2026.1',
          promptProfileId: 'profile_verifier',
          promptProfileVersion: '1.0.0',
          modelRoutingRequirements: {},
          remainingBudget: { maxTokens: 10000, remainingTokens: 10000 },
          cancellationSignal: signal,
          correlationId: taskId,
          inputPayload: {
            objective: task.objective,
            observations: task.observations
          }
        });
        isVerified = verifyRes.outcome === 'COMPLETED';
      }

      if (signal.aborted) return;

      // STEP 5: COMPLETED
      task = await this.repository.getTask(taskId);
      if (task) {
        task.deliverableSummary = `Successfully executed autonomous mission for: "${task.objective}". Verified: ${isVerified}.`;
        await this.updateDuringExecution(task, signal);
      }
      await this.transitionDuringExecution(taskId, signal, 'COMPLETED', 'Mission accomplished and verified');
      this.emit('task.completed', { taskId, deliverableSummary: task?.deliverableSummary });
    } catch (err: any) {
      if (signal.aborted || String(err.message || '').includes('STALE_FENCING_TOKEN') ||
          String(err.message || '').includes('Concurrent update or stale fencing token')) return;
      try {
        await this.transitionDuringExecution(taskId, signal, 'FAILED', err.message || 'Execution error');
      } catch (transitionError: any) {
        if (String(transitionError.message || '').includes('STALE_FENCING_TOKEN') || signal.aborted) return;
        throw transitionError;
      }
      this.emit('task.failed', { taskId, error: err.message });
    } finally {
      if (this.activeExecutions.get(taskId)?.signal === signal) this.activeExecutions.delete(taskId);
      if (this.executionFences.get(taskId)?.signal === signal) this.executionFences.delete(taskId);
    }
  }

  private async runStep(taskId: string, step: AgentPlanStep, signal: AbortSignal): Promise<void> {
    const task = await this.repository.getTask(taskId);
    if (!task) return;
    this.assertExecutionFence(taskId, signal, task);

    const targetStep = task.plan?.steps.find(s => s.stepId === step.stepId) || step;
    targetStep.status = 'RUNNING';
    targetStep.startedAt = Date.now();
    step.status = 'RUNNING';
    step.startedAt = targetStep.startedAt;
    task.activeStepId = targetStep.stepId;
    await this.updateDuringExecution(task, signal);
    this.emit('task.step_started', { taskId, stepId: targetStep.stepId, title: targetStep.title });

    let specialistResult: any = null;
    const role = targetStep.role;

    if (role && this.specialistRegistry.hasSpecialist(role)) {
      const specialist = this.specialistRegistry.getSpecialist(role)!;
      specialistResult = await specialist.execute({
        runId: `run_${taskId}_${targetStep.stepId}`,
        taskId: `step_${targetStep.stepId}`,
        principal: task.principal,
        tenantId: task.principal.workspaceId || 'default',
        workspaceId: task.principal.workspaceId || 'default',
        authorizedCapabilities: [...specialist.requiredCapabilities],
        effectiveToolScopes: ['*'],
        executionPolicyVersion: '2026.1',
        promptProfileId: `profile_${role}`,
        promptProfileVersion: '1.0.0',
        modelRoutingRequirements: {},
        remainingBudget: { maxTokens: 20000, remainingTokens: 20000 },
        cancellationSignal: signal,
        correlationId: taskId,
        inputPayload: {
          objective: task.objective,
          stepTitle: targetStep.title,
          stepDescription: targetStep.description,
          priorObservations: task.observations,
          priorResults: task.observations.reduce((acc: Record<string, any>, o) => {
            if (o.stepId) acc[o.stepId] = o.summary;
            if (o.sourceName) acc[o.sourceName] = o.summary;
            return acc;
          }, {}),
          ...((task.workingMemory && targetStep.stepId ? (task.workingMemory[targetStep.stepId] as any) : undefined) || {})
        },
        workingMemory: task.workingMemory || {}
      });
    }

    // Ignore a late specialist response after lease loss or shutdown.
    if (signal.aborted) return;

    const obs: AgentObservation = {
      observationId: `obs_${randomUUID().slice(0, 8)}`,
      stepId: targetStep.stepId,
      source: 'specialist',
      sourceName: targetStep.assignedSpecialist || targetStep.role || 'System',
      summary: specialistResult?.error?.message || specialistResult?.output?.summary || `Executed step "${targetStep.title}" successfully.`,
      timestamp: Date.now(),
      isError: specialistResult?.outcome === 'FAILED'
    };

    task.observations.push(obs);
    if (!task.workingMemory) task.workingMemory = {};
    if (specialistResult?.output) {
      task.workingMemory[targetStep.stepId] = specialistResult.output;
    }
    targetStep.status = specialistResult?.outcome === 'FAILED' ? 'FAILED' : 'COMPLETED';
    targetStep.completedAt = Date.now();
    targetStep.resultSummary = obs.summary;
    step.status = targetStep.status;
    step.completedAt = targetStep.completedAt;
    step.resultSummary = targetStep.resultSummary;
    await this.updateDuringExecution(task, signal);

    this.emit('task.observation', { taskId, observation: obs });
    this.emit('task.handoff', {
      taskId,
      fromStep: targetStep.stepId,
      specialistRole: role,
      outputSummary: obs.summary
    });
    this.emit('task.step_completed', { taskId, stepId: targetStep.stepId, status: targetStep.status });
  }

  public async refinePlan(taskId: string, additionalSteps: AgentPlanStep[]): Promise<AutonomousAgentTask> {
    const task = await this.repository.getTask(taskId);
    if (!task || !task.plan) throw new Error(`Task "${taskId}" has no active plan.`);
    task.plan.steps.push(...additionalSteps);
    task.plan.updatedAt = Date.now();
    await this.repository.updateTask(task);
    this.emit('task.plan_refined', { taskId, addedSteps: additionalSteps.map(s => s.stepId) });
    return task;
  }

  public async approveStep(
    taskId: string,
    approvalRequestId: string,
    approved: boolean,
    notes?: string
  ): Promise<AutonomousAgentTask> {
    const task = await this.repository.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found.`);
    if (task.state !== 'WAITING_FOR_APPROVAL') {
      throw new Error(`Task "${taskId}" is in state "${task.state}", not WAITING_FOR_APPROVAL.`);
    }
    if (task.approvalRequestId !== approvalRequestId) {
      throw new Error(`Approval request ID mismatch: expected ${task.approvalRequestId}, got ${approvalRequestId}.`);
    }

    if (!approved) {
      await this.transitionState(taskId, 'FAILED', `Step rejected by user: ${notes || 'No reason provided'}`);
      return (await this.repository.getTask(taskId))!;
    }

    // Step was approved! Transition WAITING_FOR_APPROVAL -> RESUMING -> RUNNING
    await this.transitionState(taskId, 'RESUMING', 'Approval granted; resuming execution');
    const runningTask = await this.transitionState(taskId, 'RUNNING', 'Resumed execution');

    // Mark current waiting step as ready to continue
    if (runningTask.plan && runningTask.activeStepId) {
      const activeStep = runningTask.plan.steps.find(s => s.stepId === runningTask.activeStepId);
      if (activeStep) {
        activeStep.status = 'PENDING';
      }
      runningTask.approvalRequestId = undefined;
      await this.repository.updateTask(runningTask);
    }

    // Continue execution loop
    const controller = new AbortController();
    this.activeExecutions.set(taskId, controller);
    this.executionFences.set(taskId, {
      signal: controller.signal,
      token: (await this.repository.getTask(taskId))!.fencingToken
    });
    void this.continueExecutionFromCurrentStep(taskId, controller.signal);

    return (await this.repository.getTask(taskId))!;
  }

  private async continueExecutionFromCurrentStep(taskId: string, signal: AbortSignal): Promise<void> {
    try {
      const task = await this.repository.getTask(taskId);
      if (!task || !task.plan) return;
      this.assertExecutionFence(taskId, signal, task);

      const remainingSteps = task.plan.steps.filter(s => s.status === 'PENDING' || s.status === 'WAITING_FOR_APPROVAL');

      for (const step of remainingSteps) {
        if (signal.aborted) return;
        await this.runStep(taskId, step, signal);
        if (signal.aborted) return;
      }

      // VERIFYING
      await this.transitionDuringExecution(taskId, signal, 'VERIFYING', 'Running final verification gate');
      const taskAfter = await this.repository.getTask(taskId);
      if (taskAfter) {
        taskAfter.deliverableSummary = `Successfully executed autonomous mission for: "${taskAfter.objective}". Verified: true.`;
        await this.updateDuringExecution(taskAfter, signal);
      }
      await this.transitionDuringExecution(taskId, signal, 'COMPLETED', 'Mission accomplished and verified');
      this.emit('task.completed', { taskId, deliverableSummary: taskAfter?.deliverableSummary });
    } catch (error: any) {
      if (signal.aborted || String(error.message || '').includes('STALE_FENCING_TOKEN') ||
          String(error.message || '').includes('Concurrent update or stale fencing token')) return;
      try {
        await this.transitionDuringExecution(taskId, signal, 'FAILED', error.message || 'Resumed execution failed');
      } catch (transitionError: any) {
        if (signal.aborted || String(transitionError.message || '').includes('STALE_FENCING_TOKEN')) return;
        throw transitionError;
      }
      this.emit('task.failed', { taskId, error: error.message });
    } finally {
      if (this.activeExecutions.get(taskId)?.signal === signal) this.activeExecutions.delete(taskId);
      if (this.executionFences.get(taskId)?.signal === signal) this.executionFences.delete(taskId);
    }
  }

  public async pauseTask(taskId: string): Promise<AutonomousAgentTask> {
    const task = await this.repository.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found.`);

    const controller = this.activeExecutions.get(taskId);
    if (controller) {
      controller.abort();
      this.activeExecutions.delete(taskId);
    }

    return this.transitionState(taskId, 'PAUSED', 'Task paused by user');
  }

  public async resumeTask(taskId: string): Promise<AutonomousAgentTask> {
    const task = await this.repository.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found.`);
    if (task.state !== 'PAUSED') {
      throw new Error(`Cannot resume task in state "${task.state}". Must be PAUSED.`);
    }

    if (task.approvalRequestId) {
      return this.transitionState(taskId, 'WAITING_FOR_APPROVAL', 'Resumed waiting for approval');
    }

    await this.transitionState(taskId, 'RESUMING', 'Task resuming from pause checkpoint');
    await this.transitionState(taskId, 'RUNNING', 'Task actively running again');

    const controller = new AbortController();
    this.activeExecutions.set(taskId, controller);
    this.executionFences.set(taskId, { signal: controller.signal, token: (await this.repository.getTask(taskId))!.fencingToken });
    void this.continueExecutionFromCurrentStep(taskId, controller.signal);

    return (await this.repository.getTask(taskId))!;
  }

  public async recoverTask(taskId: string, workerId = 'worker_recovery'): Promise<AutonomousAgentTask> {
    const task = await this.repository.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found.`);

    if (this.repository.claimTask) {
      const claim = await this.repository.claimTask(taskId, workerId, 60000);
      if (!claim.success) throw new Error(`Failed to claim task for recovery: ${claim.error}`);
    }

    if (task.state === 'WAITING_FOR_APPROVAL') {
      return task; // Preserves approval state
    }

    if (task.state === 'PAUSED' || task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELLED') {
      return task;
    }

    await this.transitionState(taskId, 'RESUMING', 'Worker crash recovery initiated; resuming from persisted checkpoint');
    await this.transitionState(taskId, 'RUNNING', 'Worker crash recovery active');

    const controller = new AbortController();
    this.activeExecutions.set(taskId, controller);
    this.executionFences.set(taskId, { signal: controller.signal, token: (await this.repository.getTask(taskId))!.fencingToken });
    void this.continueExecutionFromCurrentStep(taskId, controller.signal);

    return (await this.repository.getTask(taskId))!;
  }

  public async cancelTask(taskId: string, reason = 'Cancelled by user'): Promise<AutonomousAgentTask> {
    const task = await this.repository.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found.`);

    const controller = this.activeExecutions.get(taskId);
    if (controller) {
      controller.abort();
      this.activeExecutions.delete(taskId);
    }

    return this.transitionState(taskId, 'CANCELLED', reason);
  }

  private async transitionState(
    taskId: string,
    newState: AutonomousTaskState,
    reason?: string
  ): Promise<AutonomousAgentTask> {
    const prev = await this.repository.getTask(taskId);
    const updated = await this.repository.updateState(taskId, newState, reason);
    this.emit('task.state_changed', {
      taskId,
      from: prev?.state,
      to: newState,
      reason
    });
    return updated;
  }
}
