import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { db } from '../../db/src/index.js';

export interface RuntimeLease {
  name: string;
  owner: string;
  fence: number;
  leaseUntil: number;
}

export interface OutboxRecord {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  ownerId?: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'DELIVERED';
  attempts: number;
  availableAt: number;
  claimedBy?: string;
  claimedUntil?: number;
  deliveredAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface OutboxInput {
  topic: string;
  aggregateType: string;
  aggregateId: string;
  ownerId?: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
}

export function runtimeNodeId(prefix = 'runtime'): string {
  return process.env.AIRA_RUNTIME_NODE_ID?.trim() || `${prefix}:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

export async function insertOutbox(executor: any, input: OutboxInput): Promise<string> {
  const now = Date.now();
  const id = `out_${randomUUID()}`;
  const row = {
    id,
    topic: input.topic,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    owner_id: input.ownerId || null,
    payload: JSON.stringify(input.payload),
    dedupe_key: input.dedupeKey || null,
    status: 'PENDING',
    attempts: 0,
    available_at: now,
    created_at: now,
    updated_at: now
  };
  if (input.dedupeKey) {
    const inserted = await executor('aira_runtime_outbox').insert(row).onConflict('dedupe_key').ignore().returning('id');
    return inserted[0]?.id || id;
  }
  await executor('aira_runtime_outbox').insert(row);
  return id;
}

export class RuntimeLeaseRepository {
  async claimOrRenew(name: string, owner: string, ttlMs: number): Promise<RuntimeLease | undefined> {
    const now = Date.now();
    const until = now + Math.max(5_000, ttlMs);
    const result = await db.raw(
      `INSERT INTO aira_runtime_leases (name, owner, fence, lease_until, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         owner = EXCLUDED.owner,
         fence = CASE WHEN aira_runtime_leases.owner = EXCLUDED.owner THEN aira_runtime_leases.fence ELSE aira_runtime_leases.fence + 1 END,
         lease_until = EXCLUDED.lease_until,
         updated_at = EXCLUDED.updated_at
       WHERE aira_runtime_leases.owner = EXCLUDED.owner OR aira_runtime_leases.lease_until < ?
       RETURNING name, owner, fence, lease_until`,
      [name, owner, until, now, now, now]
    );
    const row = result.rows?.[0] || result[0]?.[0];
    return row ? { name: row.name, owner: row.owner, fence: Number(row.fence), leaseUntil: Number(row.lease_until) } : undefined;
  }

  async current(name: string): Promise<RuntimeLease | undefined> {
    const row = await db('aira_runtime_leases').where({ name }).andWhere('lease_until', '>=', Date.now()).first();
    return row ? { name: row.name, owner: row.owner, fence: Number(row.fence), leaseUntil: Number(row.lease_until) } : undefined;
  }

  async release(name: string, owner: string, fence: number): Promise<boolean> {
    return (await db('aira_runtime_leases').where({ name, owner, fence }).delete()) > 0;
  }
}

export class RuntimeOutboxRepository {
  async claimBatch(workerId: string, limit = 50, leaseMs = 30_000): Promise<OutboxRecord[]> {
    const now = Date.now();
    const until = now + Math.max(5_000, leaseMs);
    return db.transaction(async trx => {
      const rows = await trx('aira_runtime_outbox')
        .where({ status: 'PENDING' })
        .andWhere('available_at', '<=', now)
        .andWhere(builder => builder.whereNull('claimed_until').orWhere('claimed_until', '<', now))
        .orderBy('created_at', 'asc')
        .forUpdate()
        .skipLocked()
        .limit(Math.max(1, Math.min(limit, 500)));
      if (!rows.length) return [];
      const ids = rows.map(row => row.id);
      await trx('aira_runtime_outbox').whereIn('id', ids).update({
        claimed_by: workerId,
        claimed_until: until,
        attempts: trx.raw('attempts + 1'),
        updated_at: now
      });
      return rows.map(row => this.map({ ...row, claimed_by: workerId, claimed_until: until, attempts: Number(row.attempts || 0) + 1 }));
    });
  }

  async markDelivered(id: string, workerId: string): Promise<boolean> {
    const now = Date.now();
    return (await db('aira_runtime_outbox').where({ id, status: 'PENDING', claimed_by: workerId }).update({
      status: 'DELIVERED', delivered_at: now, claimed_by: null, claimed_until: null, last_error: null, updated_at: now
    })) > 0;
  }

  async markRetry(id: string, workerId: string, error: string, retryDelayMs = 5_000): Promise<boolean> {
    const now = Date.now();
    return (await db('aira_runtime_outbox').where({ id, status: 'PENDING', claimed_by: workerId }).update({
      available_at: now + Math.max(500, retryDelayMs), claimed_by: null, claimed_until: null,
      last_error: error.slice(0, 4000), updated_at: now
    })) > 0;
  }

  async health(): Promise<{ pending: number; oldestPendingAgeMs: number; failedAttempts: number }> {
    const now = Date.now();
    const summary = await db('aira_runtime_outbox').where({ status: 'PENDING' })
      .select(db.raw('COUNT(*)::bigint as pending'), db.raw('MIN(created_at) as oldest'), db.raw('COALESCE(SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END), 0)::bigint as retried'))
      .first();
    return {
      pending: Number(summary?.pending || 0),
      oldestPendingAgeMs: summary?.oldest ? Math.max(0, now - Number(summary.oldest)) : 0,
      failedAttempts: Number(summary?.retried || 0)
    };
  }

  private map(row: any): OutboxRecord {
    return {
      id: row.id,
      topic: row.topic,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      ownerId: row.owner_id || undefined,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      status: row.status,
      attempts: Number(row.attempts || 0),
      availableAt: Number(row.available_at),
      claimedBy: row.claimed_by || undefined,
      claimedUntil: row.claimed_until ? Number(row.claimed_until) : undefined,
      deliveredAt: row.delivered_at ? Number(row.delivered_at) : undefined,
      lastError: row.last_error || undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }
}

export class RuntimeOutboxDispatcher {
  private timer?: NodeJS.Timeout;
  private draining = false;
  readonly workerId: string;

  constructor(
    private readonly repo = new RuntimeOutboxRepository(),
    private readonly sink: (record: OutboxRecord) => Promise<void> = async record => {
      const payload = JSON.stringify({ id: record.id, topic: record.topic, aggregateType: record.aggregateType, aggregateId: record.aggregateId });
      await db.raw('SELECT pg_notify(?, ?)', ['aira_runtime_events', payload.slice(0, 7900)]);
    },
    workerId = runtimeNodeId('outbox')
  ) { this.workerId = workerId; }

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain().catch(error => console.error('[RuntimeOutboxDispatcher]', error)), Math.max(250, intervalMs));
    this.timer.unref?.();
    void this.drain().catch(error => console.error('[RuntimeOutboxDispatcher]', error));
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let delivered = 0;
    try {
      for (const record of await this.repo.claimBatch(this.workerId)) {
        try {
          await this.sink(record);
          if (await this.repo.markDelivered(record.id, this.workerId)) delivered++;
        } catch (error) {
          await this.repo.markRetry(record.id, this.workerId, (error as Error).message, Math.min(60_000, 1_000 * 2 ** Math.min(record.attempts, 6)));
        }
      }
      return delivered;
    } finally { this.draining = false; }
  }
}
