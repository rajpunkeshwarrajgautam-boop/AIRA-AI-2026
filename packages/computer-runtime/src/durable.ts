import { distributedRuntime, type DurableComputerLease } from './distributed.js';
import type { ComputerLease, LeaseAcquisition } from './lease.js';
import { executionLeaseFor } from '../../agent-runtime/src/repositories.js';
import { db } from '../../db/src/index.js';

export class DurableComputerLeaseManager {
  readonly coordinator = distributedRuntime;
  async current(ownerId: string) { return this.coordinator.currentComputerLease(ownerId); }
  async acquireBot(ownerId: string, botId: string, runId: string): Promise<DurableComputerLease> {
    const execution = executionLeaseFor(runId);
    if (!execution) throw new Error('EXECUTION_LEASE_LOST');
    if (!await db('runs').where({ id: runId, principal_id: ownerId, execution_owner: execution.owner, execution_fence: execution.fence })
      .whereNotIn('state', ['COMPLETED', 'FAILED', 'CANCELLED'])
      .whereRaw('execution_lease_until >= floor(extract(epoch FROM clock_timestamp()) * 1000)').first()) throw new Error('EXECUTION_LEASE_LOST');
    const current = await this.current(ownerId);
    const previous = current?.mode === 'BOT' && current.holderId.match(/^run:(.*):execution:(\d+):worker:(.*)$/);
    if (current && previous && !await db('runs').where({ id: previous[1], execution_fence: Number(previous[2]), execution_owner: previous[3] })
      .whereNotIn('state', ['COMPLETED', 'FAILED', 'CANCELLED'])
      .whereRaw('execution_lease_until >= floor(extract(epoch FROM clock_timestamp()) * 1000)').first()) {
      await db('aira_computer_leases').where({ owner_id: ownerId, token: current.token, fence: current.fence })
        .whereRaw("NOT EXISTS (SELECT 1 FROM aira_computer_actions WHERE owner_id = ? AND status IN ('STARTED', 'AMBIGUOUS'))", [ownerId])
        .update({ lease_until: 0 });
    }
    return this.coordinator.acquireComputerLease({
      ownerId, botId, holderId: `run:${runId}:execution:${execution.fence}:worker:${execution.owner}`,
      mode: 'BOT', ttlMs: 180000
    });
  }
  async takeover(ownerId: string, botId: string, sessionId: string): Promise<LeaseAcquisition> {
    const previous = await this.current(ownerId);
    const lease = await this.coordinator.acquireComputerLease({ ownerId, botId, holderId: 'human:' + sessionId, mode: 'HUMAN', ttlMs: 300000, preemptBot: true });
    return { lease, preempted: previous };
  }
  async assertHuman(ownerId: string, token: string): Promise<DurableComputerLease> {
    const lease = await this.coordinator.assertComputerLease(ownerId, token);
    if (lease.mode !== 'HUMAN') throw new Error('Take control of this computer before interacting with it.');
    return this.coordinator.renewComputerLease(ownerId, token, 300000);
  }
  async release(ownerId: string, token: string): Promise<ComputerLease | undefined> {
    const lease = await this.current(ownerId);
    if (!lease || lease.token !== token) return undefined;
    return await this.coordinator.releaseComputerLease(ownerId, token, lease.fence) ? lease : undefined;
  }
  async releaseRun(ownerId: string, runId: string): Promise<boolean> {
    const lease = await this.current(ownerId);
    if (!lease?.holderId.startsWith('run:' + runId + ':execution:')) return false;
    const captured = executionLeaseFor(runId);
    if (captured && lease.holderId !== `run:${runId}:execution:${captured.fence}:worker:${captured.owner}`) return false;
    if (!captured) {
      const run = await db('runs').where({ id: runId, principal_id: ownerId }).first();
      if (!run || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) return false;
    }
    return this.coordinator.releaseComputerLease(ownerId, lease.token, lease.fence);
  }
}
