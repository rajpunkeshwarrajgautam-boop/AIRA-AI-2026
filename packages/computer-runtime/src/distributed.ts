import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../../db/src/index.js';

export type DurableLeaseMode = 'BOT' | 'HUMAN';
export type DesiredComputerState = 'RUNNING' | 'STOPPED' | 'SUSPENDED';
export type ObservedComputerState = DesiredComputerState | 'STARTING' | 'STOPPING' | 'ERROR' | 'UNKNOWN';

export interface DurableComputerLease {
  ownerId: string;
  botId: string;
  holderId: string;
  mode: DurableLeaseMode;
  token: string;
  fence: number;
  acquiredAt: number;
  expiresAt: number;
}

export interface DurableComputerEvent {
  ownerId: string;
  botId: string;
  sequence: number;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface SchedulerLease { name: string; holderId: string; fence: number; expiresAt: number }
export interface OutboxRecord { id: string; topic: string; aggregateId: string; dedupeKey: string; payload: unknown; attempts: number }

const n = (value: unknown) => Number(value || 0);
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('INVALID_LEASE_DURATION');
  return value;
}

export class DistributedRuntimeCoordinator {
  constructor(private readonly knex: Knex = db) {}

  private async databaseTime(knex: Knex = this.knex): Promise<number> {
    const result = await knex.raw('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now');
    return n(result.rows[0].now);
  }

  async currentComputerLease(ownerId: string): Promise<DurableComputerLease | undefined> {
    const row = await this.knex('aira_computer_leases').where({ owner_id: ownerId })
      .whereRaw('lease_until > floor(extract(epoch FROM clock_timestamp()) * 1000)').first();
    return row ? this.mapLease(row) : undefined;
  }

  async acquireComputerLease(input: { ownerId: string; botId: string; holderId: string; mode: DurableLeaseMode; ttlMs: number; preemptBot?: boolean }): Promise<DurableComputerLease> {
    positive(input.ttlMs);
    return this.knex.transaction(async trx => {
      // Materialize an expired sentinel before locking: FOR UPDATE alone cannot
      // serialize contenders when there is no row yet.
      await trx('aira_computer_leases').insert({
        owner_id: input.ownerId, bot_id: input.botId, holder_id: input.holderId,
        mode: input.mode, token: randomUUID(), fence: 0, acquired_at: 0, lease_until: 0, updated_at: 0
      }).onConflict('owner_id').ignore();
      const current = await trx('aira_computer_leases').where({ owner_id: input.ownerId }).forUpdate().first();
      const now = await this.databaseTime(trx);
      const active = current && n(current.lease_until) > now;
      const sameHolder = current.holder_id === input.holderId && current.bot_id === input.botId && current.mode === input.mode;
      if (active && !sameHolder) {
        const humanMayPreemptBot = input.preemptBot && input.mode === 'HUMAN' && current.mode === 'BOT';
        if (!humanMayPreemptBot) throw new Error(current.mode === 'HUMAN' ? 'COMPUTER_TAKEN_OVER' : 'COMPUTER_BUSY');
      }
      const fence = n(current.fence) + (sameHolder && active ? 0 : 1);
      const token = sameHolder && active ? String(current.token) : randomUUID();
      const acquiredAt = sameHolder && active ? n(current.acquired_at) : now;
      const row = {
        owner_id: input.ownerId, bot_id: input.botId, holder_id: input.holderId, mode: input.mode, token, fence,
        acquired_at: acquiredAt, lease_until: now + input.ttlMs, updated_at: now
      };
      await trx('aira_computer_leases').insert(row).onConflict('owner_id').merge(row);
      return this.mapLease(row);
    });
  }

  async assertComputerLease(ownerId: string, token: string, fence?: number): Promise<DurableComputerLease> {
    let query = this.knex('aira_computer_leases').where({ owner_id: ownerId, token })
      .whereRaw('lease_until > floor(extract(epoch FROM clock_timestamp()) * 1000)');
    if (fence !== undefined) query = query.andWhere({ fence });
    const row = await query.first();
    if (!row) throw new Error('COMPUTER_LEASE_LOST');
    return this.mapLease(row);
  }

