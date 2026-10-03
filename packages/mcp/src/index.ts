import { ToolDefinition } from '../../contracts/src/index.js';
import { ToolRegistry } from '../../tool-runtime/src/index.js';

export interface McpServerConfig {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  disabled?: boolean;
}

export class McpHost {
  private servers: Map<string, McpServerConfig> = new Map();

  constructor(private toolRegistry: ToolRegistry) {
    this.registerDefaultServers();
  }

  public registerServer(config: McpServerConfig): void {
    this.servers.set(config.id, config);
  }

  public listServers(): McpServerConfig[] {
    return Array.from(this.servers.values());
  }

  public async connectServer(serverId: string): Promise<boolean> {
    const config = this.servers.get(serverId);
    if (!config) {
      throw new Error(`MCP Server with id ${serverId} not found.`);
    }

    if (!config.url) {
      throw new Error(`MCP Server with id ${serverId} requires an HTTP URL for this phase.`);
    }

    try {
      const response = await fetch(`${config.url}/tools`);
      if (!response.ok) {
        throw new Error(`Failed to fetch tools from ${config.url}/tools: ${response.statusText}`);
      }
      
      const data = await response.json();
      const tools = data.tools || [];
      
      for (const t of tools) {
        const serverToolDef: ToolDefinition = {
          id: `mcp_${config.id}_${t.name}`,
          name: t.name,
          description: t.description || `Tool ${t.name} from MCP server ${config.name}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
          source: 'mcp',
          permissionLevel: 'READ',
          executionRuntime: 'LOCAL'
        };

        this.toolRegistry.register({
          definition: serverToolDef,
          execute: async (args, ctx) => {
            const start = Date.now();
            try {
              const execResponse = await fetch(`${config.url}/tools/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: t.name, arguments: args })
              });
              
              if (!execResponse.ok) {
                const text = await execResponse.text();
                throw new Error(`MCP Execution failed: ${text}`);
              }
              
              const execData = await execResponse.json();
              
              return {
                toolCallId: 'call_mcp_' + Date.now(),
                output: execData,
                isError: execData.isError || false,
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

  private registerDefaultServers(): void {
    // Intentionally empty for real MCP integration unless we configure them from DB/env
  }
}
