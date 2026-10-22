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

export class IdempotencyDatabaseError extends Error {
  readonly statusCode = 503;
  readonly code = 'IDEMPOTENCY_DATABASE_UNAVAILABLE';
  constructor(message = 'Durable idempotency backend is unavailable. Mutating operation aborted.') {
    super(message);
    this.name = 'IdempotencyDatabaseError';
  }
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

export const DEFAULT_LOCK_LEASE_MS = 60_000; // 60-second lease for crash/abandonment recovery

export class DurableIdempotencyManager {
  private memoryCache = new Map<string, IdempotencyRecord>();
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
    payload: any
  ): Promise<{ isReplay: false } | { isReplay: true; statusCode: number; responseBody: any }> {
    const key = `${principalId}:${operationId}`;
    const payloadHash = computePayloadHash(payload);
    const now = Date.now();
    const lockedUntil = now + this.lockLeaseMs;

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
      if (cached.status === 'IN_PROGRESS') {
        if (now <= (cached.locked_until || 0)) {
          throw new IdempotencyInProgressError();
        }
        // Memory cache lock expired; will attempt recovery below
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

        if (row.status === 'IN_PROGRESS') {
          const currentLock = parseInt(row.locked_until || '0', 10);
          if (now <= currentLock) {
            // Actively being processed by concurrent instance
            throw new IdempotencyInProgressError();
          }

          // Defined recovery policy for abandoned operations:
          // The previous attempt timed out / crashed. Payload matches, so atomically renew lease.
          const renewed = await db('idempotent_operations')
            .where({ key, status: 'IN_PROGRESS', locked_until: row.locked_until })
            .update({
              locked_until: lockedUntil,
              updated_at: now
            });

          if (renewed > 0) {
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
      if (err instanceof IdempotencyConflictError || err instanceof IdempotencyInProgressError) {
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
      this.memoryCache.set(key, memRecord);
      return { isReplay: false };
    }
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
      if (this.isProduction()) {
        throw new IdempotencyDatabaseError(`Failed to persist completed idempotency state: ${err.message}`);
      }
    }
  }

  /**
   * Release lease on error so legitimate retries can execute cleanly.
   * Safety invariant: Only deletes the row if it is still 'IN_PROGRESS'.
   * A conflict or failed downstream request can NEVER delete a completed operation's record.
   */
  async fail(principalId: string, operationId: string): Promise<void> {
    const key = `${principalId}:${operationId}`;
    const mem = this.memoryCache.get(key);
    if (mem && mem.status !== 'IN_PROGRESS') {
      // Invariant: Never delete a COMPLETED record from memory cache
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
}

export const durableIdempotencyManager = new DurableIdempotencyManager();
