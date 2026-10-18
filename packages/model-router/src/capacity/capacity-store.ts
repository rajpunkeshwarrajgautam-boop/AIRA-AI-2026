import crypto from 'node:crypto';
import type { Knex } from 'knex';

export interface CapacityPermit {
  id: string;
  scope: 'global' | 'user';
  principalId: string;
  createdAt: number;
  expiresAt: number;
}

export interface AtomicAdmissionRequest {
  principalId: string;
  userMaxConcurrent: number;
  userRpmLimit: number;
  globalMaxConcurrent: number;
  globalRpmLimit: number;
  userWindowMs?: number;    // default 60000
  globalWindowMs?: number;  // default 60000
  permitTtlSeconds?: number;// default 30
}

export interface AtomicAdmissionResult {
  decision: 'ADMIT' | 'USER_CONCURRENCY_EXCEEDED' | 'USER_RPM_EXCEEDED' | 'GLOBAL_RPM_EXCEEDED' | 'GLOBAL_CONCURRENCY_EXCEEDED' | 'STORE_UNAVAILABLE';
  userPermitId?: string;
  globalPermitId?: string;
  currentCounts: {
    userConcurrent: number;
    globalConcurrent: number;
    userRpm: number;
    globalRpm: number;
  };
  resetMs: {
    userRpm: number;
    globalRpm: number;
  };
  telemetry?: {
    dbRoundTrips: number;
    transactionMs: number;
    lockWaitMs?: number;
  };
}

