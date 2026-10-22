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

export class DurableIdempotencyManager {
  private memoryCache = new Map<string, IdempotencyRecord>();
  private tableEnsured = false;
  private isDbAvailable: boolean | null = null;

  private async checkDb(): Promise<boolean> {
    if (this.isDbAvailable !== null) return this.isDbAvailable;
    try {
      await db.raw('SELECT 1');
      this.isDbAvailable = true;
      return true;
    } catch {
      this.isDbAvailable = false;
      return false;
    }
  }

  private async ensureTable(): Promise<void> {
    if (this.tableEnsured) return;
    const available = await this.checkDb();
    if (!available) {
      this.tableEnsured = true;
      return;
    }
    try {
      const hasTable = await db.schema.hasTable('idempotent_operations');
      if (!hasTable) {
        await db.schema.createTable('idempotent_operations', (table) => {
          table.string('key', 256).primary();
          table.string('principal_id', 128).notNullable();
          table.string('operation_id', 128).notNullable();
          table.string('operation_type', 64).notNullable();
          table.string('payload_hash', 64).notNullable();
          table.string('status', 32).notNullable();
          table.integer('response_status').defaultTo(200);
          table.text('response_body').defaultTo('');
          table.bigInteger('created_at').notNullable();
          table.bigInteger('updated_at').notNullable();
          table.index(['principal_id', 'operation_id'], 'idx_idempotent_principal_op');
        });
      }
      this.tableEnsured = true;
    } catch {
      this.tableEnsured = true;
    }
  }

  /**
   * Acquire idempotency lock or return existing result if already completed.
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

    // Check fast-path memory cache first
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
        throw new IdempotencyInProgressError();
      }
    }

    await this.ensureTable();

    if (!this.isDbAvailable) {
      const record: IdempotencyRecord = {
        key,
        principal_id: principalId,
        operation_id: operationId,
        operation_type: operationType,
        payload_hash: payloadHash,
        status: 'IN_PROGRESS',
        response_status: 200,
        response_body: '',
        created_at: now,
        updated_at: now
      };
      this.memoryCache.set(key, record);
      return { isReplay: false };
    }

    try {
      const row = await db('idempotent_operations').where({ key }).first();
      if (row) {
        if (row.payload_hash !== payloadHash) {
          throw new IdempotencyConflictError();
        }
        if (row.status === 'COMPLETED') {
          const parsed = row.response_body ? JSON.parse(row.response_body) : {};
          this.memoryCache.set(key, { ...row, status: 'COMPLETED' });
          return { isReplay: true, statusCode: row.response_status, responseBody: parsed };
        }
        if (row.status === 'IN_PROGRESS') {
          throw new IdempotencyInProgressError();
        }
      }

      // Record in-progress execution
      const record: IdempotencyRecord = {
        key,
        principal_id: principalId,
        operation_id: operationId,
        operation_type: operationType,
        payload_hash: payloadHash,
        status: 'IN_PROGRESS',
        response_status: 200,
        response_body: '',
        created_at: now,
        updated_at: now
      };

      this.memoryCache.set(key, record);

      try {
        await db('idempotent_operations').insert(record);
      } catch (insertErr: any) {
        // Unique constraint violation means concurrent request beat this one
        if (insertErr.code === '23505' || String(insertErr).includes('UNIQUE')) {
          const concurrentRow = await db('idempotent_operations').where({ key }).first();
          if (concurrentRow && concurrentRow.payload_hash !== payloadHash) {
            throw new IdempotencyConflictError();
          }
          if (concurrentRow && concurrentRow.status === 'COMPLETED') {
            const parsed = concurrentRow.response_body ? JSON.parse(concurrentRow.response_body) : {};
            return { isReplay: true, statusCode: concurrentRow.response_status, responseBody: parsed };
          }
          throw new IdempotencyInProgressError();
        }
      }

      return { isReplay: false };
    } catch (err: any) {
      if (err instanceof IdempotencyConflictError || err instanceof IdempotencyInProgressError) {
        throw err;
      }
      // If DB error, proceed with in-memory lock
      const memRecord: IdempotencyRecord = {
        key,
        principal_id: principalId,
        operation_id: operationId,
        operation_type: operationType,
        payload_hash: payloadHash,
        status: 'IN_PROGRESS',
        response_status: 200,
        response_body: '',
        created_at: now,
        updated_at: now
      };
      this.memoryCache.set(key, memRecord);
      return { isReplay: false };
    }
  }

  /**
   * Complete an operation and cache its final HTTP response.
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
    } catch {
      // Memory state already updated
    }
  }

  /**
   * Record failure or release lease on error so retries can execute cleanly.
   */
  async fail(principalId: string, operationId: string): Promise<void> {
    const key = `${principalId}:${operationId}`;
    this.memoryCache.delete(key);
    try {
      await db('idempotent_operations').where({ key }).delete();
    } catch {
      // Ignore
    }
  }
}

export const durableIdempotencyManager = new DurableIdempotencyManager();
