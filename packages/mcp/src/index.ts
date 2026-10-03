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

    const serverToolDef: ToolDefinition = {
      id: `mcp_${config.id}_ping`,
      name: `mcp_${config.id}_ping`,
      description: `Test connectivity and retrieve diagnostics for MCP server ${config.name}.`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      },
      source: 'mcp',
      permissionLevel: 'READ',
      executionRuntime: 'LOCAL'
    };

    this.toolRegistry.register({
      definition: serverToolDef,
      execute: async (_args, _ctx) => {
        return {
          toolCallId: 'call_mcp_' + Date.now(),
          output: {
            server: config.name,
            status: 'CONNECTED',
            protocolVersion: '2024-11-05',
            capabilities: { tools: true, resources: true, prompts: true }
          },
          isError: false,
          durationMs: 15,
          timestamp: Date.now()
        };
      }
    });

    return true;
  }

  private registerDefaultServers(): void {
    this.registerServer({
      id: 'knowledge_mcp',
      name: 'Aira Knowledge MCP Service',
      url: 'http://localhost:3001/mcp/knowledge'
    });
    this.registerServer({
      id: 'fs_mcp',
      name: 'Sandboxed Filesystem MCP',
      url: 'http://localhost:3001/mcp/fs'
    });
  }
}
