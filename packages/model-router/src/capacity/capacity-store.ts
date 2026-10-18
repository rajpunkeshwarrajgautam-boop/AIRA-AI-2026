import crypto from 'node:crypto';
import type { Knex } from 'knex';

export interface CapacityPermit {
  id: string;
  scope: 'global' | 'user';
  principalId: string;
  createdAt: number;
  expiresAt: number;
}

export interface CapacityStore {
  isAvailable?(): Promise<boolean>;

  acquirePermit(
    scope: 'global' | 'user',
    principalId: string,
    maxConcurrent: number,
    ttlSeconds?: number
  ): Promise<{ acquired: boolean; currentActive: number; permitId?: string }>;

  releasePermit(permitId: string): Promise<void>;

  recordAndCheckRpm(
    scope: 'global' | 'user',
    principalId: string,
    limitRpm: number,
    windowMs?: number
  ): Promise<{ allowed: boolean; currentRpm: number; resetMs: number }>;

  getActiveConcurrency(scope: 'global' | 'user', principalId?: string): Promise<number>;

  getCurrentRpm(scope: 'global' | 'user', principalId?: string, windowMs?: number): Promise<number>;

  reset(): Promise<void>;
}

export class InMemoryCapacityStore implements CapacityStore {
  private permits: Map<string, CapacityPermit> = new Map();
  private rpmLogs: Map<string, number[]> = new Map();

  public async isAvailable(): Promise<boolean> {
    return true;
  }

  private prunePermits(now = Date.now()): void {
    for (const [id, permit] of this.permits.entries()) {
      if (permit.expiresAt <= now) {
        this.permits.delete(id);
      }
    }
  }

  public async acquirePermit(
    scope: 'global' | 'user',
    principalId: string,
    maxConcurrent: number,
    ttlSeconds = 30
  ): Promise<{ acquired: boolean; currentActive: number; permitId?: string }> {
    const now = Date.now();
    this.prunePermits(now);

    let activeCount = 0;
    for (const permit of this.permits.values()) {
      if (scope === 'global' && permit.scope === 'global') {
        activeCount++;
      } else if (scope === 'user' && permit.scope === 'user' && permit.principalId === principalId) {
        activeCount++;
      }
    }

    if (activeCount >= maxConcurrent) {
      return { acquired: false, currentActive: activeCount };
    }

    const permitId = `pmt_${crypto.randomUUID().slice(0, 12)}`;
    const expiresAt = now + ttlSeconds * 1000;
    this.permits.set(permitId, {
      id: permitId,
      scope,
      principalId,
      createdAt: now,
      expiresAt
    });

    return { acquired: true, currentActive: activeCount + 1, permitId };
  }

  public async releasePermit(permitId: string): Promise<void> {
    this.permits.delete(permitId);
  }

  public async recordAndCheckRpm(
    scope: 'global' | 'user',
    principalId: string,
    limitRpm: number,
    windowMs = 60000
  ): Promise<{ allowed: boolean; currentRpm: number; resetMs: number }> {
    const now = Date.now();
    const key = scope === 'global' ? 'global' : `user:${principalId}`;
    const windowStart = now - windowMs;

    let timestamps = this.rpmLogs.get(key) || [];
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= limitRpm) {
      const oldest = timestamps[0];
      const resetMs = Math.max(0, (oldest + windowMs) - now);
      this.rpmLogs.set(key, timestamps);
      return { allowed: false, currentRpm: timestamps.length, resetMs };
    }

    timestamps.push(now);
    this.rpmLogs.set(key, timestamps);
    return { allowed: true, currentRpm: timestamps.length, resetMs: 0 };
  }

  public async getActiveConcurrency(scope: 'global' | 'user', principalId?: string): Promise<number> {
    this.prunePermits();
    let count = 0;
    for (const permit of this.permits.values()) {
      if (scope === 'global' && permit.scope === 'global') {
        count++;
      } else if (scope === 'user' && permit.scope === 'user' && (!principalId || permit.principalId === principalId)) {
        count++;
      }
    }
    return count;
  }

  public async getCurrentRpm(scope: 'global' | 'user', principalId?: string, windowMs = 60000): Promise<number> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const key = scope === 'global' ? 'global' : `user:${principalId}`;
    const timestamps = (this.rpmLogs.get(key) || []).filter(t => t > windowStart);
    return timestamps.length;
  }

  public async reset(): Promise<void> {
    this.permits.clear();
    this.rpmLogs.clear();
  }
}

