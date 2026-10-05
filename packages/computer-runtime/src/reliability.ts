import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ComputerProvider } from './provider.js';
import { DistributedRuntimeCoordinator, distributedRuntime, type DesiredComputerState } from './distributed.js';

export interface RuntimeReliabilityOptions {
  instanceId?: string;
  version?: string;
  heartbeatMs?: number;
  schedulerLeaseMs?: number;
  reconcileMs?: number;
}

export class RuntimeReliabilityService {
  readonly instanceId: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private schedulerFence?: number;

  constructor(
    private readonly provider: ComputerProvider,
    private readonly coordinator: DistributedRuntimeCoordinator = distributedRuntime,
    private readonly options: RuntimeReliabilityOptions = {}
  ) {
    this.instanceId = options.instanceId || `api:${hostname()}:${process.pid}:${randomUUID()}`;
  }

  async start(): Promise<void> {
    await this.heartbeat();
    await this.reconcile();
    const heartbeatMs = Math.max(5_000, this.options.heartbeatMs || 20_000);
    const reconcileMs = Math.max(5_000, this.options.reconcileMs || 15_000);
    this.heartbeatTimer = setInterval(() => void this.heartbeat().catch(error => console.error('[RuntimeReliability] heartbeat', error)), heartbeatMs);
    this.reconcileTimer = setInterval(() => void this.reconcile().catch(error => console.error('[RuntimeReliability] reconcile', error)), reconcileMs);
    this.heartbeatTimer.unref?.();
    this.reconcileTimer.unref?.();
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.heartbeatTimer = undefined;
    this.reconcileTimer = undefined;
  }

  async heartbeat(now = Date.now()): Promise<void> {
    await this.coordinator.heartbeatInstance(this.instanceId, 'aira-bot-api', this.options.version || process.env.npm_package_version || 'dev', { provider: this.provider.kind }, now);
    const leadership = await this.coordinator.acquireSchedulerLease('aira-bot-routines', this.instanceId, this.options.schedulerLeaseMs || 45_000, now);
    this.schedulerFence = leadership?.fence;
  }

  isSchedulerLeader(): boolean { return this.schedulerFence !== undefined; }

  async requestState(ownerId: string, desiredState: DesiredComputerState): Promise<number> {
    return this.coordinator.setComputerDesiredState(ownerId, this.provider.kind, desiredState);
  }

  async reconcile(): Promise<void> {
    for (const item of await this.coordinator.reconciliationBacklog(50)) {
      if (item.provider !== this.provider.kind) continue;
      try {
        await this.applyDesiredState(item.ownerId, item.desiredState);
        await this.coordinator.recordComputerObservation(item.ownerId, item.generation, item.desiredState);
        await this.coordinator.enqueueOutbox('computer.reconciled', item.ownerId, `computer:${item.ownerId}:generation:${item.generation}`, { ownerId: item.ownerId, generation: item.generation, state: item.desiredState });
      } catch (error) {
        await this.coordinator.recordComputerObservation(item.ownerId, item.generation, 'ERROR', undefined, (error as Error).message);
      }
    }
  }

  async health(): Promise<{ live: true; ready: boolean; schedulerLeader: boolean; database: boolean; staleInstances: number; reconciliationBacklog: number; pendingOutbox: number }> {
    const state = await this.coordinator.readiness();
    return { live: true, ...state, schedulerLeader: this.isSchedulerLeader() || state.schedulerLeader };
  }

  private async applyDesiredState(ownerId: string, desiredState: DesiredComputerState): Promise<void> {
    // Computer providers are per-user; botId is intentionally a reconciliation sentinel.
    // Docker provider ignores bot identity for lifecycle and keeps per-bot workspace separation in /data.
    const botId = '__reconciler__';
    if (desiredState === 'RUNNING') { await this.provider.start(ownerId, botId); return; }
    if (desiredState === 'SUSPENDED' && 'suspend' in this.provider && typeof (this.provider as any).suspend === 'function') { await (this.provider as any).suspend(ownerId); return; }
    await this.provider.stop(ownerId, botId);
  }
}
