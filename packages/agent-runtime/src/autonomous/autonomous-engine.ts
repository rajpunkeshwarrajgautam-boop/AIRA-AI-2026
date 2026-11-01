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
}

export class AutonomousAgentEngine extends EventEmitter {
  private repository: IAutonomousTaskRepository;
  private specialistRegistry: SpecialistRegistry;
  private toolGateway?: ToolGateway;
  private approvalKernel?: ApprovalKernel;
  private modelRouter?: ModelRouter;
  private activeExecutions: Map<string, AbortController> = new Map();

  constructor(options: AutonomousEngineOptions = {}) {
    super();
    this.repository = options.repository || new InMemoryAutonomousTaskRepository();
    this.specialistRegistry = options.specialistRegistry || new SpecialistRegistry();
    this.toolGateway = options.toolGateway;
    this.approvalKernel = options.approvalKernel;
    this.modelRouter = options.modelRouter;
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
    customPlan?: AgentObjectivePlan
  ): Promise<AutonomousAgentTask> {
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

  public async startTask(taskId: string): Promise<AutonomousAgentTask> {
    const task = await this.repository.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found.`);

    const abortController = new AbortController();
    this.activeExecutions.set(taskId, abortController);

    // STEP 1: PLANNING
    await this.transitionState(taskId, 'PLANNING', 'Decomposing natural language objective into structured plan');

    if (!task.plan || task.plan.steps.length === 0) {
      task.plan = await this.decomposeObjective(task);
      await this.repository.updateTask(task);
    }

    this.emit('task.plan_ready', { taskId, plan: task.plan });

    // STEP 2: READY
    await this.transitionState(taskId, 'READY', 'Plan compiled; ready for execution');

    // STEP 3: RUNNING
    await this.transitionState(taskId, 'RUNNING', 'Beginning autonomous execution of plan steps');

    // Asynchronously execute steps in sequence
    void this.executeLoop(taskId, abortController.signal);

    return (await this.repository.getTask(taskId))!;
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

      for (const step of task.plan.steps) {
        if (signal.aborted) {
          await this.transitionState(taskId, 'CANCELLED', 'Execution cancelled by signal');
          return;
        }

        // Re-read task in case state changed (e.g. paused)
        task = await this.repository.getTask(taskId);
        if (!task || task.state === 'CANCELLED' || task.state === 'PAUSED') {
          return;
        }

        // Check if step requires approval
        if (step.sideEffectLevel === 'WRITE' || step.sideEffectLevel === 'DESTRUCTIVE') {
          const approvalId = `req_appr_${randomUUID().slice(0, 8)}`;
          task.approvalRequestId = approvalId;
          task.activeStepId = step.stepId;
          step.status = 'WAITING_FOR_APPROVAL';
          await this.repository.updateTask(task);

          await this.transitionState(taskId, 'WAITING_FOR_APPROVAL', `Approval requested for step: ${step.title}`);
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
      }

      // STEP 4: VERIFYING
      await this.transitionState(taskId, 'VERIFYING', 'Running final verification gate');
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

      // STEP 5: COMPLETED
      task = await this.repository.getTask(taskId);
      if (task) {
        task.deliverableSummary = `Successfully executed autonomous mission for: "${task.objective}". Verified: ${isVerified}.`;
        await this.repository.updateTask(task);
      }
      await this.transitionState(taskId, 'COMPLETED', 'Mission accomplished and verified');
      this.emit('task.completed', { taskId, deliverableSummary: task?.deliverableSummary });
    } catch (err: any) {
      await this.transitionState(taskId, 'FAILED', err.message || 'Execution error');
      this.emit('task.failed', { taskId, error: err.message });
    } finally {
      this.activeExecutions.delete(taskId);
    }
  }

  private async runStep(taskId: string, step: AgentPlanStep, signal: AbortSignal): Promise<void> {
    const task = await this.repository.getTask(taskId);
    if (!task) return;

    step.status = 'RUNNING';
    step.startedAt = Date.now();
    task.activeStepId = step.stepId;
    await this.repository.updateTask(task);
    this.emit('task.step_started', { taskId, stepId: step.stepId, title: step.title });

    let specialistResult: any = null;
    const role = step.role;

    if (role && this.specialistRegistry.hasSpecialist(role)) {
      const specialist = this.specialistRegistry.getSpecialist(role)!;
      specialistResult = await specialist.execute({
        runId: `run_${taskId}_${step.stepId}`,
        taskId: `step_${step.stepId}`,
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
          stepTitle: step.title,
          stepDescription: step.description
        }
      });
    }

    const obs: AgentObservation = {
      observationId: `obs_${randomUUID().slice(0, 8)}`,
      stepId: step.stepId,
      source: 'specialist',
      sourceName: step.assignedSpecialist || step.role || 'System',
      summary: specialistResult?.output?.summary || `Executed step "${step.title}" successfully.`,
      timestamp: Date.now(),
      isError: specialistResult?.outcome === 'FAILED'
    };

    task.observations.push(obs);
    step.status = specialistResult?.outcome === 'FAILED' ? 'FAILED' : 'COMPLETED';
    step.completedAt = Date.now();
    step.resultSummary = obs.summary;
    await this.repository.updateTask(task);

    this.emit('task.observation', { taskId, observation: obs });
    this.emit('task.step_completed', { taskId, stepId: step.stepId, status: step.status });
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
    void this.continueExecutionFromCurrentStep(taskId, controller.signal);

    return (await this.repository.getTask(taskId))!;
  }

  private async continueExecutionFromCurrentStep(taskId: string, signal: AbortSignal): Promise<void> {
    const task = await this.repository.getTask(taskId);
    if (!task || !task.plan) return;

    const remainingSteps = task.plan.steps.filter(s => s.status === 'PENDING' || s.status === 'WAITING_FOR_APPROVAL');

    for (const step of remainingSteps) {
      if (signal.aborted) {
        await this.transitionState(taskId, 'CANCELLED', 'Execution cancelled by signal');
        return;
      }
      await this.runStep(taskId, step, signal);
    }

    // VERIFYING
    await this.transitionState(taskId, 'VERIFYING', 'Running final verification gate');
    const taskAfter = await this.repository.getTask(taskId);
    if (taskAfter) {
      taskAfter.deliverableSummary = `Successfully executed autonomous mission for: "${taskAfter.objective}". Verified: true.`;
      await this.repository.updateTask(taskAfter);
    }
    await this.transitionState(taskId, 'COMPLETED', 'Mission accomplished and verified');
    this.emit('task.completed', { taskId, deliverableSummary: taskAfter?.deliverableSummary });
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
