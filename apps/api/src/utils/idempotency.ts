import crypto from 'node:crypto';
import { db } from '../../../../packages/db/src/index.js';

export interface IdempotencyRecord {
  key: string;
  principal_id: string;
  operation_id: string;
  operation_type: string;
  payload_hash: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_status: number;
  response_body: string;
  locked_until: number;
  created_at: number;
  updated_at: number;
}

export class IdempotencyConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(message = 'Idempotency conflict: Operation ID already used with different payload.') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyInProgressError extends Error {
  readonly statusCode = 409;
  readonly code = 'IDEMPOTENCY_IN_PROGRESS';
  constructor(message = 'Operation with this client operation ID is already in progress.') {
    super(message);
    this.name = 'IdempotencyInProgressError';
  }
}

export class IdempotencyUncertainOutcomeError extends Error {
  readonly statusCode = 409;
  readonly code = 'IDEMPOTENCY_UNCERTAIN_OUTCOME';
  constructor(message = 'Operation outcome is uncertain: external side effect was committed. Re-execution is blocked to prevent duplicate billing or executions.') {
    super(message);
    this.name = 'IdempotencyUncertainOutcomeError';
  }
}

export class IdempotencyDatabaseError extends Error {
  readonly statusCode = 503;
  readonly code = 'IDEMPOTENCY_DATABASE_UNAVAILABLE';
  constructor(message = 'Durable idempotency backend is unavailable. Mutating operation aborted.') {
    super(message);
    this.name = 'IdempotencyDatabaseError';
  }
}

export interface FailOptions {
  sideEffectCommitted?: boolean;
  result?: any;
  error?: string;
}

function canonicalizePayload(val: any): any {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(canonicalizePayload);
  const sorted: Record<string, any> = {};
  for (const k of Object.keys(val).sort()) {
    // Exclude volatile tracking fields from idempotency comparison if present
    if (k === 'clientOperationId' || k === 'idempotencyKey') continue;
    sorted[k] = canonicalizePayload(val[k]);
  }
  return sorted;
}

