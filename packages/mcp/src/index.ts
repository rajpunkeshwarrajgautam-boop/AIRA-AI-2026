import { ToolDefinition, ToolDefinitionSchema } from '../../contracts/src/index.js';
import { ToolRegistry, ToolGateway } from '../../tool-runtime/src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { validateMcpUrl, McpSecurityError } from './ssrf-protection.js';

export { validateMcpUrl, McpSecurityError };

export interface McpServerConfig {
  id: string;
  name: string;
  url?: string;
  transport?: 'streamable_http' | 'sse' | 'stdio';
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  ownerId?: string;
  isPlatform?: boolean;
}

export interface McpServerStatus {
  serverId: string;
  name: string;
  transport: 'streamable_http' | 'sse' | 'stdio';
  connected: boolean;
  toolCount: number;
  tools: string[];
  lastError?: string;
  ownerId?: string;
}

export interface SafeMcpServerSummary {
  id: string;
  name: string;
  url?: string;
  transport: 'streamable_http' | 'sse' | 'stdio';
  hasHeaders: boolean;
  headerNames: string[];
  hasEnv: boolean;
  ownerId?: string;
  isPlatform: boolean;
  connected: boolean;
  toolCount: number;
  tools: string[];
  lastError?: string;
}

/**
 * Approved base command names for stdio transport.
 * Arbitrary process execution is strictly prohibited.
 */
const APPROVED_STDIO_COMMANDS = new Set([
  'node',
  'node.exe',
  'npx',
  'npx.cmd',
  'tsx',
  'tsx.cmd',
  'python',
  'python.exe',
  'python3',
  'python3.exe',
  'uv',
  'uv.exe'
]);

/**
 * Strips host credentials, tokens, connection strings, and sensitive keys
 * from environment dictionaries before passing to stdio child processes.
 */
export function sanitizeStdioEnv(baseEnv?: Record<string, string | undefined>): Record<string, string> {
  const safeEnv: Record<string, string> = {
    PATH: process.env.PATH || '',
    SYSTEMROOT: process.env.SYSTEMROOT || '',
    HOME: process.env.HOME || process.env.USERPROFILE || '',
    USERPROFILE: process.env.USERPROFILE || ''
  };

  if (baseEnv) {
    for (const [k, v] of Object.entries(baseEnv)) {
      if (typeof v === 'string') {
        safeEnv[k] = v;
      }
    }
  }

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
      kUpper.includes('JWT') ||
      kUpper.includes('PASSWORD') ||
      kUpper.includes('CREDENTIAL')
    ) {
      delete safeEnv[k];
    }
  }

  return safeEnv;
}

export interface McpOperationOptions {
  ownerId?: string;
  isOperator?: boolean;
}

/**
 * Do not connect remote MCP transports from the public API runtime without
 * connection-time network controls. A hostname allowlist and a DNS check
 * before fetch are insufficient: the SDK owns DNS resolution and redirects
 * after validation, allowing DNS rebinding or redirects into private networks.
 *
 * Approved host configuration is intentionally NOT an escape hatch. Restore
 * remote transports only through a separately reviewed, network-restricted
 * connector with connection-time address pinning and redirect revalidation.
 * Local integration fixtures remain available outside production.
 */
export function assertApprovedPublicMcpDestination(
  url?: URL,
  _approvedHosts = process.env.AIRA_APPROVED_MCP_HOSTS || ''
): void {
  if (!(process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL))) return;
  // Do not echo the URL; it may contain credentials or private paths.
  void url;
  void _approvedHosts;
  throw new McpSecurityError(
    'Remote MCP connections are disabled until secure connection-time egress enforcement is available.',
    'MCP_EGRESS_ENFORCEMENT_REQUIRED',
    503
  );
}

/** A gateway tool cannot cross user ownership merely because its name is global. */
export function isMcpToolInvocationAuthorized(
  config: McpServerConfig | undefined,
  principal?: { userId?: string; roles?: string[] }
): boolean {
  if (!config) return false;
  const roles = principal?.roles || [];
  if (config.transport === 'stdio' &&
      !roles.includes('operator') && !roles.includes('platform_admin')) return false;
  if (config.isPlatform || config.ownerId === 'platform') return true;
  return Boolean(principal?.userId && principal.userId === config.ownerId);
}