  async renewComputerLease(ownerId: string, token: string, ttlMs: number): Promise<DurableComputerLease> {
    positive(ttlMs);
    return this.knex.transaction(async trx => {
      const row = await trx('aira_computer_leases').where({ owner_id: ownerId }).forUpdate().first();
      const now = await this.databaseTime(trx);
      if (!row || row.token !== token || n(row.lease_until) <= now) throw new Error('COMPUTER_LEASE_LOST');
      const leaseUntil = now + ttlMs;
      await trx('aira_computer_leases').where({ owner_id: ownerId }).update({ lease_until: leaseUntil, updated_at: now });
      return this.mapLease({ ...row, lease_until: leaseUntil });
    });
  }

  async releaseComputerLease(ownerId: string, token: string, fence?: number): Promise<boolean> {
    let query = this.knex('aira_computer_leases').where({ owner_id: ownerId, token });
    if (fence !== undefined) query = query.andWhere({ fence });
    // Keep the fencing high-water mark across release/reacquisition.
    return (await query.whereRaw('lease_until > floor(extract(epoch FROM clock_timestamp()) * 1000)')
      .update({ lease_until: 0 })) === 1;
  }

  async appendComputerEvent(ownerId: string, botId: string, type: string, data: Record<string, unknown> = {}, timestamp = Date.now()): Promise<DurableComputerEvent> {
    return this.knex.transaction(async trx => {
      const seqRows = await trx.raw(`
        INSERT INTO aira_computer_event_sequences (owner_id, sequence) VALUES (?, 1)
        ON CONFLICT (owner_id) DO UPDATE SET sequence = aira_computer_event_sequences.sequence + 1
        RETURNING sequence
      `, [ownerId]);
      const sequence = n(seqRows.rows?.[0]?.sequence ?? seqRows[0]?.sequence);
      await trx('aira_computer_events').insert({ owner_id: ownerId, bot_id: botId, sequence, type, data: JSON.stringify(data), created_at: timestamp });
      return { ownerId, botId, sequence, type, data, timestamp };
    });
  }

  async computerEvents(ownerId: string, botId: string, after = 0, limit = 500): Promise<DurableComputerEvent[]> {
    const rows = await this.knex('aira_computer_events').where({ owner_id: ownerId, bot_id: botId }).andWhere('sequence', '>', after).orderBy('sequence', 'asc').limit(Math.min(Math.max(limit, 1), 1000));
    return rows.map(row => ({ ownerId: row.owner_id, botId: row.bot_id, sequence: n(row.sequence), type: row.type, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data, timestamp: n(row.created_at) }));
  }

  async enqueueOutbox(topic: string, aggregateId: string, dedupeKey: string, payload: unknown, availableAt?: number): Promise<string | undefined> {
    const now = await this.databaseTime();
    const id = randomUUID();
    const rows = await this.knex('aira_runtime_outbox').insert({ id, topic, aggregate_id: aggregateId, dedupe_key: dedupeKey, payload: JSON.stringify(payload), status: 'PENDING', attempts: 0, available_at: availableAt ?? now, created_at: now }).onConflict('dedupe_key').ignore().returning('id');
    return rows[0]?.id;
  }

  async claimOutbox(workerId: string, limit = 50, leaseMs = 30_000): Promise<OutboxRecord[]> {
    positive(leaseMs);
    return this.knex.transaction(async trx => {
      const now = await this.databaseTime(trx);
      const rows = await trx('aira_runtime_outbox').where(builder => builder.where({ status: 'PENDING' }).orWhere(q => q.where({ status: 'CLAIMED' }).andWhere('claim_until', '<=', now)))
        .andWhere('available_at', '<=', now).orderBy('created_at', 'asc').forUpdate().skipLocked().limit(Math.min(Math.max(limit, 1), 200));
      if (!rows.length) return [];
      const ids = rows.map(row => row.id);
      await trx('aira_runtime_outbox').whereIn('id', ids).update({ status: 'CLAIMED', claimed_by: workerId, claim_until: now + leaseMs }).increment('attempts', 1);
      return rows.map(row => ({ id: row.id, topic: row.topic, aggregateId: row.aggregate_id, dedupeKey: row.dedupe_key, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload, attempts: n(row.attempts) + 1 }));
    });
  }