export class DistributedPostgresCapacityStore implements CapacityStore {
  private client: Knex;
  private schemaVerified = false;
  private verifyPromise: Promise<boolean> | null = null;

  constructor(client: Knex) {
    this.client = client;
  }

  public async isAvailable(): Promise<boolean> {
    return this.verifySchema();
  }

  public async verifySchema(): Promise<boolean> {
    if (this.schemaVerified) return true;
    if (this.verifyPromise) return this.verifyPromise;

    this.verifyPromise = (async () => {
      try {
        const hasPermits = await this.client.schema.hasTable('capacity_permits');
        const hasRateLog = await this.client.schema.hasTable('capacity_rate_log');
        if (hasPermits && hasRateLog) {
          this.schemaVerified = true;
          return true;
        }
        console.error('[DistributedPostgresCapacityStore] Schema verification failed: capacity_permits or capacity_rate_log missing. Execute migration 019_capacity_guard_schema.');
        this.schemaVerified = false;
        return false;
      } catch (err) {
        console.error('[DistributedPostgresCapacityStore] Error verifying schema readiness:', err);
        this.schemaVerified = false;
        return false;
      } finally {
        this.verifyPromise = null;
      }
    })();

    return this.verifyPromise;
  }

  public async acquirePermit(
    scope: 'global' | 'user',
    principalId: string,
    maxConcurrent: number,
    ttlSeconds = 30
  ): Promise<{ acquired: boolean; currentActive: number; permitId?: string }> {
    try {
      const ready = await this.verifySchema();
      if (!ready) {
        return { acquired: false, currentActive: maxConcurrent };
      }
      const now = Date.now();
      const expiresAt = now + ttlSeconds * 1000;
      const permitId = `pmt_${crypto.randomUUID().slice(0, 12)}`;

      // Atomic acquire with single round-trip: prune expired and insert only if count < maxConcurrent
      const result = await this.client.raw(`
        WITH cleanup AS (
          DELETE FROM capacity_permits WHERE expires_at <= ?
        ),
        active_check AS (
          SELECT COUNT(*) as current_count
          FROM capacity_permits
          WHERE scope = ? AND (? = 'global' OR principal_id = ?) AND expires_at > ?
        ),
        inserted AS (
          INSERT INTO capacity_permits (id, scope, principal_id, created_at, expires_at)
          SELECT ?, ?, ?, ?, ?
          WHERE (SELECT current_count FROM active_check) < ?
          RETURNING id
        )
        SELECT 
          (SELECT current_count FROM active_check) as prior_count,
          (SELECT id FROM inserted) as inserted_id;
      `, [
        now,
        scope,
        scope,
        principalId,
        now,
        permitId,
        scope,
        principalId,
        now,
        expiresAt,
        maxConcurrent
      ]);

      const row = result.rows ? result.rows[0] : (Array.isArray(result) ? result[0] : null);
      const insertedId = row?.inserted_id;
      const priorCount = Number(row?.prior_count || 0);

      if (insertedId) {
        return { acquired: true, currentActive: priorCount + 1, permitId: insertedId };
      }
      return { acquired: false, currentActive: priorCount };
    } catch (err) {
      // Conservative fail-closed on storage failure (Section 23)
      console.error('[DistributedPostgresCapacityStore] Error acquiring permit, failing conservatively:', err);
      return { acquired: false, currentActive: maxConcurrent };
    }
  }

  public async releasePermit(permitId: string): Promise<void> {
    try {
      await this.client('capacity_permits').where({ id: permitId }).delete();
    } catch (err) {
      console.warn('[DistributedPostgresCapacityStore] Error releasing permit:', err);
    }
  }

