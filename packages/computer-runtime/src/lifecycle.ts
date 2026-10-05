import { db } from '../../db/src/index.js';
import type { ComputerProviderKind } from './provider.js';

export type ComputerDesiredState = 'ACTIVE' | 'SUSPENDED';
export type ComputerObservedState = 'RUNNING' | 'STOPPED' | 'MISSING' | 'ERROR' | 'UNKNOWN';

export interface ComputerInstanceRecord {
  ownerId: string;
  provider: ComputerProviderKind;
  resourceName?: string;
  desiredState: ComputerDesiredState;
  observedState: ComputerObservedState;
  generation: number;
  lastError?: string;
  lastSeenAt?: number;
  createdAt: number;
  updatedAt: number;
}

export class ComputerInstanceRepository {
  async setDesired(ownerId: string, provider: ComputerProviderKind, desiredState: ComputerDesiredState, resourceName?: string): Promise<ComputerInstanceRecord> {
    const now = Date.now();
    const existing = await db('aira_computer_instances').where({ owner_id: ownerId }).first();
    if (!existing) {
      const rows = await db('aira_computer_instances').insert({
        owner_id: ownerId,
        provider,
        resource_name: resourceName || null,
        desired_state: desiredState,
        observed_state: 'UNKNOWN',
        generation: 1,
        created_at: now,
        updated_at: now
      }).returning('*');
      return this.map(rows[0]);
    }
    const generation = existing.desired_state === desiredState && existing.provider === provider ? Number(existing.generation || 1) : Number(existing.generation || 1) + 1;
    const rows = await db('aira_computer_instances').where({ owner_id: ownerId }).update({
      provider,
      resource_name: resourceName || existing.resource_name || null,
      desired_state: desiredState,
      generation,
      updated_at: now
    }).returning('*');
    return this.map(rows[0]);
  }

  async observe(ownerId: string, observedState: ComputerObservedState, lastError?: string): Promise<ComputerInstanceRecord | undefined> {
    const now = Date.now();
    const rows = await db('aira_computer_instances').where({ owner_id: ownerId }).update({
      observed_state: observedState,
      last_error: lastError ? lastError.slice(0, 4000) : null,
      last_seen_at: now,
      updated_at: now
    }).returning('*');
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async get(ownerId: string): Promise<ComputerInstanceRecord | undefined> {
    const row = await db('aira_computer_instances').where({ owner_id: ownerId }).first();
    return row ? this.map(row) : undefined;
  }

  async list(provider?: ComputerProviderKind): Promise<ComputerInstanceRecord[]> {
    let query = db('aira_computer_instances').select('*');
    if (provider) query = query.where({ provider });
    const rows = await query.orderBy('updated_at', 'asc');
    return rows.map(row => this.map(row));
  }

  async unhealthy(provider?: ComputerProviderKind): Promise<ComputerInstanceRecord[]> {
    const records = await this.list(provider);
    return records.filter(record =>
      record.observedState === 'ERROR' ||
      (record.desiredState === 'ACTIVE' && !['RUNNING', 'STOPPED'].includes(record.observedState)) ||
      (record.desiredState === 'SUSPENDED' && record.observedState !== 'STOPPED')
    );
  }

  private map(row: any): ComputerInstanceRecord {
    return {
      ownerId: row.owner_id,
      provider: row.provider,
      resourceName: row.resource_name || undefined,
      desiredState: row.desired_state,
      observedState: row.observed_state,
      generation: Number(row.generation || 1),
      lastError: row.last_error || undefined,
      lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }
}
