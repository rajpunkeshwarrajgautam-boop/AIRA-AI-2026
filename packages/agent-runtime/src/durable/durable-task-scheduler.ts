import {
  TaskDAG,
  SpecialistTaskContract,
  validateTaskDAG,
  ExecutionPrincipal,
  isTerminalSpecialistState
} from '../../../contracts/src/index.js';
import {
  SpecialistTaskRepository,
  DurableSpecialistTask
} from './specialist-task-repository.js';
import { assertValidTransition } from './task-state-machine.js';

export interface SchedulerOptions {
  maxConcurrency?: number;
  maxQueueAdmission?: number;
}

export interface SchedulingBatchResult {
  runnableTasks: DurableSpecialistTask[];
  blockedTasks: DurableSpecialistTask[];
  terminalTasks: DurableSpecialistTask[];
  activeTaskCount: number;
}

export class DurableTaskScheduler {
  private maxConcurrency: number;
  private maxQueueAdmission: number;

  constructor(
    private repository: SpecialistTaskRepository,
    options: SchedulerOptions = {}
  ) {
    this.maxConcurrency = options.maxConcurrency ?? 3;
    this.maxQueueAdmission = options.maxQueueAdmission ?? 50;
  }

  /**
   * Submits a full Task DAG into durable storage, establishing initial QUEUED and BLOCKED tasks.
   */
  public async submitDAG(
    dag: TaskDAG,
    principal: ExecutionPrincipal,
    options: { missionId?: string; workspaceId?: string } = {}
  ): Promise<DurableSpecialistTask[]> {
    const validation = validateTaskDAG(dag);
    if (!validation.valid) {
      throw new Error(`DAG validation failed: ${validation.error}`);
    }

    if (dag.tasks.length > this.maxQueueAdmission) {
      throw new Error(`Queue admission limit exceeded: DAG contains ${dag.tasks.length} tasks (max: ${this.maxQueueAdmission}).`);
    }

    const now = Date.now();
    const createdTasks: DurableSpecialistTask[] = [];

    for (const contract of dag.tasks) {
      // Check for duplicate submission by idempotency if key present
      const idempotencyKey = (contract.inputContract as any)?.idempotencyKey || contract.taskId;
      const existing = await this.repository.getTaskByIdempotencyKey(principal.userId, idempotencyKey);
      if (existing) {
        const requestedWorkspace = options.workspaceId || principal.workspaceId;
        if (
          existing.id !== contract.taskId || existing.runId !== contract.runId ||
          existing.principalId !== principal.userId || existing.workspaceId !== requestedWorkspace
        ) {
          throw new Error('Durable task idempotency key is already bound to a different run, owner, or workspace.');
        }
        createdTasks.push(existing);
        continue;
      }

      // Root tasks (0 dependencies) start in QUEUED; dependent tasks start in BLOCKED
      const hasDeps = contract.dependencies && contract.dependencies.length > 0;
      const initialState = hasDeps ? 'BLOCKED' : 'QUEUED';

      const task: DurableSpecialistTask = {
        id: contract.taskId,
        runId: contract.runId,
        missionId: options.missionId,
        principalId: principal.userId,
        workspaceId: options.workspaceId || principal.workspaceId,
        role: contract.role,
        objective: contract.objective,
        state: initialState,
        dependencies: [...contract.dependencies],
        inputPayload: { ...(contract.inputContract || {}) },
        executionConstraints: contract.executionConstraints,
        authorizationRequirements: contract.authorizationRequirements,
        budgetLimits: contract.budgetLimits,
        timeoutMs: contract.timeoutConfig?.stepTimeoutMs ?? 60000,
        attemptCount: 0,
        maxRetries: contract.retryPolicy?.maxRetries ?? 2,
        backoffMultiplier: contract.retryPolicy?.backoffMultiplier ?? 1.5,
        fencingToken: 0,
        idempotencyKey,
        usageTelemetry: { tokensUsed: 0, durationMs: 0 },
        provenance: { workerId: 'aira-task-scheduler' },
        checkpoints: [{ checkpoint: 'INITIALIZED', timestamp: now }],
        createdAt: now,
        updatedAt: now
      };

      await this.repository.saveTask(task);
      await this.repository.recordEvent({
        taskId: task.id,
        runId: task.runId,
        eventType: 'TASK_SUBMITTED',
        toState: initialState,
        fencingToken: 0,
        payload: { dependencies: task.dependencies }
      });

      createdTasks.push(task);
    }

    return createdTasks;
  }