  public async recordAndCheckRpm(
    scope: 'global' | 'user',
    principalId: string,
    limitRpm: number,
    windowMs = 60000
  ): Promise<{ allowed: boolean; currentRpm: number; resetMs: number }> {
    try {
      const ready = await this.verifySchema();
      if (!ready) {
        return { allowed: false, currentRpm: limitRpm, resetMs: 8000 };
      }
      const now = Date.now();
      const windowStart = now - windowMs;
      const logId = `log_${crypto.randomUUID().slice(0, 12)}`;

      const result = await this.client.raw(`
        WITH cleanup AS (
          DELETE FROM capacity_rate_log WHERE timestamp <= ?
        ),
        active_check AS (
          SELECT COUNT(*) as current_count, MIN(timestamp) as oldest_ts
          FROM capacity_rate_log
          WHERE scope = ? AND (? = 'global' OR principal_id = ?) AND timestamp > ?
        ),
        inserted AS (
          INSERT INTO capacity_rate_log (id, scope, principal_id, timestamp)
          SELECT ?, ?, ?, ?
          WHERE (SELECT current_count FROM active_check) < ?
          RETURNING id
        )
        SELECT 
          (SELECT current_count FROM active_check) as prior_count,
          (SELECT oldest_ts FROM active_check) as oldest_ts,
          (SELECT id FROM inserted) as inserted_id;
      `, [
        windowStart,
        scope,
        scope,
        principalId,
        windowStart,
        logId,
        scope,
        principalId,
        now,
        limitRpm
      ]);

      const row = result.rows ? result.rows[0] : (Array.isArray(result) ? result[0] : null);
      const insertedId = row?.inserted_id;
      const priorCount = Number(row?.prior_count || 0);
      const oldestTs = row?.oldest_ts ? Number(row.oldest_ts) : now;

      if (insertedId) {
        return { allowed: true, currentRpm: priorCount + 1, resetMs: 0 };
      }

      const resetMs = Math.max(0, (oldestTs + windowMs) - now);
      return { allowed: false, currentRpm: priorCount, resetMs };
    } catch (err) {
      console.error('[DistributedPostgresCapacityStore] Error checking RPM, failing conservatively:', err);
      return { allowed: false, currentRpm: limitRpm, resetMs: 8000 };
    }
  }

  public async getActiveConcurrency(scope: 'global' | 'user', principalId?: string): Promise<number> {
    try {
      const ready = await this.verifySchema();
      if (!ready) return 0;
      const now = Date.now();
      let query = this.client('capacity_permits')
        .where('expires_at', '>', now)
        .where('scope', scope);
      if (scope === 'user' && principalId) {
        query = query.where('principal_id', principalId);
      }
      const countRes = await query.count('id as count').first();
      return Number(countRes?.count || 0);
    } catch (err) {
      console.warn('[DistributedPostgresCapacityStore] Error getting active concurrency:', err);
      return 0;
    }
  }

  public async getCurrentRpm(scope: 'global' | 'user', principalId?: string, windowMs = 60000): Promise<number> {
    try {
      const ready = await this.verifySchema();
      if (!ready) return 0;
      const windowStart = Date.now() - windowMs;
      let query = this.client('capacity_rate_log')
        .where('timestamp', '>', windowStart)
        .where('scope', scope);
      if (scope === 'user' && principalId) {
        query = query.where('principal_id', principalId);
      }
      const countRes = await query.count('id as count').first();
      return Number(countRes?.count || 0);
    } catch (err) {
      console.warn('[DistributedPostgresCapacityStore] Error getting current RPM:', err);
      return 0;
    }
  }

  public async reset(): Promise<void> {
    try {
      const ready = await this.verifySchema();
      if (!ready) return;
      await this.client('capacity_permits').delete();
      await this.client('capacity_rate_log').delete();
    } catch {
      // Ignored during testing/reset
    }
  }
}
