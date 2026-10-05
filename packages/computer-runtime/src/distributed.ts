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

export class DistributedRuntimeCoordinator {
  constructor(private readonly knex: Knex = db) {}

  async currentComputerLease(ownerId: string, now = Date.now()): Promise<DurableComputerLease | undefined> {
    const row = await this.knex('aira_computer_leases').where({ owner_id: ownerId }).andWhere('lease_until', '>', now).first();
    return row ? this.mapLease(row) : undefined;
  }

  async acquireComputerLease(input: { ownerId: string; botId: string; holderId: string; mode: DurableLeaseMode; ttlMs: number; preemptBot?: boolean }, now = Date.now()): Promise<DurableComputerLease> {
    return this.knex.transaction(async trx => {
      const current = await trx('aira_computer_leases').where({ owner_id: input.ownerId }).forUpdate().first();
      const active = current && n(current.lease_until) > now;
      if (active && current.holder_id !== input.holderId) {
        const humanMayPreemptBot = input.preemptBot && input.mode === 'HUMAN' && current.mode === 'BOT';
        if (!humanMayPreemptBot) throw new Error(current.mode === 'HUMAN' ? 'COMPUTER_TAKEN_OVER' : 'COMPUTER_BUSY');
      }
      const fence = current ? n(current.fence) + (current.holder_id === input.holderId && active ? 0 : 1) : 1;
      const token = current?.holder_id === input.holderId && active ? String(current.token) : randomUUID();
      const acquiredAt = current?.holder_id === input.holderId && active ? n(current.acquired_at) : now;
      const row = {
        owner_id: input.ownerId, bot_id: input.botId, holder_id: input.holderId, mode: input.mode, token, fence,
        acquired_at: acquiredAt, lease_until: now + input.ttlMs, updated_at: now
      };
      await trx('aira_computer_leases').insert(row).onConflict('owner_id').merge(row);
      return this.mapLease(row);
    });
  }

  async assertComputerLease(ownerId: string, token: string, fence?: number, now = Date.now()): Promise<DurableComputerLease> {
    let query = this.knex('aira_computer_leases').where({ owner_id: ownerId, token }).andWhere('lease_until', '>', now);
    if (fence !== undefined) query = query.andWhere({ fence });
    const row = await query.first();
    if (!row) throw new Error('COMPUTER_LEASE_LOST');
    return this.mapLease(row);
  }

  async renewComputerLease(ownerId: string, token: string, ttlMs: number, now = Date.now()): Promise<DurableComputerLease> {
    const rows = await this.knex('aira_computer_leases').where({ owner_id: ownerId, token }).andWhere('lease_until', '>', now)
      .update({ lease_until: now + ttlMs, updated_at: now }).returning('*');
    if (!rows[0]) throw new Error('COMPUTER_LEASE_LOST');
    return this.mapLease(rows[0]);
  }

