import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../db/src/index.js';

export const SkillInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  instructions: z.string().trim().min(1).max(8000)
}).strict();
export type SkillInput = z.infer<typeof SkillInputSchema>;
export type BotSkillRecord = SkillInput & { id: string; ownerId: string; createdAt: number; updatedAt: number };

export class BotSkillRepository {
  async list(ownerId: string): Promise<BotSkillRecord[]> {
    const rows = await db('aira_bot_skills').where({ owner_id: ownerId }).orderBy('updated_at', 'desc');
    return rows.map(row => this.map(row));
  }

  async get(ownerId: string, id: string): Promise<BotSkillRecord | undefined> {
    const row = await db('aira_bot_skills').where({ owner_id: ownerId, id }).first();
    return row ? this.map(row) : undefined;
  }

  async create(ownerId: string, input: SkillInput): Promise<BotSkillRecord> {
    const now = Date.now();
    const record: BotSkillRecord = { ...input, id: `skill_${randomUUID()}`, ownerId, createdAt: now, updatedAt: now };
    try {
      await db('aira_bot_skills').insert({ id: record.id, owner_id: ownerId, name: input.name, description: input.description, instructions: input.instructions, created_at: now, updated_at: now });
    } catch (error: any) {
      if (String(error?.code) === '23505' || /unique/i.test(String(error?.message))) throw new Error('A reusable skill with this name already exists.');
      throw error;
    }
    return record;
  }

  async update(ownerId: string, id: string, input: SkillInput): Promise<BotSkillRecord | undefined> {
    try {
      const rows = await db('aira_bot_skills').where({ owner_id: ownerId, id }).update({ name: input.name, description: input.description, instructions: input.instructions, updated_at: Date.now() }).returning('*');
      return rows[0] ? this.map(rows[0]) : undefined;
    } catch (error: any) {
      if (String(error?.code) === '23505' || /unique/i.test(String(error?.message))) throw new Error('A reusable skill with this name already exists.');
      throw error;
    }
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    const skill = await this.get(ownerId, id);
    if (!skill) return false;
    const bots = await db('aira_bots').where({ owner_id: ownerId }).select('id', 'definition');
    for (const row of bots) {
      const definition = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;
      if (Array.isArray(definition?.skillIds) && definition.skillIds.includes(id)) throw new Error('This skill is attached to an Aira Bot. Detach it before deleting the skill.');
    }
    return (await db('aira_bot_skills').where({ owner_id: ownerId, id }).delete()) > 0;
  }

  async requireOwned(ownerId: string, ids: string[]): Promise<BotSkillRecord[]> {
    const unique = Array.from(new Set(ids));
    if (!unique.length) return [];
    const rows = await db('aira_bot_skills').where({ owner_id: ownerId }).whereIn('id', unique);
    if (rows.length !== unique.length) throw new Error('One or more reusable skills are unavailable to this user.');
    const byId = new Map(rows.map(row => [row.id, this.map(row)]));
    return unique.map(id => byId.get(id)!);
  }

  async snapshot(ownerId: string, ids: string[]): Promise<Array<{ id: string; name: string; description: string; instructions: string; updatedAt: number }>> {
    const records = await this.requireOwned(ownerId, ids);
    return records.map(skill => ({ id: skill.id, name: skill.name, description: skill.description, instructions: skill.instructions, updatedAt: skill.updatedAt }));
  }

  private map(row: any): BotSkillRecord {
    return { id: row.id, ownerId: row.owner_id, name: row.name, description: row.description || '', instructions: row.instructions, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }
}
