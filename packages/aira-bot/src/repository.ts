import { randomUUID } from 'node:crypto';
import { db } from '../../db/src/index.js';
import type { Bot, BotInput } from './contracts.js';

export class BotRepository {
  async list(owner: string): Promise<Bot[]> {
    const rows = await db('aira_bots').where({ owner_id: owner }).orderBy('created_at', 'desc');
    return rows.map(row => this.map(row));
  }
  async get(owner: string, id: string): Promise<Bot | undefined> {
    const row = await db('aira_bots').where({ owner_id: owner, id }).first();
    return row ? this.map(row) : undefined;
  }
  async create(owner: string, input: BotInput): Promise<Bot> {
    const now = Date.now();
    const bot = { ...input, id: `bot_${randomUUID()}`, createdAt: now, updatedAt: now };
    await db('aira_bots').insert({ id: bot.id, owner_id: owner, definition: JSON.stringify(input), created_at: now, updated_at: now });
    return bot;
  }
  async update(owner: string, id: string, input: BotInput): Promise<Bot | undefined> {
    const rows = await db('aira_bots').where({ owner_id: owner, id }).update({ definition: JSON.stringify(input), updated_at: Date.now() }).returning('*');
    return rows[0] ? this.map(rows[0]) : undefined;
  }
  async remove(owner: string, id: string): Promise<boolean> {
    // Task history remains durable; deleting a bot with history is deliberately rejected.
    if (await db('aira_bot_tasks').where({ owner_id: owner, bot_id: id }).first()) throw new Error('This bot has task history. Keep it to preserve run records.');
    return (await db('aira_bots').where({ owner_id: owner, id }).delete()) > 0;
  }
  async recordTask(owner: string, botId: string, runId: string, objective: string) {
    const task = { id: `task_${randomUUID()}`, bot_id: botId, owner_id: owner, run_id: runId, objective, created_at: Date.now() };
    await db('aira_bot_tasks').insert(task);
    return task;
  }
  async tasks(owner: string, botId: string) {
    return db('aira_bot_tasks').where({ owner_id: owner, bot_id: botId }).orderBy('created_at', 'desc');
  }
  private map(row: any): Bot {
    const input = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;
    return { ...input, id: row.id, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }
}
