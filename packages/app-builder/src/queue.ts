import { randomUUID } from 'node:crypto';
import { db } from '../../db/src/index.js';

export type BuildQueueState = 'QUEUED' | 'LEASED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'BLOCKED';
export interface QueuedBuild {
  id: string;
  ownerId: string;
  projectId?: string;
  objective: string;
  state: BuildQueueState;
  attempts: number;
  generation: number;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  cancelRequested: boolean;
  result?: Record<string, unknown>;
}
type Row = {
  id: string; owner_id: string; project_id: string | null; objective: string;
  state: BuildQueueState; attempts: number; fencing_generation: number;
  lease_owner: string | null; lease_expires_at: Date | null; cancel_requested: boolean;
  result: Record<string, unknown> | null;
};
const table = 'aira_app_build_jobs';
const map = (r: Row): QueuedBuild => ({
  id: r.id, ownerId: r.owner_id, projectId: r.project_id || undefined,
  objective: r.objective, state: r.state, attempts: Number(r.attempts),
  generation: Number(r.fencing_generation), leaseOwner: r.lease_owner || undefined,
  leaseExpiresAt: r.lease_expires_at || undefined,
  cancelRequested: Boolean(r.cancel_requested), result: r.result || undefined
});
function assertIdentifier(value: string, name: string): void {
  if (!/^[a-zA-Z0-9_:.-]{1,160}$/.test(value)) throw new Error('INVALID_' + name);
}
function assertLeaseMs(ms: number): void {
  if (!Number.isInteger(ms) || ms < 1_000 || ms > 120_000) throw new Error('INVALID_LEASE_TTL');
}

/**
 * Durable, fenced and principal-scoped queue operations. The queue is a control
 * plane primitive only: project source and sandbox execution are NOT stored here.
 */
