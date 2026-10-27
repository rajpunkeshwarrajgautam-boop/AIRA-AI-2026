import { SpecialistWorkerRuntime } from './specialist-worker-runtime.js';
import { TaskLeaseManager } from './task-lease-manager.js';
import { SpecialistTaskRepository } from './specialist-task-repository.js';
import { SpecialistRegistry } from '../specialists/specialist-registry.js';
import { isTerminalSpecialistState } from './task-state-machine.js';

export interface WorkerHostConfig {
  workerId?: string;
  pollIntervalMs?: number;
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
}

export class SpecialistWorkerHost {
  public readonly workerId: string;
  private runtime: SpecialistWorkerRuntime;
  private leaseManager: TaskLeaseManager;
  private pollIntervalMs: number;
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
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
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
  }

  /**
   * Starts the worker polling and execution loop.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startedAt = Date.now();
    console.log(`[SpecialistWorkerHost] Worker ${this.workerId} started (concurrency=${this.concurrency}, pollInterval=${this.pollIntervalMs}ms).`);

    this.schedulePoll();
  }

  /**
   * Performs one cycle of lease reclamation and task claiming/execution.
   */
  public async tick(): Promise<void> {
    if (!this.isRunning) return;

    try {
      // 1. Reclaim expired leases
      const reclaimed = await this.leaseManager.reclaimExpiredLeases(Date.now());
      if (reclaimed.length > 0) {
        this.reclaimedCount += reclaimed.length;
        console.log(`[SpecialistWorkerHost] Reclaimed ${reclaimed.length} expired lease(s).`);
      }

      // 2. Determine capacity
      const capacity = this.concurrency - this.inFlightTasks.size;
      if (capacity <= 0) return;

      // 3. Find unassigned QUEUED or RETRY_WAIT tasks
      // For standalone workers, we scan expired or queued tasks across all runs
      const claimable = await this.findGlobalClaimableTasks(capacity);
      for (const task of claimable) {
        if (this.inFlightTasks.size >= this.concurrency) break;
        if (this.inFlightTasks.has(task.id)) continue;

        this.inFlightTasks.add(task.id);
        this.executeTaskAsync(task);
      }
    } catch (err) {
      console.error(`[SpecialistWorkerHost] Error in worker tick:`, err);
    }
  }

  private async executeTaskAsync(task: any): Promise<void> {
    try {
      await this.runtime.executeTask(task);
      this.processedCount++;
    } catch (err) {
      console.error(`[SpecialistWorkerHost] Error executing task ${task.id}:`, err);
    } finally {
      this.inFlightTasks.delete(task.id);
    }
  }

  private async findGlobalClaimableTasks(limit: number): Promise<any[]> {
    // Note: In Postgres repository, finding runnable queued tasks can be scoped
    // Here we find expired or queued tasks
    const expired = await this.repository.findExpiredLeases(Date.now(), limit);
    return expired;
  }

  private schedulePoll(): void {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(async () => {
      await this.tick();
      this.schedulePoll();
    }, this.pollIntervalMs);
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
      concurrency: this.concurrency
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
