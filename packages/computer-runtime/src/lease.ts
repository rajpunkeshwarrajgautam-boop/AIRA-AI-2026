import { createHash, randomUUID } from 'node:crypto';
import { db } from '../../db/src/index.js';

export type ComputerLeaseMode = 'BOT' | 'HUMAN';

export interface ComputerLeaseView {
  ownerId: string;
  botId: string;
  holderId: string;
  mode: ComputerLeaseMode;
  fence: number;
  acquiredAt: number;
  expiresAt: number;
}

export interface ComputerLease extends ComputerLeaseView {
  token: string;
}

export interface LeaseAcquisition {
  lease: ComputerLease;
  preempted?: ComputerLeaseView;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class ComputerLeaseManager {
  constructor(private readonly ttlMs = 60_000) {}

  private humanTtl(): number { return Math.max(this.ttlMs, 5 * 60_000); }

  private map(row: any): ComputerLeaseView {
    return {
      ownerId: row.owner_id,
      botId: row.bot_id,
      holderId: row.holder_id,
      mode: row.mode,
      fence: Number(row.fence || 0),
      acquiredAt: Number(row.acquired_at),
      expiresAt: Number(row.expires_at)
    };
  }

  async current(ownerId: string): Promise<ComputerLeaseView | undefined> {
    const row = await db('aira_computer_leases').where({ owner_id: ownerId }).andWhere('expires_at', '>', Date.now()).first();
    return row ? this.map(row) : undefined;
  }

  async acquireBot(ownerId: string, botId: string, runId: string): Promise<ComputerLease> {
    const holderId = `run:${runId}`;
    const token = randomUUID();
    const now = Date.now();
    const until = now + this.ttlMs;
    const result = await db.raw(
      `INSERT INTO aira_computer_leases
         (owner_id, bot_id, holder_id, mode, token_hash, fence, acquired_at, expires_at, updated_at)
       VALUES (?, ?, ?, 'BOT', ?, 1, ?, ?, ?)
       ON CONFLICT (owner_id) DO UPDATE SET
         bot_id = EXCLUDED.bot_id,
         holder_id = EXCLUDED.holder_id,
         mode = 'BOT',
         token_hash = EXCLUDED.token_hash,
         fence = CASE
           WHEN aira_computer_leases.mode = 'BOT'
             AND aira_computer_leases.holder_id = EXCLUDED.holder_id
             AND aira_computer_leases.expires_at > ?
           THEN aira_computer_leases.fence
           ELSE aira_computer_leases.fence + 1
         END,
         acquired_at = CASE
           WHEN aira_computer_leases.mode = 'BOT'
             AND aira_computer_leases.holder_id = EXCLUDED.holder_id
             AND aira_computer_leases.expires_at > ?
           THEN aira_computer_leases.acquired_at
           ELSE EXCLUDED.acquired_at
         END,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at
       WHERE aira_computer_leases.expires_at <= ?
          OR (aira_computer_leases.mode = 'BOT' AND aira_computer_leases.holder_id = EXCLUDED.holder_id)
       RETURNING *`,
      [ownerId, botId, holderId, tokenHash(token), now, until, now, now, now, now]
    );
    const row = result.rows?.[0] || result[0]?.[0];
    if (!row) {
      const existing = await this.current(ownerId);
      if (existing?.mode === 'HUMAN') throw new Error('COMPUTER_TAKEN_OVER');
      throw new Error('COMPUTER_BUSY');
    }
    return { ...this.map(row), token };
  }

  async takeover(ownerId: string, botId: string, sessionId: string): Promise<LeaseAcquisition> {
    const token = randomUUID();
    const holderId = `human:${sessionId}`;
    const now = Date.now();
    const until = now + this.humanTtl();
    return db.transaction(async trx => {
      const previousRow = await trx('aira_computer_leases').where({ owner_id: ownerId }).forUpdate().first();
      const previous = previousRow && Number(previousRow.expires_at) > now ? this.map(previousRow) : undefined;
      let row: any;
      if (previousRow) {
        const rows = await trx('aira_computer_leases').where({ owner_id: ownerId }).update({
          bot_id: botId,
          holder_id: holderId,
          mode: 'HUMAN',
          token_hash: tokenHash(token),
          fence: trx.raw('fence + 1'),
          acquired_at: now,
          expires_at: until,
          updated_at: now
        }).returning('*');
        row = rows[0];
      } else {
        const rows = await trx('aira_computer_leases').insert({
          owner_id: ownerId,
          bot_id: botId,
          holder_id: holderId,
          mode: 'HUMAN',
          token_hash: tokenHash(token),
          fence: 1,
          acquired_at: now,
          expires_at: until,
          updated_at: now
        }).returning('*');
        row = rows[0];
      }
      return { lease: { ...this.map(row), token }, preempted: previous };
    });
  }

  async renewHuman(ownerId: string, token: string): Promise<ComputerLease> {
    const now = Date.now();
    const until = now + this.humanTtl();
    const rows = await db('aira_computer_leases')
      .where({ owner_id: ownerId, mode: 'HUMAN', token_hash: tokenHash(token) })
      .andWhere('expires_at', '>', now)
      .update({ expires_at: until, updated_at: now })
      .returning('*');
    if (!rows[0]) throw new Error('Computer takeover lease is not valid.');
    return { ...this.map(rows[0]), token };
  }

  async assertHuman(ownerId: string, token: string): Promise<ComputerLease> {
    const lease = await this.renewHuman(ownerId, token).catch(() => undefined);
    if (!lease) throw new Error('Take control of this computer before interacting with it.');
    return lease;
  }

  async release(ownerId: string, token: string): Promise<ComputerLeaseView | undefined> {
    return db.transaction(async trx => {
      const row = await trx('aira_computer_leases').where({ owner_id: ownerId, token_hash: tokenHash(token) }).forUpdate().first();
      if (!row) return undefined;
      await trx('aira_computer_leases').where({ owner_id: ownerId, token_hash: tokenHash(token), fence: row.fence }).delete();
      return this.map(row);
    });
  }

  async releaseRun(ownerId: string, runId: string): Promise<boolean> {
    return (await db('aira_computer_leases').where({ owner_id: ownerId, holder_id: `run:${runId}`, mode: 'BOT' }).delete()) > 0;
  }
}