export class PostgresApplicationBuildQueue {
  async enqueue(ownerId: string, objective: string, idempotencyKey: string, projectId?: string): Promise<QueuedBuild> {
    assertIdentifier(ownerId, 'OWNER');
    assertIdentifier(idempotencyKey, 'IDEMPOTENCY_KEY');
    if (projectId) assertIdentifier(projectId, 'PROJECT');
    if (!objective.trim() || objective.length > 8_000) throw new Error('INVALID_OBJECTIVE');
    return db.transaction(async trx => {
      await trx(table).insert({
        id: randomUUID(), owner_id: ownerId, project_id: projectId || null,
        objective, idempotency_key: idempotencyKey, state: 'QUEUED'
      }).onConflict(['owner_id', 'idempotency_key']).ignore();
      const row = await trx<Row>(table).where({ owner_id: ownerId, idempotency_key: idempotencyKey }).first();
      if (!row) throw new Error('BUILD_QUEUE_INSERT_FAILED');
      if (row.objective !== objective || row.project_id !== (projectId || null)) {
        throw new Error('IDEMPOTENCY_KEY_CONFLICT');
      }
      return map(row);
    });
  }
  async get(id: string, ownerId: string): Promise<QueuedBuild | undefined> {
    assertIdentifier(ownerId, 'OWNER');
    const row = await db<Row>(table).where({ id, owner_id: ownerId }).first();
    return row ? map(row) : undefined;
  }
  async claim(workerId: string, leaseMs: number): Promise<QueuedBuild | undefined> {
    assertIdentifier(workerId, 'WORKER');
    assertLeaseMs(leaseMs);
    return db.transaction(async trx => {
      const selected = await trx<Row>(table)
        .where({ state: 'QUEUED', cancel_requested: false })
        .orderBy('created_at', 'asc').orderBy('id', 'asc')
        .forUpdate().skipLocked().first();
      if (!selected) return undefined;
      const [row] = await trx<Row>(table).where({ id: selected.id }).update({
        state: 'LEASED', lease_owner: workerId,
        lease_expires_at: trx.raw("NOW() + (? * INTERVAL '1 millisecond')", [leaseMs]),
        fencing_generation: trx.raw('fencing_generation + 1'),
        attempts: trx.raw('attempts + 1'), updated_at: trx.fn.now()
      }).returning('*');
      return map(row);
    });
  }
  private leaseQuery(id: string, workerId: string, generation: number) {
    assertIdentifier(workerId, 'WORKER');
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('INVALID_FENCE');
    return db(table).where({ id, lease_owner: workerId, fencing_generation: generation })
      .whereIn('state', ['LEASED', 'RUNNING'])
      .where('cancel_requested', false)
      .where('lease_expires_at', '>', db.fn.now());
  }
  async start(id: string, workerId: string, generation: number): Promise<boolean> {
    const updated = await this.leaseQuery(id, workerId, generation)
      .where({ state: 'LEASED' }).update({ state: 'RUNNING', updated_at: db.fn.now() });
    return updated === 1;
  }
  async heartbeat(id: string, workerId: string, generation: number, leaseMs: number): Promise<boolean> {
    assertLeaseMs(leaseMs);
    const updated = await this.leaseQuery(id, workerId, generation).update({
      lease_expires_at: db.raw("NOW() + (? * INTERVAL '1 millisecond')", [leaseMs]),
      updated_at: db.fn.now()
    });
    return updated === 1;
  }
  async finish(id: string, workerId: string, generation: number,
    state: 'COMPLETED' | 'FAILED', result: Record<string, unknown>): Promise<boolean> {
    const updated = await this.leaseQuery(id, workerId, generation).update({
      state, result: JSON.stringify(result), lease_owner: null, lease_expires_at: null,
      updated_at: db.fn.now()
    });
    return updated === 1;
  }
  async requestCancellation(id: string, ownerId: string): Promise<QueuedBuild | undefined> {
    assertIdentifier(ownerId, 'OWNER');
    return db.transaction(async trx => {
      const row = await trx<Row>(table).where({ id, owner_id: ownerId }).forUpdate().first();
      if (!row) return undefined;
      if (row.state === 'QUEUED') {
        await trx(table).where({ id }).update({
          state: 'CANCELLED', cancel_requested: true, updated_at: trx.fn.now()
        });
      } else if (row.state === 'LEASED' || row.state === 'RUNNING') {
        await trx(table).where({ id }).update({ cancel_requested: true, updated_at: trx.fn.now() });
      }
      const updated = await trx<Row>(table).where({ id }).first();
      return map(updated!);
    });
  }
  async acknowledgeCancellation(id: string, workerId: string, generation: number): Promise<boolean> {
    assertIdentifier(workerId, 'WORKER');
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('INVALID_FENCE');
    const updated = await db(table).where({
      id, lease_owner: workerId, fencing_generation: generation, cancel_requested: true
    }).whereIn('state', ['LEASED', 'RUNNING']).update({
      state: 'CANCELLED', lease_owner: null, lease_expires_at: null, updated_at: db.fn.now()
    });
    return updated === 1;
  }
  async recoverExpired(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('INVALID_RECOVERY_LIMIT');
    return db.transaction(async trx => {
      const rows = await trx<Row>(table).whereIn('state', ['LEASED', 'RUNNING'])
        .where('lease_expires_at', '<=', trx.fn.now())
        .orderBy('lease_expires_at').limit(limit).forUpdate().skipLocked();
      for (const row of rows) {
        // Prevent unlimited replay of an interrupted job. The old worker may
        // still be tearing down its container; fencing invalidates its commit.
        const exhausted = Number(row.attempts) >= 3;
        await trx(table).where({ id: row.id }).update({
          state: row.cancel_requested ? 'CANCELLED' : exhausted ? 'FAILED' : 'QUEUED',
          result: exhausted && !row.cancel_requested
            ? JSON.stringify({ error: 'BUILD_LEASE_RETRY_LIMIT_EXCEEDED' }) : row.result,
          lease_owner: null, lease_expires_at: null, updated_at: trx.fn.now()
        });
      }
      return rows.length;
    });
  }
}
