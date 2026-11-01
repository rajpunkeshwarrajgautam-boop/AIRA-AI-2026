import { ToolDefinition, ToolDefinitionSchema } from '../../contracts/src/index.js';
import { ToolRegistry, ToolGateway } from '../../tool-runtime/src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpServerConfig {
  id: string;
  name: string;
  url?: string;
  transport?: 'streamable_http' | 'sse' | 'stdio';
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface McpServerStatus {
  serverId: string;
  name: string;
  transport: 'streamable_http' | 'sse' | 'stdio';
  connected: boolean;
  toolCount: number;
  tools: string[];
  lastError?: string;
}

export class McpHost {
  private servers: Map<string, McpServerConfig> = new Map();
  private clients: Map<string, Client> = new Map();
  private serverTools: Map<string, ToolDefinition[]> = new Map();
  private serverErrors: Map<string, string> = new Map();

  constructor(private toolRegistryOrGateway: ToolRegistry | ToolGateway) {}

  public registerServer(config: McpServerConfig): void {
    this.servers.set(config.id, config);
  }

  public unregisterServer(serverId: string): void {
    void this.disconnectServer(serverId);
    this.servers.delete(serverId);
    this.serverTools.delete(serverId);
    this.serverErrors.delete(serverId);
  }

  public listServers(): McpServerConfig[] {
    return Array.from(this.servers.values());
  }

  public getServerStatus(serverId: string): McpServerStatus | undefined {
    const config = this.servers.get(serverId);
    if (!config) return undefined;
    const isConnected = this.clients.has(serverId);
    const tools = this.serverTools.get(serverId) || [];
    return {
      serverId,
      name: config.name,
      transport: config.transport || 'streamable_http',
      connected: isConnected,
      toolCount: tools.length,
      tools: tools.map(t => t.name),
      lastError: this.serverErrors.get(serverId)
    };
  }

  public listAllStatuses(): McpServerStatus[] {
    return Array.from(this.servers.keys())
      .map(id => this.getServerStatus(id))
      .filter((s): s is McpServerStatus => s !== undefined);
  }

  public listServerTools(serverId: string): ToolDefinition[] {
    return this.serverTools.get(serverId) || [];
  }

  public async pingServer(serverId: string): Promise<boolean> {
    const client = this.clients.get(serverId);
    if (!client) return false;
    try {
      await client.ping();
      return true;
    } catch {
      return false;
    }
  }

  public async connectServer(serverId: string): Promise<boolean> {
    const config = this.servers.get(serverId);
    if (!config) throw new Error(`MCP Server with id ${serverId} not found.`);

    // If already connected, close existing session first
    if (this.clients.has(serverId)) {
      await this.disconnectServer(serverId);
    }

    let transport: any;

    if (config.transport === 'stdio') {
      if (!config.command) {
        throw new Error(`MCP stdio server ${serverId} requires a command path.`);
      }

      // Security Isolation: Strip host credentials from stdio child process environment
      const safeEnv: Record<string, string> = {
        PATH: process.env.PATH || '',
        SYSTEMROOT: process.env.SYSTEMROOT || '',
        HOME: process.env.HOME || process.env.USERPROFILE || '',
        USERPROFILE: process.env.USERPROFILE || '',
        ...(config.env || {})
      };

      for (const k of Object.keys(safeEnv)) {
        const kUpper = k.toUpperCase();
        if (
          kUpper.includes('TOKEN') ||
          kUpper.includes('SECRET') ||
          kUpper.includes('KEY') ||
          kUpper.includes('DATABASE') ||
          kUpper.includes('NEON') ||
          kUpper.includes('POSTGRES') ||
          kUpper.includes('AUTH') ||
          kUpper.includes('COOKIE') ||
          kUpper.includes('JWT')
        ) {
          delete safeEnv[k];
        }
      }

      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: safeEnv
      });
    } else {
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

      const headers = config.headers || {};
      if (config.transport === 'sse') {
        transport = new SSEClientTransport(parsedUrl, {
          eventSourceInit: {
            // @ts-expect-error headers may be supported by fetch-based polyfill
            headers
          },
          requestInit: {
            headers
          }
        });
      } else {
        transport = new StreamableHTTPClientTransport(parsedUrl, {
          requestInit: {
            headers
          }
        });
      }
    }

    try {
      const client = new Client(
        {
          name: 'aira-mcp-host',
          version: '1.0.0'
        },
        { capabilities: {} }
      );

      await client.connect(transport);
      this.clients.set(serverId, client);
      this.serverErrors.delete(serverId);

      const toolsRes = await client.listTools();
      const tools = toolsRes.tools || [];
      const registeredDefs: ToolDefinition[] = [];

      for (const t of tools) {
        const serverToolDef: ToolDefinition = ToolDefinitionSchema.parse({
          id: `mcp_${config.id}_${t.name}`,
          name: `mcp_${config.id}_${t.name}`,
          version: 1,
          description: t.description || `Tool ${t.name} from MCP server ${config.name}`,
          category: 'mcp',
          parameters: t.inputSchema || { type: 'object', properties: {} },
          source: 'mcp',
          permissionLevel: 'READ',
          sideEffectLevel: 'READ',
          permissionScopes: ['mcp.invoke'],
          approvalPolicy: 'autonomous',
          executionRuntime: 'LOCAL',
          availability: 'READY',
          adapter: 'mcp',
          provider: config.name,
          metadata: { serverId: config.id, originalName: t.name }
        });

        const execAdapter = async (args: any, _ctx: any) => {
          const start = Date.now();
          try {
            const execResponse = await client.callTool({
              name: t.name,
              arguments: args as any
            });

            // Security Gate: tag external untrusted MCP output
            return {
              toolCallId: 'call_mcp_' + Date.now(),
              output: execResponse.content,
              isError: execResponse.isError || false,
              untrustedExternalData: true,
              durationMs: Date.now() - start,
              timestamp: Date.now()
            };
          } catch (err: any) {
            return {
              toolCallId: 'call_mcp_' + Date.now(),
              output: err.message,
              isError: true,
              error: err.message,
              untrustedExternalData: true,
              durationMs: Date.now() - start,
              timestamp: Date.now()
            };
          }
        };

        if ('registerTool' in this.toolRegistryOrGateway) {
          (this.toolRegistryOrGateway as ToolGateway).registerTool({
            definition: serverToolDef,
            execute: execAdapter
          });
        }
        if ('register' in this.toolRegistryOrGateway) {
          (this.toolRegistryOrGateway as ToolRegistry).register({
            definition: serverToolDef,
            execute: execAdapter as any
          });
        }
        registeredDefs.push(serverToolDef);
      }

      this.serverTools.set(serverId, registeredDefs);
      return true;
    } catch (err: any) {
      this.serverErrors.set(serverId, err.message);
      console.error(`Failed to connect MCP server ${config.name}:`, err.message);
      return false;
    }
  }

  public async disconnectServer(serverId: string): Promise<boolean> {
    const client = this.clients.get(serverId);
    if (!client) return false;
    try {
      await client.close();
    } catch {}
    this.clients.delete(serverId);
    this.serverTools.delete(serverId);
    return true;
  }

  public async disconnectAll(): Promise<void> {
    for (const [id, client] of this.clients.entries()) {
      try {
        await client.close();
      } catch {}
    }
    this.clients.clear();
    this.serverTools.clear();
  }
}