export function generateAdvisoryLockKey(prefix: 'rpm' | 'permit', identifier: string): string {
  // P1.6.5: Stable 64-bit signed BigInt key to eliminate 32-bit hashtext lock collision risk
  const hash = crypto.createHash('sha256').update(`aira:cap:${prefix}:${identifier}`).digest();
  return hash.readBigInt64BE(0).toString();
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

  releasePermits?(permitIds: string[]): Promise<void>;

  atomicAdmit?(req: AtomicAdmissionRequest): Promise<AtomicAdmissionResult>;

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

  public async releasePermits(permitIds: string[]): Promise<void> {
    for (const id of permitIds) {
      this.permits.delete(id);
    }
  }

  public async atomicAdmit(
    req: AtomicAdmissionRequest
  ): Promise<AtomicAdmissionResult> {
    const now = Date.now();
    this.prunePermits(now);

    const {
      principalId,
      userMaxConcurrent,
      userRpmLimit,
      globalMaxConcurrent,
      globalRpmLimit,
      userWindowMs = 60000,
      globalWindowMs = 60000,
      permitTtlSeconds = 30
    } = req;

    let userConcurrent = 0;
    let globalConcurrent = 0;
    for (const permit of this.permits.values()) {
      if (permit.scope === 'user' && permit.principalId === principalId) {
        userConcurrent++;
      }
      if (permit.scope === 'global') {
        globalConcurrent++;
      }
    }

    const userKey = `user:${principalId}`;
    const userWindowStart = now - userWindowMs;
    let userTimestamps = (this.rpmLogs.get(userKey) || []).filter(t => t > userWindowStart);
    const userRpm = userTimestamps.length;
    const userOldestTs = userTimestamps[0] ?? now;
    const userResetMs = userRpm >= userRpmLimit ? Math.max(0, (userOldestTs + userWindowMs) - now) : 0;

    const globalKey = 'global';
    const globalWindowStart = now - globalWindowMs;
    let globalTimestamps = (this.rpmLogs.get(globalKey) || []).filter(t => t > globalWindowStart);
    const globalRpm = globalTimestamps.length;
    const globalOldestTs = globalTimestamps[0] ?? now;
    const globalResetMs = globalRpm >= globalRpmLimit ? Math.max(0, (globalOldestTs + globalWindowMs) - now) : 0;

    const currentCounts = {
      userConcurrent,
      globalConcurrent,
      userRpm,
      globalRpm
    };
    const resetMs = {
      userRpm: userResetMs,
      globalRpm: globalResetMs
    };

    if (userConcurrent >= userMaxConcurrent) {
      return { decision: 'USER_CONCURRENCY_EXCEEDED', currentCounts, resetMs };
    }
    if (userRpm >= userRpmLimit) {
      return { decision: 'USER_RPM_EXCEEDED', currentCounts, resetMs };
    }
    if (globalRpm >= globalRpmLimit) {
      return { decision: 'GLOBAL_RPM_EXCEEDED', currentCounts, resetMs };
    }
    if (globalConcurrent >= globalMaxConcurrent) {
      return { decision: 'GLOBAL_CONCURRENCY_EXCEEDED', currentCounts, resetMs };
    }

    const userPermitId = `pmt_u_${crypto.randomUUID().slice(0, 10)}`;
    const globalPermitId = `pmt_g_${crypto.randomUUID().slice(0, 10)}`;
    const expiresAt = now + permitTtlSeconds * 1000;

    this.permits.set(userPermitId, {
      id: userPermitId,
      scope: 'user',
      principalId,
      createdAt: now,
      expiresAt
    });
    this.permits.set(globalPermitId, {
      id: globalPermitId,
      scope: 'global',
      principalId,
      createdAt: now,
      expiresAt
    });

    userTimestamps.push(now);
    this.rpmLogs.set(userKey, userTimestamps);

    globalTimestamps.push(now);
    this.rpmLogs.set(globalKey, globalTimestamps);

    return {
      decision: 'ADMIT',
      userPermitId,
      globalPermitId,
      currentCounts: {
        userConcurrent: userConcurrent + 1,
        globalConcurrent: globalConcurrent + 1,
        userRpm: userRpm + 1,
        globalRpm: globalRpm + 1
      },
      resetMs: { userRpm: 0, globalRpm: 0 },
      telemetry: {
        dbRoundTrips: 0,
        transactionMs: 0,
        lockWaitMs: 0
      }
    };
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

      if (typeof this.client.transaction === 'function') {
        return await this.client.transaction(async (trx) => {
          const lockKey = `permit_${scope}_${scope === 'global' ? 'global' : principalId}`;
          try {
            await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [lockKey]);
          } catch {
            // Non-postgres fallback
          }

          await trx('capacity_permits').where('expires_at', '<=', now).delete();

          let countQuery = trx('capacity_permits')
            .where('scope', scope)
            .where('expires_at', '>', now);
          if (scope === 'user') {
            countQuery = countQuery.where('principal_id', principalId);
          }
          const countRes = await countQuery.count();
          const row = Array.isArray(countRes) ? countRes[0] : countRes;
          const activeCount = Number((row && (row.count ?? row['count(*)'])) || 0);

          if (activeCount >= maxConcurrent) {
            return { acquired: false, currentActive: activeCount };
          }

          await trx('capacity_permits').insert({
            id: permitId,
            scope,
            principal_id: principalId,
            created_at: now,
            expires_at: expiresAt
          });

          return { acquired: true, currentActive: activeCount + 1, permitId };
        });
      }

      // Fallback for non-transactional mock environments
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

  public async releasePermits(permitIds: string[]): Promise<void> {
    if (!permitIds || permitIds.length === 0) return;
    try {
      await this.client('capacity_permits').whereIn('id', permitIds).delete();
    } catch (err) {
      console.warn('[DistributedPostgresCapacityStore] Error releasing permits:', err);
    }
  }

  public async atomicAdmit(
    req: AtomicAdmissionRequest
  ): Promise<AtomicAdmissionResult> {
    const tStart = performance.now();
    try {
      const ready = await this.verifySchema();
      if (!ready) {
        return {
          decision: 'STORE_UNAVAILABLE',
          currentCounts: { userConcurrent: req.userMaxConcurrent, globalConcurrent: req.globalMaxConcurrent, userRpm: req.userRpmLimit, globalRpm: req.globalRpmLimit },
          resetMs: { userRpm: 8000, globalRpm: 8000 }
        };
      }

      const {
        principalId,
        userMaxConcurrent,
        userRpmLimit,
        globalMaxConcurrent,
        globalRpmLimit,
        userWindowMs = 60000,
        globalWindowMs = 60000,
        permitTtlSeconds = 30
      } = req;

      const now = Date.now();
      const expiresAt = now + permitTtlSeconds * 1000;
      const userWindowStart = now - userWindowMs;
      const globalWindowStart = now - globalWindowMs;
      const minWindowStart = Math.min(userWindowStart, globalWindowStart);

      const userPermitId = `pmt_u_${crypto.randomUUID().slice(0, 10)}`;
      const globalPermitId = `pmt_g_${crypto.randomUUID().slice(0, 10)}`;
      const userLogId = `log_u_${crypto.randomUUID().slice(0, 10)}`;
      const globalLogId = `log_g_${crypto.randomUUID().slice(0, 10)}`;

      // Deterministic 64-bit advisory lock keys (Section 7 & 8)
      const lockGlobalRpm = generateAdvisoryLockKey('rpm', 'global');
      const lockGlobalPermit = generateAdvisoryLockKey('permit', 'global');
      const lockUserRpm = generateAdvisoryLockKey('rpm', principalId);
      const lockUserPermit = generateAdvisoryLockKey('permit', principalId);

      const bindings = [
        now, // 1: prune_permits expires_at <= ?
        minWindowStart, // 2: prune_rpm timestamp <= ?
        principalId, // 3: user_concurrent principal_id = ?
        now, // 4: user_concurrent expires_at > ?
        now, // 5: global_concurrent expires_at > ?
        principalId, // 6: user_rpm principal_id = ?
        userWindowStart, // 7: user_rpm timestamp > ?
        principalId, // 8: user_oldest_ts principal_id = ?
        userWindowStart, // 9: user_oldest_ts timestamp > ?
        globalWindowStart, // 10: global_rpm timestamp > ?
        globalWindowStart, // 11: global_oldest_ts timestamp > ?
        userMaxConcurrent, // 12: user_concurrent >= ?
        userRpmLimit, // 13: user_rpm >= ?
        globalRpmLimit, // 14: global_rpm >= ?
        globalMaxConcurrent, // 15: global_concurrent >= ?
        userPermitId, // 16: user permit id
        principalId, // 17: user permit principal_id
        now, // 18: user permit created_at
        expiresAt, // 19: user permit expires_at
        globalPermitId, // 20: global permit id
        principalId, // 21: global permit principal_id
        now, // 22: global permit created_at
        expiresAt, // 23: global permit expires_at
        userLogId, // 24: user log id
        principalId, // 25: user log principal_id
        now, // 26: user log timestamp
        globalLogId, // 27: global log id
        now // 28: global log timestamp
      ];

      const atomicCteSql = `
        WITH prune_permits AS (
          DELETE FROM capacity_permits WHERE expires_at <= ?::bigint
        ),
        prune_rpm AS (
          DELETE FROM capacity_rate_log WHERE timestamp <= ?::bigint
        ),
        counts AS (
          SELECT
            (SELECT COUNT(*)::int FROM capacity_permits WHERE scope = 'user' AND principal_id = ? AND expires_at > ?::bigint) as user_concurrent,
            (SELECT COUNT(*)::int FROM capacity_permits WHERE scope = 'global' AND expires_at > ?::bigint) as global_concurrent,
            (SELECT COUNT(*)::int FROM capacity_rate_log WHERE scope = 'user' AND principal_id = ? AND timestamp > ?::bigint) as user_rpm,
            (SELECT MIN(timestamp) FROM capacity_rate_log WHERE scope = 'user' AND principal_id = ? AND timestamp > ?::bigint) as user_oldest_ts,
            (SELECT COUNT(*)::int FROM capacity_rate_log WHERE scope = 'global' AND timestamp > ?::bigint) as global_rpm,
            (SELECT MIN(timestamp) FROM capacity_rate_log WHERE scope = 'global' AND timestamp > ?::bigint) as global_oldest_ts
        ),
        decision AS (
          SELECT
            user_concurrent,
            global_concurrent,
            user_rpm,
            user_oldest_ts,
            global_rpm,
            global_oldest_ts,
            CASE
              WHEN user_concurrent >= ?::int THEN 'USER_CONCURRENCY_EXCEEDED'
              WHEN user_rpm >= ?::int THEN 'USER_RPM_EXCEEDED'
              WHEN global_rpm >= ?::int THEN 'GLOBAL_RPM_EXCEEDED'
              WHEN global_concurrent >= ?::int THEN 'GLOBAL_CONCURRENCY_EXCEEDED'
              ELSE 'ADMIT'
            END as status
          FROM counts
        ),
        insert_permits AS (
          INSERT INTO capacity_permits (id, scope, principal_id, created_at, expires_at)
          SELECT p.id, p.scope, p.principal_id, p.created_at, p.expires_at
          FROM (
            VALUES
              (?::text, 'user', ?::text, ?::bigint, ?::bigint),
              (?::text, 'global', ?::text, ?::bigint, ?::bigint)
          ) AS p(id, scope, principal_id, created_at, expires_at)
          WHERE (SELECT status FROM decision) = 'ADMIT'
          RETURNING id
        ),
        insert_rpm AS (
          INSERT INTO capacity_rate_log (id, scope, principal_id, timestamp)
          SELECT r.id, r.scope, r.principal_id, r.timestamp
          FROM (
            VALUES
              (?::text, 'user', ?::text, ?::bigint),
              (?::text, 'global', 'system', ?::bigint)
          ) AS r(id, scope, principal_id, timestamp)
          WHERE (SELECT status FROM decision) = 'ADMIT'
          RETURNING id
        )
        SELECT 
          d.status,
          d.user_concurrent,
          d.global_concurrent,
          d.user_rpm,
          d.user_oldest_ts,
          d.global_rpm,
          d.global_oldest_ts,
          (SELECT COUNT(*)::int FROM insert_permits) as permits_inserted
        FROM decision d;
      `;

      let row: any = null;
      let lockWaitMs = 0;
      let dbRoundTrips = 1;

      if (typeof this.client.transaction === 'function') {
        const trxRes = await this.client.transaction(async (trx) => {
          const tLockStart = performance.now();
          try {
            await trx.raw(`
              SELECT 
                pg_advisory_xact_lock(?::bigint),
                pg_advisory_xact_lock(?::bigint),
                pg_advisory_xact_lock(?::bigint),
                pg_advisory_xact_lock(?::bigint)
            `, [lockGlobalRpm, lockGlobalPermit, lockUserRpm, lockUserPermit]);
          } catch {
            // Non-postgres fallback
          }
          lockWaitMs = Math.round(performance.now() - tLockStart);

          const res = await trx.raw(atomicCteSql, bindings);
          return res?.rows ? res.rows[0] : (Array.isArray(res) ? res[0] : null);
        });
        row = trxRes;
        dbRoundTrips = 1;
      } else {
        const res = await this.client.raw(atomicCteSql, bindings);
        row = res?.rows ? res.rows[0] : (Array.isArray(res) ? res[0] : null);
      }

      const totalTransactionMs = Math.round(performance.now() - tStart);
      const status = row?.status || 'STORE_UNAVAILABLE';
      const userConcurrent = Number(row?.user_concurrent || 0);
      const globalConcurrent = Number(row?.global_concurrent || 0);
      const userRpm = Number(row?.user_rpm || 0);
      const globalRpm = Number(row?.global_rpm || 0);
      const userOldestTs = row?.user_oldest_ts ? Number(row.user_oldest_ts) : now;
      const globalOldestTs = row?.global_oldest_ts ? Number(row.global_oldest_ts) : now;

      const userResetMs = userRpm >= userRpmLimit ? Math.max(0, (userOldestTs + userWindowMs) - now) : 0;
      const globalResetMs = globalRpm >= globalRpmLimit ? Math.max(0, (globalOldestTs + globalWindowMs) - now) : 0;

      if (status === 'ADMIT') {
        return {
          decision: 'ADMIT',
          userPermitId,
          globalPermitId,
          currentCounts: {
            userConcurrent: userConcurrent + 1,
            globalConcurrent: globalConcurrent + 1,
            userRpm: userRpm + 1,
            globalRpm: globalRpm + 1
          },
          resetMs: { userRpm: 0, globalRpm: 0 },
          telemetry: {
            dbRoundTrips,
            transactionMs: totalTransactionMs,
            lockWaitMs
          }
        };
      }

      return {
        decision: status as any,
        currentCounts: {
          userConcurrent,
          globalConcurrent,
          userRpm,
          globalRpm
        },
        resetMs: {
          userRpm: userResetMs,
          globalRpm: globalResetMs
        },
        telemetry: {
          dbRoundTrips,
          transactionMs: totalTransactionMs,
          lockWaitMs
        }
      };
    } catch (err) {
      console.error('[DistributedPostgresCapacityStore] Error during atomic admission, failing conservatively:', err);
      return {
        decision: 'STORE_UNAVAILABLE',
        currentCounts: {
          userConcurrent: req.userMaxConcurrent,
          globalConcurrent: req.globalMaxConcurrent,
          userRpm: req.userRpmLimit,
          globalRpm: req.globalRpmLimit
        },
        resetMs: { userRpm: 8000, globalRpm: 8000 },
        telemetry: {
          dbRoundTrips: 1,
          transactionMs: Math.round(performance.now() - tStart),
          lockWaitMs: 0
        }
      };
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

      if (typeof this.client.transaction === 'function') {
        return await this.client.transaction(async (trx) => {
          const lockKey = `rpm_${scope}_${scope === 'global' ? 'global' : principalId}`;
          try {
            await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [lockKey]);
          } catch {
            // Non-postgres fallback
          }

          await trx('capacity_rate_log').where('timestamp', '<=', windowStart).delete();

          let countQuery = trx('capacity_rate_log')
            .where('scope', scope)
            .where('timestamp', '>', windowStart);
          if (scope === 'user') {
            countQuery = countQuery.where('principal_id', principalId);
          }
          const countRes = await countQuery
            .select(trx.raw ? trx.raw('COUNT(id) as count, MIN(timestamp) as oldest_ts') : 'id');
          const row = Array.isArray(countRes) ? countRes[0] : countRes;
          const priorCount = Number(row?.count || (Array.isArray(countRes) ? countRes.length : 0));
          const oldestTs = row?.oldest_ts ? Number(row.oldest_ts) : now;

          if (priorCount >= limitRpm) {
            const resetMs = Math.max(0, (oldestTs + windowMs) - now);
            return { allowed: false, currentRpm: priorCount, resetMs };
          }

          await trx('capacity_rate_log').insert({
            id: logId,
            scope,
            principal_id: principalId,
            timestamp: now
          });

          return { allowed: true, currentRpm: priorCount + 1, resetMs: 0 };
        });
      }

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
