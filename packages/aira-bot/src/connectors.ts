import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Run, ToolCall, ToolDefinition, ToolResult } from '../../contracts/src/index.js';

const ConnectorConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(120),
  url: z.string().url().max(2048),
  transport: z.enum(['streamable_http', 'sse']).default('streamable_http'),
  allowedTools: z.array(z.string().trim().min(1).max(160)).min(1).max(100)
}).strict();
const ConnectorConfigListSchema = z.array(ConnectorConfigSchema).max(32);
export type BotConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
export interface BotConnectorSummary { id: string; name: string; connected: boolean; allowedTools: string[] }

interface ConnectedServer {
  client: Client;
  tools: Map<string, { name: string; description?: string; inputSchema?: Record<string, unknown> }>;
}

function isPrivateIp(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) || a >= 224;
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('ff') || lower.startsWith('2001:db8')) return true;
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? isPrivateIp(mapped) : false;
  }
  return true;
}

async function validatedConnectorUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Connector endpoints must use HTTP(S).');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Production connector endpoints must use HTTPS.');
  if (url.username || url.password) throw new Error('Connector endpoint URLs cannot contain credentials.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Connector endpoints cannot target localhost.');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Connector endpoints cannot target private or reserved networks.');
  } else {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(entry => isPrivateIp(entry.address))) throw new Error('Connector endpoint resolves to a private or reserved network.');
  }
  return url;
}

function parseConfig(): BotConnectorConfig[] {
  const raw = process.env.AIRA_BOT_MCP_SERVERS_JSON;
  if (!raw?.trim()) return [];
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('AIRA_BOT_MCP_SERVERS_JSON is not valid JSON.'); }
  const parsed = ConnectorConfigListSchema.parse(value);
  const ids = new Set<string>();
  for (const item of parsed) {
    if (ids.has(item.id)) throw new Error(`Duplicate Aira Bot connector id: ${item.id}`);
    ids.add(item.id);
  }
  return parsed;
}

function result(call: ToolCall, startedAt: number, output: unknown, error?: string): ToolResult {
  return { toolCallId: call.id, output: error ? null : output, error, isError: Boolean(error), durationMs: Date.now() - startedAt, timestamp: Date.now() };
}

export class BotConnectorRuntime {
  private readonly configs: Map<string, BotConnectorConfig>;
  private readonly connected = new Map<string, ConnectedServer>();
  constructor(configs = parseConfig()) { this.configs = new Map(configs.map(config => [config.id, config])); }

  summaries(): BotConnectorSummary[] {
    return Array.from(this.configs.values()).map(config => ({ id: config.id, name: config.name, connected: this.connected.has(config.id), allowedTools: [...config.allowedTools] }));
  }
  configuredIds(): string[] { return Array.from(this.configs.keys()); }
  has(id: string): boolean { return this.configs.has(id); }

  toolDefinitions(enabledConnectorIds: string[]): ToolDefinition[] {
    if (!enabledConnectorIds.some(id => this.configs.has(id))) return [];
    return [
      {
        id: 'tool_connector_list', name: 'connector_list', source: 'connector', executionRuntime: 'CLOUD', permissionLevel: 'READ', idempotencyClass: 'SAFE_READ',
        description: 'List the MCP connector tools explicitly enabled for this bot, including their input schemas.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        id: 'tool_connector_call', name: 'connector_call', source: 'connector', executionRuntime: 'CLOUD', permissionLevel: 'EXTERNAL_COMMUNICATION', idempotencyClass: 'EXTERNAL_SIDE_EFFECT',
        description: 'Call one allowlisted tool on an MCP connector enabled for this bot. Every call requires human approval because provider-specific side-effect metadata is not yet trusted.',
        parameters: { type: 'object', properties: { connectorId: { type: 'string' }, toolName: { type: 'string' }, arguments: { type: 'object' } }, required: ['connectorId', 'toolName', 'arguments'] }
      }
    ];
  }

  async listTools(enabledConnectorIds: string[]): Promise<Array<{ connectorId: string; connectorName: string; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>> {
    const output = [];
    for (const id of Array.from(new Set(enabledConnectorIds))) {
      const config = this.configs.get(id);
      if (!config) throw new Error(`Connector "${id}" is not configured on this host.`);
      const server = await this.connect(id);
      output.push({
        connectorId: id,
        connectorName: config.name,
        tools: Array.from(server.tools.values()).map(tool => ({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema || { type: 'object', properties: {} } }))
      });
    }
    return output;
  }

  async call(enabledConnectorIds: string[], connectorId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!enabledConnectorIds.includes(connectorId)) throw new Error('Connector is outside this bot’s enabled connector allowlist.');
    const config = this.configs.get(connectorId);
    if (!config) throw new Error(`Connector "${connectorId}" is not configured on this host.`);
    if (!config.allowedTools.includes(toolName)) throw new Error(`Connector tool "${toolName}" is not allowlisted for ${config.name}.`);
    const server = await this.connect(connectorId);
    if (!server.tools.has(toolName)) throw new Error(`Connector tool "${toolName}" is not currently exposed by ${config.name}.`);
    const response = await server.client.callTool({ name: toolName, arguments: args as any });
    if (response.isError) throw new Error(`Connector ${config.name}/${toolName} reported an error.`);
    return response.content;
  }

  async execute(run: Run, call: ToolCall, enabledConnectorIds: string[]): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      if (call.name === 'connector_list') return result(call, startedAt, await this.listTools(enabledConnectorIds));
      if (call.name === 'connector_call') {
        const connectorId = String(call.arguments.connectorId || '');
        const toolName = String(call.arguments.toolName || '');
        const args = call.arguments.arguments;
        if (!connectorId || !toolName || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('connector_call requires connectorId, toolName, and an object arguments value.');
        return result(call, startedAt, await this.call(enabledConnectorIds, connectorId, toolName, args as Record<string, unknown>));
      }
      return result(call, startedAt, null, `Connector tool "${call.name}" is not registered.`);
    } catch (error) { return result(call, startedAt, null, (error as Error).message); }
  }

  async close(): Promise<void> {
    for (const server of this.connected.values()) await server.client.close().catch(() => undefined);
    this.connected.clear();
  }

  private async connect(id: string): Promise<ConnectedServer> {
    const existing = this.connected.get(id);
    if (existing) return existing;
    const config = this.configs.get(id);
    if (!config) throw new Error(`Connector "${id}" is not configured on this host.`);
    const url = await validatedConnectorUrl(config.url);
    const transport = config.transport === 'sse' ? new SSEClientTransport(url) : new StreamableHTTPClientTransport(url);
    const client = new Client({ name: 'aira-bot-connector-runtime', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const discovered = await client.listTools();
    const tools = new Map<string, { name: string; description?: string; inputSchema?: Record<string, unknown> }>();
    for (const tool of discovered.tools || []) {
      if (!config.allowedTools.includes(tool.name)) continue;
      tools.set(tool.name, { name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> });
    }
    if (!tools.size) {
      await client.close().catch(() => undefined);
      throw new Error(`Connector ${config.name} exposes none of its configured allowlisted tools.`);
    }
    const server = { client, tools };
    this.connected.set(id, server);
    return server;
  }
}

export const botConnectorRuntime = new BotConnectorRuntime();
