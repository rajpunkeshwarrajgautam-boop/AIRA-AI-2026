import { z } from 'zod';
import { ModelIdSchema } from '../../contracts/src/index.js';

export const BotToolSchema = z.enum([
  'web_search',
  'calculator',
  'browser_open',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_wait',
  'file_read',
  'file_write',
  'terminal_exec',
  'delegate_bot',
  'delegation_status',
  'connector_list',
  'connector_call'
]);
export type BotTool = z.infer<typeof BotToolSchema>;

export const BotInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  instructions: z.string().trim().min(1).max(12000),
  model: ModelIdSchema.exclude(['mock-deterministic']).default('aira-auto'),
  tools: z.array(BotToolSchema).max(14).default([]),
  connectorIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).max(16).default([]),
  approvalPolicy: z.enum(['always_ask', 'risky_only']).default('risky_only'),
  memory: z.string().max(12000).default(''),
  skills: z.array(z.object({ name: z.string().trim().min(1).max(80), instructions: z.string().trim().min(1).max(4000) })).max(12).default([]),
  skillIds: z.array(z.string().trim().min(1).max(120)).max(24).default([]),
  maxSteps: z.number().int().min(1).max(20).default(8)
}).strict();
export type BotInput = z.infer<typeof BotInputSchema>;
export type Bot = BotInput & { id: string; createdAt: number; updatedAt: number };
export const BotTaskSchema = z.object({ prompt: z.string().trim().min(1).max(16000) }).strict();
export const BotActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool'), name: z.string().trim().min(1).max(80), arguments: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ type: z.literal('final'), content: z.string().min(1).max(64000) }).strict()
]);
