import { z } from 'zod';
import { ModelIdSchema } from '../../contracts/src/index.js';

export const BuilderRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(24000),
  model: ModelIdSchema.default('aira-auto'),
  allowExecution: z.literal(true),
  allowInternet: z.boolean().default(false),
  allowPreview: z.boolean().default(false),
  workspaceTicket: z.string().max(6000).optional(),
}).strict();
export type BuilderRequest = z.infer<typeof BuilderRequestSchema>;

const filePath = z.string().min(1).max(240);
export const BuilderActionSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('write_file'), path: filePath, content: z.string().max(300000) }).strict(),
  z.object({ tool: z.literal('read_file'), path: filePath }).strict(),
  z.object({ tool: z.literal('list_files'), path: filePath.default('.') }).strict(),
  z.object({ tool: z.literal('run_command'), command: z.string().min(1).max(8000), timeoutMs: z.number().int().min(1000).max(20000).default(15000) }).strict(),
  z.object({ tool: z.literal('start_preview'), command: z.string().max(8000).optional() }).strict(),
  z.object({ tool: z.literal('publish_file'), path: filePath, title: z.string().min(1).max(100) }).strict(),
  z.object({ tool: z.literal('finish'), summary: z.string().min(1).max(12000) }).strict(),
]);
export type BuilderAction = z.infer<typeof BuilderActionSchema>;
export interface BuilderEvent { type: string; data: Record<string, unknown> }
export interface BuilderFile { title: string; path: string; bytes: number; url: string; expiresAt: number }
export const WORKSPACE = '/home/user/workspace';
export const MAX_DOWNLOAD_BYTES = 3 * 1024 * 1024;
