import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgresApplicationBuildQueue, type QueuedBuild } from './queue.js';

export interface DispatchOutcome {
  state: 'COMPLETED' | 'FAILED';
  // COMPLETED means build commands finished, NOT independent product acceptance.
  result: Record<string, unknown>;
}
export type BuildJobHandler = (job: QueuedBuild, signal: AbortSignal) => Promise<DispatchOutcome>;
export type BuildTerminalHandler = (job: QueuedBuild, state: 'COMPLETED' | 'FAILED', result: Record<string, unknown>) => Promise<void>;
export type BuildCancellationHandler = (job: QueuedBuild) => Promise<void>;

export interface DispatcherOptions {
  workerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  maxAttempts?: number;
}
export class ApplicationBuildDispatcher {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly pollMs: number;
  readonly maxAttempts: number;
  private stopping = false;
  private activeControllers = new Set<AbortController>();
  constructor(
    readonly queue: PostgresApplicationBuildQueue,
    readonly handler: BuildJobHandler,
    readonly terminalHandler?: BuildTerminalHandler,
    readonly cancellationHandler?: BuildCancellationHandler,
    opts: DispatcherOptions = {}
  ) {
    this.workerId = opts.workerId || 'builder_' + randomUUID();
    this.leaseMs = opts.leaseMs || 60_000;
    this.heartbeatMs = opts.heartbeatMs || 5_000;
    this.pollMs = opts.pollMs || 1_000;
    this.maxAttempts = opts.maxAttempts || 3;
    if (this.heartbeatMs < 100 || this.heartbeatMs * 3 >= this.leaseMs) throw new Error('INVALID_DISPATCH_HEARTBEAT');
    if (this.pollMs < 50 || this.pollMs > 30_000) throw new Error('INVALID_DISPATCH_INTERVAL');
    if (this.maxAttempts < 1 || this.maxAttempts > 5) throw new Error('INVALID_DISPATCH_ATTEMPTS');
  }

  stop(): void {
    this.stopping = true;
    for (const controller of this.activeControllers) controller.abort();
  }

  /** Claim at most one job; all queue mutations are generation-fenced. */
  async runOnce(): Promise<boolean> {
    if (this.stopping) return false;
    await this.queue.recoverExpired(25);
    const job = await this.queue.claim(this.workerId, this.leaseMs);
    if (!job) return false;
    const generation = job.generation;
    if (!await this.queue.start(job.id, this.workerId, generation)) return true;
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let leaseLost = false;
    let cancelled = false;
    let watching = true;
    const monitor = (async () => {
      while (watching && !this.stopping && !controller.signal.aborted) {
        await sleep(this.heartbeatMs);
        if (!watching || controller.signal.aborted) break;
        try {
          const current = await this.queue.get(job.id, job.ownerId);
          if (!current || current.cancelRequested || current.state === 'CANCELLED') {
            cancelled = true;
            controller.abort();
            break;
          }
          const alive = await this.queue.heartbeat(job.id, this.workerId, generation, this.leaseMs);
          if (!alive) {
            leaseLost = true;
            controller.abort();
            break;
          }
        } catch {
          // Fail closed: a dispatcher that cannot prove its lease must stop
          // attempting further project side effects.
          leaseLost = true;
          controller.abort();
          break;
        }
      }
    })();

    try {
      let outcome: DispatchOutcome;
      try {
        outcome = await this.handler(job, controller.signal);
      } catch (err: unknown) {
        outcome = {
          state: 'FAILED',
          result: { error: err instanceof Error ? err.message.slice(0, 800) : 'UNHANDLED_BUILD_ERROR' }
        };
      }
      const latest = await this.queue.get(job.id, job.ownerId);
      if (latest?.cancelRequested || cancelled) {
        controller.abort();
        await this.queue.acknowledgeCancellation(job.id, this.workerId, generation);
        if (this.cancellationHandler) await this.cancellationHandler(job);
        return true;
      }
      if (leaseLost || controller.signal.aborted) return true;
      // Failure does not get silently retried: the agent may already have
      // executed non-idempotent tool calls. Recovery requires reconciliation.
      const accepted = await this.queue.finish(job.id, this.workerId, generation, outcome.state, outcome.result);
      if (accepted && this.terminalHandler) await this.terminalHandler(job, outcome.state, outcome.result);
      return true;
    } finally {
      watching = false;
      controller.abort();
      this.activeControllers.delete(controller);
      await monitor;
    }
  }

  async serve(signal?: AbortSignal): Promise<void> {
    while (!this.stopping && !signal?.aborted) {
      try {
        const handled = await this.runOnce();
        if (!handled) await sleep(this.pollMs);
      } catch (err) {
        // Unavailable Postgres does not crash the long-lived supervisor.
        console.error('[aira-builder-dispatcher] iteration failed:', err instanceof Error ? err.message : 'unknown');
        await sleep(this.pollMs);
      }
    }
  }
}
