import { randomUUID } from 'node:crypto';

export type ComputerLeaseMode = 'BOT' | 'HUMAN';

export interface ComputerLease {
  token: string;
  ownerId: string;
  botId: string;
  holderId: string;
  mode: ComputerLeaseMode;
  acquiredAt: number;
  expiresAt: number;
}

export interface LeaseAcquisition {
  lease: ComputerLease;
  preempted?: ComputerLease;
}

export class ComputerLeaseManager {
  private leases = new Map<string, ComputerLease>();

  constructor(private readonly ttlMs = 60_000) {}

  private key(ownerId: string): string { return ownerId; }

  private active(ownerId: string): ComputerLease | undefined {
    const key = this.key(ownerId);
    const lease = this.leases.get(key);
    if (!lease) return undefined;
    if (lease.expiresAt <= Date.now()) {
      this.leases.delete(key);
      return undefined;
    }
    return lease;
  }

  current(ownerId: string): ComputerLease | undefined {
    const lease = this.active(ownerId);
    return lease ? { ...lease } : undefined;
  }

  acquireBot(ownerId: string, botId: string, runId: string): ComputerLease {
    const existing = this.active(ownerId);
    const holderId = `run:${runId}`;
    if (existing?.mode === 'HUMAN') throw new Error('COMPUTER_TAKEN_OVER');
    if (existing && existing.holderId !== holderId) throw new Error('COMPUTER_BUSY');
    const now = Date.now();
    const lease: ComputerLease = existing
      ? { ...existing, botId, expiresAt: now + this.ttlMs }
      : { token: randomUUID(), ownerId, botId, holderId, mode: 'BOT', acquiredAt: now, expiresAt: now + this.ttlMs };
    this.leases.set(this.key(ownerId), lease);
    return { ...lease };
  }

  takeover(ownerId: string, botId: string, sessionId: string): LeaseAcquisition {
    const previous = this.active(ownerId);
    const now = Date.now();
    const lease: ComputerLease = {
      token: randomUUID(), ownerId, botId, holderId: `human:${sessionId}`, mode: 'HUMAN', acquiredAt: now,
      expiresAt: now + Math.max(this.ttlMs, 5 * 60_000)
    };
    this.leases.set(this.key(ownerId), lease);
    return { lease: { ...lease }, preempted: previous ? { ...previous } : undefined };
  }

  renewHuman(ownerId: string, token: string): ComputerLease {
    const existing = this.active(ownerId);
    if (!existing || existing.mode !== 'HUMAN' || existing.token !== token) throw new Error('Computer takeover lease is not valid.');
    existing.expiresAt = Date.now() + Math.max(this.ttlMs, 5 * 60_000);
    this.leases.set(this.key(ownerId), existing);
    return { ...existing };
  }

  assertHuman(ownerId: string, token: string): ComputerLease {
    const existing = this.active(ownerId);
    if (!existing || existing.mode !== 'HUMAN' || existing.token !== token) throw new Error('Take control of this computer before interacting with it.');
    return this.renewHuman(ownerId, token);
  }

  release(ownerId: string, token: string): ComputerLease | undefined {
    const existing = this.active(ownerId);
    if (!existing || existing.token !== token) return undefined;
    this.leases.delete(this.key(ownerId));
    return { ...existing };
  }

  releaseRun(ownerId: string, runId: string): boolean {
    const existing = this.active(ownerId);
    if (!existing || existing.holderId !== `run:${runId}`) return false;
    this.leases.delete(this.key(ownerId));
    return true;
  }
}