  async completeOutbox(id: string, workerId: string, attempt: number): Promise<boolean> {
    return this.finishOutbox(id, workerId, attempt, { status: 'PUBLISHED', published_at: this.knex.raw('floor(extract(epoch FROM clock_timestamp()) * 1000)') });
  }

  async failOutbox(id: string, workerId: string, attempt: number, error: string, retryAt: number): Promise<boolean> {
    return this.finishOutbox(id, workerId, attempt, { status: 'PENDING', available_at: retryAt, last_error: error.slice(0, 4000) });
  }

  private async finishOutbox(id: string, workerId: string, attempt: number, values: Record<string, unknown>): Promise<boolean> {
    return this.knex.transaction(async trx => {
      const row = await trx('aira_runtime_outbox').where({ id }).forUpdate().first();
      const now = await this.databaseTime(trx);
      if (!row || row.status !== 'CLAIMED' || row.claimed_by !== workerId || n(row.attempts) !== attempt || n(row.claim_until) <= now) return false;
      await trx('aira_runtime_outbox').where({ id }).update({ ...values, claim_until: null, claimed_by: null });
      return true;
    });
  }

  async acquireSchedulerLease(name: string, holderId: string, ttlMs: number): Promise<SchedulerLease | undefined> {
    positive(ttlMs);
    return this.knex.transaction(async trx => {
      await trx('aira_scheduler_leases').insert({ name, holder_id: holderId, fence: 0, lease_until: 0, updated_at: 0 }).onConflict('name').ignore();
      const current = await trx('aira_scheduler_leases').where({ name }).forUpdate().first();
      const now = await this.databaseTime(trx);
      if (current && n(current.lease_until) > now && current.holder_id !== holderId) return undefined;
      const fence = current ? n(current.fence) + (current.holder_id === holderId && n(current.lease_until) > now ? 0 : 1) : 1;
      const row = { name, holder_id: holderId, fence, lease_until: now + ttlMs, updated_at: now };
      await trx('aira_scheduler_leases').insert(row).onConflict('name').merge(row);
      return { name, holderId, fence, expiresAt: row.lease_until };
    });
  }

  async assertSchedulerLease(lease: SchedulerLease): Promise<boolean> {
    return Boolean(await this.knex('aira_scheduler_leases')
      .where({ name: lease.name, holder_id: lease.holderId, fence: lease.fence })
      .whereRaw('lease_until > floor(extract(epoch FROM clock_timestamp()) * 1000)').first());
  }

  async heartbeatInstance(instanceId: string, role: string, version: string, metadata: Record<string, unknown> = {}): Promise<void> {
    const now = await this.databaseTime();
    const row = { instance_id: instanceId, role, version, started_at: now, heartbeat_at: now, metadata: JSON.stringify(metadata) };
    await this.knex('aira_runtime_instances').insert(row).onConflict('instance_id').merge({ role, version, heartbeat_at: now, metadata: JSON.stringify(metadata) });
  }

  async setComputerDesiredState(ownerId: string, provider: string, desiredState: DesiredComputerState): Promise<number> {
    return this.knex.transaction(async trx => {
      await trx('aira_computer_instances').insert({
        owner_id: ownerId, provider, desired_state: 'STOPPED', observed_state: 'UNKNOWN',
        generation: 0, observed_generation: 0, updated_at: 0
      }).onConflict('owner_id').ignore();
      const current = await trx('aira_computer_instances').where({ owner_id: ownerId }).forUpdate().first();
      const now = await this.databaseTime(trx);
      const generation = n(current?.generation) + 1;
      const row = { owner_id: ownerId, provider, desired_state: desiredState, observed_state: current?.observed_state || 'UNKNOWN', provider_ref: current?.provider_ref || null, generation, observed_generation: n(current?.observed_generation), updated_at: now };
      await trx('aira_computer_instances').insert(row).onConflict('owner_id').merge(row);
      return generation;
    });
  }

