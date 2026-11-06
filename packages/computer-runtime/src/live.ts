import type { AgentRuntime } from '../../agent-runtime/src/index.js';
import { distributedRuntime } from './distributed.js';
import { computerRuntime, type ManagedComputerRuntime } from './managed.js';
import { computerActions, RuntimeOutboxPublisher } from './actions.js';
import { RuntimeReliabilityService } from './reliability.js';

export class LiveRuntimeService {
  readonly reliability: RuntimeReliabilityService;
  readonly publisher = new RuntimeOutboxPublisher();
  private recoveryTimer?: NodeJS.Timeout;
  private recovering = false;
  private started = false;
  constructor(private readonly runtime: AgentRuntime, readonly computer: ManagedComputerRuntime = computerRuntime) {
    this.reliability = new RuntimeReliabilityService(computer.provider, distributedRuntime, {
      instanceId: process.env.AIRA_INSTANCE_ID,
      heartbeatMs: Number(process.env.AIRA_RUNTIME_HEARTBEAT_MS || 20000),
      schedulerLeaseMs: Number(process.env.AIRA_SCHEDULER_LEASE_MS || 45000),
      applyState: (owner, state) => computer.reconcileState(owner, state)
    });
  }
  async start() {
    await this.recover();
    await this.reliability.start();
    await this.publisher.tick();
    this.publisher.start();
    this.recoveryTimer = setInterval(() => void this.recover().catch(error => console.error('[LiveRecovery]', error)), 5000);
    this.recoveryTimer.unref();
    this.started = true;
  }
  async recover() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      await computerActions.recover(this.computer.provider);
      await this.runtime.recoverInterruptedRuns();
    } finally { this.recovering = false; }
  }
  async readiness() {
    const health = await this.reliability.health();
    return { ...health, ready: this.started && health.ready };
  }
  stop() {
    this.started = false;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.publisher.stop();
    this.reliability.stop();
  }
}
