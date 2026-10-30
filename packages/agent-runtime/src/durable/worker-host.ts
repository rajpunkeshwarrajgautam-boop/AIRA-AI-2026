import { SpecialistWorkerRuntime } from './specialist-worker-runtime.js';
import { TaskLeaseManager } from './task-lease-manager.js';
import { SpecialistTaskRepository } from './specialist-task-repository.js';
import { SpecialistRegistry } from '../specialists/specialist-registry.js';
import { DurableTaskScheduler } from './durable-task-scheduler.js';
import { isTerminalSpecialistState } from './task-state-machine.js';

export interface WorkerHostConfig {
  workerId?: string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  idleBackoffMultiplier?: number;
  concurrency?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
}

export interface WorkerHostHealth {
  status: 'STARTING' | 'HEALTHY' | 'SHUTTING_DOWN' | 'STOPPED';
  workerId: string;
  uptimeSeconds: number;
  activeCount: number;
  processedCount: number;
  reclaimedCount: number;
  concurrency: number;
  currentPollIntervalMs?: number;
}

export class SpecialistWorkerHost {
  public readonly workerId: string;
  private runtime: SpecialistWorkerRuntime;
  private leaseManager: TaskLeaseManager;
  private scheduler: DurableTaskScheduler;
  private minPollIntervalMs: number;
  private maxPollIntervalMs: number;
  private currentPollIntervalMs: number;
  private idleBackoffMultiplier: number;
  private concurrency: number;
  private isRunning = false;
  private startedAt = 0;
  private processedCount = 0;
  private reclaimedCount = 0;
  private inFlightTasks = new Set<string>();
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private repository: SpecialistTaskRepository,
    private registry: SpecialistRegistry,
    config: WorkerHostConfig = {}
  ) {
    this.workerId = config.workerId || `host_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.minPollIntervalMs = Math.max(50, config.pollIntervalMs ?? 500);
    this.maxPollIntervalMs = Math.max(this.minPollIntervalMs, config.maxPollIntervalMs ?? (this.minPollIntervalMs * 4));
    this.idleBackoffMultiplier = Math.max(1.0, config.idleBackoffMultiplier ?? 1.5);
    this.currentPollIntervalMs = this.minPollIntervalMs;
    this.concurrency = config.concurrency ?? 3;
    this.leaseManager = new TaskLeaseManager(repository, {
      defaultLeaseDurationMs: config.leaseDurationMs ?? 30000,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 5000
    });
    this.runtime = new SpecialistWorkerRuntime(repository, this.leaseManager, registry, {
      workerId: this.workerId,
      leaseDurationMs: config.leaseDurationMs ?? 30000,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 5000
    });
    this.scheduler = new DurableTaskScheduler(repository, {
      maxConcurrency: this.concurrency
    });
  }

  /**
   * Starts the worker polling and execution loop.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startedAt = Date.now();
    console.log(`[SpecialistWorkerHost] Worker ${this.workerId} started (concurrency=${this.concurrency}, pollInterval=${this.minPollIntervalMs}ms).`);

    await this.tick();
    this.schedulePoll();
  }

  /**
   * Performs one cycle of lease reclamation and task claiming/execution.
   */
  public async tick(): Promise<void> {
    if (!this.isRunning) return;

    try {
      let hasWork = false;

      // 1. Reclaim expired leases
      const reclaimed = await this.leaseManager.reclaimExpiredLeases(Date.now());
      if (reclaimed.length > 0) {
        this.reclaimedCount += reclaimed.length;
        hasWork = true;
        console.log(`[SpecialistWorkerHost] Reclaimed ${reclaimed.length} expired lease(s).`);
      }

      // 2. Determine capacity
      const capacity = this.concurrency - this.inFlightTasks.size;
      if (capacity > 0) {
        // 3. Find unassigned QUEUED or RETRY_WAIT tasks
        // For standalone workers, we scan expired or queued tasks across all runs
        const claimable = await this.findGlobalClaimableTasks(capacity);
        if (claimable.length > 0) {
          hasWork = true;
        }
        for (const task of claimable) {
          if (this.inFlightTasks.size >= this.concurrency) break;
          if (this.inFlightTasks.has(task.id)) continue;

          this.inFlightTasks.add(task.id);
          this.executeTaskAsync(task);
        }
      }

      // 4. Adaptive polling rate adjustment:
      if (hasWork || this.inFlightTasks.size > 0) {
        // Active queue or tasks in flight: poll at fast rate
        this.currentPollIntervalMs = this.minPollIntervalMs;
      } else {
        // Idle queue: back off to preserve database capacity and reduce query volume
        this.currentPollIntervalMs = Math.min(
          this.maxPollIntervalMs,
          Math.round(this.currentPollIntervalMs * this.idleBackoffMultiplier)
        );
      }
    } catch (err) {
      console.error(`[SpecialistWorkerHost] Error in worker tick:`, err);
    }
  }

  private async executeTaskAsync(task: any): Promise<void> {
    try {
      await this.runtime.executeTask(task);
      this.processedCount++;
      if (task.runId) {
        await this.scheduler.scheduleRun(task.runId);
      }
    } catch (err) {
      console.error(`[SpecialistWorkerHost] Error executing task ${task.id}:`, err);
    } finally {
      this.inFlightTasks.delete(task.id);
    }
  }

  private async findGlobalClaimableTasks(limit: number): Promise<any[]> {
    return await this.repository.findClaimableTasks(Date.now(), limit);
  }

  private schedulePoll(): void {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(async () => {
      await this.tick();
      this.schedulePoll();
    }, this.currentPollIntervalMs);
  }

  /**
   * Health check reporting runtime status.
   */
  public getHealth(): WorkerHostHealth {
    return {
      status: this.isRunning ? 'HEALTHY' : 'STOPPED',
      workerId: this.workerId,
      uptimeSeconds: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      activeCount: this.inFlightTasks.size,
      processedCount: this.processedCount,
      reclaimedCount: this.reclaimedCount,
      concurrency: this.concurrency,
      currentPollIntervalMs: this.currentPollIntervalMs
    };
  }

  /**
   * Graceful stop: clears polling and awaits or aborts in-flight tasks.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    console.log(`[SpecialistWorkerHost] Shutting down worker ${this.workerId}...`);
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    await this.runtime.shutdown();
    this.inFlightTasks.clear();
    console.log(`[SpecialistWorkerHost] Worker ${this.workerId} stopped cleanly.`);
  }
}
