import {
  SpecialistTaskState,
  isTerminalSpecialistState
} from '../../../contracts/src/index.js';
import {
  SpecialistTaskRepository,
  DurableSpecialistTask,
  TaskClaimResult
} from './specialist-task-repository.js';
import { StaleFencingTokenError } from './task-state-machine.js';

export interface TaskLeaseConfig {
  defaultLeaseDurationMs: number;
  heartbeatIntervalMs: number;
  maxLeaseExtensions: number;
}

export class TaskLeaseManager {
  private config: TaskLeaseConfig;

  constructor(
    private repository: SpecialistTaskRepository,
    config: Partial<TaskLeaseConfig> = {}
  ) {
    this.config = {
      defaultLeaseDurationMs: config.defaultLeaseDurationMs ?? 30000,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 10000,
      maxLeaseExtensions: config.maxLeaseExtensions ?? 10
    };
  }

  /**
   * Atomically claims an eligible task for the specified worker.
   * Increments the task's monotonic fencing token and sets the initial lease expiration.
   */
  public async acquireLease(
    taskId: string,
    workerId: string,
    leaseDurationMs?: number,
    expectedFencingToken?: number
  ): Promise<TaskClaimResult> {
    const duration = leaseDurationMs || this.config.defaultLeaseDurationMs;
    return await this.repository.claimTask(taskId, workerId, duration, expectedFencingToken);
  }

  /**
   * Extends the lease on an actively executing task.
   * Fails if the worker has been fenced out or if the task has transitioned to terminal state.
   */
  public async renewLease(
    taskId: string,
    workerId: string,
    fencingToken: number,
    leaseDurationMs?: number
  ): Promise<boolean> {
    const duration = leaseDurationMs || this.config.defaultLeaseDurationMs;
    return await this.repository.renewLease(taskId, workerId, duration, fencingToken);
  }

  /**
   * Scans for tasks with expired leases and safely transitions them to RETRY_WAIT or FAILED.
   * Never reclaims tasks that have already reached a terminal state.
   */
  public async reclaimExpiredLeases(now = Date.now()): Promise<DurableSpecialistTask[]> {
    const expiredTasks = await this.repository.findExpiredLeases(now);
    const reclaimed: DurableSpecialistTask[] = [];

    for (const task of expiredTasks) {
      if (isTerminalSpecialistState(task.state)) continue;

      const hasRetriesLeft = task.attemptCount < task.maxRetries;
      const nextState: SpecialistTaskState = hasRetriesLeft ? 'RETRY_WAIT' : 'TIMED_OUT';

      try {
        const success = await this.repository.updateTaskState(
          task.id,
          nextState,
          task.fencingToken,
          {
            errorDetails: {
              code: hasRetriesLeft ? 'LEASE_EXPIRED_RETRYABLE' : 'LEASE_EXPIRED_EXHAUSTED',
              message: `Worker lease expired after ${task.timeoutMs}ms without heartbeat completion.`,
              retryable: hasRetriesLeft
            }
          }
        );

        if (success) {
          reclaimed.push({ ...task, state: nextState });
        }
      } catch (err) {
        // If stale fencing token or state race, skip and let other workers proceed safely
        if (err instanceof StaleFencingTokenError) {
          continue;
        }
        console.error(`[TaskLeaseManager] Error reclaiming expired lease for task ${task.id}:`, err);
      }
    }

    return reclaimed;
  }
}
