import { db } from '../../db/src/index.js';
import { insertOutbox } from '../../runtime-reliability/src/index.js';

export type ComputerEventType =
  | 'computer.started'
  | 'computer.stopped'
  | 'browser.opened'
  | 'browser.acted'
  | 'file.read'
  | 'file.written'
  | 'terminal.executed'
  | 'control.taken'
  | 'control.released'
  | 'lease.blocked'
  | 'lifecycle.reconciled';

export interface ComputerEvent {
  sequence: number;
  type: ComputerEventType;
  timestamp: number;
  ownerId: string;
  botId: string;
  data: Record<string, unknown>;
}

export class ComputerEventRepository {
  async append(ownerId: string, botId: string, type: ComputerEventType, data: Record<string, unknown> = {}): Promise<ComputerEvent> {
    const timestamp = Date.now();
    return db.transaction(async trx => {
      const rows = await trx('aira_computer_events').insert({
        owner_id: ownerId,
        bot_id: botId,
        type,
        data: JSON.stringify(data),
        created_at: timestamp
      }).returning('*');
      const row = rows[0];
      const event: ComputerEvent = {
        sequence: Number(row.sequence),
        type: row.type,
        timestamp: Number(row.created_at),
        ownerId: row.owner_id,
        botId: row.bot_id,
        data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data
      };
      await insertOutbox(trx, {
        topic: 'computer.event',
        aggregateType: 'computer',
        aggregateId: ownerId,
        ownerId,
        dedupeKey: `computer:${ownerId}:${event.sequence}`,
        payload: event as unknown as Record<string, unknown>
      });
      return event;
    });
  }

  async list(ownerId: string, botId: string, after = 0, limit = 500): Promise<ComputerEvent[]> {
    const rows = await db('aira_computer_events')
      .where({ owner_id: ownerId, bot_id: botId })
      .andWhere('sequence', '>', after)
      .orderBy('sequence', 'asc')
      .limit(Math.max(1, Math.min(limit, 1000)));
    return rows.map(row => ({
      sequence: Number(row.sequence),
      type: row.type,
      timestamp: Number(row.created_at),
      ownerId: row.owner_id,
      botId: row.bot_id,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data
    }));
  }

  async latestSequence(ownerId: string, botId: string): Promise<number> {
    const row = await db('aira_computer_events').where({ owner_id: ownerId, bot_id: botId }).max('sequence as max_seq').first();
    return Number(row?.max_seq || 0);
  }
}