  async recordComputerObservation(ownerId: string, generation: number, observedState: ObservedComputerState, providerRef?: string, error?: string): Promise<boolean> {
    return this.knex.transaction(async trx => {
      const current = await trx('aira_computer_instances').where({ owner_id: ownerId }).forUpdate().first();
      if (!current || n(current.generation) !== generation || n(current.observed_generation) > generation) return false;
      const now = await this.databaseTime(trx);
      await trx('aira_computer_instances').where({ owner_id: ownerId }).update({
        observed_state: observedState, observed_generation: generation, provider_ref: providerRef || null,
        last_error: error?.slice(0, 4000) || null, last_reconciled_at: now, updated_at: now
      });
      // Observation and its durable notification commit together. An ERROR is
      // retried, not announced as a completed desired-state transition.
      if (observedState === current.desired_state) {
        await trx('aira_runtime_outbox').insert({
          id: randomUUID(), topic: 'computer.reconciled', aggregate_id: ownerId,
          dedupe_key: `computer:${ownerId}:generation:${generation}`,
          payload: JSON.stringify({ ownerId, generation, state: observedState }),
          status: 'PENDING', attempts: 0, available_at: now, created_at: now
        }).onConflict('dedupe_key').ignore();
      }
      return true;
    });
  }

  async reconciliationBacklog(limit = 100): Promise<Array<{ ownerId: string; provider: string; desiredState: DesiredComputerState; observedState: ObservedComputerState; generation: number }>> {
    const rows = await this.knex('aira_computer_instances').whereRaw('generation > observed_generation OR desired_state <> observed_state').orderBy('updated_at', 'asc').limit(limit);
    return rows.map(row => ({ ownerId: row.owner_id, provider: row.provider, desiredState: row.desired_state, observedState: row.observed_state, generation: n(row.generation) }));
  }

  async reconcileComputer(ownerId: string, generation: number, apply: (state: DesiredComputerState) => Promise<void>): Promise<boolean> {
    return this.knex.transaction(async trx => {
      const row = await trx('aira_computer_instances').where({ owner_id: ownerId }).forUpdate().first();
      if (!row || n(row.generation) !== generation) return false;
      if (n(row.observed_generation) === generation && row.observed_state === row.desired_state) return false;
      const scoped = new DistributedRuntimeCoordinator(trx);
      // Serialize idempotent provider lifecycle operations with both competing
      // reconcilers and new intent. A crash leaves the intent in the backlog.
      try { await apply(row.desired_state); }
      catch (error) {
        await scoped.recordComputerObservation(ownerId, generation, 'ERROR', undefined, (error as Error).message);
        return false;
      }
      return scoped.recordComputerObservation(ownerId, generation, row.desired_state);
    });
  }

  async readiness(heartbeatGraceMs = 90_000): Promise<{ ready: boolean; database: boolean; schedulerLeader: boolean; staleInstances: number; reconciliationBacklog: number; pendingOutbox: number }> {
    await this.knex.raw('SELECT 1');
    const now = await this.databaseTime();
    const stale = await this.knex('aira_runtime_instances').where('heartbeat_at', '<', now - heartbeatGraceMs).count<{ count: string }[]>('* as count');
    const leaders = await this.knex('aira_scheduler_leases').where({ name: 'aira-bot-routines' }).andWhere('lease_until', '>', now).count<{ count: string }[]>('* as count');
    const active = await this.knex('aira_runtime_instances').where({ role: 'aira-bot-api' }).andWhere('heartbeat_at', '>=', now - heartbeatGraceMs).count<{ count: string }[]>('* as count');
    const backlog = await this.knex('aira_computer_instances').whereRaw('generation > observed_generation OR desired_state <> observed_state').count<{ count: string }[]>('* as count');
    const pending = await this.knex('aira_runtime_outbox').whereIn('status', ['PENDING', 'CLAIMED']).count<{ count: string }[]>('* as count');
    const staleInstances = n(stale[0]?.count); const reconciliationBacklog = n(backlog[0]?.count); const pendingOutbox = n(pending[0]?.count); const schedulerLeader = n(leaders[0]?.count) > 0;
    // Dead historical instances are diagnostics, not a permanent outage.
    return { ready: n(active[0]?.count) > 0 && schedulerLeader && reconciliationBacklog === 0, database: true, schedulerLeader, staleInstances, reconciliationBacklog, pendingOutbox };
  }

  private mapLease(row: any): DurableComputerLease {
    return { ownerId: row.owner_id, botId: row.bot_id, holderId: row.holder_id, mode: row.mode, token: row.token, fence: n(row.fence), acquiredAt: n(row.acquired_at), expiresAt: n(row.lease_until) };
  }
}

export const distributedRuntime = new DistributedRuntimeCoordinator();
