import {
  TaskDAG,
  ExecutionPrincipal,
  SpecialistTaskResult,
  SpecialistTaskOutcome
} from '../../../contracts/src/index.js';
import {
  SpecialistTaskRepository,
  DurableSpecialistTask
} from './specialist-task-repository.js';
import { DurableTaskScheduler } from './durable-task-scheduler.js';
import { SpecialistWorkerRuntime } from './specialist-worker-runtime.js';
import { TaskLeaseManager } from './task-lease-manager.js';

export interface MissionExecutionResult {
  runId: string;
  missionId?: string;
  outcome: SpecialistTaskOutcome;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  results: Record<string, SpecialistTaskResult>;
  timing: {
    startedAt: number;
    completedAt: number;
    durationMs: number;
  };
  error?: string;
}

export class DurableExecutionCoordinator {
  constructor(
    private repository: SpecialistTaskRepository,
    private scheduler: DurableTaskScheduler,
    private leaseManager: TaskLeaseManager,
    private workerRuntime: SpecialistWorkerRuntime
  ) {}

  /**
   * Executes a complete specialist DAG mission durably to a terminal conclusion.
   */
  public async executeMission(
    dag: TaskDAG,
    principal: ExecutionPrincipal,
    options: { missionId?: string; pollIntervalMs?: number; maxDurationMs?: number } = {}
  ): Promise<MissionExecutionResult> {
    const startedAt = Date.now();
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    const maxDurationMs = options.maxDurationMs ?? 300000; // 5 minute safeguard
    const runId = dag.runId;

    // 1. Submit DAG into durable storage
    const createdTasks = await this.scheduler.submitDAG(dag, principal, { missionId: options.missionId });
    const totalTasks = createdTasks.length;
    const results: Record<string, SpecialistTaskResult> = {};

    // 2. Execution Loop
    while (Date.now() - startedAt < maxDurationMs) {
      // Reclaim any expired leases first
      await this.leaseManager.reclaimExpiredLeases(Date.now());

      // Schedule and retrieve runnable tasks
      const batch = await this.scheduler.scheduleRun(runId);

      // If all tasks have reached terminal states, break and aggregate
      if (batch.terminalTasks.length === totalTasks) {
        break;
      }

      // If no tasks are currently runnable and no tasks are active in progress,
      // we check if deadlock / dependency failure occurred
      if (batch.runnableTasks.length === 0 && batch.activeTaskCount === 0) {
        // All remaining tasks must be BLOCKED because dependencies failed
        break;
      }

      // Execute runnable tasks in parallel up to concurrency limit
      if (batch.runnableTasks.length > 0) {
        const promises = batch.runnableTasks.map(async (task) => {
          try {
            const res = await this.workerRuntime.executeTask(task);
            results[task.id] = res;
          } catch (err: any) {
            console.error(`[DurableExecutionCoordinator] Task ${task.id} execution error:`, err);
          }
        });

        await Promise.all(promises);
      } else {
        // Wait for active tasks before next evaluation cycle
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    }

    const completedAt = Date.now();
    const finalTasks = await this.repository.listTasksByRun(runId);

    const completedCount = finalTasks.filter(t => t.state === 'COMPLETED').length;
    const failedCount = finalTasks.filter(t => t.state === 'FAILED' || t.state === 'TIMED_OUT' || t.state === 'UNAVAILABLE').length;
    const cancelledCount = finalTasks.filter(t => t.state === 'CANCELLED').length;

    let missionOutcome: SpecialistTaskOutcome = 'COMPLETED';
    let errorMessage: string | undefined;

    if (cancelledCount > 0) {
      missionOutcome = 'CANCELLED';
      errorMessage = 'Mission was cancelled before all tasks completed.';
    } else if (failedCount > 0) {
      missionOutcome = 'FAILED';
      errorMessage = `${failedCount} of ${totalTasks} specialist tasks failed during execution.`;
    } else if (completedCount < totalTasks) {
      missionOutcome = 'TIMED_OUT';
      errorMessage = `Mission exceeded maximum duration of ${maxDurationMs}ms before reaching terminal completion.`;
    }

    return {
      runId,
      missionId: options.missionId,
      outcome: missionOutcome,
      totalTasks,
      completedTasks: completedCount,
      failedTasks: failedCount,
      cancelledTasks: cancelledCount,
      results,
      timing: {
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt
      },
      error: errorMessage
    };
  }

  /**
   * Cancels an in-progress mission.
   */
  public async cancelMission(runId: string, reason = 'Mission cancelled by user'): Promise<void> {
    await this.scheduler.cancelAllTasks(runId, reason);
  }
}