export function computePayloadHash(payload: any): string {
  const canonical = JSON.stringify(canonicalizePayload(payload));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export const DEFAULT_LOCK_LEASE_MS = 60_000; // 60-second default lease for crash/abandonment recovery

export class DurableIdempotencyManager {
  private memoryCache = new Map<string, IdempotencyRecord>();
  private activeInFlight = new Set<string>();
  private lockLeaseMs: number;

  constructor(lockLeaseMs = DEFAULT_LOCK_LEASE_MS) {
    this.lockLeaseMs = lockLeaseMs;
  }

  public isProduction(): boolean {
    return process.env.NODE_ENV === 'production' || 
           process.env.VERCEL === '1' || 
           Boolean(process.env.STAGING) || 
           process.env.FAIL_CLOSED_IDEMPOTENCY === '1';
  }

  /**
   * Acquire idempotency lock or return existing result if already completed.
   * Fail closed: in production, database errors reject the request (HTTP 503)
   * rather than silently degrading to process-local memory.
   */
  async beginOrGet(
    principalId: string,
    operationId: string,
    operationType: string,
    payload: any,
    customLeaseMs?: number
  ): Promise<{ isReplay: false } | { isReplay: true; statusCode: number; responseBody: any }> {
    const key = `${principalId}:${operationId}`;
    const payloadHash = computePayloadHash(payload);
    const now = Date.now();
    const leaseDuration = customLeaseMs ?? this.lockLeaseMs;
    const lockedUntil = now + leaseDuration;

    // Concurrency invariant: If operation is actively executing in this process, reject immediately
    if (this.activeInFlight.has(key)) {
      throw new IdempotencyInProgressError('Operation with this client operation ID is actively executing.');
    }

    // Check fast-path memory cache first (within same process instance)
    const cached = this.memoryCache.get(key);
    if (cached) {
      if (cached.payload_hash !== payloadHash) {
        throw new IdempotencyConflictError();
      }
      if (cached.status === 'COMPLETED') {
        const parsed = cached.response_body ? JSON.parse(cached.response_body) : {};
        return { isReplay: true, statusCode: cached.response_status, responseBody: parsed };
      }
      if (cached.status === 'FAILED') {
        let isUncertain = false;
        try {
          const parsed = cached.response_body ? JSON.parse(cached.response_body) : {};
          if (parsed.code === 'UNCERTAIN_OUTCOME' || parsed.uncertainOutcome === true) {
            isUncertain = true;
          }
        } catch {}
        if (isUncertain) {
          throw new IdempotencyUncertainOutcomeError();
        }
      }
      if (cached.status === 'IN_PROGRESS') {
        if (this.activeInFlight.has(key) || now <= (cached.locked_until || 0)) {
          throw new IdempotencyInProgressError();
        }
        // Memory cache lock expired; will attempt recovery via DB below
      }
    }

    try {
      const row = await db('idempotent_operations').where({ key }).first();
      if (row) {
        // Enforce payload equality across all statuses
        if (row.payload_hash !== payloadHash) {
          throw new IdempotencyConflictError();
        }

        if (row.status === 'COMPLETED') {
          const parsed = row.response_body ? JSON.parse(row.response_body) : {};
          this.memoryCache.set(key, { ...row, status: 'COMPLETED' });
          return { isReplay: true, statusCode: row.response_status, responseBody: parsed };
        }

        if (row.status === 'FAILED') {
          let isUncertain = false;
          try {
            const parsed = row.response_body ? JSON.parse(row.response_body) : {};
            if (parsed.code === 'UNCERTAIN_OUTCOME' || parsed.uncertainOutcome === true) {
              isUncertain = true;
            }
          } catch {}
          if (isUncertain) {
            throw new IdempotencyUncertainOutcomeError();
          }
        }

        if (row.status === 'IN_PROGRESS') {
          const currentLock = parseInt(row.locked_until || '0', 10);
          if (this.activeInFlight.has(key) || now <= currentLock) {
            // Actively being processed by this or a concurrent instance
            throw new IdempotencyInProgressError();
          }

          // Defined recovery policy for abandoned operations:
          // The previous attempt timed out / crashed and is not active in this process.
          // Payload matches, so atomically renew lease.
          const renewed = await db('idempotent_operations')
            .where({ key, status: 'IN_PROGRESS', locked_until: row.locked_until })
            .update({
              locked_until: lockedUntil,
              updated_at: now
            });

          if (renewed > 0) {
            this.activeInFlight.add(key);
            this.memoryCache.set(key, {
              ...row,
              status: 'IN_PROGRESS',
              locked_until: lockedUntil,
              updated_at: now
            });
            return { isReplay: false };
          }

          // Concurrent instance claimed the lease renewal first
          throw new IdempotencyInProgressError();
        }
      }

      // Record in-progress execution with initial lease
      const record: IdempotencyRecord = {
        key,
        principal_id: principalId,
        operation_id: operationId,
        operation_type: operationType,
        payload_hash: payloadHash,
        status: 'IN_PROGRESS',
        response_status: 200,
        response_body: '',
        locked_until: lockedUntil,
        created_at: now,
        updated_at: now
      };

      try {
        await db('idempotent_operations').insert(record);
        this.activeInFlight.add(key);
        this.memoryCache.set(key, record);
        return { isReplay: false };
      } catch (insertErr: any) {
        // Unique constraint violation means concurrent request beat this one to the lock
        if (insertErr.code === '23505' || String(insertErr).includes('UNIQUE') || String(insertErr).includes('constraint')) {
          const concurrentRow = await db('idempotent_operations').where({ key }).first();
          if (concurrentRow) {
            if (concurrentRow.payload_hash !== payloadHash) {
              throw new IdempotencyConflictError();
            }
            if (concurrentRow.status === 'COMPLETED') {
              const parsed = concurrentRow.response_body ? JSON.parse(concurrentRow.response_body) : {};
              this.memoryCache.set(key, { ...concurrentRow, status: 'COMPLETED' });
              return { isReplay: true, statusCode: concurrentRow.response_status, responseBody: parsed };
            }
          }
          throw new IdempotencyInProgressError();
        }
        throw insertErr;
      }
    } catch (err: any) {
      if (err instanceof IdempotencyConflictError || err instanceof IdempotencyInProgressError || err instanceof IdempotencyUncertainOutcomeError) {
        throw err;
      }

      // FAIL CLOSED IN PRODUCTION:
      // Production must NEVER downgrade from durable PostgreSQL to process-local memory.
      if (this.isProduction()) {
        process.stderr.write(`[IDEMPOTENCY_CRITICAL] Database failure in production: ${err.message}\n`);
        throw new IdempotencyDatabaseError(`Durable idempotency backend error: ${err.message}`);
      }

      // Non-production test fallback only when database is explicitly unavailable
      console.warn(`[Idempotency] Non-production in-memory fallback activated: ${err.message}`);
      const memRecord: IdempotencyRecord = {
        key,
        principal_id: principalId,
        operation_id: operationId,
        operation_type: operationType,
        payload_hash: payloadHash,
        status: 'IN_PROGRESS',
        response_status: 200,
        response_body: '',
        locked_until: lockedUntil,
        created_at: now,
        updated_at: now
      };
      this.activeInFlight.add(key);
      this.memoryCache.set(key, memRecord);
      return { isReplay: false };
    }
  }

  /**
   * Heartbeat: Extend the lease of an actively running operation so long-running
   * processes (such as vision generation) never lose their lock to timeouts.
   */
  async extendLease(principalId: string, operationId: string, extensionMs = 120_000): Promise<boolean> {
    const key = `${principalId}:${operationId}`;
    const now = Date.now();
    const lockedUntil = now + extensionMs;

    const mem = this.memoryCache.get(key);
    if (mem && mem.status === 'IN_PROGRESS') {
      mem.locked_until = lockedUntil;
      mem.updated_at = now;
    }

    try {
      const updated = await db('idempotent_operations')
        .where({ key, status: 'IN_PROGRESS' })
        .update({
          locked_until: lockedUntil,
          updated_at: now
        });
      return updated > 0;
    } catch (err: any) {
      if (this.isProduction()) {
        process.stderr.write(`[IDEMPOTENCY_HEARTBEAT_WARN] Failed to extend lease for ${key}: ${err.message}\n`);
      }
      return false;
    }
  }

  /**
   * Start periodic lease renewal in the background during long-running tasks.
   * Returns a handle with a .stop() method.
   */
  startHeartbeat(
    principalId: string,
    operationId: string,
    intervalMs = 15_000,
    extensionMs = 120_000
  ): { stop: () => void } {
    const key = `${principalId}:${operationId}`;
    const timer = setInterval(() => {
      if (!this.activeInFlight.has(key)) {
        clearInterval(timer);
        return;
      }
      this.extendLease(principalId, operationId, extensionMs).catch(() => {});
    }, intervalMs);

    if (timer.unref) {
      timer.unref();
    }

    return {
      stop: () => {
        clearInterval(timer);
      }
    };
  }

  /**
   * Complete an operation and cache its final HTTP response durably.
   */
  async complete(
    principalId: string,
    operationId: string,
    statusCode: number,
    responseBody: any
  ): Promise<void> {
    const key = `${principalId}:${operationId}`;
    this.activeInFlight.delete(key);
    const now = Date.now();
    const bodyStr = JSON.stringify(responseBody);

    const mem = this.memoryCache.get(key);
    if (mem) {
      mem.status = 'COMPLETED';
      mem.response_status = statusCode;
      mem.response_body = bodyStr;
      mem.updated_at = now;
    }

    try {
      await db('idempotent_operations')
        .where({ key })
        .update({
          status: 'COMPLETED',
          response_status: statusCode,
          response_body: bodyStr,
          updated_at: now
        });
    } catch (err: any) {
      // Invariant: side effect already succeeded. Never delete or revert record.
      if (this.isProduction()) {
        process.stderr.write(`[IDEMPOTENCY_CRITICAL] Failed to persist completed state in DB for ${key}: ${err.message}\n`);
        throw new IdempotencyDatabaseError(`Failed to persist completed idempotency state: ${err.message}`);
      }
    }
  }

  /**
   * Release lease on error so legitimate retries can execute cleanly.
   * Safety invariant: If an external side effect (e.g. credit deduction, image generation)
   * has already committed, the record is NEVER deleted or released. Instead, it is marked
   * COMPLETED (if result is available) or FAILED with UNCERTAIN_OUTCOME to permanently
   * prevent duplicate billing or re-execution.
   */
  async fail(principalId: string, operationId: string, options?: FailOptions): Promise<void> {
    const key = `${principalId}:${operationId}`;
    this.activeInFlight.delete(key);

    if (options?.sideEffectCommitted) {
      const now = Date.now();
      // External side effect committed! Never delete or release this operation record.
      if (options.result) {
        const bodyStr = JSON.stringify(options.result);
        const mem = this.memoryCache.get(key);
        if (mem) {
          mem.status = 'COMPLETED';
          mem.response_status = 200;
          mem.response_body = bodyStr;
          mem.updated_at = now;
        }
        try {
          await db('idempotent_operations')
            .where({ key })
            .update({
              status: 'COMPLETED',
              response_status: 200,
              response_body: bodyStr,
              updated_at: now
            });
          return;
        } catch (dbErr: any) {
          process.stderr.write(`[IDEMPOTENCY_WARN] Failed to write fallback COMPLETED: ${dbErr.message}\n`);
        }
      }

      // Mark as UNCERTAIN_OUTCOME to permanently lock against duplicate billing/retries
      const uncertainBody = JSON.stringify({
        error: 'UNCERTAIN_OUTCOME: External side effect committed but outcome persistence failed. Re-execution blocked to prevent duplicate billing.',
        code: 'UNCERTAIN_OUTCOME',
        uncertainOutcome: true,
        details: options.error || 'Side effect committed'
      });

      const mem = this.memoryCache.get(key);
      if (mem) {
        mem.status = 'FAILED';
        mem.response_status = 500;
        mem.response_body = uncertainBody;
        mem.updated_at = now;
      }

      try {
        await db('idempotent_operations')
          .where({ key })
          .update({
            status: 'FAILED',
            response_status: 500,
            response_body: uncertainBody,
            updated_at: now
          });
      } catch (dbErr: any) {
        process.stderr.write(`[IDEMPOTENCY_CRITICAL] Failed to mark UNCERTAIN_OUTCOME in DB: ${dbErr.message}\n`);
      }
      return;
    }

    // Normal failure BEFORE any external side effect committed:
    const mem = this.memoryCache.get(key);
    if (mem && mem.status !== 'IN_PROGRESS') {
      // Invariant: Never delete a COMPLETED record
      return;
    }
    this.memoryCache.delete(key);

    try {
      await db('idempotent_operations')
        .where({ key, status: 'IN_PROGRESS' })
        .delete();
    } catch (err: any) {
      if (this.isProduction()) {
        throw new IdempotencyDatabaseError(`Failed to clear in-progress idempotency lease: ${err.message}`);
      }
    }
  }

  /**
   * Reconcile an uncertain outcome record (e.g. following admin or billing audit).
   */
  async reconcile(
    principalId: string,
    operationId: string,
    resolution: { status: 'COMPLETED'; statusCode: number; responseBody: any } | { status: 'FAILED'; reason: string }
  ): Promise<void> {
    const key = `${principalId}:${operationId}`;
    const now = Date.now();
    const statusCode = resolution.status === 'COMPLETED' ? resolution.statusCode : 400;
    const bodyStr = resolution.status === 'COMPLETED' 
      ? JSON.stringify(resolution.responseBody)
      : JSON.stringify({ error: resolution.reason, reconciled: true });

    const mem = this.memoryCache.get(key);
    let existingHash = mem?.payload_hash;
    let existingType = mem?.operation_type || 'RECONCILED';
    let createdAt = mem?.created_at || now;

    if (!existingHash) {
      try {
        const row = await db('idempotent_operations').where({ key }).first();
        if (row) {
          existingHash = row.payload_hash;
          existingType = row.operation_type;
          createdAt = row.created_at;
        }
      } catch {}
    }

    this.memoryCache.set(key, {
      key,
      principal_id: principalId,
      operation_id: operationId,
      operation_type: existingType,
      payload_hash: existingHash || '',
      status: resolution.status,
      response_status: statusCode,
      response_body: bodyStr,
      locked_until: 0,
      created_at: createdAt,
      updated_at: now
    });

    await db('idempotent_operations')
      .where({ key })
      .update({
        status: resolution.status,
        response_status: statusCode,
        response_body: bodyStr,
        updated_at: now
      });
  }
}

export const durableIdempotencyManager = new DurableIdempotencyManager();
