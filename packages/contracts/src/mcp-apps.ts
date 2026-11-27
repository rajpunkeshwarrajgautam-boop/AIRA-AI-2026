/**
 * AIRA GenUI Phase 4A — Model Context Protocol Extension Apps (aira-mcp-app/v1)
 *
 * Implements declarative application descriptors, capability negotiation,
 * JSON-RPC message contracts, and security boundaries based on modelcontextprotocol/ext-apps.
 */
import { z } from 'zod';

export const AIRA_MCP_APP_CONTRACT_VERSION = 'aira-mcp-app/v1' as const;

export const AIRA_MCP_APP_LIMITS = {
  maxEntrypointBytes: 512 * 1024,
  maxStateBytes: 64 * 1024,
  maxSupportedTools: 32,
  minHeightPx: 200,
  maxHeightPx: 1600,
} as const;

export const McpAppDisplayModeSchema = z.enum(['inline', 'fullscreen', 'pip', 'modal']);
export type McpAppDisplayMode = z.infer<typeof McpAppDisplayModeSchema>;

export const McpAppCapabilitiesSchema = z.object({
  requiresToolExecution: z.boolean().default(false),
  requiresStateSync: z.boolean().default(true),
  readOnly: z.boolean().default(false),
  maxHeightPx: z.number().int().min(200).max(1600).default(800),
});
export type McpAppCapabilities = z.infer<typeof McpAppCapabilitiesSchema>;

const IdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/, 'Invalid identifier');

export const McpAppDescriptorSchema = z
  .object({
    schemaVersion: z.literal(AIRA_MCP_APP_CONTRACT_VERSION),
    appId: IdSchema,
    serverId: IdSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    entrypointHtml: z.string().min(1).max(AIRA_MCP_APP_LIMITS.maxEntrypointBytes),
    supportedTools: z.array(IdSchema).max(AIRA_MCP_APP_LIMITS.maxSupportedTools).default([]),
    displayMode: McpAppDisplayModeSchema.default('inline'),
    capabilities: McpAppCapabilitiesSchema.default({
      requiresToolExecution: false,
      requiresStateSync: true,
      readOnly: false,
      maxHeightPx: 800,
    }),
    initialState: z.record(z.string().max(64), z.unknown()).default({}),
    textFallback: z.string().min(1).max(4096),
  })
  .strict();

export type McpAppDescriptor = z.infer<typeof McpAppDescriptorSchema>;

export type McpAppValidationResult =
  | { ok: true; descriptor: McpAppDescriptor }
  | { ok: false; code: string; error: string };

export function validateMcpAppDescriptor(input: unknown): McpAppValidationResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, code: 'MCP_APP_DESCRIPTOR_INVALID', error: 'Descriptor must be a non-null object.' };
  }

  const parsed = McpAppDescriptorSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'MCP_APP_SCHEMA_INVALID',
      error: parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
    };
  }

  return { ok: true, descriptor: parsed.data };
}

/**
 * JSON-RPC 2.0 message schemas for host-to-iframe MCP App bridge
 */
export const McpAppRpcMethodSchema = z.enum([
  'ui/ready',
  'ui/resize',
  'ui/stateUpdate',
  'ui/error',
  'tools/call',
  'tools/result',
]);
export type McpAppRpcMethod = z.infer<typeof McpAppRpcMethodSchema>;

export const McpAppRpcMessageSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]).optional(),
    method: McpAppRpcMethodSchema,
    params: z.record(z.string(), z.unknown()).default({}),
    nonce: z.string().min(8).max(128),
    appId: IdSchema,
  })
  .strict();

export type McpAppRpcMessage = z.infer<typeof McpAppRpcMessageSchema>;