  /**
   * Evaluates the run's tasks and identifies tasks ready to run while respecting concurrency limits.
   * Automatically unblocks BLOCKED tasks whose dependencies have all completed.
   * If any dependency failed or was cancelled, fails the dependent task.
   */
  public async scheduleRun(runId: string): Promise<SchedulingBatchResult> {
    const allTasks = await this.repository.listTasksByRun(runId);
    const completedSet = new Set<string>();
    const failedSet = new Set<string>();

    for (const t of allTasks) {
      if (t.state === 'COMPLETED') completedSet.add(t.id);
      if (t.state === 'FAILED' || t.state === 'CANCELLED' || t.state === 'TIMED_OUT' || t.state === 'UNAVAILABLE') {
        failedSet.add(t.id);
      }
    }

    // 1. Process BLOCKED tasks
    for (const task of allTasks) {
      if (task.state !== 'BLOCKED') continue;

      // Check if any prerequisite failed
      const failedDep = task.dependencies.find(depId => failedSet.has(depId));
      if (failedDep) {
        assertValidTransition(task.id, 'BLOCKED', 'FAILED');
        await this.repository.updateTaskState(task.id, 'FAILED', task.fencingToken, {
          errorDetails: {
            code: 'PREREQUISITE_DEPENDENCY_FAILED',
            message: `Dependency task "${failedDep}" failed or was cancelled. Task aborted.`,
            retryable: false
          }
        });
        failedSet.add(task.id);
        task.state = 'FAILED';
        continue;
      }

      // Check if all prerequisites completed
      const allCompleted = task.dependencies.every(depId => completedSet.has(depId));
      if (allCompleted) {
        assertValidTransition(task.id, 'BLOCKED', 'QUEUED');
        await this.repository.updateTaskState(task.id, 'QUEUED', task.fencingToken);
        task.state = 'QUEUED';
      }
    }

    // 2. Identify active tasks (CLAIMED, RUNNING, WAITING_FOR_APPROVAL)
    const activeTasks = allTasks.filter(t => t.state === 'CLAIMED' || t.state === 'RUNNING' || t.state === 'WAITING_FOR_APPROVAL');
    const availableCapacity = Math.max(0, this.maxConcurrency - activeTasks.length);

    // 3. Select runnable QUEUED or RETRY_WAIT tasks up to available capacity
    const queuedTasks = allTasks.filter(t => t.state === 'QUEUED' || t.state === 'RETRY_WAIT');
    const admittedRunnable = queuedTasks.slice(0, availableCapacity);

    const blockedTasks = allTasks.filter(t => t.state === 'BLOCKED');
    const terminalTasks = allTasks.filter(t => isTerminalSpecialistState(t.state));

    return {
      runnableTasks: admittedRunnable,
      blockedTasks,
      terminalTasks,
      activeTaskCount: activeTasks.length
    };
  }

  /**
   * Cancels all non-terminal tasks associated with a run or mission.
   */
  public async cancelAllTasks(runId: string, reason = 'Mission was cancelled'): Promise<number> {
    const tasks = await this.repository.listTasksByRun(runId);
    let cancelledCount = 0;

    for (const task of tasks) {
      if (isTerminalSpecialistState(task.state)) continue;

      try {
        await this.repository.updateTaskState(task.id, 'CANCELLED', task.fencingToken, {
          errorDetails: {
            code: 'TASK_CANCELLED_BY_OPERATOR',
            message: reason,
            retryable: false
          }
        });
        cancelledCount++;
      } catch (err) {
        console.error(`[DurableTaskScheduler] Failed to cancel task ${task.id}:`, err);
      }
    }

    return cancelledCount;
  }
}
