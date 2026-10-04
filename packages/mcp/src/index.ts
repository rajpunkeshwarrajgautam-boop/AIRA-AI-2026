import { ToolDefinition } from '../../contracts/src/index.js';
import { ToolRegistry } from '../../tool-runtime/src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export interface McpServerConfig {
  id: string;
  name: string;
  url?: string;
  transport?: 'streamable_http' | 'sse';
}

export class McpHost {
  private servers: Map<string, McpServerConfig> = new Map();
  private clients: Map<string, Client> = new Map();

  constructor(private toolRegistry: ToolRegistry) {
  }

  public registerServer(config: McpServerConfig): void {
    this.servers.set(config.id, config);
  }

  public listServers(): McpServerConfig[] {
    return Array.from(this.servers.values());
  }

  public async connectServer(serverId: string): Promise<boolean> {
    const config = this.servers.get(serverId);
    if (!config) throw new Error(`MCP Server with id ${serverId} not found.`);
    if (!config.url) throw new Error(`MCP Server with id ${serverId} requires an HTTP URL.`);

    // Security Gate 1: URL Validation & SSRF Prevention
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(config.url);
    } catch {
      throw new Error(`Invalid URL for MCP server ${serverId}: ${config.url}`);
    }
    
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Invalid protocol for MCP server ${serverId}. Only http and https are allowed.`);
    }

    const isLocal = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === '::1';
    if (process.env.NODE_ENV === 'production' && isLocal && process.env.AIRA_ALLOW_LOCAL_MCP !== 'true') {
      throw new Error(`Security Violation: Connecting to localhost MCP endpoints is forbidden in production.`);
    }

    try {
      const transport = config.transport === 'sse' ? new SSEClientTransport(parsedUrl) : new StreamableHTTPClientTransport(parsedUrl);
      const client = new Client({
        name: "aira-mcp-host",
        version: "1.0.0"
      }, { capabilities: {} });

      await client.connect(transport);
      this.clients.set(serverId, client);

      const toolsRes = await client.listTools();
      const tools = toolsRes.tools || [];
      
      for (const t of tools) {
        const serverToolDef: ToolDefinition = {
          id: `mcp_${config.id}_${t.name}`,
          name: t.name,
          description: t.description || `Tool ${t.name} from MCP server ${config.name}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
          source: 'mcp',
          permissionLevel: 'READ',
          idempotencyClass: 'NON_IDEMPOTENT',
          executionRuntime: 'LOCAL'
        };

        this.toolRegistry.register({
          definition: serverToolDef,
          execute: async (args, ctx) => {
            const start = Date.now();
            try {
              const execResponse = await client.callTool({
                name: t.name,
                arguments: args as any
              });
              
              return {
                toolCallId: 'call_mcp_' + Date.now(),
                output: execResponse.content,
                isError: Boolean(execResponse.isError),
                durationMs: Date.now() - start,
                timestamp: Date.now()
              };
            } catch (err: any) {
              return {
                toolCallId: 'call_mcp_' + Date.now(),
                output: err.message,
                isError: true,
                error: err.message,
                durationMs: Date.now() - start,
                timestamp: Date.now()
              };
            }
          }
        });
      }

      return true;
    } catch (err: any) {
      console.error(`Failed to connect MCP server ${config.name}:`, err.message);
      return false;
    }
  }

  public async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
  }
}

