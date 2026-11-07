import { EventEmitter } from 'node:events';
import { IAutonomousTaskRepository } from './repository.js';
import { AutonomousAgentEngine } from './autonomous-engine.js';
import { AutonomousAgentTask } from '../../../contracts/src/index.js';

export interface AutonomousWorkerHostConfig {
  workerId?: string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  idleBackoffMultiplier?: number;
  concurrency?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
}

export interface AutonomousWorkerHealth {
  status: 'STARTING' | 'HEALTHY' | 'SHUTTING_DOWN' | 'STOPPED';
  workerId: string;
  uptimeSeconds: number;
  activeCount: number;
  processedCount: number;
  reclaimedCount: number;
  concurrency: number;
  currentPollIntervalMs?: number;
}

export class AutonomousWorkerHost extends EventEmitter {
  public readonly workerId: string;
  private minPollIntervalMs: number;
  private maxPollIntervalMs: number;
  private currentPollIntervalMs: number;
  private idleBackoffMultiplier: number;
  private concurrency: number;
  private leaseDurationMs: number;
  private heartbeatIntervalMs: number;

  private isRunning = false;
  private isShuttingDown = false;
  private startedAt = 0;
  private processedCount = 0;
  private reclaimedCount = 0;
  private inFlightTasks = new Map<string, { abortController: AbortController; heartbeatTimer: NodeJS.Timeout }>();
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private repository: IAutonomousTaskRepository,
    private engine: AutonomousAgentEngine,
    config: AutonomousWorkerHostConfig = {}
  ) {
    super();
    this.workerId = config.workerId || `auto_worker_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.minPollIntervalMs = Math.max(50, config.pollIntervalMs ?? 500);
    this.maxPollIntervalMs = Math.max(this.minPollIntervalMs, config.maxPollIntervalMs ?? (this.minPollIntervalMs * 4));
    this.idleBackoffMultiplier = Math.max(1.0, config.idleBackoffMultiplier ?? 1.5);
    this.currentPollIntervalMs = this.minPollIntervalMs;
    this.concurrency = config.concurrency ?? 2;
    this.leaseDurationMs = config.leaseDurationMs ?? 15000;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 3000;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isShuttingDown = false;
    this.startedAt = Date.now();
    this.emit('worker.started', { workerId: this.workerId, concurrency: this.concurrency });

    await this.tick();
  }

  public async stop(): Promise<void> {
    if (!this.isRunning || this.isShuttingDown) return;
    this.isShuttingDown = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }

    // Abort active executions and clear heartbeats
    for (const [taskId, { abortController, heartbeatTimer }] of this.inFlightTasks.entries()) {
      clearInterval(heartbeatTimer);
      abortController.abort();
    }

    // Wait briefly for in-flight tasks to exit cleanly (max 3 seconds)
    const deadline = Date.now() + 3000;
    while (this.inFlightTasks.size > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }

    this.inFlightTasks.clear();
    this.isRunning = false;
    this.isShuttingDown = false;
    this.emit('worker.stopped', { workerId: this.workerId });
  }

  public getHealth(): AutonomousWorkerHealth {
    const uptimeSeconds = this.startedAt > 0 ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
    let status: AutonomousWorkerHealth['status'] = 'STOPPED';
    if (this.isShuttingDown) status = 'SHUTTING_DOWN';
    else if (this.isRunning) status = 'HEALTHY';

    return {
      status,
      workerId: this.workerId,
      uptimeSeconds,
      activeCount: this.inFlightTasks.size,
      processedCount: this.processedCount,
      reclaimedCount: this.reclaimedCount,
      concurrency: this.concurrency,
      currentPollIntervalMs: this.currentPollIntervalMs
    };
  }

  private async tick(): Promise<void> {
    if (!this.isRunning || this.isShuttingDown) return;

    try {
      const availableCapacity = this.concurrency - this.inFlightTasks.size;
      if (availableCapacity > 0) {
        const now = Date.now();
        const claimableTasks = this.repository.findClaimableTasks
          ? await this.repository.findClaimableTasks(now, availableCapacity)
          : [];

        if (claimableTasks.length > 0) {
          this.currentPollIntervalMs = this.minPollIntervalMs;
          for (const task of claimableTasks) {
            if (this.inFlightTasks.size >= this.concurrency) break;
            if (this.inFlightTasks.has(task.taskId)) continue;

            // Attempt atomic claim
            if (this.repository.claimTask) {
              const claim = await this.repository.claimTask(task.taskId, this.workerId, this.leaseDurationMs);
              if (claim.success && claim.task) {
                this.processedCount++;
                void this.processTask(claim.task);
              }
            } else {
              // Direct processing for in-memory or unleased repositories
              this.processedCount++;
              void this.processTask(task);
            }
          }
        } else {
          // Exponential idle backoff
          this.currentPollIntervalMs = Math.min(
            this.maxPollIntervalMs,
            Math.round(this.currentPollIntervalMs * this.idleBackoffMultiplier)
          );
        }
      }
    } catch (err: any) {
      this.emit('worker.error', { workerId: this.workerId, error: err.message });
    } finally {
      if (this.isRunning && !this.isShuttingDown) {
        this.pollTimer = setTimeout(() => void this.tick(), this.currentPollIntervalMs);
      }
    }
  }

  private async processTask(task: AutonomousAgentTask): Promise<void> {
    const taskId = task.taskId;
    const abortController = new AbortController();

    // Start heartbeat lease renewal
    let currentFencingToken = task.fencingToken || 1;
    const heartbeatTimer = setInterval(async () => {
      try {
        const current = await this.repository.getTask(taskId);
        if (!current || current.leaseOwner !== this.workerId) {
          clearInterval(heartbeatTimer);
          abortController.abort();
          return;
        }
        currentFencingToken = current.fencingToken;
        if (this.repository.renewLease) {
          const renewed = await this.repository.renewLease(
            taskId,
            this.workerId,
            this.leaseDurationMs,
            currentFencingToken
          );
          if (!renewed) {
            clearInterval(heartbeatTimer);
            abortController.abort();
          }
        }
      } catch {
        // Heartbeat failure
      }
    }, this.heartbeatIntervalMs);

    this.inFlightTasks.set(taskId, { abortController, heartbeatTimer });
    this.emit('task.claimed', { taskId, workerId: this.workerId, fencingToken: currentFencingToken });

    try {
      const result = await this.engine.executeAutonomousTask(taskId, abortController.signal);
      this.emit('task.completed', { taskId, state: result.state, deliverableSummary: result.deliverableSummary });
    } catch (err: any) {
      this.emit('task.failed', { taskId, error: err.message });
    } finally {
      clearInterval(heartbeatTimer);
      this.inFlightTasks.delete(taskId);
    }
  }
}