  async releaseComputerLease(ownerId: string, token: string, fence?: number): Promise<boolean> {
    let query = this.knex('aira_computer_leases').where({ owner_id: ownerId, token });
    if (fence !== undefined) query = query.andWhere({ fence });
    return (await query.delete()) === 1;
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

  async enqueueOutbox(topic: string, aggregateId: string, dedupeKey: string, payload: unknown, availableAt = Date.now()): Promise<string | undefined> {
    const id = randomUUID();
    const rows = await this.knex('aira_runtime_outbox').insert({ id, topic, aggregate_id: aggregateId, dedupe_key: dedupeKey, payload: JSON.stringify(payload), status: 'PENDING', attempts: 0, available_at: availableAt, created_at: Date.now() }).onConflict('dedupe_key').ignore().returning('id');
    return rows[0]?.id;
  }

  async claimOutbox(workerId: string, limit = 50, leaseMs = 30_000, now = Date.now()): Promise<OutboxRecord[]> {
    return this.knex.transaction(async trx => {
      const rows = await trx('aira_runtime_outbox').where(builder => builder.where({ status: 'PENDING' }).orWhere(q => q.where({ status: 'CLAIMED' }).andWhere('claim_until', '<=', now)))
        .andWhere('available_at', '<=', now).orderBy('created_at', 'asc').forUpdate().skipLocked().limit(Math.min(Math.max(limit, 1), 200));
      if (!rows.length) return [];
      const ids = rows.map(row => row.id);
      await trx('aira_runtime_outbox').whereIn('id', ids).update({ status: 'CLAIMED', claimed_by: workerId, claim_until: now + leaseMs }).increment('attempts', 1);
      return rows.map(row => ({ id: row.id, topic: row.topic, aggregateId: row.aggregate_id, dedupeKey: row.dedupe_key, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload, attempts: n(row.attempts) + 1 }));
    });
  }

  async completeOutbox(id: string, workerId: string, now = Date.now()): Promise<boolean> {
    return (await this.knex('aira_runtime_outbox').where({ id, claimed_by: workerId, status: 'CLAIMED' }).update({ status: 'PUBLISHED', published_at: now, claim_until: null, claimed_by: null })) === 1;
  }

  async failOutbox(id: string, workerId: string, error: string, retryAt: number): Promise<boolean> {
    return (await this.knex('aira_runtime_outbox').where({ id, claimed_by: workerId, status: 'CLAIMED' }).update({ status: 'PENDING', available_at: retryAt, claim_until: null, claimed_by: null, last_error: error.slice(0, 4000) })) === 1;
  }

  async acquireSchedulerLease(name: string, holderId: string, ttlMs: number, now = Date.now()): Promise<SchedulerLease | undefined> {
    return this.knex.transaction(async trx => {
      const current = await trx('aira_scheduler_leases').where({ name }).forUpdate().first();
      if (current && n(current.lease_until) > now && current.holder_id !== holderId) return undefined;
      const fence = current ? n(current.fence) + (current.holder_id === holderId && n(current.lease_until) > now ? 0 : 1) : 1;
      const row = { name, holder_id: holderId, fence, lease_until: now + ttlMs, updated_at: now };
      await trx('aira_scheduler_leases').insert(row).onConflict('name').merge(row);
      return { name, holderId, fence, expiresAt: row.lease_until };
    });
  }

  async heartbeatInstance(instanceId: string, role: string, version: string, metadata: Record<string, unknown> = {}, now = Date.now()): Promise<void> {
    const row = { instance_id: instanceId, role, version, started_at: now, heartbeat_at: now, metadata: JSON.stringify(metadata) };
    await this.knex('aira_runtime_instances').insert(row).onConflict('instance_id').merge({ role, version, heartbeat_at: now, metadata: JSON.stringify(metadata) });
  }

  async setComputerDesiredState(ownerId: string, provider: string, desiredState: DesiredComputerState, now = Date.now()): Promise<number> {
    return this.knex.transaction(async trx => {
      const current = await trx('aira_computer_instances').where({ owner_id: ownerId }).forUpdate().first();
      const generation = n(current?.generation) + 1;
      const row = { owner_id: ownerId, provider, desired_state: desiredState, observed_state: current?.observed_state || 'UNKNOWN', provider_ref: current?.provider_ref || null, generation, observed_generation: n(current?.observed_generation), updated_at: now };
      await trx('aira_computer_instances').insert(row).onConflict('owner_id').merge(row);
      return generation;
    });
  }

  async recordComputerObservation(ownerId: string, generation: number, observedState: ObservedComputerState, providerRef?: string, error?: string, now = Date.now()): Promise<boolean> {
    const updated = await this.knex('aira_computer_instances').where({ owner_id: ownerId }).andWhere('generation', '>=', generation).andWhere('observed_generation', '<=', generation)
      .update({ observed_state: observedState, observed_generation: generation, provider_ref: providerRef || null, last_error: error?.slice(0, 4000) || null, last_reconciled_at: now, updated_at: now });
    return updated === 1;
  }

  async reconciliationBacklog(limit = 100): Promise<Array<{ ownerId: string; provider: string; desiredState: DesiredComputerState; observedState: ObservedComputerState; generation: number }>> {
    const rows = await this.knex('aira_computer_instances').whereRaw('generation > observed_generation OR desired_state <> observed_state').orderBy('updated_at', 'asc').limit(limit);
    return rows.map(row => ({ ownerId: row.owner_id, provider: row.provider, desiredState: row.desired_state, observedState: row.observed_state, generation: n(row.generation) }));
  }

  async readiness(now = Date.now(), heartbeatGraceMs = 90_000): Promise<{ ready: boolean; database: boolean; schedulerLeader: boolean; staleInstances: number; reconciliationBacklog: number; pendingOutbox: number }> {
    await this.knex.raw('SELECT 1');
    const stale = await this.knex('aira_runtime_instances').where('heartbeat_at', '<', now - heartbeatGraceMs).count<{ count: string }[]>('* as count');
    const leaders = await this.knex('aira_scheduler_leases').where('lease_until', '>', now).count<{ count: string }[]>('* as count');
    const backlog = await this.knex('aira_computer_instances').whereRaw('generation > observed_generation OR desired_state <> observed_state').count<{ count: string }[]>('* as count');
    const pending = await this.knex('aira_runtime_outbox').whereIn('status', ['PENDING', 'CLAIMED']).count<{ count: string }[]>('* as count');
    const staleInstances = n(stale[0]?.count); const reconciliationBacklog = n(backlog[0]?.count); const pendingOutbox = n(pending[0]?.count); const schedulerLeader = n(leaders[0]?.count) > 0;
    return { ready: staleInstances === 0, database: true, schedulerLeader, staleInstances, reconciliationBacklog, pendingOutbox };
  }

  private mapLease(row: any): DurableComputerLease {
    return { ownerId: row.owner_id, botId: row.bot_id, holderId: row.holder_id, mode: row.mode, token: row.token, fence: n(row.fence), acquiredAt: n(row.acquired_at), expiresAt: n(row.lease_until) };
  }
}

export const distributedRuntime = new DistributedRuntimeCoordinator();