export class McpHost {
  private servers: Map<string, McpServerConfig> = new Map();
  private clients: Map<string, Client> = new Map();
  private serverTools: Map<string, ToolDefinition[]> = new Map();
  private serverErrors: Map<string, string> = new Map();

  constructor(private toolRegistryOrGateway: ToolRegistry | ToolGateway) {}

  /**
   * Helper to verify tenant ownership:
   * Returns true if the server belongs to ownerId, or is a platform server, or caller is operator.
   */
  private checkOwnership(config: McpServerConfig, ownerId?: string, isOperator = false): boolean {
    if (isOperator) return true;
    // Public callers cannot manage platform connections. Legacy internal callers
    // without a user principal may inspect platform entries, but HTTP routes
    // always pass a verified ownerId or a verified operator flag.
    if (config.isPlatform || config.ownerId === 'platform') return !ownerId;
    if (!ownerId) return false;
    return config.ownerId === ownerId;
  }

  /**
   * Register a new MCP server configuration.
   * Customer-facing APIs are strictly prohibited from registering stdio transports.
   */
  public registerServer(config: McpServerConfig, options: McpOperationOptions = {}): void {
    const { ownerId, isOperator = false } = options;

    if (!config.id || typeof config.id !== 'string') {
      throw new McpSecurityError('Server id is required', 'INVALID_SERVER_ID', 400);
    }
    if (!config.name || typeof config.name !== 'string') {
      throw new McpSecurityError('Server name is required', 'INVALID_SERVER_NAME', 400);
    }

    const transport = config.transport || (config.command ? 'stdio' : 'streamable_http');

    // Security Gate SEC-01: stdio command execution restriction
    if (transport === 'stdio') {
      if (!isOperator) {
        throw new McpSecurityError(
          'stdio process transport is restricted to server-side operators. Customer APIs must use streamable_http or sse transports.',
          'STDIO_TRANSPORT_RESTRICTED',
          403
        );
      }

      if (!config.command || typeof config.command !== 'string') {
        throw new McpSecurityError('stdio server requires a command path.', 'MISSING_COMMAND', 400);
      }

      // Prohibit shell metacharacters in command and arguments
      if (/[;&|`$<>]/.test(config.command)) {
        throw new McpSecurityError('Command contains prohibited shell metacharacters.', 'DANGEROUS_COMMAND', 400);
      }

      const baseCmd = path.basename(config.command).toLowerCase();
      if (!APPROVED_STDIO_COMMANDS.has(baseCmd)) {
        throw new McpSecurityError(
          `Command '${baseCmd}' is not in the approved execution allowlist.`,
          'UNAPPROVED_COMMAND',
          403
        );
      }

      if (config.args && Array.isArray(config.args)) {
        for (const arg of config.args) {
          if (typeof arg !== 'string') {
            throw new McpSecurityError('All arguments must be strings.', 'INVALID_ARGUMENT', 400);
          }
        }
      }
    } else {
      if (!config.url || typeof config.url !== 'string') {
        throw new McpSecurityError('HTTP/SSE MCP servers require a valid url.', 'MISSING_URL', 400);
      }
    }

    // Tenant isolation: assign verified ownerId
    const effectiveOwner = options.ownerId || config.ownerId || 'platform';
    const isPlatform = Boolean(
      (isOperator || (!options.ownerId && !config.ownerId)) &&
      (config.isPlatform || effectiveOwner === 'platform')
    );

    // Prevent overwriting another account's server
    const existing = this.servers.get(config.id);
    if (existing && !this.checkOwnership(existing, options.ownerId, isOperator)) {
      throw new McpSecurityError(
        `Cannot overwrite server '${config.id}' owned by another tenant.`,
        'TENANT_ISOLATION_VIOLATION',
        403
      );
    }

    this.servers.set(config.id, {
      ...config,
      transport,
      ownerId: effectiveOwner,
      isPlatform
    });
  }

  public unregisterServer(serverId: string, options: McpOperationOptions = {}): boolean {
    const config = this.servers.get(serverId);
    if (!config) return false;

    if (!this.checkOwnership(config, options.ownerId, options.isOperator)) {
      throw new McpSecurityError(
        `Permission denied: Server '${serverId}' is not owned by this principal.`,
        'FORBIDDEN',
        403
      );
    }

    void this.disconnectServer(serverId, options);
    this.servers.delete(serverId);
    this.serverTools.delete(serverId);
    this.serverErrors.delete(serverId);
    return true;
  }

  /**
   * Return safe, credential-scrubbed summaries of registered servers.
   * Secrets, tokens, connection strings, headers, and env vars are NEVER returned.
   */
  public listServers(ownerId?: string, isOperator = false): SafeMcpServerSummary[] {
    const results: SafeMcpServerSummary[] = [];

    for (const config of this.servers.values()) {
      if (this.checkOwnership(config, ownerId, isOperator)) {
        const isConnected = this.clients.has(config.id);
        const tools = this.serverTools.get(config.id) || [];
        const headerNames = config.headers ? Object.keys(config.headers).map(h => h.toLowerCase()) : [];

        results.push({
          id: config.id,
          name: config.name,
          // A configured path, query, or userinfo can itself contain a token.
          // A management summary exposes only the origin, never the secret URL.
          url: config.url ? (() => {
            try { return new URL(config.url).origin; } catch { return undefined; }
          })() : undefined,
          transport: config.transport || 'streamable_http',
          hasHeaders: headerNames.length > 0,
          headerNames,
          hasEnv: Boolean(config.env && Object.keys(config.env).length > 0),
          ownerId: config.ownerId,
          isPlatform: Boolean(config.isPlatform || config.ownerId === 'platform'),
          connected: isConnected,
          toolCount: tools.length,
          tools: tools.map(t => t.name),
          lastError: this.serverErrors.has(config.id) ? 'MCP_CONNECTION_FAILED' : undefined
        });
      }
    }

    return results;
  }

  public getServerConfig(serverId: string, options: McpOperationOptions = {}): McpServerConfig | undefined {
    const config = this.servers.get(serverId);
    if (!config) return undefined;
    if (!this.checkOwnership(config, options.ownerId, options.isOperator)) {
      throw new McpSecurityError('Permission denied: cannot read server configuration.', 'FORBIDDEN', 403);
    }
    return config;
  }

  public getServerStatus(serverId: string, options: McpOperationOptions = {}): McpServerStatus | undefined {
    const config = this.servers.get(serverId);
    if (!config) return undefined;
    if (!this.checkOwnership(config, options.ownerId, options.isOperator)) {
      return undefined;
    }

    const isConnected = this.clients.has(serverId);
    const tools = this.serverTools.get(serverId) || [];
    return {
      serverId,
      name: config.name,
      transport: config.transport || 'streamable_http',
      connected: isConnected,
      toolCount: tools.length,
      tools: tools.map(t => t.name),
      lastError: this.serverErrors.has(serverId) ? 'MCP_CONNECTION_FAILED' : undefined,
      ownerId: config.ownerId
    };
  }

  public listAllStatuses(ownerId?: string, isOperator = false): McpServerStatus[] {
    const results: McpServerStatus[] = [];
    for (const id of this.servers.keys()) {
      const status = this.getServerStatus(id, { ownerId, isOperator });
      if (status) results.push(status);
    }
    return results;
  }

  public listServerTools(serverId: string, options: McpOperationOptions = {}): ToolDefinition[] {
    const config = this.servers.get(serverId);
    if (!config) return [];
    if (!this.checkOwnership(config, options.ownerId, options.isOperator)) {
      throw new McpSecurityError('Permission denied: cannot inspect tools for this server.', 'FORBIDDEN', 403);
    }
    return this.serverTools.get(serverId) || [];
  }

  public getConnectedCount(): number {
    return this.clients.size;
  }

  public async pingServer(serverId: string, options: McpOperationOptions = {}): Promise<boolean> {
    const config = this.servers.get(serverId);
    if (!config || !this.checkOwnership(config, options.ownerId, options.isOperator)) return false;

    const client = this.clients.get(serverId);
    if (!client) return false;
    try {
      await client.ping();
      return true;
    } catch {
      return false;
    }
  }

  public async connectServer(serverId: string, options: McpOperationOptions = {}): Promise<boolean> {
    const config = this.servers.get(serverId);
    if (!config) throw new Error(`MCP Server with id ${serverId} not found.`);

    // Tenant check
    if (!this.checkOwnership(config, options.ownerId, options.isOperator)) {
      throw new McpSecurityError(`Permission denied: cannot connect server '${serverId}'.`, 'FORBIDDEN', 403);
    }

    // If already connected, close existing session first
    if (this.clients.has(serverId)) {
      await this.disconnectServer(serverId, options);
    }

    try {
      let transport: any;

      if (config.transport === 'stdio') {
        // Platform registration must not imply customer permission to launch
        // its process. Internal no-principal callers remain supported.
        if (!options.isOperator && !(config.isPlatform && !options.ownerId)) {
          throw new McpSecurityError(
            'stdio process transport can only be connected by verified operators.',
            'STDIO_CONNECT_FORBIDDEN',
            403
          );
        }

        if (!config.command) {
          throw new Error(`MCP stdio server ${serverId} requires a command path.`);
        }

        // Security Isolation: Strip host credentials from stdio child process environment
        const safeEnv = sanitizeStdioEnv(config.env);

        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: safeEnv
        });
      } else {
        if (!config.url) throw new Error(`MCP Server with id ${serverId} requires an HTTP URL.`);

        // Production connections are disabled: reject BEFORE parsing or
        // resolving caller-supplied hosts, so a disabled route cannot cause
        // outbound DNS requests or progress to an SDK-managed redirect.
        assertApprovedPublicMcpDestination();

        // Local/non-production MCP integration fixtures retain SSRF validation.
        const validation = await validateMcpUrl(config.url, {
          allowLocalInDev: process.env.NODE_ENV !== 'production' || process.env.AIRA_ALLOW_LOCAL_MCP === 'true'
        });
        const parsedUrl = validation.safeUrl;

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
          // External MCP tool names/descriptions are untrusted and cannot
          // prove read-only side effects. Default to consent-required WRITE.
          permissionLevel: 'WRITE',
          sideEffectLevel: 'WRITE',
          permissionScopes: ['mcp.invoke'],
          approvalPolicy: 'require_approval',
          executionRuntime: 'LOCAL',
          availability: 'READY',
          adapter: 'mcp',
          provider: config.name,
          metadata: { serverId: config.id, originalName: t.name, ownerId: config.ownerId }
        });

        const execAdapter = async (args: any, _ctx: any) => {
          const start = Date.now();
          // Registered tools share a process-wide gateway. Check ownership
          // AGAIN when the tool is invoked, not only when it is registered.
          const liveConfig = this.servers.get(serverId);
          if (!isMcpToolInvocationAuthorized(liveConfig, _ctx?.principal)) {
            return {
              toolCallId: 'call_mcp_' + Date.now(),
              output: null,
              isError: true,
              error: 'MCP_TOOL_ACCESS_DENIED',
              untrustedExternalData: true,
              durationMs: Date.now() - start,
              timestamp: Date.now()
            };
          }
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
      // A rejected security boundary is an HTTP error, not a successful
      // connection attempt with a false result. Do not downgrade a 403/503
      // from transport policy into a 200 response on the management route.
      // Never retain raw transport messages, URLs, headers, or credential
      // material in status summaries or application logs.
      this.serverErrors.set(serverId, 'MCP_CONNECTION_FAILED');
      if (err instanceof McpSecurityError) {
        throw err;
      }
      console.error('[MCP] Remote connection failed (details redacted).');
      return false;
    }
  }

  public async disconnectServer(serverId: string, options: McpOperationOptions = {}): Promise<boolean> {
    const config = this.servers.get(serverId);
    if (!config) return false;

    if (!this.checkOwnership(config, options.ownerId, options.isOperator)) {
      throw new McpSecurityError(`Permission denied: cannot disconnect server '${serverId}'.`, 'FORBIDDEN', 403);
    }

    const client = this.clients.get(serverId);
    if (!client) return false;
    try {
      await client.close();
    } catch {}
    this.clients.delete(serverId);

    const tools = this.serverTools.get(serverId) || [];
    for (const t of tools) {
      if ('unregisterTool' in this.toolRegistryOrGateway) {
        (this.toolRegistryOrGateway as any).unregisterTool(t.id);
        (this.toolRegistryOrGateway as any).unregisterTool(t.name);
      }
    }
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
